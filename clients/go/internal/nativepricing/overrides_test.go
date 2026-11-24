package nativepricing

import (
	"reflect"
	"testing"
)

// The override layer's fixtures are hand-built so every assertion names the exact
// field the port touches. ccusage's apply_override (pricing.rs:1820-1912) reads
// its base from `self.entries`, which holds the LiteLLM table and the builtin
// rows but never the models.dev fallback - that snapshot is a separate
// PricingMap - so the fixtures keep a primary row, an alias target and a
// models.dev-only row side by side.

// overrideCorpus is the frozen input every override test starts from.
func overrideCorpus() Corpus {
	return Corpus{
		Models: map[string]CorpusModel{
			// Explicit cache rates, the shape LiteLLM publishes for sonnet and
			// gpt-4o. The scaling gate must leave these alone.
			"claude-explicit": {
				Input: 3e-6, Output: 15e-6, CacheCreate: 3.75e-6, CacheRead: 3e-7,
				CacheCreateExplicit: true, CacheReadExplicit: true,
				FastMultiplier: 1, FlexMultiplier: 1,
				Source: SourceLiteLLM,
			},
			// Derived cache rates: cache_create = input × 1.25,
			// cache_read = input × 0.1, exactly as the LiteLLM loader derives
			// them when the snapshot omits `cc`/`cr`.
			"claude-derived": {
				Input: 3e-6, Output: 15e-6, CacheCreate: 3.75e-6, CacheRead: 3e-7,
				FastMultiplier: 1, FlexMultiplier: 1,
				Source: SourceLiteLLM,
			},
			// A hardcoded alias target: the override arrives as "gpt-5.6".
			"gpt-5.6-sol": {
				Input: 4e-6, Output: 20e-6, CacheCreate: 5e-6, CacheRead: 4e-7,
				CacheCreateExplicit: true, CacheReadExplicit: true,
				FastMultiplier: 2, FlexMultiplier: 1,
				Source: SourceLiteLLM,
			},
			// A separately priced tier with a whole-request threshold.
			"gpt-tiered": {
				Input: 1e-6, Output: 10e-6, CacheCreate: 1.25e-6, CacheRead: 1e-7,
				InputAbove: floatValue(2e-6), OutputAbove: floatValue(20e-6),
				CacheCreateAbove: floatValue(2.5e-6), CacheReadAbove: floatValue(2e-7),
				LongContextThreshold: int64Value(200_000),
				FastMultiplier:       1, FlexMultiplier: 1,
				Source: SourceLiteLLM,
			},
			// The models.dev fallback table. ccusage's apply_override cannot see
			// it, so it must never become the override's base.
			"md-only": {
				Input: 2e-6, Output: 6e-6, CacheCreate: 2.5e-6, CacheRead: 3e-7,
				FastMultiplier: 1, FlexMultiplier: 1,
				ExactOnly: true, Source: SourceModelsDev,
			},
		},
		ExactOnlyNames: map[string]bool{"md-only": true},
		ContextLimits: map[string]int64{
			"claude-explicit": 200_000,
			"claude-derived":  1_000_000,
			"md-only":         500_000,
		},
		Counts: map[string]int{countLitellm: 4, countModelsDev: 1},
	}
}

func mustOverride(t *testing.T, corpus Corpus, overrides map[string]any) Corpus {
	t.Helper()
	updated, err := corpus.WithOverrides(overrides)
	if err != nil {
		t.Fatalf("WithOverrides: %v", err)
	}
	return updated
}

// corpusWithEntry returns a fresh corpus whose model row has been rewritten by
// mutate.
//
// It rebuilds through overrideCorpus() every time on purpose. Corpus is a struct
// holding map and pointer fields, so `copyOf := corpus` shares the Models map,
// and an earlier version of the scaling test wrote its fixture edit straight
// into the map both values were reading - the later sub-case then ran against a
// contaminated base and passed for the wrong reason. The clone is belt and
// braces should overrideCorpus ever start returning a shared corpus.
func corpusWithEntry(t *testing.T, model string, mutate func(CorpusModel) CorpusModel) Corpus {
	t.Helper()
	corpus := overrideCorpus()
	corpus.Models = cloneModels(corpus.Models)
	corpus.Models[model] = mutate(corpus.Models[model])
	return corpus
}

