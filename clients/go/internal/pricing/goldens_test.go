package pricing

// Cross-language parity for the dynamic ccusage pricing overrides.
//
// goldens/ccusage-overrides.json is produced by the TypeScript implementation
// (scripts/clients-go-gen-pricing-goldens.mts) and must never be edited by
// hand. It carries the raw catalogue response, the fallback (static) layer and
// the overrides the TS builder yields for them, so this test fails the moment
// the two implementations disagree on parsing, the ambiguous-id collapse, the
// official anchor, the case-variant aliases, or the above-200k strip.

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"reflect"
	"sort"
	"testing"
)

//go:embed goldens/ccusage-overrides.json
var ccusageOverridesGolden []byte

func TestCcusagePricingOverridesMatchTheTypeScriptGolden(t *testing.T) {
	var golden struct {
		Catalogue json.RawMessage `json:"catalogue"`
		Fallback  map[string]any  `json:"fallback"`
		Overrides map[string]any  `json:"overrides"`
	}
	decoder := json.NewDecoder(bytes.NewReader(ccusageOverridesGolden))
	decoder.UseNumber()
	if err := decoder.Decode(&golden); err != nil {
		t.Fatalf("parse goldens/ccusage-overrides.json: %v", err)
	}

	parsed, err := ValidateResponse(golden.Catalogue)
	if err != nil {
		t.Fatalf("validate the golden catalogue: %v", err)
	}
	overrides := CreateCcusagePricingOverrides(parsed.Models)
	merged := mergePricingOverrides(
		readPricingOverrides(golden.Fallback),
		overrides,
		map[string]any{},
		nonRepresentableContextPricingModelIDs(parsed.Models, overrides),
	)

	got, ok := normalizeJSONNumbers(merged).(map[string]any)
	if !ok {
		t.Fatalf("merged overrides is %T, want an object", merged)
	}
	want, ok := normalizeJSONNumbers(golden.Overrides).(map[string]any)
	if !ok {
		t.Fatalf("golden overrides is %T, want an object", golden.Overrides)
	}

	keys := make([]string, 0, len(got)+len(want))
	for key := range got {
		keys = append(keys, key)
	}
	for key := range want {
		if _, seen := got[key]; !seen {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	for _, key := range keys {
		if !reflect.DeepEqual(got[key], want[key]) {
			t.Errorf("pricingOverrides[%q] = %v, want %v", key, got[key], want[key])
		}
	}
}

// normalizeJSONNumbers rewrites every json.Number as a float64 so a value that
// travelled through the fallback layer (still json.Number) compares equal to
// the same value computed from the catalogue.
func normalizeJSONNumbers(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, entry := range typed {
			result[key] = normalizeJSONNumbers(entry)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for index, entry := range typed {
			result[index] = normalizeJSONNumbers(entry)
		}
		return result
	case json.Number:
		number, err := typed.Float64()
		if err != nil {
			return typed
		}
		return number
	default:
		return value
	}
}
