package nativepricing

import "testing"

// stagedCorpus builds a two-table corpus by hand: a primary table (LiteLLM and
// builtins) and a models.dev table. The vendored snapshot moves with every
// ccusage release, so the lookup rules are pinned against a corpus the test
// owns; the shipped snapshot is used only for the cases that are about the real
// data.
//
// Like loadCorpus, a models.dev key the primary table already prices keeps the
// primary entry, and every models.dev exact-only id lands in ExactOnlyNames.
func stagedCorpus(primary, modelsDev map[string]CorpusModel) Corpus {
	models := make(map[string]CorpusModel, len(primary)+len(modelsDev))
	exactOnlyNames := map[string]bool{}
	for model, pricing := range primary {
		models[model] = pricing
	}
	for model, pricing := range modelsDev {
		if pricing.ExactOnly {
			exactOnlyNames[normalizePricingKey(model)] = true
		}
		if _, taken := models[model]; taken {
			continue
		}
		pricing.Source = SourceModelsDev
		models[model] = pricing
	}
	return Corpus{Models: models, ExactOnlyNames: exactOnlyNames}
}

func mustFind(t *testing.T, corpus Corpus, model string) CorpusModel {
	t.Helper()
	pricing, ok := corpus.Find(model)
	if !ok {
		t.Fatalf("Find(%q) missed, want a priced model", model)
	}
	return pricing
}

func TestFind_prefersAnExactMatch(t *testing.T) {
	corpus := stagedCorpus(map[string]CorpusModel{
		"gpt-5":      {Input: 1e-6},
		"gpt-5-mini": {Input: 2.5e-7},
	}, nil)

	// "gpt-5-mini" is a longer key that also matches "gpt-5" as a prefix, so a
	// lookup that scans by length alone bills the request at the mini rate.
	if got := mustFind(t, corpus, "gpt-5"); got.Input != 1e-6 {
		t.Errorf("Find(%q).Input = %v, want the exact key's 1e-6", "gpt-5", got.Input)
	}
	if got := mustFind(t, corpus, "gpt-5-mini"); got.Input != 2.5e-7 {
		t.Errorf("Find(%q).Input = %v, want 2.5e-7", "gpt-5-mini", got.Input)
	}
}

func TestFind_normalizesDotsAndAtOnly(t *testing.T) {
	corpus := stagedCorpus(map[string]CorpusModel{"v-v2-x": {Input: 1}}, nil)
	for _, spelling := range []string{"v-v2-x", "v.v2@x", "v.v2-x", "v-v2@x", "v@v2-x"} {
		if _, ok := corpus.Find(spelling); !ok {
			t.Errorf("Find(%q) missed, want the v-v2-x entry", spelling)
		}
	}

	// '/' and '_' are meaningful separators, not '.'/'@' spellings.
	slashed := stagedCorpus(map[string]CorpusModel{"v/v2_x": {Input: 1}}, nil)
	if _, ok := slashed.Find("v/v2_x"); !ok {
		t.Fatal("Find(\"v/v2_x\") missed, want an exact hit")
	}
	for _, spelling := range []string{"v/v2.x", "v-v2_x", "v.v2_x", "v/v2@x"} {
		if _, ok := slashed.Find(spelling); ok {
			t.Errorf("Find(%q) hit, want a miss: '/' and '_' do not normalize", spelling)
		}
	}
}

func TestFind_doesNotFoldAVersionSuffix(t *testing.T) {
	corpus := stagedCorpus(map[string]CorpusModel{"gpt-5": {Input: 1}}, nil)

	// A numeric continuation is a different model, not a spelling of this one.
	// This is the suffix rule that keeps a newer release from inheriting the
	// older model's rate (pricing.rs:2703).
	for _, model := range []string{"gpt-5.5", "gpt-5-5", "gpt-5-2", "gpt-5.10"} {
		if pricing, ok := corpus.Find(model); ok {
			t.Errorf("Find(%q) = %v, want a miss", model, pricing.Input)
		}
	}
	// A non-numeric suffix on a boundary is still a match.
	if _, ok := corpus.Find("gpt-5-preview"); !ok {
		t.Error("Find(\"gpt-5-preview\") missed, want the gpt-5 entry")
	}
	// A non-boundary suffix is not.
	if _, ok := corpus.Find("gpt-5x"); ok {
		t.Error("Find(\"gpt-5x\") hit, want a miss: 'x' is not a key boundary")
	}
}

