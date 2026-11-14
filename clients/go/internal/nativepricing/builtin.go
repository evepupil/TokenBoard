package nativepricing

// This file is the code builtin rate table: ccusage's put_builtin_pricing
// (rust/crates/ccusage-core/src/pricing.rs:2015-2560) plus the two helpers it
// uses, put_builtin_entry (:1980-1983) and put_builtin_glm (:1990-2009).
//
// The builtins are the last resort for models ccusage must always be able to
// price, and they belong to the primary stage: load_embedded runs
// LiteLLM -> put_builtin_pricing -> fill_long_context_rates_from_models_dev, and
// the embedded models.dev snapshot is consulted only after the primary map
// misses. loadCorpus reproduces that order, so a builtin row wins over a
// models.dev row for the same key while a LiteLLM row keeps its rates - upstream
// data is refreshed hourly, and overwriting it with these frozen numbers would
// reintroduce stale prices whenever a vendor changes theirs.
//
// Two details of the Rust code matter for parity and are deliberately preserved:
//
//   - three rows are written with a bare `self.entries.insert`, not
//     `put_builtin_entry`, so gpt-5.1-codex, gpt-5.2-codex and gpt-5.2 replace a
//     LiteLLM row instead of filling a gap (that is what gives gpt-5.2 a
//     published 1.75e-6 cache-create rate where the snapshot derives 2.1875e-6,
//     while its neighbour gpt-5.3-codex keeps the derived rate);
//   - put_builtin_glm only patches the two cache fields, and only when the row
//     it finds did not publish them itself, because z.ai bills no cache writes
//     and the base rates have to stay the snapshot's.
//
// Not ported here: the context limits put_builtin_pricing also writes
// (1_050_000 for gpt-5.5/gpt-5.4/gpt-5.6-*, 1_000_000 for the opus 4.6+ rows,
// 262_144 for the moonshot rows, 200_000 for the claude 3 rows). ccusage keeps
// three limit tiers - the primary map's context_limits, models.dev, and a final
// builtin_context_limits that only the gpt-5.6 rows fill - and Corpus.ContextLimits
// is a single merged map, so porting them would collapse tiers that answer
// differently (gpt-5.6-sol is 922_000 from LiteLLM, not the builtin 1_050_000).
// Nothing in S1 reads ContextLimits; whoever ports context_limit owes it the
// three tiers.

// builtinInsert is the write strategy one table row uses.
type builtinInsert int

const (
	// builtinFillMissing is put_builtin_entry's or_insert: the row is written
	// only when the primary table does not already price the key.
	builtinFillMissing builtinInsert = iota
	// builtinOverwrite is the bare entries.insert the gpt-5.1-codex,
	// gpt-5.2-codex and gpt-5.2 rows use: whatever the primary table holds is
	// replaced.
	builtinOverwrite
	// builtinPatchCache is put_builtin_glm: a row the primary table already
	// prices keeps its rates and gains only the cache fields it left derived;
	// a row it does not price is written whole.
	builtinPatchCache
)

// builtinEntry is one put_builtin_* call, transcribed.
type builtinEntry struct {
	model                                 string
	input, output, cacheCreate, cacheRead float64
	// The above-threshold bands. Only claude-sonnet-4 publishes any; every other
	// row leaves them for the long-context graft to borrow from models.dev.
	inputAbove, outputAbove, cacheCreateAbove, cacheReadAbove *float64
	// cacheExplicit is the cache_read_explicit / cache_create_explicit pair,
	// which every row sets the same way: derived only for grok-4.3.
	cacheExplicit bool
	// fastFromOverrides and flexFromOverrides make the row resolve that
	// multiplier from the embedded override files instead of the literal 1.0
	// ccusage hardcodes for every other row.
	fastFromOverrides, flexFromOverrides bool
	mode                                 builtinInsert
}

// floatValue returns a pointer to value, for the optional band fields.
func floatValue(value float64) *float64 { return &value }

