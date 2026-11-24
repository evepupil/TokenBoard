package nativepricing

// find_exact / find_exact_with_fallback (pricing.rs:1484-1548). The tool
// adapters (hermes's provider-prefixed candidates, kilo's provider candidate,
// openclaw's display-name key) need a lookup that never falls back to fuzzy
// matching: a fuzzy hit here would price a bare `gpt-5` request from a much
// longer key and diverge from ccusage.

import "testing"

func exactTestCorpus() Corpus {
	return Corpus{Models: map[string]CorpusModel{
		"claude-opus-5@eu":     {Input: 1},
		"deepseek/deepseek.v4": {Input: 2},
		"a.b":                  {Input: 3},
		"a-b":                  {Input: 4},
		"gpt-5":                {Input: 5},
		"gpt-5-mini":           {Input: 6},
	}}
}

// TestFindExactReadsThePrimaryMapOnly pins PricingMap::find_exact's receiver
// (pricing.rs:1484-1486): the embedded models.dev snapshot is a separate map,
// so a key only it prices is not an exact hit. kilo gates its
// provider-qualified candidate on this call (parser.rs:243-258) and openclaw
// its decorated display name (parser.rs:382); a models.dev key answering here
// would put a candidate in the chain ccusage never adds, and the row would
// bill at a different rate.
func TestFindExactReadsThePrimaryMapOnly(t *testing.T) {
	corpus := Corpus{Models: map[string]CorpusModel{
		"deepinfra/inkling": {Input: 9.5e-7, Source: SourceModelsDev},
		"inkling":           {Input: 1.0888e-6, Source: SourceModelsDev},
		"gpt-5":             {Input: 5, Source: SourceLiteLLM},
	}}
	if _, ok := corpus.FindExact("deepinfra/inkling"); ok {
		t.Fatal("FindExact answered a models.dev-only key")
	}
	if pricing, ok := corpus.FindExact("gpt-5"); !ok || pricing.Input != 5 {
		t.Fatalf("FindExact(gpt-5) = %+v/%v, want the primary row", pricing, ok)
	}
}

func TestFindExactOnlyHitsExactKeys(t *testing.T) {
	corpus := exactTestCorpus()
	if pricing, ok := corpus.FindExact("gpt-5"); !ok || pricing.Input != 5 {
		t.Fatalf("FindExact(gpt-5) = %+v/%v", pricing, ok)
	}
	// find_exact has no normalized fallback: only the spelling in the map hits.
	if _, ok := corpus.FindExact("claude-opus-5-eu"); ok {
		t.Fatal("FindExact must not normalize separators")
	}
	if _, ok := corpus.FindExact("gpt-5-preview"); ok {
		t.Fatal("FindExact must not fuzzy match prefixes")
	}
}

func TestFindExactWithFallbackNormalizesDotsAndAt(t *testing.T) {
	corpus := exactTestCorpus()
	pricing, ok := corpus.FindExactWithFallback("claude-opus-5-eu")
	if !ok || pricing.Input != 1 {
		t.Fatalf("fallback lookup = %+v/%v, want the @-key row", pricing, ok)
	}
	if pricing, ok := corpus.FindExactWithFallback("deepseek/deepseek-v4"); !ok || pricing.Input != 2 {
		t.Fatalf("fallback lookup = %+v/%v, want the dot-key row", pricing, ok)
	}
}

func TestFindExactWithFallbackDoesNotFuzzyMatch(t *testing.T) {
	corpus := exactTestCorpus()
	if _, ok := corpus.FindExactWithFallback("gpt-5-preview"); ok {
		t.Fatal("find_exact_with_fallback must never fuzzy match")
	}
	if _, ok := corpus.FindExactWithFallback("gpt"); ok {
		t.Fatal("find_exact_with_fallback must never match a longer key's prefix")
	}
}

// TestFindExactWithFallbackFinishesThePrimaryMapFirst pins the per-map walk
// find_exact_with_fallback performs (pricing.rs:1501-1516): the primary map's
// find_exact_normalized runs to completion - exact key, exact-only spelling,
// normalized-key index - before the embedded models.dev map is asked anything.
// Hoisting both exact lookups above the normalized index would let a
// models.dev key beat the primary map's normalized hit for the same spelling,
// which is the one place the two tables can disagree on a price.
func TestFindExactWithFallbackFinishesThePrimaryMapFirst(t *testing.T) {
	corpus := Corpus{Models: map[string]CorpusModel{
		"claude-3-7-sonnet": {Input: 3e-06, Source: SourceLiteLLM},
		"claude-3.7-sonnet": {Input: 2.5e-06, Source: SourceModelsDev},
	}}
	pricing, ok := corpus.FindExactWithFallback("claude-3.7-sonnet")
	if !ok || pricing.Source != SourceLiteLLM || pricing.Input != 3e-06 {
		t.Fatalf("lookup = %+v/%v, want the primary map's normalized hit", pricing, ok)
	}
}