func TestFind_allowsAnEightDigitDateSuffix(t *testing.T) {
	corpus := stagedCorpus(map[string]CorpusModel{"gpt-5": {Input: 1}}, nil)

	// MODEL_DATE_SUFFIX_DIGITS: exactly 8 trailing digits after a separator is
	// a release date, so a date-pinned request shares the base model's rate.
	for _, model := range []string{"gpt-5-20250514", "gpt-5.20250514"} {
		if _, ok := corpus.Find(model); !ok {
			t.Errorf("Find(%q) missed, want the gpt-5 entry", model)
		}
	}
	// 7 or 9 digits are versions, not dates.
	for _, model := range []string{"gpt-5-2025051", "gpt-5-202505141"} {
		if pricing, ok := corpus.Find(model); ok {
			t.Errorf("Find(%q) = %v, want a miss", model, pricing.Input)
		}
	}
}

func TestFind_exactOnlyModelsAreNotPrefixMatched(t *testing.T) {
	corpus := stagedCorpus(
		map[string]CorpusModel{"claude-opus-5": {Input: 5e-6}},
		map[string]CorpusModel{"claude-opus-5@fast": {Input: 10e-6, ExactOnly: true}},
	)

	// The catalog spelling and a separator spelling of the same id both name the
	// tier, not the base model.
	for _, model := range []string{"claude-opus-5@fast", "claude-opus-5-fast", "claude-opus-5.fast"} {
		if got := mustFind(t, corpus, model); got.Input != 10e-6 {
			t.Errorf("Find(%q).Input = %v, want the exact-only tier's 10e-6", model, got.Input)
		}
	}

	// A request that only prefix-matches the tier does not get it: the fuzzy
	// scan never returns an exact-only candidate. Here the primary table has
	// nothing to answer with, so the lookup misses rather than billing 10e-6.
	tierOnly := stagedCorpus(nil, map[string]CorpusModel{
		"claude-opus-5@fast": {Input: 10e-6, ExactOnly: true},
	})
	if pricing, ok := tierOnly.Find("claude-opus-5-fast-preview"); ok {
		t.Errorf("Find(%q) = %v, want a miss: exact-only ids are not fuzzy candidates",
			"claude-opus-5-fast-preview", pricing.Input)
	}
}

func TestFind_isCaseSensitive(t *testing.T) {
	corpus := stagedCorpus(map[string]CorpusModel{"gpt-5": {Input: 1e-6}}, nil)
	for _, model := range []string{"GPT-5", "Gpt-5"} {
		if _, ok := corpus.Find(model); ok {
			t.Errorf("Find(%q) hit, want a miss: the lookup does not fold case", model)
		}
	}
}

func TestFind_resolvesHardcodedAliases(t *testing.T) {
	// An exact entry for the alias itself still wins.
	exact := stagedCorpus(map[string]CorpusModel{
		"gpt-5.6":     {Input: 1e-6},
		"gpt-5.6-sol": {Input: 2e-6},
	}, nil)
	if got := mustFind(t, exact, "gpt-5.6"); got.Input != 1e-6 {
		t.Errorf("Find(\"gpt-5.6\").Input = %v, want the original model's 1e-6", got.Input)
	}

	// Otherwise pricing_alias points at the canonical key.
	aliased := stagedCorpus(map[string]CorpusModel{"gpt-5.6-sol": {Input: 2e-6}}, nil)
	if got := mustFind(t, aliased, "gpt-5.6"); got.Input != 2e-6 {
		t.Errorf("Find(\"gpt-5.6\").Input = %v, want the alias target's 2e-6", got.Input)
	}

	corpus := mustLoadCorpus(t)
	for alias, target := range map[string]string{
		"gpt-reserve":   "gpt-5.6-luna",
		"gpt-5.3-spark": "gpt-5.3-codex-spark",
	} {
		want := mustFind(t, corpus, target)
		if got := mustFind(t, corpus, alias); got.Input != want.Input || got.Output != want.Output {
			t.Errorf("Find(%q) = %v/%v, want the %q rates %v/%v",
				alias, got.Input, got.Output, target, want.Input, want.Output)
		}
	}
}