// TestWithOverrides_parsesCamelCaseKeys feeds the exact shape
// packages/collector/ccusage.json carries, then proves the snake_case spelling
// serde's rename_all produces internally is NOT the wire format: those keys have
// to be ignored, not half-applied.
func TestWithOverrides_parsesCamelCaseKeys(t *testing.T) {
	corpus := overrideCorpus()

	updated := mustOverride(t, corpus, map[string]any{
		"claude-explicit": map[string]any{
			"inputCostPerToken":           1e-6,
			"outputCostPerToken":          2e-6,
			"cacheReadInputTokenCost":     3e-7,
			"cacheCreationInputTokenCost": 4e-6,
			"fastMultiplier":              3.0,
			"flexMultiplier":              0.25,
		},
	})

	entry := updated.Models["claude-explicit"]
	approx(t, entry.Input, 1e-6, "input from inputCostPerToken")
	approx(t, entry.Output, 2e-6, "output from outputCostPerToken")
	approx(t, entry.CacheRead, 3e-7, "cache read from cacheReadInputTokenCost")
	approx(t, entry.CacheCreate, 4e-6, "cache create from cacheCreationInputTokenCost")
	approx(t, entry.FastMultiplier, 3, "fastMultiplier")
	approx(t, entry.FlexMultiplier, 0.25, "flexMultiplier")

	// The same values under ccusage's internal Rust field names must do nothing.
	unchanged := mustOverride(t, corpus, map[string]any{
		"claude-explicit": map[string]any{
			"input_cost_per_token":            1e-6,
			"output_cost_per_token":           2e-6,
			"cache_read_input_token_cost":     3e-7,
			"cache_creation_input_token_cost": 4e-6,
			"fast_multiplier":                 3.0,
			"flex_multiplier":                 0.25,
			"max_input_tokens":                1234,
		},
	})
	if got := unchanged.Models["claude-explicit"]; !reflect.DeepEqual(got, corpus.Models["claude-explicit"]) {
		t.Fatalf("snake_case keys changed the entry:\ngot  %+v\nwant %+v", got, corpus.Models["claude-explicit"])
	}
	if got, want := unchanged.ContextLimits["claude-explicit"], corpus.ContextLimits["claude-explicit"]; got != want {
		t.Fatalf("snake_case max_input_tokens wrote a context limit: got %d, want %d", got, want)
	}
}

// TestWithOverrides_scalesCacheRatesOnlyWhenBaseIsDerived covers ccusage's
// should_scale gate: an input override rescales the cache rates only when the
// base derived them, and only by new_input / old_input.
func TestWithOverrides_scalesCacheRatesOnlyWhenBaseIsDerived(t *testing.T) {
	corpus := overrideCorpus()
	// The derived fixture is 1,500,000 tokens-per-dollar; halving the input rate
	// halves both derived cache rates.
	updated := mustOverride(t, corpus, map[string]any{
		"claude-derived": map[string]any{"inputCostPerToken": 1.5e-6},
	})

	entry := updated.Models["claude-derived"]
	approx(t, entry.Input, 1.5e-6, "input")
	approx(t, entry.Output, 15e-6, "output is not scaled")
	approx(t, entry.CacheCreate, 1.875e-6, "derived cache create is scaled by 0.5")
	approx(t, entry.CacheRead, 1.5e-7, "derived cache read is scaled by 0.5")
	if entry.CacheReadExplicit || entry.CacheCreateExplicit {
		t.Fatal("scaling does not make a derived rate explicit")
	}

	// An explicit cache rate on the base closes the gate, even for the other
	// bucket: should_scale reads cache_read_explicit alone. The zero-rate case
	// below gets its own corpus too - sharing one map across sub-cases would let
	// an earlier edit leak into the later ones.
	halfExplicit := corpusWithEntry(t, "claude-derived", func(base CorpusModel) CorpusModel {
		base.CacheReadExplicit = true
		return base
	})
	kept := mustOverride(t, halfExplicit, map[string]any{
		"claude-derived": map[string]any{"inputCostPerToken": 1.5e-6},
	})
	approx(t, kept.Models["claude-derived"].CacheCreate, 3.75e-6, "cache create stays put when the gate is closed")
	approx(t, kept.Models["claude-derived"].CacheRead, 3e-7, "cache read stays put when the gate is closed")

	// A zero derived rate stays zero: ccusage guards the multiply with
	// `base.cache_create > 0` / `base.cache_read > 0`, so the open gate is not
	// enough. The companion model below has the same gate conditions but non-zero
	// cache rates, and it does scale - that contrast is what proves the zero is
	// held by the guard rather than by a closed gate.
	zero := corpusWithEntry(t, "claude-derived", func(base CorpusModel) CorpusModel {
		base.CacheCreate, base.CacheRead = 0, 0
		return base
	})
	zero.Models["claude-gated"] = CorpusModel{
		Input: 3e-6, Output: 15e-6, CacheCreate: 3.75e-6, CacheRead: 3e-7,
		FastMultiplier: 1, FlexMultiplier: 1, Source: SourceLiteLLM,
	}
	zeroedOut := mustOverride(t, zero, map[string]any{
		"claude-derived": map[string]any{"inputCostPerToken": 1.5e-6},
		"claude-gated":   map[string]any{"inputCostPerToken": 1.5e-6},
	})
	if got := zeroedOut.Models["claude-derived"]; got.CacheCreate != 0 || got.CacheRead != 0 {
		t.Fatalf("zero cache rates must stay zero, got %+v", got)
	}
	approx(t, zeroedOut.Models["claude-gated"].CacheRead, 1.5e-7,
		"the same gate does scale a non-zero base, so the zero above is the guard")
}

