package nativepricing

// The server-provided pricing override layer: ccusage's apply_override /
// apply_overrides (rust/crates/ccusage-core/src/pricing.rs:1810-1912), ported
// onto Corpus.
//
// The wire format is camelCase - `inputCostPerToken`, `cacheReadInputTokenCost`,
// `maxInputTokens` - because those are the keys ccusage's serde rename_all
// produces from its Rust field names, and the keys
// clients/go/internal/pricing/config.go:555-588 emits. The snake_case spellings
// that appear in ccusage's source are an internal detail; a payload carrying
// them has to be ignored, not half-applied, and a test pins that.
//
// Two parts of apply_override are easy to get wrong and are called out where
// they live: the conditional cache-rate scaling, and the fact that ccusage
// resolves the override's base from its primary table only.

import (
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"sort"
	"strconv"
)

// WithOverrides returns a copy of c with ccusage's pricingOverrides applied.
// The receiver and every map it owns are left untouched.
//
// Matching is by exact key, then by the hardcoded alias - NOT by fuzzy or
// separator-normalized lookup. That mirrors apply_override
// (pricing.rs:1820-1826), which asks `self.entries.get(model)` and then
// `pricing_alias(model).and_then(|alias| self.entries.get(alias))` and never
// runs the finder at all.
//
// Every failure is an error. A rate that is not a number, or a maxInputTokens
// that is not a whole non-negative count, would otherwise silently price a
// model at the wrong rate; ccusage's serde would have refused the whole config.
func (c Corpus) WithOverrides(overrides map[string]any) (Corpus, error) {
	models := make([]string, 0, len(overrides))
	for model := range overrides {
		models = append(models, model)
	}
	// Sorted so a payload with several bad rows always reports the same one.
	sort.Strings(models)

	parsed := make(map[string]overrideFields, len(overrides))
	for _, model := range models {
		fields, err := parseOverrideFields(overrides[model])
		if err != nil {
			return Corpus{}, fmt.Errorf("nativepricing: pricingOverrides[%q]: %w", model, err)
		}
		parsed[model] = fields
	}

	// Deep copy: the caller's corpus keeps its own Models / ContextLimits /
	// ExactOnlyNames / Counts, so applying overrides never rewrites history.
	updated := Corpus{
		Models:         maps.Clone(c.Models),
		ExactOnlyNames: maps.Clone(c.ExactOnlyNames),
		ContextLimits:  maps.Clone(c.ContextLimits),
		Counts:         maps.Clone(c.Counts),
	}
	if updated.Models == nil && len(parsed) > 0 {
		updated.Models = make(map[string]CorpusModel, len(parsed))
	}
	for _, model := range models {
		updated.applyOverride(model, parsed[model])
	}
	return updated, nil
}

// WithServerOverrides parses a server payload and applies its pricingOverrides.
//
// Three shapes reach this method, and all three are accepted because the Go
// client and the TS collector write different files:
//
//   - the generated ccusage config, {"defaults":{"pricingOverrides":{…}}}
//     (packages/collector/ccusage.json, pricing/config.go's merged output);
//   - a bare envelope, {"pricingOverrides":{…}, …};
//   - the override map itself, {"<model>":{…}}.
//
// Byte-for-byte the same overrides produce the same Corpus whichever shape
// wraps them.
func (c Corpus) WithServerOverrides(raw []byte) (Corpus, error) {
	overrides, err := parseServerOverrides(raw)
	if err != nil {
		return Corpus{}, fmt.Errorf("nativepricing: read pricing overrides: %w", err)
	}
	return c.WithOverrides(overrides)
}

