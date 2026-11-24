package nativepricing

import (
	"testing"
	"testing/fstest"
)

// The multiplier fixtures are built by hand so each stage of ccusage's
// multiplier_for has a case that can only be answered by that stage. The shipped
// files are checked separately, against the corpus they are loaded into.

// TestMultiplierFor_resolvesExactAliasAndNormalizedPrefix walks every stage of
// ccusage's SpeedMultiplierOverrides::multiplier_for (pricing.rs:946-992) in
// order, so a reordering of the stages fails a named case rather than quietly
// changing a rate.
func TestMultiplierFor_resolvesExactAliasAndNormalizedPrefix(t *testing.T) {
	overrides := multiplierOverrides{
		Exact: map[string]float64{
			"gpt-5.6-sol":     2,
			"gpt-5.6":         3, // an exact key that is also an alias name
			"claude-opus-4-6": 4,
			"gpt-5":           5,
			"openai/gpt-5":    6,
			"vendor.gpt-5":    7,
		},
		NormalizedPrefix: map[string]float64{
			"claude-opus-4-6": 6,
			"claude-opus-4":   2,
		},
	}

	cases := map[string]float64{
		// Stage 1: the id as written.
		"gpt-5":   5,
		"gpt-5.6": 3, // the exact key beats the alias to gpt-5.6-sol

		// Stage 2: a date suffix is stripped, then the exact key / prefix is tried.
		"claude-opus-4-6-20260101": 4, // date suffix stripped to the exact key
		"claude-opus-4-6-thinking": 6, // no exact key: the longer prefix wins
		"claude-opus-4-turbo":      2, // only the shorter prefix matches
		"unknown-model":            1, // no override at all keeps 1.0

		// Stage 3: the parts ccusage splits on, and their dotted suffixes.
		"anthropic/claude-opus-4-6": 4, // the bare part matches exactly
		"openai/gpt-5":              6, // the slashed key is itself an exact key
		"vendor/gpt-5":              5, // the part "gpt-5" matches
		"vendor.gpt-5":              7, // exact key wins before the split
		"a/b:gpt-5":                 5, // ':' splits too
	}

	for model, want := range cases {
		if got := overrides.multiplierFor(model); got != want {
			t.Errorf("multiplierFor(%q) = %v, want %v", model, got, want)
		}
	}
}

// TestMultiplierFor_resolvesHardcodedAliasBeforeTheSplit is stage 2 on its own:
// a name that is a hardcoded alias takes the aliased id's multiplier.
func TestMultiplierFor_resolvesHardcodedAliasBeforeTheSplit(t *testing.T) {
	overrides := multiplierOverrides{
		Exact: map[string]float64{
			"gpt-5.6-sol": 2.5,
			// A key the alias's own part would otherwise match, to prove the
			// alias stage runs first.
			"gpt-reserve": 99,
		},
	}

	// pricingAlias("gpt-5.6") -> "gpt-5.6-sol".
	if got := overrides.multiplierFor("gpt-5.6"); got != 2.5 {
		t.Errorf("multiplierFor(%q) = %v, want the alias target's 2.5", "gpt-5.6", got)
	}
	if got := overrides.multiplierFor("gpt-reserve"); got != 99 {
		t.Errorf("multiplierFor(%q) = %v, want 99", "gpt-reserve", got)
	}
}

// TestMultiplierFor_triesTheWholePartBeforeItsDottedSuffixes pins modelParts'
// dotted-suffix expansion: ccusage's flat_map yields the whole part first, then
// the tail after each '.', in order. "a.b.c" is tried as "a.b.c", then "b.c",
// then "c".
func TestMultiplierFor_triesTheWholePartBeforeItsDottedSuffixes(t *testing.T) {
	overrides := multiplierOverrides{Exact: map[string]float64{"b.c": 7, "c": 9}}

	if got := overrides.multiplierFor("a.b.c"); got != 7 {
		t.Errorf("multiplierFor(%q) = %v, want 7: the first matching suffix wins", "a.b.c", got)
	}
	if got := overrides.multiplierFor("a.z.c"); got != 9 {
		t.Errorf("multiplierFor(%q) = %v, want 9", "a.z.c", got)
	}
	// The whole part is tried before any suffix.
	whole := multiplierOverrides{Exact: map[string]float64{"a.b.c": 1, "c": 9}}
	if got := whole.multiplierFor("a.b.c"); got != 1 {
		t.Errorf("multiplierFor(%q) = %v, want the whole key's 1", "a.b.c", got)
	}
}