// TestWithOverrides_keepsExplicitCacheRates is the sonnet/gpt-4o case the
// scaling gate exists for.
func TestWithOverrides_keepsExplicitCacheRates(t *testing.T) {
	corpus := overrideCorpus()
	updated := mustOverride(t, corpus, map[string]any{
		"claude-explicit": map[string]any{"inputCostPerToken": 6e-6},
	})

	entry := updated.Models["claude-explicit"]
	approx(t, entry.Input, 6e-6, "input")
	approx(t, entry.CacheCreate, 3.75e-6, "explicit cache create is never scaled")
	approx(t, entry.CacheRead, 3e-7, "explicit cache read is never scaled")
	if !entry.CacheReadExplicit || !entry.CacheCreateExplicit {
		t.Fatal("an untouched explicit rate stays explicit")
	}

	// An explicit override beats scaling even when the gate is open.
	explicitOverride := mustOverride(t, corpus, map[string]any{
		"claude-derived": map[string]any{
			"inputCostPerToken":       1.5e-6,
			"cacheReadInputTokenCost": 9e-7,
		},
	})
	approx(t, explicitOverride.Models["claude-derived"].CacheRead, 9e-7, "explicit override wins over scaling")
	approx(t, explicitOverride.Models["claude-derived"].CacheCreate, 1.875e-6, "the other bucket still scales")
}

// TestWithOverrides_parsesAbove200kSuffixKeys pins the four marginal-band keys
// and ccusage's asymmetric handling: the input/output bands are copied, the
// cache bands scale with the gate.
func TestWithOverrides_parsesAbove200kSuffixKeys(t *testing.T) {
	corpus := overrideCorpus()
	updated := mustOverride(t, corpus, map[string]any{
		"gpt-tiered": map[string]any{
			"inputCostPerTokenAbove200kTokens":           3e-6,
			"outputCostPerTokenAbove200kTokens":          30e-6,
			"cacheReadInputTokenCostAbove200kTokens":     4e-7,
			"cacheCreationInputTokenCostAbove200kTokens": 5e-6,
		},
	})

	entry := updated.Models["gpt-tiered"]
	approx(t, *entry.InputAbove, 3e-6, "input above")
	approx(t, *entry.OutputAbove, 30e-6, "output above")
	approx(t, *entry.CacheReadAbove, 4e-7, "cache read above")
	approx(t, *entry.CacheCreateAbove, 5e-6, "cache create above")
	// An override never rewrites the tier threshold; it comes from models.dev.
	if entry.LongContextThreshold == nil || *entry.LongContextThreshold != 200_000 {
		t.Fatalf("long-context threshold = %v, want the base's 200000", entry.LongContextThreshold)
	}
	// Untouched base rates survive.
	approx(t, entry.Input, 1e-6, "base input")
	approx(t, entry.Output, 10e-6, "base output")

	// The cache bands scale with the same gate as the base cache rates.
	// gpt-tiered's fixture derives its cache rates (no explicit flag), so the
	// gate is open and WithOverrides leaves the receiver untouched - the same
	// corpus value can be reused here.
	scaled := mustOverride(t, corpus, map[string]any{
		"gpt-tiered": map[string]any{"inputCostPerToken": 2e-6},
	})
	approx(t, *scaled.Models["gpt-tiered"].CacheCreateAbove, 5e-6, "cache create above scaled by 2")
	approx(t, *scaled.Models["gpt-tiered"].CacheReadAbove, 4e-7, "cache read above scaled by 2")
	// The input/output bands are copied, never scaled.
	approx(t, *scaled.Models["gpt-tiered"].InputAbove, 2e-6, "input above is not scaled")
	approx(t, *scaled.Models["gpt-tiered"].OutputAbove, 20e-6, "output above is not scaled")
}

