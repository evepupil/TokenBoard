package pricing

// Port of packages/collector/src/ccusage-config.test.ts.
//
// The TS suite reads packages/collector/ccusage.json from the repo. The Go suite
// reads the embedded copy (clients/go/internal/pricing/ccusage.json), which
// catalogue.go requires to stay byte-identical to the TS file.

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func bundledCcusageConfig(t *testing.T) map[string]any {
	t.Helper()
	var value any
	decoder := json.NewDecoder(bytes.NewReader(bundledConfig))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("decode bundled ccusage config: %v", err)
	}
	config, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("bundled ccusage config is %T, want an object", value)
	}
	return config
}

func bundledPricingOverrides(t *testing.T) map[string]any {
	t.Helper()
	return pricingOverridesOf(t, bundledCcusageConfig(t))
}

// numericRecord flattens one override entry so an unexpected extra key fails the
// comparison, the way the TS toEqual assertions do.
func numericRecord(t *testing.T, value any) map[string]float64 {
	t.Helper()
	record, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("override entry is %T, want an object", value)
	}
	numbers := make(map[string]float64, len(record))
	for key, entry := range record {
		numbers[key] = testNumber(t, entry)
	}
	return numbers
}

func TestKeepsCodexSpeedNormalizationOnCcusageAutomaticMode(t *testing.T) {
	config := bundledCcusageConfig(t)
	codex, ok := config["codex"].(map[string]any)
	if !ok {
		t.Fatalf("codex is %T, want an object", config["codex"])
	}
	defaults, ok := codex["defaults"].(map[string]any)
	if !ok {
		t.Fatalf("codex.defaults is %T, want an object", codex["defaults"])
	}
	if defaults["speed"] != "auto" {
		t.Fatalf("codex.defaults.speed = %v, want auto", defaults["speed"])
	}
}

func TestUsesCcusage20_0_33CompatibleGrokLongContextFields(t *testing.T) {
	overrides := bundledPricingOverrides(t)
	got := numericRecord(t, overrides["grok-4.5"])
	want := map[string]float64{
		"cacheReadInputTokenCost":                perMillion(0.3),
		"cacheReadInputTokenCostAbove200kTokens": perMillion(0.6),
		"inputCostPerToken":                      perMillion(2),
		"inputCostPerTokenAbove200kTokens":       perMillion(4),
		"outputCostPerToken":                     perMillion(6),
		"outputCostPerTokenAbove200kTokens":      perMillion(12),
		"maxInputTokens":                         500_000,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("grok-4.5 override = %v, want %v", got, want)
	}
}

func TestDoesNotEncode272kGPTPricingThresholdAsCcusageAbove200kFields(t *testing.T) {
	overrides := bundledPricingOverrides(t)
	gptModels := []string{
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
		"gpt-5.6",
		"gpt-5.5",
		"gpt-5.5-pro",
		"gpt-5.4",
		"gpt-5.4-pro",
	}

	for _, modelID := range gptModels {
		override := overrideOf(t, overrides, modelID)
		for key := range override {
			if strings.HasSuffix(key, "Above200kTokens") {
				t.Fatalf("%s encodes %s", modelID, key)
			}
		}
		maxInputTokens, ok := override["maxInputTokens"]
		if !ok {
			t.Fatalf("%s has no maxInputTokens", modelID)
		}
		if got := testNumber(t, maxInputTokens); got <= 272_000 {
			t.Fatalf("%s maxInputTokens = %v, want > 272000", modelID, got)
		}
	}
}

func TestDoesNotInventCacheReadPriceForGPT54Pro(t *testing.T) {
	override := overrideOf(t, bundledPricingOverrides(t), "gpt-5.4-pro")
	if _, ok := override["cacheReadInputTokenCost"]; ok {
		t.Fatalf("gpt-5.4-pro carries a cacheReadInputTokenCost")
	}
}

func TestPinsOnlyUnambiguousFallbackPricesForFreeAndSingleSourceModels(t *testing.T) {
	overrides := bundledPricingOverrides(t)
	pinned := map[string]map[string]float64{
		"LongCat-2.5-Preview": {
			"inputCostPerToken":       perMillion(0.75),
			"outputCostPerToken":      perMillion(2.95),
			"cacheReadInputTokenCost": perMillion(0.015),
			"maxInputTokens":          1_000_000,
		},
		"deepseek-flash": {
			"inputCostPerToken":       perMillion(0.15),
			"outputCostPerToken":      perMillion(0.6),
			"cacheReadInputTokenCost": perMillion(0.003),
			"maxInputTokens":          1_000_000,
		},
		// ccusage matches keys case-sensitively and the catalogue publishes this
		// id under both spellings, so the static fallback carries both too.
		"longcat-2.5-preview": {
			"inputCostPerToken":       perMillion(0.75),
			"outputCostPerToken":      perMillion(2.95),
			"cacheReadInputTokenCost": perMillion(0.015),
			"maxInputTokens":          1_000_000,
		},
	}
	for modelID, want := range pinned {
		if got := numericRecord(t, overrides[modelID]); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s override = %v, want %v", modelID, got, want)
		}
	}
	if got, want := numericRecord(t, overrides["deepseek/deepseek-flash"]),
		numericRecord(t, overrides["deepseek-flash"]); !reflect.DeepEqual(got, want) {
		t.Fatalf("deepseek/deepseek-flash override = %v, want %v", got, want)
	}
	for _, free := range []string{"longcat-2.5-preview-free", "MiniMax-M3.1-Flash-Preview", "step-5-preview-free"} {
		override := overrideOf(t, overrides, free)
		requireNumber(t, override, "inputCostPerToken", 0)
		requireNumber(t, override, "outputCostPerToken", 0)
	}
}
