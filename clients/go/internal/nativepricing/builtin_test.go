package nativepricing

import (
	"testing"
)

// testMultipliers loads the embedded service-tier override files that the
// builtin rows with override-driven multipliers resolve against.
func testMultipliers(t *testing.T) (multiplierOverrides, multiplierOverrides) {
	t.Helper()
	fast, err := readMultiplierOverrides(embeddedCorpus, fastMultipliersFile)
	if err != nil {
		t.Fatalf("read %s: %v", fastMultipliersFile, err)
	}
	flex, err := readMultiplierOverrides(embeddedCorpus, flexMultipliersFile)
	if err != nil {
		t.Fatalf("read %s: %v", flexMultipliersFile, err)
	}
	return fast, flex
}

func builtinRow(t *testing.T, model string) builtinEntry {
	t.Helper()
	for _, entry := range builtinTable {
		if entry.model == model {
			return entry
		}
	}
	t.Fatalf("%s is missing from the builtin table", model)
	return builtinEntry{}
}

func TestBuiltinTable_transcribesEveryCcusageRow(t *testing.T) {
	// put_builtin_pricing (rust/crates/ccusage-core/src/pricing.rs:2015-2560)
	// writes 42 ids: the thirteen claude ids, the OpenAI ones, grok-4.3, the two
	// moonshot rows and the z.ai glm rows. The design doc says "about 37"; 42 is
	// what the source actually writes.
	if got, want := len(builtinTable), 42; got != want {
		t.Fatalf("builtinTable has %d rows, want %d", got, want)
	}
	fast, flex := testMultipliers(t)
	rows := make(map[string]CorpusModel, len(builtinTable))
	for _, entry := range builtinTable {
		if _, duplicate := rows[entry.model]; duplicate {
			t.Fatalf("%s appears twice in the builtin table", entry.model)
		}
		rows[entry.model] = entry.pricing(fast, flex)
	}

	for model, want := range map[string]CorpusModel{
		"claude-3-haiku":     {Input: 0.25e-6, Output: 1.25e-6, CacheCreate: 0.3e-6, CacheRead: 0.03e-6},
		"gpt-5.4-mini":       {Input: 0.75e-6, Output: 4.5e-6, CacheCreate: 0.75e-6, CacheRead: 0.075e-6},
		"gpt-5.6-terra":      {Input: 2.5e-6, Output: 15e-6, CacheCreate: 3.125e-6, CacheRead: 0.25e-6},
		"moonshot/kimi-k2.5": {Input: 0.6e-6, Output: 3e-6, CacheCreate: 0.75e-6, CacheRead: 0.1e-6},
		"glm-5":              {Input: 1e-6, Output: 3.2e-6, CacheCreate: 0, CacheRead: 0.2e-6},
		"glm-5-turbo":        {Input: 1.2e-6, Output: 4e-6, CacheCreate: 0, CacheRead: 0.24e-6},
		"glm-5.1":            {Input: 1.4e-6, Output: 4.4e-6, CacheCreate: 0, CacheRead: 0.26e-6},
	} {
		got, ok := rows[model]
		if !ok {
			t.Fatalf("%s is missing from the builtin table", model)
		}
		approx(t, got.Input, want.Input, model+" input")
		approx(t, got.Output, want.Output, model+" output")
		approx(t, got.CacheCreate, want.CacheCreate, model+" cache create")
		approx(t, got.CacheRead, want.CacheRead, model+" cache read")
		if got.Source != SourceBuiltin {
			t.Errorf("%s Source = %v, want SourceBuiltin", model, got.Source)
		}
	}

	// Only claude-sonnet-4 publishes the above-threshold bands.
	sonnet := rows["claude-sonnet-4"]
	for _, band := range []struct {
		got, want *float64
		what      string
	}{
		{sonnet.InputAbove, floatValue(6e-6), "input"},
		{sonnet.OutputAbove, floatValue(22.5e-6), "output"},
		{sonnet.CacheCreateAbove, floatValue(7.5e-6), "cache create"},
		{sonnet.CacheReadAbove, floatValue(0.6e-6), "cache read"},
	} {
		if band.got == nil || band.want == nil || *band.got != *band.want {
			t.Errorf("claude-sonnet-4 above %s = %v, want %v", band.what, band.got, band.want)
		}
	}
	if rows["gpt-5.4"].InputAbove != nil {
		t.Error("only claude-sonnet-4 carries a builtin above band")
	}
	if rows["claude-sonnet-4"].LongContextThreshold != nil {
		t.Error("a builtin row publishes no tier threshold of its own")
	}

	// grok-4.3 is the one row whose cache rates are derived rather than
	// published: a user override of its input rate scales them.
	grok := rows["grok-4.3"]
	if grok.CacheCreateExplicit || grok.CacheReadExplicit {
		t.Error("grok-4.3's builtin cache rates are derived, not published")
	}
	if !rows["gpt-5.4-nano"].CacheCreateExplicit || !rows["gpt-5.4-nano"].CacheReadExplicit {
		t.Error("gpt-5.4-nano publishes both cache rates")
	}

	// Service tiers: ccusage hardcodes 1.0 for most rows and consults the
	// override files for the ones noted below.
	for model, want := range map[string]struct{ fast, flex float64 }{
		"gpt-5.4":         {fast: 2, flex: 0.5},
		"gpt-5.3-codex":   {fast: 2, flex: 1},
		"claude-opus-4-6": {fast: 6, flex: 1},
		"claude-opus-4-8": {fast: 2, flex: 1},
		"gpt-5":           {fast: 1, flex: 0.5},
		"gpt-5.2":         {fast: 1, flex: 0.5},
		"claude-opus-4":   {fast: 1, flex: 1},
		"grok-4.3":        {fast: 1, flex: 1},
		"gpt-5.1-codex":   {fast: 1, flex: 1},
	} {
		approx(t, rows[model].FastMultiplier, want.fast, model+" fast multiplier")
		approx(t, rows[model].FlexMultiplier, want.flex, model+" flex multiplier")
	}

	// Insert strategy: put_builtin_entry only fills a gap, the three direct
	// entries.insert rows replace what is there, and put_builtin_glm patches.
	for model, want := range map[string]builtinInsert{
		"gpt-5.6-sol":   builtinFillMissing,
		"gpt-5.3-codex": builtinFillMissing,
		"gpt-5.1-codex": builtinOverwrite,
		"gpt-5.2-codex": builtinOverwrite,
		"gpt-5.2":       builtinOverwrite,
		"glm-4.5":       builtinPatchCache,
		"glm-4.7":       builtinPatchCache,
		"glm-5":         builtinFillMissing,
	} {
		if got := builtinRow(t, model).mode; got != want {
			t.Errorf("%s insert mode = %v, want %v", model, got, want)
		}
	}
}

