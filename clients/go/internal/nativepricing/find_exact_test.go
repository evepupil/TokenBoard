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

func TestFindExactWithFallbackAmbiguousSpellingMisses(t *testing.T) {
	// "a.b" and "a-b" both normalize to "a-b", so the spelling names neither
	// entry (pricing.rs:1535-1548).
	corpus := exactTestCorpus()
	if _, ok := corpus.FindExactWithFallback("a@b"); ok {
		t.Fatal("an ambiguous normalized spelling must miss")
	}
	// The exact entry still answers for its own spelling.
	if pricing, ok := corpus.FindExactWithFallback("a-b"); !ok || pricing.Input != 4 {
		t.Fatalf("exact lookup = %+v/%v", pricing, ok)
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
