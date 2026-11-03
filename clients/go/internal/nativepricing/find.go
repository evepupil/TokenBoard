package nativepricing

import "strings"

// modelDateSuffixDigits is ccusage's MODEL_DATE_SUFFIX_DIGITS
// (rust/crates/ccusage-core/src/pricing.rs:61). A run of exactly this many
// digits after a '.' or '-' separator is a release date (YYYYMMDD), not a
// version continuation, so a request may still match the undated model id.
const modelDateSuffixDigits = 8

// stage names one of ccusage's two pricing tables. Corpus keeps both in Models
// and records the origin in CorpusModel.Source.
type stage int

const (
	// primaryStage is the LiteLLM snapshot plus the code builtin table.
	primaryStage stage = iota
	// modelsDevStage is the embedded models.dev snapshot, consulted only after
	// primaryStage misses entirely.
	modelsDevStage
)

// holds reports whether one model belongs to this stage's table.
func (s stage) holds(pricing CorpusModel) bool {
	return (pricing.Source == SourceModelsDev) == (s == modelsDevStage)
}

// Find returns the rates that price model, and whether any table claimed it.
//
// ccusage keeps two pricing maps - a primary one (the LiteLLM snapshot plus the
// code builtin table) and a separate embedded models.dev snapshot - and walks
// them in a fixed order (find_with_fallbacks,
// rust/crates/ccusage-core/src/pricing.rs:1404-1455). Corpus merges both into
// one map keyed by pricing key and records which snapshot answered in
// CorpusModel.Source, so Find rebuilds that walk by stage rather than scanning
// Models for the single best match:
//
//  1. primary exact, then exact for the request's hardcoded alias;
//  2. primary fuzzy, unless the requested name (or its alias) is exact-only;
//  3. models.dev exact, then the same alias step, then models.dev fuzzy.
//
// Step 3 runs only after both primary steps miss, which is what makes the walk
// and a global "exact first" scan differ: "databricks-gpt-5-6-luna" is a
// models.dev key priced at $1/M input, yet ccusage answers it from the primary
// table's fuzzy match on gpt-5.6-luna ($0.2/M).
//
// Two boundaries are deliberate. ccusage also consults a live models.dev
// catalog, which the native client never fetches: the frozen corpus is the whole
// table. And ccusage resolves CCUSAGE_MODEL_ALIASES before the walk; the shipped
// configuration leaves that table empty
// (docs/superpowers/specs/2026-11-03-native-usage-sources-design.md §6.1.2), so
// no environment alias is applied here.
func (c Corpus) Find(model string) (CorpusModel, bool) {
	// ccusage computes the fuzzy verdict once, from the requested name and its
	// pricing alias, and hands the same verdict to both stages.
	fuzzy := c.allowsFuzzyLookup(model)
	if pricing, ok := c.findOrAlias(model, primaryStage, fuzzy); ok {
		return pricing, true
	}
	return c.findOrAlias(model, modelsDevStage, fuzzy)
}

// findOrAlias mirrors find_entry_or_alias_with_fallback for one stage: the
// request's own key, then its hardcoded alias, then the request again for the
// fuzzy scan. The alias is tried with findEntry rather than findOrAlias because
// pricing_alias is one level deep in ccusage too.
func (c Corpus) findOrAlias(model string, which stage, fuzzy bool) (CorpusModel, bool) {
	if pricing, ok := c.findExact(model, which); ok {
		return pricing, true
	}
	if alias, ok := pricingAlias(model); ok {
		if pricing, ok := c.findEntry(alias, which, fuzzy); ok {
			return pricing, true
		}
	}
	return c.findEntry(model, which, fuzzy)
}