func TestFind_stripsDateSuffixBeforeTierLookup(t *testing.T) {
	corpus := mustLoadCorpus(t)

	// A dated request shares the undated model's rates, which is what
	// modelWithoutDateSuffix exists for on the long-context and multiplier side.
	for _, pair := range [][2]string{
		{"claude-sonnet-4-6", "claude-sonnet-4.6-20260416"},
		{"claude-opus-4-8", "claude-opus-4-8-20270898"},
	} {
		base := mustFind(t, corpus, pair[0])
		dated := mustFind(t, corpus, pair[1])
		if dated.Input != base.Input || dated.Output != base.Output {
			t.Errorf("Find(%q) = %v/%v, want the %q rates %v/%v",
				pair[1], dated.Input, dated.Output, pair[0], base.Input, base.Output)
		}
	}
}

func TestFind_primaryFuzzyBeatsModelsDevExact(t *testing.T) {
	corpus := mustLoadCorpus(t)

	// "databricks-gpt-5-6-luna" is a models.dev key listed at $1/M input, and the
	// primary table has no such key. ccusage still answers from the primary
	// table's fuzzy match on gpt-5.6-luna ($0.2/M), because the models.dev table
	// is only consulted once the primary table misses entirely.
	got := mustFind(t, corpus, "databricks-gpt-5-6-luna")
	if got.Input != 2e-7 {
		t.Errorf("Find(\"databricks-gpt-5-6-luna\").Input = %v, want the primary fuzzy match's 2e-7", got.Input)
	}
	if got.Source != SourceLiteLLM {
		t.Errorf("Find(\"databricks-gpt-5-6-luna\").Source = %v, want SourceLiteLLM", got.Source)
	}
	if exact := corpus.Models["databricks-gpt-5-6-luna"]; exact.Input != 1e-6 {
		t.Fatalf("fixture drift: the models.dev row for databricks-gpt-5-6-luna is %v, want 1e-6", exact.Input)
	}

	// Same shape through an alias: the models.dev row for the exact spelling is
	// $8/M, the primary table's claude-opus-5-5 is $4/M.
	opus := mustFind(t, corpus, "anthropic/claude-opus-5.5-fast")
	if opus.Input != 4e-6 {
		t.Errorf("Find(\"anthropic/claude-opus-5.5-fast\").Input = %v, want 4e-6", opus.Input)
	}
	if opus.Source != SourceLiteLLM {
		t.Errorf("Find(\"anthropic/claude-opus-5.5-fast\").Source = %v, want SourceLiteLLM", opus.Source)
	}
}

func TestFind_modelsDevOnlyReachedAfterPrimaryMisses(t *testing.T) {
	// The models.dev table answers keys the primary table has no match for at
	// all, including one the primary table's fuzzy scan finds nothing like.
	corpus := stagedCorpus(
		map[string]CorpusModel{"alpha-1": {Input: 1e-6}},
		map[string]CorpusModel{"beta-2": {Input: 2e-6}},
	)
	if got := mustFind(t, corpus, "beta-2"); got.Input != 2e-6 || got.Source != SourceModelsDev {
		t.Errorf("Find(\"beta-2\") = %v from source %v, want 2e-6 from the models.dev table", got.Input, got.Source)
	}
	if got := mustFind(t, corpus, "alpha-1"); got.Source != SourceLiteLLM {
		t.Errorf("Find(\"alpha-1\").Source = %v, want SourceLiteLLM", got.Source)
	}

	shipped := mustLoadCorpus(t)
	// A models.dev-only tier that the primary table cannot fuzzy-match: the
	// exact-only regional alias is reachable, and it comes from models.dev.
	regional := mustFind(t, shipped, "claude-opus-5@eu")
	if regional.Source != SourceModelsDev {
		t.Errorf("Find(\"claude-opus-5@eu\").Source = %v, want SourceModelsDev", regional.Source)
	}
}

func TestFind_resolvesSeparatorSpellingsOfExactOnlyIDs(t *testing.T) {
	corpus := mustLoadCorpus(t)
	canonical := mustFind(t, corpus, "claude-opus-5@eu")
	for _, spelling := range []string{"claude-opus-5-eu", "claude-opus-5.eu"} {
		got := mustFind(t, corpus, spelling)
		if got.Input != canonical.Input || got.Output != canonical.Output {
			t.Errorf("Find(%q) = %v/%v, want the exact-only id's %v/%v",
				spelling, got.Input, got.Output, canonical.Input, canonical.Output)
		}
	}
}