// TestWithOverrides_setsMaxInputTokens proves maxInputTokens lands in the
// context-window map and nowhere else: it is not a LongContextThreshold.
func TestWithOverrides_setsMaxInputTokens(t *testing.T) {
	corpus := overrideCorpus()
	updated := mustOverride(t, corpus, map[string]any{
		"claude-derived": map[string]any{"maxInputTokens": 42_000},
		"brand-new":      map[string]any{"maxInputTokens": 77_000},
	})

	if got := updated.ContextLimits["claude-derived"]; got != 42_000 {
		t.Fatalf("context limit = %d, want 42000", got)
	}
	if got := updated.ContextLimits["brand-new"]; got != 77_000 {
		t.Fatalf("a limit is recorded even for a model no snapshot prices, got %d", got)
	}
	if got := updated.Models["claude-derived"].LongContextThreshold; got != nil {
		t.Fatalf("maxInputTokens became a tier threshold: %v", got)
	}
	// Not asking for a limit leaves the existing one alone.
	untouched := mustOverride(t, corpus, map[string]any{
		"claude-explicit": map[string]any{"inputCostPerToken": 1e-6},
	})
	if got := untouched.ContextLimits["claude-explicit"]; got != 200_000 {
		t.Fatalf("context limit = %d, want the existing 200000", got)
	}
}

// TestWithOverrides_isIdempotent pins the property Task 5's goldens rely on:
// the config file is applied on every run, so applying it twice must not move a
// single bit.
func TestWithOverrides_isIdempotent(t *testing.T) {
	overrides := map[string]any{
		"claude-derived": map[string]any{
			"inputCostPerToken":                1.5e-6,
			"outputCostPerToken":               1.2e-5,
			"fastMultiplier":                   2.0,
			"maxInputTokens":                   640_000,
			"inputCostPerTokenAbove200kTokens": 3e-6,
		},
		"claude-explicit": map[string]any{"inputCostPerToken": 6e-6},
		"gpt-5.6":         map[string]any{"inputCostPerToken": 42e-6},
	}
	corpus := overrideCorpus()
	once := mustOverride(t, corpus, overrides)
	twice := mustOverride(t, once, overrides)
	if !reflect.DeepEqual(once, twice) {
		t.Fatalf("applying the same overrides twice drifted:\nonce  %+v\ntwice %+v", once, twice)
	}
}

// TestWithOverrides_rejectsMalformedJSON fails closed: a payload the parser
// cannot read must be an error, never an empty override set.
func TestWithOverrides_rejectsMalformedJSON(t *testing.T) {
	corpus := overrideCorpus()
	for _, raw := range []string{
		``,
		`{`,
		`{"pricingOverrides":`,
		`{"pricingOverrides": {"gpt-5.6": {"inputCostPerToken": }}}`,
		`{"pricingOverrides": {"gpt-5.6": {"inputCostPerToken": 1e-6}}} trailing`,
		`[]`,
		`"gpt-5.6"`,
	} {
		if _, err := corpus.WithServerOverrides([]byte(raw)); err == nil {
			t.Errorf("WithServerOverrides(%q) = nil error, want a parse failure", raw)
		}
	}

	// A value that is not an object, or a string where a rate belongs, is
	// rejected rather than silently dropped.
	if _, err := corpus.WithOverrides(map[string]any{"gpt-5.6": 1e-6}); err == nil {
		t.Error("a non-object override value must be an error")
	}
	if _, err := corpus.WithOverrides(map[string]any{
		"gpt-5.6": map[string]any{"inputCostPerToken": "cheap"},
	}); err == nil {
		t.Error("a non-numeric rate must be an error")
	}
	if _, err := corpus.WithOverrides(map[string]any{
		"gpt-5.6": map[string]any{"maxInputTokens": 1.5},
	}); err == nil {
		t.Error("a fractional maxInputTokens must be an error")
	}
	if _, err := corpus.WithOverrides(map[string]any{
		"gpt-5.6": map[string]any{"maxInputTokens": -1},
	}); err == nil {
		t.Error("a negative maxInputTokens must be an error")
	}
}