func TestApplyBuiltins_fillsOnlyThePrimaryTable(t *testing.T) {
	fast, flex := testMultipliers(t)
	models := map[string]CorpusModel{
		// LiteLLM already prices this one, so put_builtin_entry leaves it alone
		// even though the builtin rate is higher (upstream data wins).
		"gpt-5.6-sol": {
			Input: 4e-6, Output: 2e-5, CacheCreate: 5e-6, CacheRead: 4e-7,
			CacheCreateExplicit: true, CacheReadExplicit: true,
			FastMultiplier: 1, FlexMultiplier: 1, Source: SourceLiteLLM,
		},
		// ccusage keeps models.dev in a separate map, so a models.dev row is a
		// gap the primary-stage builtin fills.
		"grok-4.3": {
			Input: 1.25e-6, Output: 2.5e-6, CacheRead: 0.2e-6,
			FastMultiplier: 1, FlexMultiplier: 1, Source: SourceModelsDev,
		},
		// The direct entries.insert rows overwrite even a primary row.
		"gpt-5.2": {
			Input: 1.75e-6, Output: 1.4e-5, CacheRead: 1.75e-7,
			CacheReadExplicit: true, FastMultiplier: 1, FlexMultiplier: 1, Source: SourceLiteLLM,
		},
	}
	applyBuiltins(models, fast, flex)

	if got := models["gpt-5.6-sol"]; !sameBits(got.Input, 4e-6) || !sameBits(got.Output, 2e-5) || !sameBits(got.CacheCreate, 5e-6) {
		t.Fatalf("gpt-5.6-sol = %+v, want the snapshot's rates untouched", got)
	}
	if got := models["gpt-5.6-sol"]; got.Source != SourceLiteLLM {
		t.Fatalf("gpt-5.6-sol Source = %v, want SourceLiteLLM", got.Source)
	}

	grok := models["grok-4.3"]
	if grok.Source != SourceBuiltin {
		t.Fatalf("grok-4.3 Source = %v, want SourceBuiltin", grok.Source)
	}
	approx(t, grok.CacheRead, 0.125e-6, "grok-4.3 builtin cache read")
	approx(t, grok.CacheCreate, 1.25e-6, "grok-4.3 builtin cache create")
	if grok.CacheReadExplicit || grok.CacheCreateExplicit {
		t.Error("grok-4.3's builtin cache rates are the derived ones")
	}

	gpt52 := models["gpt-5.2"]
	if gpt52.Source != SourceBuiltin {
		t.Fatalf("gpt-5.2 Source = %v, want SourceBuiltin", gpt52.Source)
	}
	approx(t, gpt52.CacheCreate, 1.75e-6, "the direct insert replaces the derived cache-create rate")
	if !gpt52.CacheCreateExplicit || !gpt52.CacheReadExplicit {
		t.Error("the direct insert publishes both cache rates")
	}
	approx(t, gpt52.FlexMultiplier, 0.5, "gpt-5.2 flex comes from the override file")

	// A row no snapshot prices is added outright.
	haiku := models["claude-3-haiku"]
	if haiku.Source != SourceBuiltin {
		t.Fatalf("claude-3-haiku Source = %v, want SourceBuiltin", haiku.Source)
	}
	approx(t, haiku.Input, 0.25e-6, "claude-3-haiku input")

	// So is an only-if-missing row, with its override-driven multipliers.
	if _, ok := models["gpt-5.3-codex"]; !ok {
		t.Fatal("gpt-5.3-codex was not inserted")
	}
	approx(t, models["gpt-5.3-codex"].FastMultiplier, 2, "gpt-5.3-codex fast")
	approx(t, models["gpt-5.5"].FastMultiplier, 2.5, "gpt-5.5 fast")
	approx(t, models["gpt-5.5"].FlexMultiplier, 0.5, "gpt-5.5 flex")
}