// builtinTable is put_builtin_pricing in source order.
var builtinTable = []builtinEntry{
	{model: "claude-opus-4-5", input: 5e-6, output: 25e-6, cacheCreate: 6.25e-6, cacheRead: 0.5e-6, cacheExplicit: true},
	{model: "claude-opus-4-6", input: 5e-6, output: 25e-6, cacheCreate: 6.25e-6, cacheRead: 0.5e-6, cacheExplicit: true, fastFromOverrides: true, flexFromOverrides: true},
	{model: "claude-opus-4-7", input: 5e-6, output: 25e-6, cacheCreate: 6.25e-6, cacheRead: 0.5e-6, cacheExplicit: true, fastFromOverrides: true, flexFromOverrides: true},
	{model: "claude-opus-4-8", input: 5e-6, output: 25e-6, cacheCreate: 6.25e-6, cacheRead: 0.5e-6, cacheExplicit: true, fastFromOverrides: true, flexFromOverrides: true},
	{model: "claude-haiku-4-5", input: 1e-6, output: 5e-6, cacheCreate: 1.25e-6, cacheRead: 0.1e-6, cacheExplicit: true},
	{model: "claude-opus-4", input: 15e-6, output: 75e-6, cacheCreate: 18.75e-6, cacheRead: 1.5e-6, cacheExplicit: true},
	{model: "claude-sonnet-4-6", input: 3e-6, output: 15e-6, cacheCreate: 3.75e-6, cacheRead: 0.3e-6, cacheExplicit: true},
	{
		model: "claude-sonnet-4", input: 3e-6, output: 15e-6, cacheCreate: 3.75e-6, cacheRead: 0.3e-6, cacheExplicit: true,
		inputAbove: floatValue(6e-6), outputAbove: floatValue(22.5e-6),
		cacheCreateAbove: floatValue(7.5e-6), cacheReadAbove: floatValue(0.6e-6),
	},
	{model: "claude-3-5-haiku", input: 0.8e-6, output: 4e-6, cacheCreate: 1e-6, cacheRead: 0.08e-6, cacheExplicit: true},
	{model: "claude-3-5-haiku-20241022", input: 0.8e-6, output: 4e-6, cacheCreate: 1e-6, cacheRead: 0.08e-6, cacheExplicit: true},
	{model: "claude-3-opus", input: 15e-6, output: 75e-6, cacheCreate: 18.75e-6, cacheRead: 1.5e-6, cacheExplicit: true},
	{model: "claude-3-sonnet", input: 3e-6, output: 15e-6, cacheCreate: 3.75e-6, cacheRead: 0.3e-6, cacheExplicit: true},
	{model: "claude-3-haiku", input: 0.25e-6, output: 1.25e-6, cacheCreate: 0.3e-6, cacheRead: 0.03e-6, cacheExplicit: true},
	{model: "gpt-5", input: 1.25e-6, output: 10e-6, cacheCreate: 1.25e-6, cacheRead: 0.125e-6, cacheExplicit: true, flexFromOverrides: true},
	{model: "gpt-5.5", input: 5e-6, output: 30e-6, cacheCreate: 5e-6, cacheRead: 0.5e-6, cacheExplicit: true, fastFromOverrides: true, flexFromOverrides: true},
	{model: "grok-4.3", input: 1.25e-6, output: 2.5e-6, cacheCreate: 1.25e-6, cacheRead: 0.125e-6},
	{model: "moonshot/kimi-k2.5", input: 0.6e-6, output: 3e-6, cacheCreate: 0.75e-6, cacheRead: 0.1e-6, cacheExplicit: true},
	{model: "moonshot/kimi-k2.6", input: 0.95e-6, output: 4e-6, cacheCreate: 1.1875e-6, cacheRead: 0.16e-6, cacheExplicit: true},

	// gpt_5_1_pricing, written once for gpt-5.1 and once verbatim for
	// gpt-5.1-codex (a direct insert that carries none of the override lookups).
	{model: "gpt-5.1", input: 1.25e-6, output: 10e-6, cacheCreate: 1.25e-6, cacheRead: 0.125e-6, cacheExplicit: true, flexFromOverrides: true},
	{model: "gpt-5.1-codex", input: 1.25e-6, output: 10e-6, cacheCreate: 1.25e-6, cacheRead: 0.125e-6, cacheExplicit: true, mode: builtinOverwrite},

	// gpt_5_codex_pricing: gpt-5.2-codex is written verbatim, gpt-5.3-codex
	// takes the override lookups, and gpt-5.2 takes only the flex one.
	{model: "gpt-5.2-codex", input: 1.75e-6, output: 14e-6, cacheCreate: 1.75e-6, cacheRead: 0.175e-6, cacheExplicit: true, mode: builtinOverwrite},
	{model: "gpt-5.3-codex", input: 1.75e-6, output: 14e-6, cacheCreate: 1.75e-6, cacheRead: 0.175e-6, cacheExplicit: true, fastFromOverrides: true, flexFromOverrides: true},
	{model: "gpt-5.2", input: 1.75e-6, output: 14e-6, cacheCreate: 1.75e-6, cacheRead: 0.175e-6, cacheExplicit: true, flexFromOverrides: true, mode: builtinOverwrite},

	{model: "gpt-5.4", input: 2.5e-6, output: 15e-6, cacheCreate: 2.5e-6, cacheRead: 0.25e-6, cacheExplicit: true, fastFromOverrides: true, flexFromOverrides: true},
	{model: "gpt-5.4-mini", input: 0.75e-6, output: 4.5e-6, cacheCreate: 0.75e-6, cacheRead: 0.075e-6, cacheExplicit: true, flexFromOverrides: true},
	{model: "gpt-5.4-nano", input: 0.2e-6, output: 1.25e-6, cacheCreate: 0.2e-6, cacheRead: 0.02e-6, cacheExplicit: true, flexFromOverrides: true},
	{model: "gpt-5.6-sol", input: 5e-6, output: 30e-6, cacheCreate: 6.25e-6, cacheRead: 0.5e-6, cacheExplicit: true, fastFromOverrides: true, flexFromOverrides: true},
	{model: "gpt-5.6-terra", input: 2.5e-6, output: 15e-6, cacheCreate: 3.125e-6, cacheRead: 0.25e-6, cacheExplicit: true, fastFromOverrides: true, flexFromOverrides: true},
	{model: "gpt-5.6-luna", input: 1e-6, output: 6e-6, cacheCreate: 1.25e-6, cacheRead: 0.1e-6, cacheExplicit: true, fastFromOverrides: true, flexFromOverrides: true},

	// The z.ai rows: glm_pricing(input, output, cache_read) with cache_create 0,
	// applied as a cache-field patch.
	{model: "glm-4.5", input: 0.6e-6, output: 2.2e-6, cacheRead: 0.11e-6, cacheExplicit: true, mode: builtinPatchCache},
	{model: "zai/glm-4.5", input: 0.6e-6, output: 2.2e-6, cacheRead: 0.11e-6, cacheExplicit: true, mode: builtinPatchCache},
	{model: "zai/glm-4.5-x", input: 2.2e-6, output: 8.9e-6, cacheRead: 0.45e-6, cacheExplicit: true, mode: builtinPatchCache},
	{model: "zai/glm-4.5-air", input: 0.2e-6, output: 1.1e-6, cacheRead: 0.03e-6, cacheExplicit: true, mode: builtinPatchCache},
	{model: "zai/glm-4.5-airx", input: 1.1e-6, output: 4.5e-6, cacheRead: 0.22e-6, cacheExplicit: true, mode: builtinPatchCache},
	{model: "zai/glm-4.5v", input: 0.6e-6, output: 1.8e-6, cacheRead: 0.11e-6, cacheExplicit: true, mode: builtinPatchCache},
	{model: "zai/glm-4-32b-0414-128k", input: 0.1e-6, output: 0.1e-6, cacheRead: 0, cacheExplicit: true, mode: builtinPatchCache},
	{model: "zai/glm-4.5-flash", input: 0, output: 0, cacheRead: 0, cacheExplicit: true, mode: builtinPatchCache},
	{model: "glm-4.6", input: 0.6e-6, output: 2.2e-6, cacheRead: 0.11e-6, cacheExplicit: true, mode: builtinPatchCache},
	{model: "glm-4.7", input: 0.6e-6, output: 2.2e-6, cacheRead: 0.11e-6, cacheExplicit: true, mode: builtinPatchCache},

	// The glm-5 rows are put_builtin_entry calls that spread glm_base, so they
	// carry its whole-cache row rather than a patch.
	{model: "glm-5", input: 1e-6, output: 3.2e-6, cacheCreate: 0, cacheRead: 0.2e-6, cacheExplicit: true},
	{model: "glm-5-turbo", input: 1.2e-6, output: 4e-6, cacheCreate: 0, cacheRead: 0.24e-6, cacheExplicit: true},
	{model: "glm-5.1", input: 1.4e-6, output: 4.4e-6, cacheCreate: 0, cacheRead: 0.26e-6, cacheExplicit: true},
}