// TestWithServerOverrides_readsTheConfigShapes pins the payload shapes the Go
// client can be handed: the generated ccusage config, a bare
// {"pricingOverrides": …} envelope, and the override map itself.
func TestWithServerOverrides_readsTheConfigShapes(t *testing.T) {
	corpus := overrideCorpus()
	for name, raw := range map[string]string{
		"ccusage config":    `{"$schema":"https://ccusage.com/config-schema.json","codex":{"defaults":{"speed":"auto"}},"defaults":{"pricingOverrides":{"claude-explicit":{"inputCostPerToken":1e-6}}}}`,
		"envelope":          `{"pricingOverrides":{"claude-explicit":{"inputCostPerToken":1e-6}},"cursor":"p2"}`,
		"bare override map": `{"claude-explicit":{"inputCostPerToken":1e-6}}`,
	} {
		updated, err := corpus.WithServerOverrides([]byte(raw))
		if err != nil {
			t.Fatalf("%s: WithServerOverrides: %v", name, err)
		}
		approx(t, updated.Models["claude-explicit"].Input, 1e-6, name+" input")
	}

	for name, raw := range map[string]string{
		"config without a defaults section": `{"$schema":"https://ccusage.com/config-schema.json"}`,
		"config without overrides":          `{"defaults":{"speed":"auto"}}`,
		"empty object":                      `{}`,
		"null overrides":                    `{"pricingOverrides":null}`,
	} {
		updated, err := corpus.WithServerOverrides([]byte(raw))
		if err != nil {
			t.Fatalf("%s: WithServerOverrides: %v", name, err)
		}
		if !reflect.DeepEqual(updated, corpus) {
			t.Fatalf("%s: expected an unchanged corpus", name)
		}
	}
}

// TestWithOverrides_doesNotMutateTheReceiver pins purity: the caller keeps its
// Corpus and every map it owns.
func TestWithOverrides_doesNotMutateTheReceiver(t *testing.T) {
	corpus := overrideCorpus()
	snapshot := overrideCorpus()

	updated := mustOverride(t, corpus, map[string]any{
		"claude-derived": map[string]any{"inputCostPerToken": 1.5e-6, "maxInputTokens": 42},
		"brand-new":      map[string]any{"inputCostPerToken": 1e-9, "outputCostPerToken": 2e-9},
	})

	if !reflect.DeepEqual(corpus, snapshot) {
		t.Fatalf("the receiver changed:\ngot  %+v\nwant %+v", corpus, snapshot)
	}
	// Mutating the returned corpus must not reach back either.
	entry := updated.Models["claude-derived"]
	entry.Input = 99
	updated.Models["claude-derived"] = entry
	updated.ContextLimits["claude-derived"] = 7
	if got := corpus.Models["claude-derived"].Input; got != 3e-6 {
		t.Fatalf("the returned Models map shares storage with the receiver: input = %v", got)
	}
	if got := corpus.ContextLimits["claude-derived"]; got != 1_000_000 {
		t.Fatalf("the returned ContextLimits map shares storage with the receiver: %d", got)
	}

	// The band pointers are the case maps.Clone cannot fix: replacing a map entry
	// hides a shared pointer, so this writes THROUGH the pointer the returned
	// corpus owns and checks the receiver's value did not move.
	tiered := updated.Models["gpt-tiered"]
	*tiered.OutputAbove = 777
	*tiered.LongContextThreshold = 999
	updated.Models["gpt-tiered"] = tiered
	if got := *corpus.Models["gpt-tiered"].OutputAbove; got != 20e-6 {
		t.Fatalf("the returned corpus shares the OutputAbove pointer with the receiver: %v", got)
	}
	if got := *corpus.Models["gpt-tiered"].LongContextThreshold; got != 200_000 {
		t.Fatalf("the returned corpus shares the LongContextThreshold pointer with the receiver: %d", got)
	}
}