// TestFindExactWithFallbackAmbiguousSpellingFallsToTheLaterStage records what
// ccusage answers for a spelling two primary keys share while the models.dev
// map prices it exactly: find_exact_normalized's normalized-key index returns
// None for the ambiguous spelling and find_exact_with_fallback does not ask the
// primary map again, so it moves on to the models.dev map, whose exact entry
// answers (pricing.rs:1501-1516, 1519-1532). Testing only the primary ambiguous
// case passes even when that index step is missing, which is why the second
// half carries its own models.dev row.
func TestFindExactWithFallbackAmbiguousSpellingFallsToTheLaterStage(t *testing.T) {
	// "a.b" and "a-b" both normalize to "a-b", so the spelling names neither
	// primary entry (pricing.rs:1535-1548).
	corpus := exactTestCorpus()
	if _, ok := corpus.FindExactWithFallback("a@b"); ok {
		t.Fatal("an ambiguous primary spelling with no models.dev row must miss")
	}
	// The exact entry still answers for its own spelling.
	if pricing, ok := corpus.FindExactWithFallback("a-b"); !ok || pricing.Input != 4 {
		t.Fatalf("exact lookup = %+v/%v", pricing, ok)
	}

	ambiguous := exactTestCorpus()
	ambiguous.Models["b.c"] = CorpusModel{Input: 9, Source: SourceModelsDev}
	ambiguous.Models["b-c"] = CorpusModel{Input: 10, Source: SourceModelsDev}
	if pricing, ok := ambiguous.FindExactWithFallback("b.c"); !ok || pricing.Input != 9 {
		t.Fatalf("lookup = %+v/%v, want the models.dev map's exact entry", pricing, ok)
	}
	// A primary key and a models.dev key sharing a spelling are ambiguous only
	// once the walk reaches the models.dev map: the primary key answers first.
	primaryWins := exactTestCorpus()
	primaryWins.Models["a-b"] = CorpusModel{Input: 4, Source: SourceLiteLLM}
	primaryWins.Models["a@b"] = CorpusModel{Input: 11, Source: SourceModelsDev}
	if pricing, ok := primaryWins.FindExactWithFallback("a@b"); !ok || pricing.Input != 11 {
		t.Fatalf("lookup = %+v/%v, want the models.dev key for its own spelling", pricing, ok)
	}
}

func TestFindExactWithFallbackExactOnlySpelling(t *testing.T) {
	corpus := Corpus{
		Models:         map[string]CorpusModel{"claude-opus-5-5": {Input: 7, ExactOnly: true}},
		ExactOnlyNames: map[string]bool{"claude-opus-5-5": true},
	}
	// The `.` spelling of an exact-only id resolves through the id it names
	// (pricing.rs:1520-1525).
	if pricing, ok := corpus.FindExactWithFallback("claude-opus-5.5"); !ok || pricing.Input != 7 {
		t.Fatalf("exact-only lookup = %+v/%v", pricing, ok)
	}
}

// TestFindExactWithFallbackAmbiguityIsPerStage pins find_exact_with_fallback's
// two-stage walk (pricing.rs:1501-1543): the primary map and the models.dev
// map each build their own normalized-key index, so a primary key and a
// models.dev key that share a spelling are NOT ambiguous with each other. A
// global index over the merged table would answer miss here.
func TestFindExactWithFallbackAmbiguityIsPerStage(t *testing.T) {
	corpus := Corpus{Models: map[string]CorpusModel{
		"claude-3-5-haiku": {Input: 8e-7, Source: SourceLiteLLM},
		"claude-3.5-haiku": {Input: 8e-7, Source: SourceModelsDev},
	}}
	if pricing, ok := corpus.FindExactWithFallback("claude@3.5.haiku"); !ok || pricing.Source != SourceLiteLLM {
		t.Fatalf("spelled lookup = %+v/%v, want the primary entry", pricing, ok)
	}
	// Two keys inside ONE stage remain ambiguous, and the walk then falls
	// through to the other stage's answer.
	ambiguous := Corpus{Models: map[string]CorpusModel{
		"a.b":       {Input: 1, Source: SourceLiteLLM},
		"a-b":       {Input: 2, Source: SourceBuiltin},
		"z-a-b":     {Input: 3},
		"qux-1.2.3": {Input: 4, Source: SourceModelsDev},
	}}
	if _, ok := ambiguous.FindExactWithFallback("a@b"); ok {
		t.Fatal("a spelling two primary keys share must miss")
	}
}