// applyBuiltins adds the code builtin table to the merging corpus, exactly as
// put_builtin_pricing writes into the primary map after LiteLLM is loaded.
//
// "The primary table already prices this key" means a row whose Source is not
// SourceModelsDev: ccusage keeps its models.dev snapshot in a separate map that
// the builtin pass never sees, so a models.dev row is a gap the primary-stage
// builtin fills. Getting that wrong leaves eleven ids - glm-5, moonshot/kimi-k2.5,
// claude-opus-4, grok-4.3 and the rest - billed at the fallback rates.
//
// The caller must run the long-context graft afterwards: a builtin row publishes
// no above-threshold bands (claude-sonnet-4 apart) and borrows models.dev's, just
// as ccusage's fill_long_context_rates_from_models_dev does for it.
func applyBuiltins(models map[string]CorpusModel, fast, flex multiplierOverrides) {
	for _, entry := range builtinTable {
		existing, found := models[entry.model]
		primary := found && existing.Source != SourceModelsDev
		if primary {
			switch entry.mode {
			case builtinFillMissing:
				continue
			case builtinPatchCache:
				if !existing.CacheReadExplicit {
					existing.CacheRead = entry.cacheRead
					existing.CacheReadExplicit = true
				}
				if !existing.CacheCreateExplicit {
					existing.CacheCreate = entry.cacheCreate
					existing.CacheCreateExplicit = true
				}
				models[entry.model] = existing
				continue
			}
		}
		models[entry.model] = entry.pricing(fast, flex)
	}
}

// pricing renders one table row. ExactOnly is left false: the union of both
// snapshots' exact-only flags is stamped afterwards by loadCorpus, which is the
// only place that knows the models.dev index.
func (e builtinEntry) pricing(fast, flex multiplierOverrides) CorpusModel {
	pricing := CorpusModel{
		Input:               e.input,
		Output:              e.output,
		CacheCreate:         e.cacheCreate,
		CacheRead:           e.cacheRead,
		CacheCreateExplicit: e.cacheExplicit,
		CacheReadExplicit:   e.cacheExplicit,
		InputAbove:          e.inputAbove,
		OutputAbove:         e.outputAbove,
		CacheCreateAbove:    e.cacheCreateAbove,
		CacheReadAbove:      e.cacheReadAbove,
		FastMultiplier:      1,
		FlexMultiplier:      1,
		Source:              SourceBuiltin,
	}
	if e.fastFromOverrides {
		pricing.FastMultiplier = fast.multiplierFor(e.model)
	}
	if e.flexFromOverrides {
		pricing.FlexMultiplier = flex.multiplierFor(e.model)
	}
	return pricing
}