// parseServerOverrides unwraps the payload down to the model -> fields map.
func parseServerOverrides(raw []byte) (map[string]any, error) {
	var payload any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	record, ok := payload.(map[string]any)
	if !ok || record == nil {
		return nil, fmt.Errorf("want a JSON object, got %s", describeJSONValue(payload))
	}
	// The envelope first, so a payload that carries both a top-level
	// pricingOverrides and a defaults section reads the one the caller wrapped.
	if inner, ok := record["pricingOverrides"]; ok {
		return overrideMap(inner, "pricingOverrides")
	}
	// Then the ccusage config file, whose overrides live under defaults. A
	// $schema key marks a config even when the defaults section was left out.
	_, hasSchema := record["$schema"]
	_, hasDefaults := record["defaults"]
	if hasSchema || hasDefaults {
		defaults := map[string]any{}
		if defaultsValue, present := record["defaults"]; present {
			object, ok := defaultsValue.(map[string]any)
			if !ok || object == nil {
				return nil, fmt.Errorf("defaults must be an object, got %s", describeJSONValue(defaultsValue))
			}
			defaults = object
		}
		inner, present := defaults["pricingOverrides"]
		if !present || inner == nil {
			// A config with no overrides is a valid config, not an error.
			return map[string]any{}, nil
		}
		return overrideMap(inner, "defaults.pricingOverrides")
	}
	// Finally the bare map, which is what CreateCcusagePricingOverrides returns.
	return record, nil
}

// overrideMap asserts that value is a model -> fields object.
func overrideMap(value any, name string) (map[string]any, error) {
	if value == nil {
		return map[string]any{}, nil
	}
	record, ok := value.(map[string]any)
	if !ok || record == nil {
		return nil, fmt.Errorf("%s must be an object, got %s", name, describeJSONValue(value))
	}
	return record, nil
}

// overrideFields is one parsed pricingOverrides record. A nil pointer means the
// key was absent (or explicitly null, which serde reads the same way), so the
// base value is kept.
type overrideFields struct {
	input, output                    *float64
	cacheCreate, cacheRead           *float64
	inputAbove, outputAbove          *float64
	cacheCreateAbove, cacheReadAbove *float64
	maxInputTokens                   *int64
	fastMultiplier, flexMultiplier   *float64
}