// findEntry mirrors find_entry_with_fallback: an exact key, an alternate
// separator spelling of an exact-only id, then the fuzzy scan behind the
// exact-only gate.
func (c Corpus) findEntry(model string, which stage, fuzzy bool) (CorpusModel, bool) {
	if pricing, ok := c.findExact(model, which); ok {
		return pricing, true
	}
	// Only the models.dev table carries an exact-only index: ccusage fills that
	// index from the models.dev load path alone, so the primary table's step is
	// always a miss and is not reproduced here.
	if which == modelsDevStage {
		// A separator spelling of an exact-only id names that entry, so it is
		// answered from it rather than gated into a miss below. Answering is all
		// this step does: ccusage returns the entry lookup even when it is empty.
		//
		// Some of these cannot be answered exactly: an exact-only id that a
		// primary snapshot also prices keeps the primary rates in Corpus, while
		// ccusage answers from its models.dev entry. 52 exact-only primary rows
		// share a models.dev key, and four of them differ materially - gpt-5-codex's
		// cache read (1.25e-7 vs 1.3e-7), and the cache-create rate of the three
		// rows the builtin table takes over (gpt-5.1-codex 1.25e-6 vs 1.5625e-6;
		// gpt-5.2-codex and gpt-5.2 1.75e-6 vs 2.1875e-6). Reaching any of them
		// takes a respelled request such as "gpt-5.codex", so the merged corpus is
		// left as Task 1 built it and Task 5's goldens probe the cases that matter.
		if id, ok := c.exactOnlyIDSpelledBy(model); ok {
			if pricing, ok := c.Models[id]; ok {
				return pricing, true
			}
			return CorpusModel{}, false
		}
	}
	// is_exact_only_lookup_with_fallback: an exact-only request name may not be
	// answered by a fuzzy match on a different model, or the tier it names would
	// be unreachable and the base model's rate billed for it.
	if !fuzzy || c.isExactOnlyLookup(model) {
		return CorpusModel{}, false
	}
	return c.fuzzyMatch(model, which)
}

// findExact looks a key up in one stage's table.
func (c Corpus) findExact(model string, which stage) (CorpusModel, bool) {
	pricing, ok := c.Models[model]
	if !ok || !which.holds(pricing) {
		return CorpusModel{}, false
	}
	return pricing, true
}

// allowsFuzzyLookup mirrors allows_fuzzy_lookup_with_fallbacks: a spelling that
// names an exact-only id - or whose pricing alias does - may only be answered
// exactly. ccusage also asks this of the alias it resolved the name to through
// CCUSAGE_MODEL_ALIASES; with that table empty the two names coincide.
func (c Corpus) allowsFuzzyLookup(model string) bool {
	if c.isExactOnlyLookup(model) {
		return false
	}
	if alias, ok := pricingAlias(model); ok && c.isExactOnlyLookup(alias) {
		return false
	}
	return true
}

// isExactOnlyLookup mirrors ExactOnlyKeys::contains_any_spelling through
// is_exact_only_lookup_with_fallback: the id as written, or any '.'/'@'/'-'
// spelling of it, is exact-only.
//
// This is a request-name gate. The exact-only flags of the fuzzy *candidates*
// are a separate question, answered per stage in fuzzyMatch.
func (c Corpus) isExactOnlyLookup(model string) bool {
	return c.ExactOnlyNames[normalizePricingKey(model)]
}

// exactOnlyIDSpelledBy mirrors ExactOnlyKeys::id_spelled_by: the exact-only id
// an alternate separator spelling names, when exactly one does. A spelling two
// ids share names neither.
func (c Corpus) exactOnlyIDSpelledBy(model string) (string, bool) {
	spelling := normalizePricingKey(model)
	if !c.ExactOnlyNames[spelling] {
		return "", false
	}
	id := ""
	for candidate, pricing := range c.Models {
		if !pricing.ExactOnly || normalizePricingKey(candidate) != spelling {
			continue
		}
		if id != "" {
			return "", false
		}
		id = candidate
	}
	return id, id != ""
}

// fuzzyMatch mirrors the scan find_entry_with_fallback runs once the exact
// lookups miss: every candidate key in the stage's table that shares a
// price-key boundary with the request, longest first.
func (c Corpus) fuzzyMatch(model string, which stage) (CorpusModel, bool) {
	normalized := normalizePricingKey(model)
	best := ""
	var bestPricing CorpusModel
	for candidate, pricing := range c.Models {
		if !which.holds(pricing) {
			continue
		}
		// Each stage keeps its own exact-only ids out of the scan. The primary
		// table has none - only the models.dev load path fills that index - so
		// filtering on CorpusModel.ExactOnly there would make gpt-5.6-luna
		// unreachable and change its rate.
		if which == modelsDevStage && pricing.ExactOnly {
			continue
		}
		if !pricingKeyMatches(candidate, model, normalized) {
			continue
		}
		// ccusage takes max_by(|left, right| left.len().cmp(&right.len())
		// .then_with(|| right.cmp(left))). The length comparison dominates, so
		// the longest key wins; on a length tie the comparator reduces to
		// right.cmp(left), which inverts the order, so the lexicographically
		// smaller key is the maximum. Iterating a map makes both explicit here.
		if best == "" || len(candidate) > len(best) || (len(candidate) == len(best) && candidate < best) {
			best, bestPricing = candidate, pricing
		}
	}
	if best == "" {
		return CorpusModel{}, false
	}
	return bestPricing, true
}

