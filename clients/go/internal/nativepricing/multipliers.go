package nativepricing

// Service-tier multiplier overrides: ccusage's SpeedMultiplierOverrides
// (rust/crates/ccusage-core/src/pricing.rs:930-992) and the two embedded files
// data/fast-multipliers.json and data/flex-multipliers.json.
//
// Each file is a two-section object - an `exact` table keyed by full model id
// and a `normalized_prefix` table matched against a model id's '-' form. The
// lookup order is ccusage's and is not obvious, so it is spelled out on
// multiplierFor.
//
// The loader lives with the corpus (corpus.go calls into this file); this file
// owns the parsing and the lookup so the rules are stated in one place.
//
// Ported from ccusage (https://github.com/ryoppippi/ccusage), MIT licensed.
// See ../../THIRD_PARTY_NOTICES.md.

import (
	"fmt"
	"io/fs"
	"strings"
)

// multiplierOverrides is the shape of fast-multipliers.json and
// flex-multipliers.json: exact model ids, plus suffixes matched after the model
// id's separators are normalized.
type multiplierOverrides struct {
	Exact            map[string]float64 `json:"exact"`
	NormalizedPrefix map[string]float64 `json:"normalized_prefix"`
}

func readMultiplierOverrides(fsys fs.FS, name string) (multiplierOverrides, error) {
	var overrides multiplierOverrides
	if err := decodeCorpusFile(fsys, name, &overrides); err != nil {
		return multiplierOverrides{}, err
	}
	if len(overrides.Exact)+len(overrides.NormalizedPrefix) == 0 {
		return multiplierOverrides{}, fmt.Errorf("nativepricing: %s carries no multipliers", name)
	}
	return overrides, nil
}

// multiplierFor mirrors SpeedMultiplierOverrides::multiplier_for. A model that
// carries no override keeps ccusage's 1.0, i.e. "bill the base rate".
//
// The order is:
//
//  1. the model id as written;
//  2. its hardcoded pricing alias - a family name shares the variant's tier;
//  3. the id split on '/' and ':', and each part together with each of its
//     dotted suffixes (a decimal version like "gpt-5.5" survives the split),
//     tried in order as: the part, the part without its date suffix, the alias
//     of that stripped part, then a `normalized_prefix` suffix match.
//
// The dotted suffixes come from ccusage's flat_map over match_indices('.'):
// only the tail after each '.', never the whole dotted part twice.
func (o multiplierOverrides) multiplierFor(model string) float64 {
	if multiplier, ok := o.Exact[model]; ok {
		return multiplier
	}
	if alias, ok := pricingAlias(model); ok {
		if multiplier, ok := o.Exact[alias]; ok {
			return multiplier
		}
	}
	for _, part := range modelParts(model) {
		base := modelWithoutDateSuffix(part)
		if multiplier, ok := o.Exact[part]; ok {
			return multiplier
		}
		if multiplier, ok := o.Exact[base]; ok {
			return multiplier
		}
		if alias, ok := pricingAlias(base); ok {
			if multiplier, ok := o.Exact[alias]; ok {
				return multiplier
			}
		}
		if multiplier, ok := o.normalizedPrefixFor(part); ok {
			return multiplier
		}
	}
	return 1
}

// normalizedPrefixFor is the last stage of multiplier_for: the part with '.' and
// '@' normalized to '-', matched against every `normalized_prefix` key.
//
// Several prefixes can match one part, and ccusage iterates a hash map, so its
// pick is arbitrary. The longest match is the deterministic choice and the
// shipped files have no overlapping prefixes.
func (o multiplierOverrides) normalizedPrefixFor(part string) (float64, bool) {
	if len(o.NormalizedPrefix) == 0 {
		return 0, false
	}
	normalized := normalizePricingKey(part)
	bestBase, bestMultiplier, found := "", 0.0, false
	for prefix, multiplier := range o.NormalizedPrefix {
		if !matchesModelSuffix(normalized, prefix) {
			continue
		}
		if !found || len(prefix) > len(bestBase) {
			bestBase, bestMultiplier, found = prefix, multiplier, true
		}
	}
	return bestMultiplier, found
}

// modelParts splits a model id on the provider separators ccusage tries, and
// yields each dotted suffix too so a decimal version survives the split.
func modelParts(model string) []string {
	var parts []string
	for _, part := range strings.FieldsFunc(model, func(r rune) bool { return r == '/' || r == ':' }) {
		parts = append(parts, part)
		for index := strings.IndexByte(part, '.'); index >= 0; index = strings.IndexByte(part, '.') {
			part = part[index+1:]
			parts = append(parts, part)
		}
	}
	return parts
}

// matchesModelSuffix mirrors matches_model_suffix (pricing.rs:2802): base occurs
// at the end of part (the last occurrence wins), either as the whole suffix or
// followed by '-'.
func matchesModelSuffix(part, base string) bool {
	index := strings.LastIndex(part, base)
	if index < 0 {
		return false
	}
	suffix := part[index:]
	return suffix == base || suffix[len(base)] == '-'
}