// parseOverrideFields reads one model's record. Unknown keys are ignored, which
// is serde's default for a struct without deny_unknown_fields - that is exactly
// why a snake_case payload does nothing instead of being half-applied.
func parseOverrideFields(value any) (overrideFields, error) {
	record, ok := value.(map[string]any)
	if !ok || record == nil {
		return overrideFields{}, fmt.Errorf("want an object of per-token rates, got %s", describeJSONValue(value))
	}

	keys := make([]string, 0, len(record))
	for key := range record {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	var fields overrideFields
	for _, name := range keys {
		raw := record[name]
		if raw == nil {
			continue
		}
		if name == "maxInputTokens" {
			count, err := overrideCount(name, raw)
			if err != nil {
				return overrideFields{}, err
			}
			fields.maxInputTokens = count
			continue
		}
		target := fields.rateTarget(name)
		if target == nil {
			continue
		}
		rate, err := overrideRate(name, raw)
		if err != nil {
			return overrideFields{}, err
		}
		*target = rate
	}
	return fields, nil
}

// rateTarget maps one camelCase key onto the field it sets. A nil result means
// the key is not part of ccusage's PricingOverride, so the caller ignores it.
func (f *overrideFields) rateTarget(name string) **float64 {
	switch name {
	case "inputCostPerToken":
		return &f.input
	case "outputCostPerToken":
		return &f.output
	case "cacheCreationInputTokenCost":
		return &f.cacheCreate
	case "cacheReadInputTokenCost":
		return &f.cacheRead
	case "inputCostPerTokenAbove200kTokens":
		return &f.inputAbove
	case "outputCostPerTokenAbove200kTokens":
		return &f.outputAbove
	case "cacheCreationInputTokenCostAbove200kTokens":
		return &f.cacheCreateAbove
	case "cacheReadInputTokenCostAbove200kTokens":
		return &f.cacheReadAbove
	case "fastMultiplier":
		return &f.fastMultiplier
	case "flexMultiplier":
		return &f.flexMultiplier
	}
	return nil
}

// applyOverride is the port of apply_override. It writes the rewritten entry
// into c.Models and, when the override asks for one, the context window into
// c.ContextLimits.
func (c *Corpus) applyOverride(model string, fields overrideFields) {
	base, source := c.overrideBase(model)

	newInput := base.Input
	if fields.input != nil {
		newInput = *fields.input
	}

	// ccusage's scaling gate (pricing.rs:1838-1846): the cache rates were
	// derived from the input rate, so moving input has to move them too. Only
	// the read flag is consulted - a model that publishes cache_create but
	// derives cache_read does not scale - and a base whose input rate is zero
	// (Pricing::empty) never scales, because there is no ratio to scale by.
	shouldScale := fields.input != nil && base.Input > 0 && !base.CacheReadExplicit
	scale := 1.0
	if shouldScale {
		scale = newInput / base.Input
	}

	cacheCreate := base.CacheCreate
	if fields.cacheCreate != nil {
		cacheCreate = *fields.cacheCreate
	} else if shouldScale && base.CacheCreate > 0 {
		cacheCreate = base.CacheCreate * scale
	}

	cacheRead := base.CacheRead
	if fields.cacheRead != nil {
		cacheRead = *fields.cacheRead
	} else if shouldScale && base.CacheRead > 0 {
		cacheRead = base.CacheRead * scale
	}

	// The above-threshold bands follow the same rule, except that ccusage maps
	// over the Option without the `> 0` guard it applies to the base rates
	// (pricing.rs:1868-1886): a present zero band stays a present zero band.
	cacheCreateAbove := base.CacheCreateAbove
	if fields.cacheCreateAbove != nil {
		cacheCreateAbove = floatValue(*fields.cacheCreateAbove)
	} else if shouldScale && base.CacheCreateAbove != nil {
		cacheCreateAbove = floatValue(*base.CacheCreateAbove * scale)
	}

	cacheReadAbove := base.CacheReadAbove
	if fields.cacheReadAbove != nil {
		cacheReadAbove = floatValue(*fields.cacheReadAbove)
	} else if shouldScale && base.CacheReadAbove != nil {
		cacheReadAbove = floatValue(*base.CacheReadAbove * scale)
	}

	// input/output above are copied, not scaled: they are independent rates.
	inputAbove := base.InputAbove
	if fields.inputAbove != nil {
		inputAbove = floatValue(*fields.inputAbove)
	}
	outputAbove := base.OutputAbove
	if fields.outputAbove != nil {
		outputAbove = floatValue(*fields.outputAbove)
	}

	output := base.Output
	if fields.output != nil {
		output = *fields.output
	}
	fast := base.FastMultiplier
	if fields.fastMultiplier != nil {
		fast = *fields.fastMultiplier
	}
	flex := base.FlexMultiplier
	if fields.flexMultiplier != nil {
		flex = *fields.flexMultiplier
	}

	// The exact-only flag is a property of the NAME, not of the rates: ccusage's
	// ExactOnlyKeys set is not touched by apply_override, so an overridden
	// exact-only id keeps gating fuzzy lookups. Carry the merged entry's flag.
	var exactOnly bool
	if existing, ok := c.Models[model]; ok {
		exactOnly = existing.ExactOnly
	}

	c.Models[model] = CorpusModel{
		Input:                newInput,
		Output:               output,
		CacheRead:            cacheRead,
		CacheCreate:          cacheCreate,
		InputAbove:           inputAbove,
		OutputAbove:          outputAbove,
		CacheReadAbove:       cacheReadAbove,
		CacheCreateAbove:     cacheCreateAbove,
		LongContextThreshold: base.LongContextThreshold,
		FastMultiplier:       fast,
		FlexMultiplier:       flex,
		// The flags are sticky, exactly as pricing.rs:1858-1866 writes them: an
		// override that spells a cache rate makes it explicit forever, and one
		// that does not leaves the base's verdict in place.
		CacheReadExplicit:   fields.cacheRead != nil || base.CacheReadExplicit,
		CacheCreateExplicit: fields.cacheCreate != nil || base.CacheCreateExplicit,
		ExactOnly:           exactOnly,
		Source:              source,
	}

	if fields.maxInputTokens != nil {
		if c.ContextLimits == nil {
			c.ContextLimits = map[string]int64{}
		}
		c.ContextLimits[model] = *fields.maxInputTokens
	}
}

// overrideBase resolves the entry an override builds on, mirroring
// pricing.rs:1822-1826: the exact key in ccusage's primary table, then the
// hardcoded alias in that same table, then Pricing::empty.
//
// The stage matters. ccusage keeps LiteLLM + builtin rows in `entries` and the
// embedded models.dev snapshot in a separate PricingMap, so an override for a
// models.dev-only id starts from all-zero rates, not from the models.dev rate.
// Verified against ccusage 20.0.33: overriding grok-4.5 (models.dev-only) with
// the shipped config bills its cache writes at 0, which only the empty base
// produces.
//
// The returned Source places the rewritten entry back in the primary table,
// which is where apply_override's `self.entries.insert` puts it - so a lookup
// for the overridden name answers from the override, ahead of any fuzzy match
// the primary table would otherwise have won with. claude-opus-4-1 is the live
// example: models.dev-only, but `anthropic.claude-opus-4-1-…` exists in LiteLLM,
// and ccusage bills the override (1.0 for an output-only override) rather than
// that row's rates.
//
// One known residual follows from Corpus holding both tables in one map: ccusage
// keeps its models.dev row for an overridden id (unreachable, because the primary
// exact hit answers first), while the merged Corpus replaces it. The rows only
// differ for a separator-variant spelling of an exact-only id, the same family
// Task 2 and Task 3 registered for the goldens.
func (c Corpus) overrideBase(model string) (CorpusModel, ModelSource) {
	if pricing, ok := c.Models[model]; ok && pricing.Source != SourceModelsDev {
		return pricing, pricing.Source
	}
	if alias, ok := pricingAlias(model); ok {
		if pricing, ok := c.Models[alias]; ok && pricing.Source != SourceModelsDev {
			return pricing, pricing.Source
		}
	}
	return emptyPricing(), SourceLiteLLM
}

// emptyPricing is Pricing::empty() (pricing.rs:233-249): every rate and band at
// zero or absent, and both service-tier multipliers at 1 so an un-overridden
// bucket cannot erase the cost.
func emptyPricing() CorpusModel {
	return CorpusModel{FastMultiplier: 1, FlexMultiplier: 1}
}

// overrideRate reads one per-token rate.
func overrideRate(name string, value any) (*float64, error) {
	number, err := overrideNumber(name, value)
	if err != nil {
		return nil, err
	}
	if number == nil {
		return nil, nil
	}
	if math.IsNaN(*number) || math.IsInf(*number, 0) {
		return nil, fmt.Errorf("%s must be finite, got %v", name, *number)
	}
	return number, nil
}

// overrideCount reads maxInputTokens, which ccusage types as an Option<u64>.
func overrideCount(name string, value any) (*int64, error) {
	number, err := overrideNumber(name, value)
	if err != nil {
		return nil, err
	}
	if number == nil {
		return nil, nil
	}
	if math.Trunc(*number) != *number || *number < 0 || *number >= float64(math.MaxInt64) {
		return nil, fmt.Errorf("%s must be a whole non-negative token count, got %v", name, *number)
	}
	count := int64(*number)
	return &count, nil
}

// overrideNumber accepts the numeric types a Go map can carry into the
// override layer: float64 from encoding/json, json.Number from a UseNumber
// decoder (pricing/config.go:238 decodes that way), and the plain ints a test or
// a hand-built payload uses.
func overrideNumber(name string, value any) (*float64, error) {
	switch number := value.(type) {
	case nil:
		return nil, nil
	case float64:
		return floatValue(number), nil
	case float32:
		return floatValue(float64(number)), nil
	case int:
		return floatValue(float64(number)), nil
	case int64:
		return floatValue(float64(number)), nil
	case json.Number:
		parsed, err := strconv.ParseFloat(number.String(), 64)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		return floatValue(parsed), nil
	default:
		return nil, fmt.Errorf("%s must be a number, got %s", name, describeJSONValue(value))
	}
}

// describeJSONValue names a decoded JSON value's type for an error message.
func describeJSONValue(value any) string {
	if value == nil {
		return "null"
	}
	switch value.(type) {
	case map[string]any:
		return "an object"
	case []any:
		return "an array"
	case string:
		return "a string"
	case bool:
		return "a boolean"
	}
	return fmt.Sprintf("%T", value)
}