func TestApplyBuiltins_patchesOnlyDerivedGlmCacheRates(t *testing.T) {
	fast, flex := testMultipliers(t)
	models := map[string]CorpusModel{
		// LiteLLM publishes only the base rates for this id, so both cache
		// fields are derived and the z.ai facts may fill them in.
		"glm-4.5": {
			Input: 6e-7, Output: 2.2e-6, CacheCreate: 7.5e-7, CacheRead: 6e-8,
			FastMultiplier: 1, FlexMultiplier: 1, Source: SourceLiteLLM,
		},
		// A snapshot that published them keeps them.
		"glm-4.6": {
			Input: 6e-7, Output: 2.2e-6, CacheCreate: 1e-6, CacheRead: 3e-7,
			CacheCreateExplicit: true, CacheReadExplicit: true,
			FastMultiplier: 1, FlexMultiplier: 1, Source: SourceLiteLLM,
		},
	}
	applyBuiltins(models, fast, flex)

	patched := models["glm-4.5"]
	if patched.Source != SourceLiteLLM {
		t.Fatalf("patching cache fields moved the row between stages: %v", patched.Source)
	}
	approx(t, patched.Input, 6e-7, "the base rates stay the snapshot's")
	approx(t, patched.Output, 2.2e-6, "the base rates stay the snapshot's")
	approx(t, patched.CacheCreate, 0, "z.ai bills no cache writes")
	approx(t, patched.CacheRead, 0.11e-6, "z.ai's cache-read rate")
	if !patched.CacheCreateExplicit || !patched.CacheReadExplicit {
		t.Error("a patched cache rate counts as published")
	}

	kept := models["glm-4.6"]
	approx(t, kept.CacheCreate, 1e-6, "an explicit cache create is left alone")
	approx(t, kept.CacheRead, 3e-7, "an explicit cache read is left alone")

	inserted := models["zai/glm-4.5-airx"]
	if inserted.Source != SourceBuiltin {
		t.Fatalf("zai/glm-4.5-airx Source = %v, want SourceBuiltin", inserted.Source)
	}
	approx(t, inserted.Input, 1.1e-6, "zai/glm-4.5-airx input")
	approx(t, inserted.Output, 4.5e-6, "zai/glm-4.5-airx output")
	approx(t, inserted.CacheRead, 0.22e-6, "zai/glm-4.5-airx cache read")
	approx(t, inserted.CacheCreate, 0, "z.ai bills no cache writes")
}