func TestFind_resolvesDottedSpellingsOfDashedModels(t *testing.T) {
	corpus := mustLoadCorpus(t)
	for _, pair := range [][2]string{
		{"claude-haiku-4-5", "claude-haiku-4.5"},
		{"claude-opus-5-5", "claude-opus-5.5"},
	} {
		want := mustFind(t, corpus, pair[0])
		got := mustFind(t, corpus, pair[1])
		if got.Input != want.Input || got.Output != want.Output {
			t.Errorf("Find(%q) = %v/%v, want the %q rates %v/%v",
				pair[1], got.Input, got.Output, pair[0], want.Input, want.Output)
		}
	}
}

func TestFind_requiresModelKeyBoundaries(t *testing.T) {
	corpus := stagedCorpus(map[string]CorpusModel{
		"claude-opus-4-7": {Input: 5e-6},
		"claude-opus-4":   {Input: 15e-6},
	}, nil)

	if got := mustFind(t, corpus, "claude-opus-4-7-preview"); got.Input != 5e-6 {
		t.Errorf("Find(\"claude-opus-4-7-preview\").Input = %v, want 5e-6", got.Input)
	}
	if got := mustFind(t, corpus, "claude-opus-4-20250514"); got.Input != 15e-6 {
		t.Errorf("Find(\"claude-opus-4-20250514\").Input = %v, want 15e-6", got.Input)
	}
	for _, model := range []string{"claude-opus-4.70", "claude-opus-4-70", "claude-opus-4.8-20260528", "claude-opus-4x"} {
		if pricing, ok := corpus.Find(model); ok {
			t.Errorf("Find(%q) = %v, want a miss", model, pricing.Input)
		}
	}
}

func TestFind_breaksALengthTieTowardsTheSmallerKey(t *testing.T) {
	// ccusage's comparator is left.len().cmp(&right.len())
	// .then_with(|| right.cmp(left)), so the length dominates and an equal
	// length falls back to the inverted string order: the lexicographically
	// smaller key is the maximum. Two same-length candidates matching one
	// request is not hypothetical - the shipped snapshot does it for
	// Qwen/Qwen3-5-397B-A17B, where the dashed and dotted spellings tie.
	corpus := stagedCorpus(map[string]CorpusModel{
		"aaa-tail": {Input: 1e-6},
		"zzz-tail": {Input: 2e-6},
	}, nil)

	if got := mustFind(t, corpus, "model-aaa-tail-zzz-tail"); got.Input != 1e-6 {
		t.Errorf("tied candidates resolved to %v, want the smaller key's 1e-6", got.Input)
	}
}

func TestFind_missesWhatNothingPrices(t *testing.T) {
	corpus := mustLoadCorpus(t)
	for _, model := range []string{"totally-unknown-model", "claude-opus-5x"} {
		if pricing, ok := corpus.Find(model); ok {
			t.Errorf("Find(%q) = %v, want a miss", model, pricing.Input)
		}
	}
}

func TestFind_followsTheEmptyNameRule(t *testing.T) {
	// The boundary test is asked with "" as the key, so an id that starts with a
	// separator matches an empty request while a plain id does not. ccusage has
	// no special case for an empty model name either, and pinning that here
	// keeps a well-meaning guard from silently changing the answer.
	plain := stagedCorpus(map[string]CorpusModel{"gpt-5": {Input: 1}}, nil)
	if pricing, ok := plain.Find(""); ok {
		t.Errorf(`Find("") = %v, want a miss for a corpus of plain ids`, pricing.Input)
	}
	bare := stagedCorpus(map[string]CorpusModel{"@cf/mistralai/model": {Input: 1}}, nil)
	if _, ok := bare.Find(""); !ok {
		t.Error(`Find("") missed, want the separator-prefixed id: a leading '@' is a boundary`)
	}
	// A trailing byte that is not alphanumeric is a boundary too.
	trailing := stagedCorpus(map[string]CorpusModel{"gpt-5": {Input: 1}}, nil)
	if _, ok := trailing.Find("gpt-5 "); !ok {
		t.Error(`Find("gpt-5 ") missed, want the gpt-5 entry: a space is a boundary`)
	}
}