// TestWithOverrides_createsNewModelsFromAnEmptyBase is ccusage's
// `full_override_creates_new_model`: a model no table prices is billed entirely
// from the override, with every derived cache rate at zero.
func TestWithOverrides_createsNewModelsFromAnEmptyBase(t *testing.T) {
	corpus := overrideCorpus()
	updated := mustOverride(t, corpus, map[string]any{
		"brand-new": map[string]any{
			"inputCostPerToken":  1e-6,
			"outputCostPerToken": 2e-6,
			"fastMultiplier":     2.0,
		},
	})

	entry, ok := updated.Models["brand-new"]
	if !ok {
		t.Fatal("an override for an unpriced model must insert it")
	}
	approx(t, entry.Input, 1e-6, "input")
	approx(t, entry.Output, 2e-6, "output")
	if entry.CacheCreate != 0 || entry.CacheRead != 0 {
		t.Fatalf("Pricing::empty has zero cache rates, got %+v", entry)
	}
	if entry.CacheReadExplicit || entry.CacheCreateExplicit {
		t.Fatal("an override without cache rates is not explicit")
	}
	approx(t, entry.FastMultiplier, 2, "fastMultiplier")
	// Pricing::empty bills flex at 1, not 0: a zero would erase the cost.
	approx(t, entry.FlexMultiplier, 1, "flexMultiplier falls back to 1")

	// A misspelled alias resolves through the hardcoded table, like
	// apply_override's or_else(pricing_alias(model)).
	aliased := mustOverride(t, corpus, map[string]any{
		"gpt-5.6": map[string]any{"inputCostPerToken": 42e-6},
	})
	aliasEntry := aliased.Models["gpt-5.6"]
	approx(t, aliasEntry.Input, 42e-6, "alias input")
	approx(t, aliasEntry.Output, 20e-6, "alias output comes from gpt-5.6-sol")
	approx(t, aliasEntry.FastMultiplier, 2, "alias fast multiplier comes from gpt-5.6-sol")
}

// TestWithOverrides_ignoresModelsDevFallbackAsTheBase is the divergence a merged
// Corpus invites. ccusage's apply_override reads self.entries, which holds the
// LiteLLM table and the builtin rows only; the embedded models.dev snapshot is a
// separate PricingMap, so an override for a models.dev-only id starts from
// Pricing::empty. Verified against ccusage 20.0.33: overriding grok-4.5 (a
// models.dev-only id, base input 2e-6, cache_read 3e-7) with
// `{"inputCostPerToken":1e-6}` and one million tokens per bucket bills exactly
// 1.0 - the input bucket alone - while the models.dev-derived base would have
// produced a cache-read charge too.
func TestWithOverrides_ignoresModelsDevFallbackAsTheBase(t *testing.T) {
	corpus := overrideCorpus()
	updated := mustOverride(t, corpus, map[string]any{
		"md-only": map[string]any{
			"inputCostPerToken":  5e-6,
			"outputCostPerToken": 1e-5,
		},
	})

	entry := updated.Models["md-only"]
	approx(t, entry.Input, 5e-6, "input")
	approx(t, entry.Output, 1e-5, "output")
	if entry.CacheCreate != 0 {
		t.Fatalf("cache create = %v, want 0: ccusage derives it from an empty base, not the models.dev row", entry.CacheCreate)
	}
	if entry.CacheRead != 0 {
		t.Fatalf("cache read = %v, want 0: ccusage derives it from an empty base, not the models.dev row", entry.CacheRead)
	}
	// apply_override writes the result back with self.entries.insert, so the
	// rewritten entry joins the primary table and stops being a models.dev
	// fallback. That is what makes a lookup find the override ahead of the
	// primary fuzzy match ccusage would otherwise bill - verified live: an
	// output-only override on claude-opus-4-1 (models.dev-only, but with
	// anthropic.claude-opus-4-1-… rows in LiteLLM) bills the override, not the
	// fuzzy match.
	if entry.Source != SourceLiteLLM {
		t.Fatalf("an overridden entry must be promoted to the primary table, got Source=%v", entry.Source)
	}
	// The exact-only flag is a property of the name, not the rates: ccusage's
	// ExactOnlyKeys set is untouched by apply_override.
	if !entry.ExactOnly {
		t.Fatal("the exact-only flag must survive an override")
	}
	if got, ok := updated.Find("md-only"); !ok || got.Source != SourceLiteLLM {
		t.Fatalf("Find returned (%+v, %v), want the promoted override", got, ok)
	}
	// maxInputTokens is applied even though the override's base was empty.
	limited := mustOverride(t, corpus, map[string]any{
		"md-only": map[string]any{"maxInputTokens": 12_345},
	})
	if got := limited.ContextLimits["md-only"]; got != 12_345 {
		t.Fatalf("context limit = %d, want 12345", got)
	}
	if got := limited.Models["md-only"].Input; got != 0 {
		t.Fatalf("a limit-only override must leave the promoted entry's rates at zero, got input %v", got)
	}
}