func TestBuiltins_fillTheGapsInTheEmbeddedCorpus(t *testing.T) {
	corpus := mustLoadCorpus(t)

	// Five ids no embedded snapshot prices: only the builtin table knows them.
	for model, want := range map[string][4]float64{
		"claude-3-opus":             {15e-6, 75e-6, 18.75e-6, 1.5e-6},
		"claude-3-sonnet":           {3e-6, 15e-6, 3.75e-6, 0.3e-6},
		"claude-3-haiku":            {0.25e-6, 1.25e-6, 0.3e-6, 0.03e-6},
		"claude-3-5-haiku":          {0.8e-6, 4e-6, 1e-6, 0.08e-6},
		"claude-3-5-haiku-20241022": {0.8e-6, 4e-6, 1e-6, 0.08e-6},
	} {
		entry, ok := corpus.Models[model]
		if !ok {
			t.Fatalf("%s is not priced", model)
		}
		if entry.Source != SourceBuiltin {
			t.Fatalf("%s Source = %v, want SourceBuiltin", model, entry.Source)
		}
		approx(t, entry.Input, want[0], model+" input")
		approx(t, entry.Output, want[1], model+" output")
		approx(t, entry.CacheCreate, want[2], model+" cache create")
		approx(t, entry.CacheRead, want[3], model+" cache read")
	}

	// These keys are models.dev-only, and the builtin row corrects what the
	// fallback snapshot says: models.dev prices kimi-k2.6 at 1/4.16 with a
	// 0.18 cache read, the builtin row at 0.95/4 with 1.1875/0.16.
	kimi := corpus.Models["moonshot/kimi-k2.6"]
	if kimi.Source != SourceBuiltin {
		t.Fatalf("moonshot/kimi-k2.6 Source = %v, want SourceBuiltin", kimi.Source)
	}
	approx(t, kimi.Input, 0.95e-6, "moonshot/kimi-k2.6 input")
	approx(t, kimi.Output, 4e-6, "moonshot/kimi-k2.6 output")
	approx(t, kimi.CacheCreate, 1.1875e-6, "moonshot/kimi-k2.6 cache create")
	approx(t, kimi.CacheRead, 0.16e-6, "moonshot/kimi-k2.6 cache read")

	// grok-4.3's cache rates are the builtin ones (models.dev says 0.2), and
	// they stay derived.
	grok := corpus.Models["grok-4.3"]
	if grok.Source != SourceBuiltin {
		t.Fatalf("grok-4.3 Source = %v, want SourceBuiltin", grok.Source)
	}
	approx(t, grok.CacheCreate, 1.25e-6, "grok-4.3 cache create")
	approx(t, grok.CacheRead, 0.125e-6, "grok-4.3 cache read")
	if grok.CacheCreateExplicit || grok.CacheReadExplicit {
		t.Error("grok-4.3's builtin cache rates are derived")
	}

	// The z.ai rows: a models.dev-only bare id takes the whole builtin row, and
	// a LiteLLM id only has its derived cache fields patched.
	glm := corpus.Models["glm-5"]
	if glm.Source != SourceBuiltin {
		t.Fatalf("glm-5 Source = %v, want SourceBuiltin", glm.Source)
	}
	approx(t, glm.Input, 1e-6, "glm-5 input")
	approx(t, glm.Output, 3.2e-6, "glm-5 output")
	approx(t, glm.CacheCreate, 0, "glm-5 cache create")
	approx(t, glm.CacheRead, 0.2e-6, "glm-5 cache read")

	zai := corpus.Models["zai/glm-4.5"]
	if zai.Source != SourceLiteLLM {
		t.Fatalf("zai/glm-4.5 Source = %v, want SourceLiteLLM", zai.Source)
	}
	approx(t, zai.Input, 6e-7, "zai/glm-4.5 keeps the snapshot's base rates")
	approx(t, zai.CacheCreate, 0, "zai/glm-4.5 bills no cache writes")
	approx(t, zai.CacheRead, 0.11e-6, "zai/glm-4.5 cache read")

	// A builtin never overwrites LiteLLM: gpt-5.6-sol's builtin row says
	// 5e-6/30e-6 and the snapshot's 4e-6/20e-6 wins.
	sol := corpus.Models["gpt-5.6-sol"]
	if sol.Source != SourceLiteLLM {
		t.Fatalf("gpt-5.6-sol Source = %v, want SourceLiteLLM", sol.Source)
	}
	approx(t, sol.Input, 4e-6, "gpt-5.6-sol input")
	approx(t, sol.Output, 2e-5, "gpt-5.6-sol output")

	// ...but the three direct inserts do replace a LiteLLM row: the snapshot
	// derives gpt-5.2's cache-create as 2.1875e-6, the builtin publishes
	// 1.75e-6, and the builtin is what ccusage ends up with.
	gpt52 := corpus.Models["gpt-5.2"]
	if gpt52.Source != SourceBuiltin {
		t.Fatalf("gpt-5.2 Source = %v, want SourceBuiltin", gpt52.Source)
	}
	approx(t, gpt52.CacheCreate, 1.75e-6, "gpt-5.2 cache create")
	if !gpt52.CacheCreateExplicit {
		t.Error("the direct insert publishes gpt-5.2's cache-create rate")
	}
	// gpt-5.3-codex is an only-if-missing row, so the snapshot's derived rate
	// stays: the two ids really do bill differently.
	codex := corpus.Models["gpt-5.3-codex"]
	if codex.Source != SourceLiteLLM {
		t.Fatalf("gpt-5.3-codex Source = %v, want SourceLiteLLM", codex.Source)
	}
	approx(t, codex.CacheCreate, 2.1875e-6, "gpt-5.3-codex keeps the derived cache-create rate")
	if codex.CacheCreateExplicit {
		t.Error("the snapshot derives gpt-5.3-codex's cache-create rate")
	}
}