// TestMultiplierFor_normalizedPrefixNeedsASuffixBoundary pins
// matches_model_suffix (pricing.rs:2802): the prefix must end the part, either
// exactly or followed by a '-'. A prefix swallowed by more id text does not
// count.
func TestMultiplierFor_normalizedPrefixNeedsASuffixBoundary(t *testing.T) {
	overrides := multiplierOverrides{NormalizedPrefix: map[string]float64{"claude-opus-4-6": 6}}

	cases := map[string]float64{
		"claude-opus-4-6":            6, // exact suffix
		"claude-opus-4-6-thinking":   6, // '-' continues the id
		"prefix-claude-opus-4-6":     6, // the last occurrence is the suffix
		"claude-opus-4-6x":           1, // only '-' may follow, so "x" refuses the match
		"anthropic/claude-opus-4-60": 1, // "0" neither ends the id nor continues it
		"unrelated":                  1,
	}
	for model, want := range cases {
		if got := overrides.multiplierFor(model); got != want {
			t.Errorf("multiplierFor(%q) = %v, want %v", model, got, want)
		}
	}
}

// TestMultiplierFor_normalizesDotsBeforePrefixMatch pins the one normalization
// the prefix stage performs: '.' and '@' become '-' on the part, so a dotted
// request reaches a dashed prefix key.
func TestMultiplierFor_normalizesDotsBeforePrefixMatch(t *testing.T) {
	overrides := multiplierOverrides{NormalizedPrefix: map[string]float64{"claude-opus-4-6": 6}}

	for _, model := range []string{
		"anthropic/claude-opus-4.6:thinking",
		"anthropic/claude-opus-4@6",
		"anthropic.claude-opus-4.6",
	} {
		if got := overrides.multiplierFor(model); got != 6 {
			t.Errorf("multiplierFor(%q) = %v, want 6", model, got)
		}
	}
}

// TestMultiplierFor_keepsOneForAnUnloadedTable pins the zero value: a table that
// was never loaded means "no override", not "multiply by zero".
func TestMultiplierFor_keepsOneForAnUnloadedTable(t *testing.T) {
	var empty multiplierOverrides
	if got := empty.multiplierFor("gpt-5.5"); got != 1 {
		t.Fatalf("multiplierFor on an unloaded table = %v, want 1", got)
	}
	loaded := multiplierOverrides{Exact: map[string]float64{"gpt-5.5": 2.5}}
	if got := loaded.multiplierFor("gpt-5.5"); got != 2.5 {
		t.Fatalf("multiplierFor = %v, want 2.5", got)
	}
	if got := loaded.multiplierFor("other"); got != 1 {
		t.Fatalf("a model with no entry = %v, want 1", got)
	}
}

// TestReadMultiplierOverrides_readsTheShippedFiles checks the vendored pair
// against the corpus values they produce, and that a file with no multipliers is
// refused rather than silently billing every model at 1x.
func TestReadMultiplierOverrides_readsTheShippedFiles(t *testing.T) {
	fast, err := readMultiplierOverrides(embeddedCorpus, fastMultipliersFile)
	if err != nil {
		t.Fatalf("readMultiplierOverrides(%s): %v", fastMultipliersFile, err)
	}
	flex, err := readMultiplierOverrides(embeddedCorpus, flexMultipliersFile)
	if err != nil {
		t.Fatalf("readMultiplierOverrides(%s): %v", flexMultipliersFile, err)
	}
	if got := fast.multiplierFor("gpt-5.5"); got != 2.5 {
		t.Errorf("fast gpt-5.5 = %v, want 2.5", got)
	}
	if got := flex.multiplierFor("gpt-5.5"); got != 0.5 {
		t.Errorf("flex gpt-5.5 = %v, want 0.5", got)
	}
	// The prefix table and the alias table are exercised too.
	if got := fast.multiplierFor("anthropic/claude-opus-4.6:thinking"); got != 6 {
		t.Errorf("fast dotted opus 4.6 = %v, want 6", got)
	}
	if got := fast.multiplierFor("gpt-5.6"); got != 2 {
		t.Errorf("fast gpt-5.6 via its alias = %v, want 2", got)
	}
	if got := flex.multiplierFor("gpt-5.6"); got != 0.5 {
		t.Errorf("flex gpt-5.6 via its alias = %v, want 0.5", got)
	}

	// A table with no multipliers must be an error, not a 1x default.
	empty := fstest.MapFS{fastMultipliersFile: &fstest.MapFile{Data: []byte(`{"exact":{},"normalized_prefix":{}}`)}}
	if _, err := readMultiplierOverrides(empty, fastMultipliersFile); err == nil {
		t.Fatal("an override file with no multipliers must be an error")
	}
	// A file that is not the {exact, normalized_prefix} shape must fail too.
	malformed := fstest.MapFS{fastMultipliersFile: &fstest.MapFile{Data: []byte(`{"exact":[1,2,3]}`)}}
	if _, err := readMultiplierOverrides(malformed, fastMultipliersFile); err == nil {
		t.Fatal("a malformed override file must be an error")
	}
}