// pricingKeyMatches mirrors pricing_key_matches (pricing.rs:2667): two model ids
// match when one contains the other at a price-key boundary, compared both as
// written and with '.'/'@' normalized to '-'.
func pricingKeyMatches(candidate, model, normalizedModel string) bool {
	if containsPricingKey(model, candidate) || containsPricingKey(candidate, model) {
		return true
	}
	normalizedCandidate := normalizePricingKey(candidate)
	return containsPricingKey(normalizedModel, normalizedCandidate) ||
		containsPricingKey(normalizedCandidate, normalizedModel)
}

// containsPricingKey mirrors contains_pricing_key (pricing.rs:2677): key occurs
// in value with a non-alphanumeric byte (or the start) before it, and with a
// suffix that does not continue the key's numeric version.
func containsPricingKey(value, key string) bool {
	for start := 0; start <= len(value); {
		offset := strings.Index(value[start:], key)
		if offset < 0 {
			return false
		}
		index := start + offset
		before := index == 0 || isPricingKeyBoundary(value[index-1])
		if before && suffixAllowsPricingKeyMatch(key, value[index+len(key):]) {
			return true
		}
		// match_indices walks non-overlapping matches; an empty pattern (no
		// corpus key is empty) advances one byte so the loop terminates.
		next := index + len(key)
		if next == index {
			next = index + 1
		}
		start = next
	}
	return false
}

// isPricingKeyBoundary mirrors is_pricing_key_boundary: punctuation separates
// model id parts, an alphanumeric byte does not.
func isPricingKeyBoundary(char byte) bool {
	return !isASCIIDigit(char) && (char < 'a' || char > 'z') && (char < 'A' || char > 'Z')
}

// suffixAllowsPricingKeyMatch mirrors suffix_allows_pricing_key_match
// (pricing.rs:2693): what follows the key has to start a new id part and must
// not silently turn the key into a different version.
func suffixAllowsPricingKeyMatch(key, suffix string) bool {
	if suffix == "" {
		return true
	}
	if !isPricingKeyBoundary(suffix[0]) {
		return false
	}
	return !suffixStartsNumericModelVersion(key, suffix)
}

// suffixStartsNumericModelVersion mirrors suffix_starts_with_numeric_model_version
// (pricing.rs:2703): a key ending in a digit followed by '.'/'-' and more digits
// names a different version, so the match is refused - unless that digit run is
// exactly modelDateSuffixDigits long and ends the value or a separator, which is
// a release date.
//
// The date allowance is deliberately narrower than it looks: it applies only to
// a trailing run of exactly eight digits that is followed by nothing or by a
// boundary. Anything else - a shorter or longer run, or eight digits glued to
// more id text - still counts as a version.
func suffixStartsNumericModelVersion(key, suffix string) bool {
	if key == "" || !isASCIIDigit(key[len(key)-1]) {
		return false
	}
	if suffix == "" || (suffix[0] != '-' && suffix[0] != '.') {
		return false
	}
	rest := suffix[1:]
	digits := 0
	for digits < len(rest) && isASCIIDigit(rest[digits]) {
		digits++
	}
	if digits == 0 {
		return false
	}
	if digits != modelDateSuffixDigits {
		return true
	}
	// Exactly eight digits: a date only when the run ends the value or a
	// separator starts right after it.
	if len(rest) == digits {
		return false
	}
	return !isPricingKeyBoundary(rest[digits])
}

// isASCIIDigit reports whether char is '0'-'9'.
func isASCIIDigit(char byte) bool {
	return char >= '0' && char <= '9'
}