func TestBuiltins_borrowModelsDevLongContextTiers(t *testing.T) {
	corpus := mustLoadCorpus(t)

	// grok-4.3's builtin row supersedes the models.dev row, yet it still takes
	// that row's 200k band: the graft pass runs over the primary table, which is
	// exactly where a builtin lands.
	grok := corpus.Models["grok-4.3"]
	if grok.Source != SourceBuiltin {
		t.Fatalf("grok-4.3 Source = %v, want SourceBuiltin", grok.Source)
	}
	if grok.LongContextThreshold == nil || *grok.LongContextThreshold != 200_000 {
		t.Fatalf("grok-4.3 threshold = %v, want 200000", grok.LongContextThreshold)
	}
	approx(t, *grok.InputAbove, 2.5e-6, "grok-4.3 above input")
	approx(t, *grok.OutputAbove, 5e-6, "grok-4.3 above output")
	approx(t, *grok.CacheReadAbove, 0.4e-6, "grok-4.3 above cache read")
	if grok.CacheCreateAbove != nil {
		t.Fatal("models.dev publishes no cache-write band for grok-4.3")
	}

	// claude-sonnet-4 publishes above rates of its own, so the graft leaves it
	// alone and its long-context switch is the marginal default rather than
	// models.dev's whole-request 200k tier.
	sonnet := corpus.Models["claude-sonnet-4"]
	if sonnet.Source != SourceBuiltin {
		t.Fatalf("claude-sonnet-4 Source = %v, want SourceBuiltin", sonnet.Source)
	}
	if sonnet.LongContextThreshold != nil {
		t.Fatalf("claude-sonnet-4 threshold = %v, want none", *sonnet.LongContextThreshold)
	}
	want := 200_000*3e-6 + 50_000*6e-6
	approx(t, CostFromPricing(Usage{Input: 250_000}, sonnet, false), want, "claude-sonnet-4 bills marginally")
}
