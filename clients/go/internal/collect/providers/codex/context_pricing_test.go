package codex

// Port of codex-context-pricing.test.ts. Each Test function mirrors one TS
// `test(...)` block; the `test.each` tables become subtests so a failing case
// names its row.

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/pricing"
)

// maxCodexChildSessionLineBytes is codex-subagent-usage-child.ts's
// maxCodexChildSessionLineBytes, the reader budget the oversized-row tests
// cross.
const maxCodexChildSessionLineBytes = 1024 * 1024

func floatPtr(value float64) *float64 { return &value }

func stringPtr(value string) *string { return &value }

func assertCloseTo(t *testing.T, got, want float64, digits int) {
	t.Helper()
	tolerance := 0.5 * math.Pow(10, -float64(digits))
	if math.Abs(got-want) >= tolerance {
		t.Fatalf("got %.17g, want %.17g (±%.3g)", got, want, tolerance)
	}
}

func assertPriceCloseTo(t *testing.T, got *float64, want float64, digits int) {
	t.Helper()
	if got == nil {
		t.Fatalf("got nil price, want %.17g", want)
	}
	assertCloseTo(t, *got, want, digits)
}

// writeJSONL writes rows exactly as the TS helper does: compact JSON, one per
// line, with a trailing newline.
func writeJSONL(t *testing.T, filePath string, rows []map[string]any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	var builder strings.Builder
	for _, row := range rows {
		encoded, err := json.Marshal(row)
		if err != nil {
			t.Fatalf("marshal row: %v", err)
		}
		builder.Write(encoded)
		builder.WriteByte('\n')
	}
	if err := os.WriteFile(filePath, []byte(builder.String()), 0o644); err != nil {
		t.Fatalf("write jsonl: %v", err)
	}
}

func writeRawFile(t *testing.T, filePath, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filePath, []byte(content), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
}

func mustMarshal(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return encoded
}

func usage(inputTokens float64) map[string]any {
	return map[string]any{
		"input_tokens":  inputTokens,
		"output_tokens": float64(0),
		"total_tokens":  inputTokens,
	}
}

// tokenCount builds a token_count event. An empty model omits the model field
// (the TS helper's `model: null`); every other value is written verbatim.
func tokenCount(timestamp string, usagePayload map[string]any, model string) map[string]any {
	info := map[string]any{}
	if model != "" {
		info["model"] = model
	}
	for key, value := range usagePayload {
		info[key] = value
	}
	return map[string]any{
		"timestamp": timestamp,
		"type":      "event_msg",
		"payload": map[string]any{
			"type": "token_count",
			"info": info,
		},
	}
}

func sessionMeta(id string) map[string]any {
	return map[string]any{"type": "session_meta", "id": id}
}

func turnContext(model string) map[string]any {
	return map[string]any{"type": "turn_context", "payload": map[string]any{"model": model}}
}

func costsFromFiles(t *testing.T, input CollectFilesInput) ([]CodexContextPricingCost, error) {
	t.Helper()
	return CollectCodexContextPricingCostsFromFiles(input)
}

func mustCostsFromFiles(t *testing.T, input CollectFilesInput) []CodexContextPricingCost {
	t.Helper()
	costs, err := costsFromFiles(t, input)
	if err != nil {
		t.Fatalf("collect costs: %v", err)
	}
	return costs
}

func assertCostsEqual(t *testing.T, got, want []CodexContextPricingCost) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d costs (%+v), want %d (%+v)", len(got), got, len(want), want)
	}
	for index := range want {
		if got[index].UsageDate != want[index].UsageDate || got[index].Model != want[index].Model {
			t.Fatalf("cost[%d] = %+v, want %+v", index, got[index], want[index])
		}
		assertCloseTo(t, got[index].CostUSD, want[index].CostUSD, 12)
	}
}

func TestRejectsAnUnboundedFullHistoryScanBeforeOpeningFiles(t *testing.T) {
	filePaths := make([]string, MaxCodexContextPricingFiles+1)
	for index := range filePaths {
		filePaths[index] = fmt.Sprintf("/unreadable/codex-session-%d.jsonl", index)
	}

	_, err := costsFromFiles(t, CollectFilesInput{FilePaths: filePaths, Timezone: "UTC"})
	if err == nil {
		t.Fatal("expected the oversized scan to be rejected")
	}
	if !strings.Contains(err.Error(), fmt.Sprintf("exceeds %d", MaxCodexContextPricingFiles)) {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestUsesTheGPT56RequestTierAtInputTokens(t *testing.T) {
	cases := []struct {
		inputTokens float64
		inputRate   float64
	}{
		{271_999, 5.0 / 1_000_000.0},
		{272_000, 5.0 / 1_000_000.0},
		{272_001, 10.0 / 1_000_000.0},
	}
	for _, testCase := range cases {
		t.Run(fmt.Sprintf("%d", int64(testCase.inputTokens)), func(t *testing.T) {
			cost := PriceCodexRequest(PriceRequestInput{
				Model:       "gpt-5.6-sol",
				InputTokens: testCase.inputTokens,
			})
			assertPriceCloseTo(t, cost, testCase.inputTokens*testCase.inputRate, 12)
		})
	}
}

func TestUsesTheLongContextTierWhenCacheCreationCrossesThe272kRequestBoundary(t *testing.T) {
	cost := PriceCodexRequest(PriceRequestInput{
		Model:               "gpt-5.6-sol",
		InputTokens:         272_000,
		CacheCreationTokens: 1,
	})
	assertPriceCloseTo(t, cost, (272_000*10+12.5)/1_000_000.0, 12)
}

func TestUsesTheGrokRequestTierAtInputTokens(t *testing.T) {
	cases := []struct {
		inputTokens float64
		inputRate   float64
	}{
		{199_999, 2.0 / 1_000_000.0},
		{200_000, 2.0 / 1_000_000.0},
		{200_001, 4.0 / 1_000_000.0},
	}
	for _, testCase := range cases {
		t.Run(fmt.Sprintf("%d", int64(testCase.inputTokens)), func(t *testing.T) {
			cost := PriceCodexRequest(PriceRequestInput{
				Model:       "grok-4.5",
				InputTokens: testCase.inputTokens,
			})
			assertPriceCloseTo(t, cost, testCase.inputTokens*testCase.inputRate, 12)
		})
	}
}

func TestUsesThePublished272kTierFor(t *testing.T) {
	cases := []struct {
		model     string
		inputRate float64
	}{
		{"gpt-5.6-terra", 4.0 / 1_000_000.0},
		{"gpt-5.6-luna", 0.4 / 1_000_000.0},
		{"gpt-5.5", 10.0 / 1_000_000.0},
		{"gpt-5.5-pro", 60.0 / 1_000_000.0},
		{"gpt-5.4", 5.0 / 1_000_000.0},
		{"gpt-5.4-pro", 60.0 / 1_000_000.0},
	}
	for _, testCase := range cases {
		t.Run(testCase.model, func(t *testing.T) {
			cost := PriceCodexRequest(PriceRequestInput{
				Model:       testCase.model,
				InputTokens: 272_001,
			})
			assertPriceCloseTo(t, cost, 272_001*testCase.inputRate, 12)
		})
	}
}

func TestPricesEveryComponentWithTheLongContextTierNotOnlyInputTokens(t *testing.T) {
	cost := PriceCodexRequest(PriceRequestInput{
		Model:               "gpt-5.6-sol",
		InputTokens:         272_001,
		OutputTokens:        1,
		CacheReadTokens:     1,
		CacheCreationTokens: 1,
	})
	assertPriceCloseTo(t, cost, (272_000*10+1+12.5+45)/1_000_000.0, 12)
}

func TestPricesAdditiveCachedInputSeparatelyFromUncachedInput(t *testing.T) {
	cost := PriceCodexRequest(PriceRequestInput{
		Model:               "gpt-5.6-sol",
		InputTokens:         200,
		UncachedInputTokens: floatPtr(50),
		OutputTokens:        20,
		CacheReadTokens:     150,
	})
	assertPriceCloseTo(t, cost, (50*5+150*0.5+20*30)/1_000_000.0, 12)
}

func TestAppliesTheFastAndPriorityMultiplierAndNormalizesDatedModelIDs(t *testing.T) {
	standard := PriceCodexRequest(PriceRequestInput{
		Model:               "gpt-5.6-sol-20260807",
		InputTokens:         10,
		OutputTokens:        2,
		CacheReadTokens:     1,
		CacheCreationTokens: 1,
		ServiceTier:         ServiceTierStandard,
	})
	fast := PriceCodexRequest(PriceRequestInput{
		Model:               "gpt-5.6-sol-20260807",
		InputTokens:         10,
		OutputTokens:        2,
		CacheReadTokens:     1,
		CacheCreationTokens: 1,
		ServiceTier:         ServiceTierFast,
	})
	priority := PriceCodexRequest(PriceRequestInput{
		Model:               "gpt-5.6-sol",
		InputTokens:         10,
		OutputTokens:        2,
		CacheReadTokens:     1,
		CacheCreationTokens: 1,
		ServiceTier:         ServiceTierPriority,
	})

	for _, result := range []*float64{standard, fast, priority} {
		if result == nil || math.IsNaN(*result) || math.IsInf(*result, 0) {
			t.Fatalf("expected a finite price, got %v", result)
		}
	}
	assertPriceCloseTo(t, fast, *standard*2, 12)
	assertPriceCloseTo(t, priority, *fast, 12)
}

func TestInjectsADynamic272kRuleWithoutMappingItToCcusage200kPricing(t *testing.T) {
	rules := BuildCodexContextPricingRules(
		[]pricing.Model{{
			ModelID:                  "gpt-6-astra",
			InputCostPerMillion:      5,
			OutputCostPerMillion:     30,
			CacheReadCostPerMillion:  floatPtr(0.5),
			CacheWriteCostPerMillion: floatPtr(6),
			Pricing: map[string]any{
				"tiers": []any{map[string]any{
					"tier":        map[string]any{"type": "context", "size": float64(272_000)},
					"input":       float64(10),
					"output":      float64(45),
					"cache_read":  float64(1),
					"cache_write": float64(12),
				}},
				"priority_multiplier": float64(3),
			},
		}},
		nil, nil, nil,
	)

	err := WithCodexContextPricingRules(rules, func(scoped *Rules) error {
		cost := scoped.PriceCodexRequest(PriceRequestInput{
			Model:               "gpt-6-astra",
			InputTokens:         272_001,
			OutputTokens:        2,
			CacheReadTokens:     3,
			CacheCreationTokens: 4,
			ServiceTier:         ServiceTierPriority,
		})
		assertPriceCloseTo(t, cost, (3*((272_001-3)*10+2*45+3*1+4*12))/1_000_000.0, 12)
		return nil
	})
	if err != nil {
		t.Fatalf("scoped pricing: %v", err)
	}

	if cost := PriceCodexRequest(PriceRequestInput{Model: "gpt-6-astra", InputTokens: 1}); cost != nil {
		t.Fatalf("expected the dynamic rule to be scoped, got %v", *cost)
	}
}

func TestRemovesAStaleStaticRuleWhenALaterContextTierChangesTheEffectiveRates(t *testing.T) {
	diagnostics := []string{}
	baseRules := []CodexContextPricingRule{{
		ModelIDs:    []string{"gpt-6-multi-tier", "gpt-6-stable"},
		Threshold:   200_000,
		Standard:    PricingRates{Input: 1, Output: 2, CacheRead: 3, CacheCreation: 4},
		LongContext: PricingRates{Input: 5, Output: 6, CacheRead: 7, CacheCreation: 8},
	}}
	rules := BuildCodexContextPricingRules(
		[]pricing.Model{{
			ModelID:                  "gpt-6-multi-tier",
			InputCostPerMillion:      5,
			OutputCostPerMillion:     30,
			CacheReadCostPerMillion:  floatPtr(0.5),
			CacheWriteCostPerMillion: floatPtr(6),
			Pricing: map[string]any{
				"tiers": []any{
					map[string]any{
						"tier":        map[string]any{"type": "context", "size": float64(200_000)},
						"input":       float64(10),
						"output":      float64(45),
						"cache_read":  float64(1),
						"cache_write": float64(12),
					},
					map[string]any{
						"tier":        map[string]any{"type": "context", "size": float64(1_000_000)},
						"input":       float64(20),
						"output":      float64(90),
						"cache_read":  float64(2),
						"cache_write": float64(24),
					},
				},
			},
		}},
		baseRules,
		func(line string) { diagnostics = append(diagnostics, line) },
		nil,
	)

	want := []CodexContextPricingRule{{
		ModelIDs:    []string{"gpt-6-stable"},
		Threshold:   200_000,
		Standard:    PricingRates{Input: 1, Output: 2, CacheRead: 3, CacheCreation: 4},
		LongContext: PricingRates{Input: 5, Output: 6, CacheRead: 7, CacheCreation: 8},
	}}
	if !reflect.DeepEqual(rules, want) {
		t.Fatalf("rules = %+v, want %+v", rules, want)
	}
	wantDiagnostics := []string{
		"TokenBoard model pricing: skipping dynamic Codex context rule for gpt-6-multi-tier; multiple changing context tiers cannot be represented by the request-level rule",
	}
	if !reflect.DeepEqual(diagnostics, wantDiagnostics) {
		t.Fatalf("diagnostics = %v, want %v", diagnostics, wantDiagnostics)
	}

	err := WithCodexContextPricingRules(rules, func(scoped *Rules) error {
		if cost := scoped.PriceCodexRequest(PriceRequestInput{Model: "gpt-6-multi-tier", InputTokens: 1}); cost != nil {
			t.Fatalf("expected gpt-6-multi-tier to be unpriced, got %v", *cost)
		}
		cost := scoped.PriceCodexRequest(PriceRequestInput{Model: "gpt-6-stable", InputTokens: 1})
		if cost == nil || *cost != 1 {
			t.Fatalf("gpt-6-stable price = %v, want 1", cost)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("scoped pricing: %v", err)
	}
}

func TestResolvesDatedDynamicAliasesAgainstTheSuppliedBaseRules(t *testing.T) {
	rules := BuildCodexContextPricingRules(
		[]pricing.Model{{
			ModelID:              "gpt-6-astra-20260901",
			InputCostPerMillion:  5,
			OutputCostPerMillion: 30,
			Pricing: map[string]any{
				"tiers": []any{map[string]any{
					"tier":   map[string]any{"type": "context", "size": float64(272_000)},
					"input":  float64(10),
					"output": float64(45),
				}},
			},
		}},
		[]CodexContextPricingRule{{
			ModelIDs:    []string{"gpt-6-astra"},
			Threshold:   200_000,
			Standard:    PricingRates{Input: 1, Output: 1, CacheRead: 0, CacheCreation: 0},
			LongContext: PricingRates{Input: 2, Output: 2, CacheRead: 0, CacheCreation: 0},
		}},
		nil, nil,
	)

	err := WithCodexContextPricingRules(rules, func(scoped *Rules) error {
		cost := scoped.PriceCodexRequest(PriceRequestInput{
			Model:       "gpt-6-astra-20260901",
			InputTokens: 272_001,
		})
		assertPriceCloseTo(t, cost, (272_001*10)/1_000_000.0, 12)
		return nil
	})
	if err != nil {
		t.Fatalf("scoped pricing: %v", err)
	}
}

func TestSplitsASharedStaticRuleBeforeApplyingDifferentDynamicModelPrices(t *testing.T) {
	rules := BuildCodexContextPricingRules(
		[]pricing.Model{
			{
				ModelID:                  "gpt-5.6-sol",
				InputCostPerMillion:      11,
				OutputCostPerMillion:     31,
				CacheReadCostPerMillion:  floatPtr(1),
				CacheWriteCostPerMillion: floatPtr(2),
				Pricing: map[string]any{
					"tiers": []any{map[string]any{
						"tier":   map[string]any{"type": "context", "size": float64(272_000)},
						"input":  float64(11),
						"output": float64(31),
					}},
				},
			},
			{
				ModelID:                  "gpt-5.6",
				InputCostPerMillion:      22,
				OutputCostPerMillion:     42,
				CacheReadCostPerMillion:  floatPtr(1),
				CacheWriteCostPerMillion: floatPtr(2),
				Pricing: map[string]any{
					"tiers": []any{map[string]any{
						"tier":   map[string]any{"type": "context", "size": float64(272_000)},
						"input":  float64(22),
						"output": float64(42),
					}},
				},
			},
		},
		nil, nil, nil,
	)

	relevantRules := []CodexContextPricingRule{}
	for _, rule := range rules {
		for _, modelID := range rule.ModelIDs {
			if modelID == "gpt-5.6-sol" || modelID == "gpt-5.6" {
				relevantRules = append(relevantRules, rule)
				break
			}
		}
	}
	if len(relevantRules) != 2 {
		t.Fatalf("relevant rules = %d, want 2 (%+v)", len(relevantRules), relevantRules)
	}
	solRule := findRuleContaining(relevantRules, "gpt-5.6-sol")
	if solRule == nil {
		t.Fatal("missing gpt-5.6-sol rule")
	}
	if solRule.Standard.Input != 11.0/1_000_000.0 {
		t.Fatalf("gpt-5.6-sol standard input = %v, want %v", solRule.Standard.Input, 11.0/1_000_000.0)
	}
	baseRule := findRuleContaining(relevantRules, "gpt-5.6")
	if baseRule == nil {
		t.Fatal("missing gpt-5.6 rule")
	}
	if baseRule.Standard.Input != 22.0/1_000_000.0 {
		t.Fatalf("gpt-5.6 standard input = %v, want %v", baseRule.Standard.Input, 22.0/1_000_000.0)
	}
	for _, modelID := range solRule.ModelIDs {
		if modelID == "gpt-5.6" {
			t.Fatalf("gpt-5.6-sol rule still contains gpt-5.6: %v", solRule.ModelIDs)
		}
	}
}

func findRuleContaining(rules []CodexContextPricingRule, modelID string) *CodexContextPricingRule {
	for index := range rules {
		for _, candidate := range rules[index].ModelIDs {
			if candidate == modelID {
				return &rules[index]
			}
		}
	}
	return nil
}

func TestExcludesADatedExplicitOverrideFromTheCorrespondingContextRule(t *testing.T) {
	rules := BuildCodexContextPricingRules(
		[]pricing.Model{{
			ModelID:                  "gpt-5.6-sol-20260901",
			InputCostPerMillion:      11,
			OutputCostPerMillion:     31,
			CacheReadCostPerMillion:  floatPtr(1),
			CacheWriteCostPerMillion: floatPtr(2),
			Pricing: map[string]any{
				"tiers": []any{map[string]any{
					"tier":   map[string]any{"type": "context", "size": float64(272_000)},
					"input":  float64(11),
					"output": float64(31),
				}},
			},
		}},
		nil, nil,
		map[string]bool{"gpt-5.6-sol-20260901": true},
	)

	for _, rule := range rules {
		for _, modelID := range rule.ModelIDs {
			if modelID == "gpt-5.6-sol" || modelID == "gpt-5.6-sol-20260901" {
				t.Fatalf("excluded model still present: %v", rule.ModelIDs)
			}
		}
	}
}

func TestSkipsADynamicModelWhoseIDIsPublishedByMultipleProviders(t *testing.T) {
	rules := BuildCodexContextPricingRules(
		[]pricing.Model{
			{
				Provider:             "openai",
				ModelID:              "provider-collision",
				InputCostPerMillion:  1,
				OutputCostPerMillion: 2,
				Pricing: map[string]any{
					"tiers": []any{map[string]any{
						"tier":   map[string]any{"type": "context", "size": float64(200_000)},
						"input":  float64(3),
						"output": float64(4),
					}},
				},
			},
			{
				Provider:             "azure",
				ModelID:              "provider-collision",
				InputCostPerMillion:  99,
				OutputCostPerMillion: 98,
				Pricing: map[string]any{
					"tiers": []any{map[string]any{
						"tier":   map[string]any{"type": "context", "size": float64(200_000)},
						"input":  float64(97),
						"output": float64(96),
					}},
				},
			},
		},
		[]CodexContextPricingRule{},
		nil, nil,
	)

	if len(rules) != 0 {
		t.Fatalf("rules = %+v, want none", rules)
	}
}

func TestPreservesExistingStandardCachePricesWhenTheCatalogueOmitsThem(t *testing.T) {
	rules := BuildCodexContextPricingRules(
		[]pricing.Model{{
			ModelID:              "gpt-5.6-luna",
			InputCostPerMillion:  7,
			OutputCostPerMillion: 31,
			Pricing: map[string]any{
				"tiers": []any{map[string]any{
					"tier":   map[string]any{"type": "context", "size": float64(272_000)},
					"input":  float64(14),
					"output": float64(46),
				}},
			},
		}},
		nil, nil, nil,
	)
	rule := findRuleContaining(rules, "gpt-5.6-luna")
	if rule == nil {
		t.Fatal("missing gpt-5.6-luna rule")
	}
	want := PricingRates{
		Input:         7.0 / 1_000_000.0,
		Output:        31.0 / 1_000_000.0,
		CacheRead:     0.02 / 1_000_000.0,
		CacheCreation: 0.25 / 1_000_000.0,
	}
	if rule.Standard != want {
		t.Fatalf("standard = %+v, want %+v", rule.Standard, want)
	}
}

func TestSkipsADynamicContextRuleWhenCachePricesAreIncompleteWithoutAStaticFallback(t *testing.T) {
	diagnostics := []string{}
	rules := BuildCodexContextPricingRules(
		[]pricing.Model{{
			Provider:             "openai",
			ModelID:              "gpt-6-cache-unknown",
			InputCostPerMillion:  5,
			OutputCostPerMillion: 30,
			Pricing: map[string]any{
				"tiers": []any{map[string]any{
					"tier":   map[string]any{"type": "context", "size": float64(272_000)},
					"input":  float64(10),
					"output": float64(45),
				}},
			},
		}},
		[]CodexContextPricingRule{},
		func(line string) { diagnostics = append(diagnostics, line) },
		nil,
	)

	if len(rules) != 0 {
		t.Fatalf("rules = %+v, want none", rules)
	}
	want := []string{
		"TokenBoard model pricing: skipping dynamic Codex context rule for gpt-6-cache-unknown; cache pricing is incomplete (cache-read, cache-write)",
	}
	if !reflect.DeepEqual(diagnostics, want) {
		t.Fatalf("diagnostics = %v, want %v", diagnostics, want)
	}
}

func TestKeepsConcurrentDynamicPricingContextsIsolated(t *testing.T) {
	makeRules := func(modelID string, input float64) []CodexContextPricingRule {
		return BuildCodexContextPricingRules(
			[]pricing.Model{{
				ModelID:                  modelID,
				InputCostPerMillion:      input,
				OutputCostPerMillion:     0,
				CacheReadCostPerMillion:  floatPtr(0),
				CacheWriteCostPerMillion: floatPtr(0),
				Pricing: map[string]any{
					"tiers": []any{map[string]any{
						"tier":   map[string]any{"type": "context", "size": float64(200_000)},
						"input":  input,
						"output": float64(0),
					}},
				},
			}},
			nil, nil, nil,
		)
	}

	results := make([]float64, 2)
	failures := make([]error, 2)
	var waitGroup sync.WaitGroup
	waitGroup.Add(2)
	go func() {
		defer waitGroup.Done()
		failures[0] = WithCodexContextPricingRules(makeRules("dynamic-a", 1), func(scoped *Rules) error {
			cost := scoped.PriceCodexRequest(PriceRequestInput{Model: "dynamic-a", InputTokens: 1})
			if cost == nil {
				return fmt.Errorf("dynamic-a was not priced")
			}
			results[0] = *cost
			return nil
		})
	}()
	go func() {
		defer waitGroup.Done()
		failures[1] = WithCodexContextPricingRules(makeRules("dynamic-b", 2), func(scoped *Rules) error {
			cost := scoped.PriceCodexRequest(PriceRequestInput{Model: "dynamic-b", InputTokens: 1})
			if cost == nil {
				return fmt.Errorf("dynamic-b was not priced")
			}
			results[1] = *cost
			return nil
		})
	}()
	waitGroup.Wait()
	for _, err := range failures {
		if err != nil {
			t.Fatalf("scoped pricing: %v", err)
		}
	}
	assertCloseTo(t, results[0], 1.0/1_000_000.0, 12)
	assertCloseTo(t, results[1], 2.0/1_000_000.0, 12)
}

func TestOnlyStripsValidCalendarDatesFromModelIDs(t *testing.T) {
	cases := []struct{ value, want string }{
		{"gpt-5.6-sol-20260807", "gpt-5.6-sol"},
		{"gpt-5.6-sol-20240229", "gpt-5.6-sol"},
		{"gpt-5.6-sol-20260230", "gpt-5.6-sol-20260230"},
		{"gpt-5.6-sol-20250229", "gpt-5.6-sol-20250229"},
		{"gpt-5.6-sol-20251301", "gpt-5.6-sol-20251301"},
		{"gpt-5.6-sol-20250132", "gpt-5.6-sol-20250132"},
		{"gpt-5.6-sol-12345678", "gpt-5.6-sol-12345678"},
		{"-20260807", "-20260807"},
		{"", ""},
		{"  ", ""},
		{"GPT-4", "gpt-4"},
		{"gpt-5-20241201", "gpt-5-20241201"},
		{"model-2026-0807", "model-2026-0807"},
	}
	for _, testCase := range cases {
		t.Run(fmt.Sprintf("%q", testCase.value), func(t *testing.T) {
			if got := NormalizeModelID(testCase.value); got != testCase.want {
				t.Fatalf("NormalizeModelID(%q) = %q, want %q", testCase.value, got, testCase.want)
			}
		})
	}
}

func TestReconstructsCumulativeTokenRowsAndDeduplicatesOnlyIdenticalEventsAcrossFiles(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "sessions", "first.jsonl")
	duplicate := filepath.Join(root, "sessions", "duplicate.jsonl")
	distinct := filepath.Join(root, "sessions", "distinct.jsonl")
	rows := []map[string]any{
		tokenCount("2026-05-01T00:00:00.000Z", map[string]any{
			"last_token_usage": map[string]any{
				"input_tokens": float64(271_999), "output_tokens": float64(1), "total_tokens": float64(272_000),
			},
		}, "gpt-5.6-sol"),
		tokenCount("2026-05-01T00:01:00.000Z", map[string]any{
			"last_token_usage": map[string]any{
				"input_tokens": float64(272_001), "output_tokens": float64(1), "total_tokens": float64(272_002),
			},
		}, "gpt-5.6-sol"),
	}
	writeJSONL(t, first, append([]map[string]any{sessionMeta("same-session")}, rows...))
	writeJSONL(t, duplicate, append([]map[string]any{sessionMeta("same-session")}, rows...))
	writeJSONL(t, distinct, []map[string]any{
		sessionMeta("different-session"),
		tokenCount("2026-05-01T00:02:00.000Z", map[string]any{
			"last_token_usage": map[string]any{
				"input_tokens": float64(272_001), "output_tokens": float64(1), "total_tokens": float64(272_002),
			},
		}, "gpt-5.6-sol"),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths: []string{first, duplicate, distinct},
		Timezone:  "UTC",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-05-01",
		Model:     "gpt-5.6-sol",
		CostUSD:   (271_999*5+30)/1_000_000.0 + 2*((272_001*10+45)/1_000_000.0),
	}})
}

func TestDoesNotDeduplicateEqualUsageFromDifferentSessions(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "sessions", "first.jsonl")
	second := filepath.Join(root, "sessions", "second.jsonl")
	row := tokenCount("2026-05-01T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, "gpt-5.6-sol")
	writeJSONL(t, first, []map[string]any{sessionMeta("first-session"), row})
	writeJSONL(t, second, []map[string]any{sessionMeta("second-session"), row})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths: []string{first, second},
		Timezone:  "UTC",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: (20 * 5) / 1_000_000.0,
	}})
}

func TestUsesTheStableSessionIDWhenCodexEmitsAPerRecordID(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "sessions", "session.jsonl")
	writeJSONL(t, file, []map[string]any{
		{"type": "session_meta", "payload": map[string]any{"session_id": "stable-session", "id": "subagent-record"}},
		{"type": "session_meta", "payload": map[string]any{"session_id": "stable-session", "id": "root-record"}},
		tokenCount("2026-05-01T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, "gpt-5.6-sol"),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: (10 * 5) / 1_000_000.0,
	}})
}

func TestSkipsContextPricingModelsOutsideTheCcusageDailyModelScope(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "sessions", "excluded.jsonl")
	writeJSONL(t, file, []map[string]any{
		sessionMeta("excluded-session"),
		tokenCount("2026-05-01T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, "gpt-5.4"),
	})

	diagnostics := []string{}
	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths: []string{file},
		CanonicalModelsByDate: CodexContextPricingModelHints{
			"2026-05-01": {"gpt-5.5": true, "gpt-5.6-sol": true},
		},
		Timezone: "UTC",
		Stderr:   func(line string) { diagnostics = append(diagnostics, line) },
	})
	if len(costs) != 0 {
		t.Fatalf("costs = %+v, want none", costs)
	}
	want := []string{
		"Codex context pricing skipped gpt-5.4 usage outside the ccusage daily model scope for 2026-05-01",
	}
	if !reflect.DeepEqual(diagnostics, want) {
		t.Fatalf("diagnostics = %v, want %v", diagnostics, want)
	}
}

func TestDeduplicatesAnArchivedCopyWhenSessionMetadataHasNoIdentity(t *testing.T) {
	root := t.TempDir()
	active := filepath.Join(root, "sessions", "2026", "05", "20", "same-file.jsonl")
	archived := filepath.Join(root, "archived_sessions", "2026", "05", "20", "same-file.jsonl")
	row := tokenCount("2026-05-01T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, "gpt-5.6-sol")
	writeJSONL(t, active, []map[string]any{row})
	writeJSONL(t, archived, []map[string]any{row})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths: []string{active, archived},
		Timezone:  "UTC",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: (10 * 5) / 1_000_000.0,
	}})
}

func TestPrefersTheActiveCopyWhenActiveAndArchivedContentsDiffer(t *testing.T) {
	root := t.TempDir()
	active := filepath.Join(root, "sessions", "2026", "05", "20", "same-file.jsonl")
	archived := filepath.Join(root, "archived_sessions", "2026", "05", "20", "same-file.jsonl")
	writeJSONL(t, active, []map[string]any{
		tokenCount("2026-05-01T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, "gpt-5.6-sol"),
	})
	writeJSONL(t, archived, []map[string]any{
		tokenCount("2026-05-01T00:01:00.000Z", map[string]any{"last_token_usage": usage(20)}, "gpt-5.6-sol"),
	})

	costs, err := CollectCodexContextPricingCostsFromHomes(CollectHomesInput{
		CodexHomes: []string{root},
		Timezone:   "UTC",
	})
	if err != nil {
		t.Fatalf("collect costs: %v", err)
	}
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: (10 * 5) / 1_000_000.0,
	}})
}

func TestDeduplicatesAnArchivedCopyWhenOnlyTheActiveSessionHasAnIdentity(t *testing.T) {
	root := t.TempDir()
	active := filepath.Join(root, "sessions", "2026", "05", "20", "same-file.jsonl")
	archived := filepath.Join(root, "archived_sessions", "2026", "05", "20", "same-file.jsonl")
	row := tokenCount("2026-05-01T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, "gpt-5.6-sol")
	writeJSONL(t, active, []map[string]any{sessionMeta("same-session"), row})
	writeJSONL(t, archived, []map[string]any{row})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths: []string{active, archived},
		Timezone:  "UTC",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: (10 * 5) / 1_000_000.0,
	}})
}

func TestDeduplicatesAnActiveCopyWhenOnlyTheArchivedSessionHasAnIdentity(t *testing.T) {
	root := t.TempDir()
	active := filepath.Join(root, "sessions", "2026", "05", "20", "same-file.jsonl")
	archived := filepath.Join(root, "archived_sessions", "2026", "05", "20", "same-file.jsonl")
	row := tokenCount("2026-05-01T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, "gpt-5.6-sol")
	writeJSONL(t, active, []map[string]any{row})
	writeJSONL(t, archived, []map[string]any{sessionMeta("same-session"), row})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths: []string{archived, active},
		Timezone:  "UTC",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: (10 * 5) / 1_000_000.0,
	}})
}

func TestDoesNotDoubleCountWhenOnlyOneArchiveCopyExposesIdentityAfterTheOtherWasScanned(t *testing.T) {
	root := t.TempDir()
	active := filepath.Join(root, "sessions", "2026", "05", "20", "same-file.jsonl")
	archived := filepath.Join(root, "archived_sessions", "2026", "05", "20", "same-file.jsonl")
	row := tokenCount("2026-05-01T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, "gpt-5.6-sol")
	writeJSONL(t, active, []map[string]any{row})
	writeJSONL(t, archived, []map[string]any{sessionMeta("same-session"), row})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths: []string{active, archived},
		Timezone:  "UTC",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: (10 * 5) / 1_000_000.0,
	}})
}

func TestKeepsAnonymousSessionsWithTheSameFilenameSeparateAcrossProfiles(t *testing.T) {
	root := t.TempDir()
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	relativePath := filepath.Join("2026", "05", "20", "same-file.jsonl")
	row := tokenCount("2026-05-01T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, "gpt-5.6-sol")
	writeJSONL(t, filepath.Join(firstHome, "sessions", relativePath), []map[string]any{row})
	writeJSONL(t, filepath.Join(secondHome, "sessions", relativePath), []map[string]any{row})

	costs, err := CollectCodexContextPricingCostsFromHomes(CollectHomesInput{
		CodexHomes: []string{firstHome, secondHome},
		Timezone:   "UTC",
	})
	if err != nil {
		t.Fatalf("collect costs: %v", err)
	}
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: (20 * 5) / 1_000_000.0,
	}})
}

func TestKeepsSessionsWithTheSameMetadataIDSeparateAcrossProfiles(t *testing.T) {
	root := t.TempDir()
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	relativePath := filepath.Join("2026", "05", "20", "same-session.jsonl")
	rows := []map[string]any{
		sessionMeta("same-session-id"),
		tokenCount("2026-05-01T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, "gpt-5.6-sol"),
	}
	writeJSONL(t, filepath.Join(firstHome, "sessions", relativePath), rows)
	writeJSONL(t, filepath.Join(secondHome, "sessions", relativePath), rows)

	costs, err := CollectCodexContextPricingCostsFromHomes(CollectHomesInput{
		CodexHomes: []string{firstHome, secondHome},
		Timezone:   "UTC",
	})
	if err != nil {
		t.Fatalf("collect costs: %v", err)
	}
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: (20 * 5) / 1_000_000.0,
	}})
}

func TestDeduplicatesASessionCopiedIntoASymlinkedArchiveRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privileges on Windows")
	}
	root := t.TempDir()
	home := filepath.Join(root, "codex-home")
	archive := filepath.Join(root, "archive-target")
	relativePath := filepath.Join("2026", "05", "20", "same-file.jsonl")
	row := tokenCount("2026-05-01T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, "gpt-5.6-sol")
	writeJSONL(t, filepath.Join(home, "sessions", relativePath), []map[string]any{row})
	writeJSONL(t, filepath.Join(archive, relativePath), []map[string]any{row})
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatalf("mkdir home: %v", err)
	}
	if err := os.Symlink(archive, filepath.Join(home, "archived_sessions")); err != nil {
		t.Fatalf("symlink archive root: %v", err)
	}

	costs, err := CollectCodexContextPricingCostsFromHomes(CollectHomesInput{
		CodexHomes:        []string{home},
		Timezone:          "UTC",
		CodexSymlinkRoots: []string{archive},
	})
	if err != nil {
		t.Fatalf("collect costs: %v", err)
	}
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: (10 * 5) / 1_000_000.0,
	}})
}

func TestKeepsCumulativeBaselinesSeparateWhenOneSessionChangesModels(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "sessions", "switch.jsonl")
	writeJSONL(t, file, []map[string]any{
		sessionMeta("switching-session"),
		turnContext("gpt-5.6-sol"),
		tokenCount("2026-05-01T00:00:00.000Z", map[string]any{"total_token_usage": usage(10)}, "gpt-5.6-sol"),
		turnContext("gpt-5.6-terra"),
		tokenCount("2026-05-01T00:01:00.000Z", map[string]any{"total_token_usage": usage(5)}, "gpt-5.6-terra"),
		turnContext("gpt-5.6-sol"),
		tokenCount("2026-05-01T00:02:00.000Z", map[string]any{"total_token_usage": usage(15)}, "gpt-5.6-sol"),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
	if len(costs) != 2 {
		t.Fatalf("costs = %+v, want 2", costs)
	}
	if costs[0].UsageDate != "2026-05-01" || costs[0].Model != "gpt-5.6-sol" {
		t.Fatalf("costs[0] = %+v", costs[0])
	}
	assertCloseTo(t, costs[0].CostUSD, (15*5)/1_000_000.0, 14)
	if costs[1].UsageDate != "2026-05-01" || costs[1].Model != "gpt-5.6-terra" {
		t.Fatalf("costs[1] = %+v", costs[1])
	}
	assertCloseTo(t, costs[1].CostUSD, (5*2)/1_000_000.0, 14)
}

func TestKeepsCumulativeBaselinesContinuousAcrossAliasesInOneModelFamily(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "sessions", "switch.jsonl")
	writeJSONL(t, file, []map[string]any{
		sessionMeta("alias-switch-session"),
		turnContext("gpt-5.6"),
		tokenCount("2026-05-01T00:00:00.000Z", map[string]any{"total_token_usage": usage(10)}, "gpt-5.6"),
		turnContext("gpt-5.6-sol"),
		tokenCount("2026-05-01T00:01:00.000Z", map[string]any{"total_token_usage": usage(15)}, "gpt-5.6-sol"),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
	assertCostsEqual(t, costs, []CodexContextPricingCost{
		{UsageDate: "2026-05-01", Model: "gpt-5.6", CostUSD: (10 * 5) / 1_000_000.0},
		{UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: (5 * 5) / 1_000_000.0},
	})
}

func TestMapsCodexAutoReviewUsageToTheReleaseDateFallbackModel(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "sessions", "auto-review.jsonl")
	writeJSONL(t, file, []map[string]any{
		turnContext("codex-auto-review"),
		tokenCount("2026-04-23T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, ""),
		tokenCount("2026-03-05T00:00:00.000Z", map[string]any{"last_token_usage": usage(20)}, ""),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
	assertCostsEqual(t, costs, []CodexContextPricingCost{
		{UsageDate: "2026-04-23", Model: "gpt-5.5", CostUSD: (10 * 5) / 1_000_000.0},
		{UsageDate: "2026-03-05", Model: "gpt-5.4", CostUSD: (20 * 2.5) / 1_000_000.0},
	})
}

func TestRetainsTheModelFromAnOversizedTurnContextForFollowingTokenRows(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "sessions", "oversized-turn-context.jsonl")
	diagnostics := []string{}
	writeJSONL(t, file, []map[string]any{
		{
			"type": "turn_context",
			"payload": map[string]any{
				"model":   "codex-auto-review",
				"context": strings.Repeat("x", maxCodexChildSessionLineBytes+1),
			},
		},
		tokenCount("2026-08-12T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, ""),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths: []string{file},
		Timezone:  "UTC",
		Stderr:    func(line string) { diagnostics = append(diagnostics, line) },
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-08-12", Model: "gpt-5.5", CostUSD: (10 * 5) / 1_000_000.0,
	}})
	if len(diagnostics) != 1 ||
		!strings.Contains(diagnostics[0], "Retained bounded turn_context metadata from 1 oversized Codex context pricing JSONL row") {
		t.Fatalf("diagnostics = %v", diagnostics)
	}
}

func TestAggregatesOversizedIrrelevantRowsAcrossContextPricingScans(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "sessions", "first.jsonl")
	second := filepath.Join(root, "sessions", "second.jsonl")
	diagnostics := []string{}
	oversized := map[string]any{
		"type":    "event_msg",
		"payload": map[string]any{"type": "progress", "text": strings.Repeat("x", maxCodexChildSessionLineBytes+1)},
	}
	writeJSONL(t, first, []map[string]any{
		turnContext("gpt-5.6-sol"),
		oversized,
		tokenCount("2026-08-12T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, "gpt-5.6-sol"),
	})
	writeJSONL(t, second, []map[string]any{
		turnContext("gpt-5.6-sol"),
		oversized,
		tokenCount("2026-08-12T00:01:00.000Z", map[string]any{"last_token_usage": usage(10)}, "gpt-5.6-sol"),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths: []string{first, second},
		Timezone:  "UTC",
		Stderr:    func(line string) { diagnostics = append(diagnostics, line) },
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-08-12", Model: "gpt-5.6-sol", CostUSD: (20 * 5) / 1_000_000.0,
	}})
	want := []string{fmt.Sprintf(
		"Skipped 2 oversized Codex context pricing JSONL rows without usage or subagent metadata across 2 scans (largest %d bytes)",
		len(mustMarshal(t, oversized)))}
	if !reflect.DeepEqual(diagnostics, want) {
		t.Fatalf("diagnostics = %v, want %v", diagnostics, want)
	}
}

func TestRetainsModelNameFromNestedOversizedTurnContextMetadata(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "sessions", "oversized-turn-context-metadata.jsonl")
	writeJSONL(t, file, []map[string]any{
		{
			"type": "turn_context",
			"payload": map[string]any{
				"metadata": map[string]any{"model_name": "codex-auto-review"},
				"context":  strings.Repeat("x", maxCodexChildSessionLineBytes+1),
			},
		},
		tokenCount("2026-08-12T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, ""),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-08-12", Model: "gpt-5.5", CostUSD: (10 * 5) / 1_000_000.0,
	}})
}

func TestKeepsThePrimaryOversizedTurnContextModelWhenMetadataHasAConflictingFallback(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "sessions", "oversized-turn-context-conflict.jsonl")
	writeJSONL(t, file, []map[string]any{
		{
			"type": "turn_context",
			"payload": map[string]any{
				"model":    "gpt-5.6-sol",
				"metadata": map[string]any{"model_name": "codex-auto-review"},
				"context":  strings.Repeat("x", maxCodexChildSessionLineBytes+1),
			},
		},
		tokenCount("2026-08-12T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, ""),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-08-12", Model: "gpt-5.6-sol", CostUSD: (10 * 5) / 1_000_000.0,
	}})
}

func TestUsesTheConfiguredTimezoneWhenAutoReviewCrossesAUTCDateBoundary(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "sessions", "auto-review.jsonl")
	writeJSONL(t, file, []map[string]any{
		turnContext("codex-auto-review"),
		tokenCount("2026-04-22T16:30:00.000Z", map[string]any{"last_token_usage": usage(10)}, ""),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "Asia/Shanghai"})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-04-23", Model: "gpt-5.5", CostUSD: (10 * 5) / 1_000_000.0,
	}})
}

func TestMapsARawFallbackModelToTheOnlyCanonicalModelForThatDate(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "sessions", "fallback.jsonl")
	writeJSONL(t, file, []map[string]any{
		turnContext("gpt-5.4"),
		tokenCount("2026-07-03T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, "gpt-5.4"),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths:             []string{file},
		CanonicalModelsByDate: CodexContextPricingModelHints{"2026-07-03": {"gpt-5.5": true}},
		Timezone:              "UTC",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-07-03", Model: "gpt-5.5", CostUSD: (10 * 5) / 1_000_000.0,
	}})
}

func TestMapsAHistoricalModelToTheCanonicalModelForItsSessionFile(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "session.jsonl")
	writeJSONL(t, file, []map[string]any{
		sessionMeta("historical-model-session"),
		turnContext("gpt-5.5"),
		tokenCount("2026-07-18T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, ""),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths:             []string{file},
		CanonicalModelsByFile: CodexContextPricingFileModelHints{file: "gpt-5.6-terra"},
		Timezone:              "UTC",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-07-18", Model: "gpt-5.6-terra", CostUSD: (10 * 2) / 1_000_000.0,
	}})
}

func TestNormalizesADatedCanonicalModelHintBeforePricing(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "session.jsonl")
	writeJSONL(t, file, []map[string]any{
		turnContext("gpt-5.6-sol"),
		tokenCount("2026-07-18T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, "gpt-5.6-sol"),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths:             []string{file},
		CanonicalModelsByFile: CodexContextPricingFileModelHints{file: "gpt-5.6-sol-20260807"},
		Timezone:              "UTC",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-07-18", Model: "gpt-5.6-sol", CostUSD: (10 * 5) / 1_000_000.0,
	}})
}

func TestPricesContextEventsAfterAMixedModelSessionWasAttributedToANonContextModel(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "session.jsonl")
	writeJSONL(t, file, []map[string]any{
		sessionMeta("mixed-model-session"),
		turnContext("deepseek-v4-flash"),
		tokenCount("2026-07-18T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, ""),
		turnContext("gpt-5.6-sol"),
		tokenCount("2026-07-18T00:01:00.000Z", map[string]any{"last_token_usage": usage(20)}, ""),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths:             []string{file},
		CanonicalModelsByFile: CodexContextPricingFileModelHints{file: "deepseek-v4-flash"},
		Timezone:              "UTC",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-07-18", Model: "gpt-5.6-sol", CostUSD: (20 * 5) / 1_000_000.0,
	}})
}

func TestPricesOnlyTheCumulativeIncrementAfterANonContextModelSwitch(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "sessions", "mixed-cumulative.jsonl")
	writeJSONL(t, file, []map[string]any{
		sessionMeta("mixed-cumulative-session"),
		turnContext("deepseek-v4-flash"),
		tokenCount("2026-07-18T00:00:00.000Z", map[string]any{"total_token_usage": usage(100)}, ""),
		turnContext("gpt-5.6-sol"),
		tokenCount("2026-07-18T00:01:00.000Z", map[string]any{"total_token_usage": usage(120)}, ""),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths:             []string{file},
		CanonicalModelsByFile: CodexContextPricingFileModelHints{file: "deepseek-v4-flash"},
		Timezone:              "UTC",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-07-18", Model: "gpt-5.6-sol", CostUSD: (20 * 5) / 1_000_000.0,
	}})
}

func TestSharesTheCumulativeBaselineWhenAMixedSessionSwitchesToAutoReview(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "sessions", "mixed-auto-review-cumulative.jsonl")
	writeJSONL(t, file, []map[string]any{
		sessionMeta("mixed-auto-review-cumulative-session"),
		turnContext("deepseek-v4-flash"),
		tokenCount("2026-08-12T00:00:00.000Z", map[string]any{"total_token_usage": usage(100)}, ""),
		turnContext("codex-auto-review"),
		tokenCount("2026-08-12T00:01:00.000Z", map[string]any{"total_token_usage": usage(120)}, ""),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths:             []string{file},
		CanonicalModelsByFile: CodexContextPricingFileModelHints{file: "deepseek-v4-flash"},
		Timezone:              "UTC",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-08-12", Model: "gpt-5.5", CostUSD: (20 * 5) / 1_000_000.0,
	}})
}

func TestKeepsAContextEventAfterAnInitialNonContextModelHasNoTokenRow(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "session.jsonl")
	writeJSONL(t, file, []map[string]any{
		sessionMeta("context-only-after-attribution"),
		turnContext("deepseek-v4-flash"),
		turnContext("gpt-5.6-sol"),
		tokenCount("2026-07-18T00:01:00.000Z", map[string]any{"last_token_usage": usage(20)}, ""),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths:             []string{file},
		CanonicalModelsByFile: CodexContextPricingFileModelHints{file: "deepseek-v4-flash"},
		Timezone:              "UTC",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-07-18", Model: "gpt-5.6-sol", CostUSD: (20 * 5) / 1_000_000.0,
	}})
}

func TestKeepsContextTokenRowsWhenTheCanonicalNonContextFileHasNoTurnContextRow(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "session.jsonl")
	writeJSONL(t, file, []map[string]any{
		sessionMeta("context-row-only-after-attribution"),
		tokenCount("2026-07-18T00:01:00.000Z", map[string]any{"last_token_usage": usage(20)}, "gpt-5.6-sol"),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths:             []string{file},
		CanonicalModelsByFile: CodexContextPricingFileModelHints{file: "deepseek-v4-flash"},
		Timezone:              "UTC",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-07-18", Model: "gpt-5.6-sol", CostUSD: (20 * 5) / 1_000_000.0,
	}})
}

func TestKeepsContextTokenRowsWhenTheExplicitModelIsNestedInThePayloadUsageFallback(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "session.jsonl")
	totalUsage := map[string]any{"model": "gpt-5.6-sol"}
	for key, value := range usage(20) {
		totalUsage[key] = value
	}
	writeJSONL(t, file, []map[string]any{{
		"timestamp": "2026-07-18T00:01:00.000Z",
		"type":      "event_msg",
		"payload": map[string]any{
			"type":              "token_count",
			"total_token_usage": totalUsage,
			"usage":             usage(20),
		},
	}})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths:             []string{file},
		CanonicalModelsByFile: CodexContextPricingFileModelHints{file: "deepseek-v4-flash"},
		Timezone:              "UTC",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-07-18", Model: "gpt-5.6-sol", CostUSD: (20 * 5) / 1_000_000.0,
	}})
}

func TestDoesNotCrashWhileClassifyingAutoReviewInAMixedModelSession(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "session.jsonl")
	writeJSONL(t, file, []map[string]any{
		turnContext("deepseek-v4-flash"),
		turnContext("codex-auto-review"),
		tokenCount("2026-08-12T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, ""),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths:             []string{file},
		CanonicalModelsByFile: CodexContextPricingFileModelHints{file: "deepseek-v4-flash"},
		Timezone:              "UTC",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-08-12", Model: "gpt-5.5", CostUSD: (10 * 5) / 1_000_000.0,
	}})
}

func TestKeepsAnAutoReviewOnlySessionAttributedToANonContextModel(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "session.jsonl")
	writeJSONL(t, file, []map[string]any{
		turnContext("codex-auto-review"),
		tokenCount("2026-08-12T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, ""),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths:             []string{file},
		CanonicalModelsByFile: CodexContextPricingFileModelHints{file: "deepseek-v4-flash"},
		Timezone:              "UTC",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-08-12", Model: "gpt-5.5", CostUSD: (10 * 5) / 1_000_000.0,
	}})
}

func TestDoesNotPriceAHistoricalContextModelAgainstANonContextCanonicalSessionModel(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "session.jsonl")
	writeJSONL(t, file, []map[string]any{
		sessionMeta("non-context-session"),
		turnContext("gpt-5.5"),
		tokenCount("2026-07-18T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, ""),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths:             []string{file},
		CanonicalModelsByFile: CodexContextPricingFileModelHints{file: "deepseek-v4-flash"},
		Timezone:              "UTC",
	})
	if len(costs) != 0 {
		t.Fatalf("costs = %+v, want none", costs)
	}
}

func TestSkipsMalformedNonContextFilesAfterCcusageAttribution(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "session.jsonl")
	writeRawFile(t, file, "{not-json\n")

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths:             []string{file},
		CanonicalModelsByFile: CodexContextPricingFileModelHints{file: "deepseek-v4-flash"},
		Timezone:              "UTC",
	})
	if len(costs) != 0 {
		t.Fatalf("costs = %+v, want none", costs)
	}
}

func TestKeepsARawModelDistinctWhenTheDateHasMultipleCanonicalModels(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "sessions", "fallback.jsonl")
	writeJSONL(t, file, []map[string]any{
		turnContext("gpt-5.4"),
		tokenCount("2026-07-08T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, "gpt-5.4"),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths:             []string{file},
		CanonicalModelsByDate: CodexContextPricingModelHints{"2026-07-08": {"gpt-5.4": true, "gpt-5.5": true}},
		Timezone:              "UTC",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-07-08", Model: "gpt-5.4", CostUSD: (10 * 2.5) / 1_000_000.0,
	}})
}

func TestKeepsRequestContextTiersWhenCanonicalModelHintsRemapADay(t *testing.T) {
	usages := []CodexContextPricingUsage{
		{
			UsageDate: "2026-07-03", Model: "gpt-5.4",
			InputTokens: 10, UncachedInputTokens: 10,
			ContextTier: contextTierStandard,
		},
		{
			UsageDate: "2026-07-03", Model: "gpt-5.4",
			InputTokens: 272_001, UncachedInputTokens: 272_001,
			ContextTier: contextTierLong,
		},
	}
	mapped := ApplyCodexContextPricingUsageModelHints(usages,
		CodexContextPricingModelHints{"2026-07-03": {"gpt-5.5": true}})
	priced := PriceCodexContextPricingUsages(mapped)
	if len(priced) != 1 {
		t.Fatalf("priced = %+v, want one entry", priced)
	}
	assertCloseTo(t, priced[0].CostUSD, (10*5+272_001*10)/1_000_000.0, 12)
}

func TestDerivesOptionalTotalTokensFromComponentsWhileApplyingModelHints(t *testing.T) {
	mapped := ApplyCodexContextPricingUsageModelHints([]CodexContextPricingUsage{
		{
			UsageDate: "2026-07-03", Model: "gpt-5.4",
			InputTokens: 10, UncachedInputTokens: 10, OutputTokens: 2,
			CacheReadTokens: 1, CacheCreationTokens: 3,
			ContextTier: contextTierStandard,
		},
		{
			UsageDate: "2026-07-03", Model: "gpt-5.4",
			InputTokens: 20, UncachedInputTokens: 20, OutputTokens: 4,
			CacheReadTokens: 2, CacheCreationTokens: 6,
			ContextTier: contextTierStandard,
		},
	}, nil)

	if len(mapped) != 1 {
		t.Fatalf("mapped = %+v, want one entry", mapped)
	}
	if mapped[0].TotalTokens == nil || *mapped[0].TotalTokens != 45 {
		t.Fatalf("totalTokens = %v, want 45", mapped[0].TotalTokens)
	}
}

func TestUsesCcusageLegacyGPT5FallbackBeforeTheFirstAutoReviewRelease(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "sessions", "auto-review.jsonl")
	writeJSONL(t, file, []map[string]any{
		turnContext("codex-auto-review"),
		tokenCount("2025-08-06T00:00:00.000Z", map[string]any{"last_token_usage": usage(10)}, ""),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
	if len(costs) != 0 {
		t.Fatalf("costs = %+v, want none", costs)
	}
}

func TestKeepsAutoReviewCumulativeUsageContinuousAcrossFallbackModelReleases(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "sessions", "auto-review.jsonl")
	writeJSONL(t, file, []map[string]any{
		turnContext("codex-auto-review"),
		tokenCount("2026-03-05T00:00:00.000Z", map[string]any{"total_token_usage": usage(100)}, ""),
		tokenCount("2026-04-23T00:00:00.000Z", map[string]any{"total_token_usage": usage(150)}, ""),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
	assertCostsEqual(t, costs, []CodexContextPricingCost{
		{UsageDate: "2026-03-05", Model: "gpt-5.4", CostUSD: (100 * 2.5) / 1_000_000.0},
		{UsageDate: "2026-04-23", Model: "gpt-5.5", CostUSD: (50 * 5) / 1_000_000.0},
	})
}

func TestUsesTheFirstCumulativeOnlyChildRowAsABaseline(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "sessions", "child.jsonl")
	writeJSONL(t, file, []map[string]any{
		{
			"type": "session_meta",
			"id":   "child-session",
			"payload": map[string]any{
				"source": map[string]any{
					"subagent": map[string]any{
						"thread_spawn": map[string]any{"parent_thread_id": "parent-session"},
					},
				},
			},
		},
		tokenCount("2026-05-01T00:00:00.000Z", map[string]any{"total_token_usage": usage(100)}, "gpt-5.6-sol"),
		tokenCount("2026-05-01T00:01:00.000Z", map[string]any{"total_token_usage": usage(150)}, "gpt-5.6-sol"),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: (50 * 5) / 1_000_000.0,
	}})
}

func TestUsesTheFirstCumulativeOnlyRowAsABaselineWhenChildMetadataOmitsTheParentID(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "sessions", "child.jsonl")
	writeJSONL(t, file, []map[string]any{
		{
			"type": "session_meta",
			"id":   "child-session-without-parent-id",
			"payload": map[string]any{
				"source": map[string]any{"subagent": map[string]any{"thread_spawn": map[string]any{}}},
			},
		},
		tokenCount("2026-05-01T00:00:00.000Z", map[string]any{"total_token_usage": usage(100)}, "gpt-5.6-sol"),
		tokenCount("2026-05-01T00:01:00.000Z", map[string]any{"total_token_usage": usage(150)}, "gpt-5.6-sol"),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: (50 * 5) / 1_000_000.0,
	}})
}

func TestFiltersRawEventsByTheConfiguredTimezoneAndInclusiveDateBounds(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "session.jsonl")
	writeJSONL(t, file, []map[string]any{
		tokenCount("2026-05-01T15:30:00.000Z", map[string]any{"last_token_usage": usage(10)}, "gpt-5.6-sol"),
		tokenCount("2026-05-02T00:30:00.000Z", map[string]any{"last_token_usage": usage(20)}, "gpt-5.6-sol"),
		tokenCount("2026-05-03T00:30:00.000Z", map[string]any{"last_token_usage": usage(30)}, "gpt-5.6-sol"),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{
		FilePaths: []string{file},
		Timezone:  "Asia/Shanghai",
		Since:     "20260502",
		Until:     "20260502",
	})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-05-02", Model: "gpt-5.6-sol", CostUSD: (20 * 5) / 1_000_000.0,
	}})
}

func TestFailsWhenACollectedRawCostHasNoMatchingDailySnapshot(t *testing.T) {
	_, err := ApplyCodexContextPricingCosts(
		[]CostSnapshot{{UsageDate: "2026-05-01", Model: "gpt-5.6-sol", TotalTokens: floatPtr(10)}},
		[]CodexContextPricingCost{{UsageDate: "2026-05-02", Model: "gpt-5.6-sol", CostUSD: 1}},
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "Codex context pricing cannot match daily snapshot") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestFailsWhenRawContextPricingAttributesADateToADifferentModel(t *testing.T) {
	_, err := ApplyCodexContextPricingCosts(
		[]CostSnapshot{{UsageDate: "2026-05-01", Model: "gpt-5.6-terra", TotalTokens: floatPtr(10)}},
		[]CodexContextPricingCost{{UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: 1}},
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "Codex context pricing cannot match daily snapshot") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestMatchesCcusageAliasesToTheCanonicalContextPricingModel(t *testing.T) {
	snapshots := []CostSnapshot{{UsageDate: "2026-05-01", Model: "gpt-5.6", TotalTokens: floatPtr(10)}}
	costs := []CodexContextPricingCost{{UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: 1}}
	result, err := ApplyCodexContextPricingCosts(snapshots, costs, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 1 || result[0].CostUSD != 1 {
		t.Fatalf("result = %+v, want cost 1", result)
	}
}

func TestRejectsANonFiniteContextPricedCostInsteadOfWritingIt(t *testing.T) {
	snapshot := []CostSnapshot{{UsageDate: "2026-05-01", Model: "gpt-5.6-sol", TotalTokens: floatPtr(10)}}
	cases := []struct {
		name string
		cost float64
	}{
		{"positive infinity", math.Inf(1)},
		{"negative", -1},
		{"above the schema limit", float64(contractMaxSnapshotCostUSD()) + 1},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := ApplyCodexContextPricingCosts(snapshot,
				[]CodexContextPricingCost{{UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: testCase.cost}}, nil)
			want := "Codex context pricing produced an invalid cost for 2026-05-01/gpt-5.6-sol"
			if err == nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestKeepsSameDayGPT56AliasesAsIndependentCostMatches(t *testing.T) {
	result, err := ApplyCodexContextPricingCosts(
		[]CostSnapshot{
			{UsageDate: "2026-05-01", Model: "gpt-5.6", TotalTokens: floatPtr(10)},
			{UsageDate: "2026-05-01", Model: "gpt-5.6-sol", TotalTokens: floatPtr(20)},
		},
		[]CodexContextPricingCost{
			{UsageDate: "2026-05-01", Model: "gpt-5.6", CostUSD: 1},
			{UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: 2},
		},
		nil,
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := []float64{result[0].CostUSD, result[1].CostUSD}
	if !reflect.DeepEqual(got, []float64{1, 2}) {
		t.Fatalf("costs = %v, want [1 2]", got)
	}
}

func TestFailsInsteadOfAssigningOneAliasRawCostToMultipleSameDaySnapshots(t *testing.T) {
	_, err := ApplyCodexContextPricingCosts(
		[]CostSnapshot{
			{UsageDate: "2026-05-01", Model: "gpt-5.6", TotalTokens: floatPtr(10)},
			{UsageDate: "2026-05-01", Model: "gpt-5.6-sol", TotalTokens: floatPtr(20)},
		},
		[]CodexContextPricingCost{{UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: 2}},
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "Codex context pricing cannot match raw cost") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestFailsInsteadOfAssigningOneExactRawCostToDuplicateSnapshots(t *testing.T) {
	_, err := ApplyCodexContextPricingCosts(
		[]CostSnapshot{
			{UsageDate: "2026-05-01", Model: "gpt-5.6-sol", TotalTokens: floatPtr(10)},
			{UsageDate: "2026-05-01", Model: "gpt-5.6-sol", TotalTokens: floatPtr(20)},
		},
		[]CodexContextPricingCost{{UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: 2}},
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "Codex context pricing cannot match duplicate daily snapshots") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestFailsWhenAPricedDailySnapshotHasNoRawContextPricingCost(t *testing.T) {
	diagnostics := []string{}
	_, err := ApplyCodexContextPricingCosts(
		[]CostSnapshot{{UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: 7, TotalTokens: floatPtr(10)}},
		nil,
		func(line string) { diagnostics = append(diagnostics, line) },
	)
	if err == nil || !strings.Contains(err.Error(), "Codex context pricing cannot match raw cost") {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []string{
		"Codex context pricing found gpt-5.6-sol daily usage without an unambiguous raw cost for 2026-05-01",
	}
	if !reflect.DeepEqual(diagnostics, want) {
		t.Fatalf("diagnostics = %v, want %v", diagnostics, want)
	}
}

func TestDoesNotRequireRawContextPricingCostForAZeroTokenSnapshot(t *testing.T) {
	result, err := ApplyCodexContextPricingCosts(
		[]CostSnapshot{{UsageDate: "2026-05-01", Model: "gpt-5.6-sol", CostUSD: 7, TotalTokens: floatPtr(0)}},
		nil, nil,
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 1 || result[0].CostUSD != 7 {
		t.Fatalf("result = %+v, want the snapshot unchanged", result)
	}
}

func TestDoesNotRequireRawContextPricingCostForMetadataOnlyTokenTotals(t *testing.T) {
	snapshot := CostSnapshot{
		UsageDate:           "2026-05-01",
		Model:               "gpt-5.6-sol",
		InputTokens:         floatPtr(0),
		OutputTokens:        floatPtr(0),
		CacheReadTokens:     floatPtr(0),
		CacheCreationTokens: floatPtr(0),
		CostUSD:             0,
		TotalTokens:         floatPtr(42),
	}
	result, err := ApplyCodexContextPricingCosts([]CostSnapshot{snapshot}, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !reflect.DeepEqual(result, []CostSnapshot{snapshot}) {
		t.Fatalf("result = %+v, want the snapshot unchanged", result)
	}
	resolved := snapshot
	resolved.Source = "codex"
	if IsUnresolvedCodexContextPricingSnapshot(resolved) {
		t.Fatal("expected the metadata-only snapshot to be resolved")
	}
}

func TestKeepsABillableSnapshotUnresolvedEvenWhenItsCachedCostIsNonZero(t *testing.T) {
	unresolved := IsUnresolvedCodexContextPricingSnapshot(CostSnapshot{
		Source:              "codex",
		Model:               "gpt-5.6-sol",
		InputTokens:         floatPtr(10),
		OutputTokens:        floatPtr(0),
		CacheReadTokens:     floatPtr(0),
		CacheCreationTokens: floatPtr(0),
		TotalTokens:         floatPtr(10),
		CostUSD:             0.01,
	})
	if !unresolved {
		t.Fatal("expected the billable snapshot to stay unresolved")
	}
}

func TestRejectsMalformedRecognizedTokenFieldsInsteadOfPricingThemAsZero(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "session.jsonl")
	writeRawFile(t, file,
		`{"timestamp":"2026-05-01T00:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"model":"gpt-5.6-sol","last_token_usage":{"input_tokens":"10","output_tokens":1}}}}`+"\n")

	_, err := costsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
	if err == nil || !strings.Contains(err.Error(), "Invalid Codex token usage field input_tokens") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestIgnoresTotalOnlyBookkeepingRowsWithoutFailingTheFileScan(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "session.jsonl")
	writeJSONL(t, file, []map[string]any{
		tokenCount("2026-05-01T00:00:00.000Z", map[string]any{
			"last_token_usage": map[string]any{"total_tokens": float64(42), "output_tokens": float64(0)},
		}, "gpt-5.6-sol"),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
	if len(costs) != 0 {
		t.Fatalf("costs = %+v, want none", costs)
	}
}

func TestRejectsFractionalAndUnsafeIntegerTokenFields(t *testing.T) {
	cases := []struct {
		name  string
		value float64
	}{
		{"fractional", 1.5},
		{"unsafe integer", float64(1<<53) + 1},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			root := t.TempDir()
			file := filepath.Join(root, "session.jsonl")
			writeJSONL(t, file, []map[string]any{
				tokenCount("2026-05-01T00:00:00.000Z", map[string]any{
					"last_token_usage": map[string]any{
						"input_tokens": testCase.value, "output_tokens": float64(1),
					},
				}, "gpt-5.6-sol"),
			})

			_, err := costsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
			if err == nil || !strings.Contains(err.Error(), "Invalid Codex token usage field input_tokens") {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestAcceptsAdditiveCachedInputAndAppliesTheLongTierToFullContext(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "session.jsonl")
	writeJSONL(t, file, []map[string]any{
		tokenCount("2026-05-01T00:00:00.000Z", map[string]any{
			"last_token_usage": map[string]any{
				"input_tokens":        float64(200_000),
				"cached_input_tokens": float64(100_000),
				"output_tokens":       float64(1),
				"total_tokens":        float64(300_001),
			},
		}, "gpt-5.6-sol"),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-05-01",
		Model:     "gpt-5.6-sol",
		CostUSD:   (200_000*10 + 100_000*1 + 1*45) / 1_000_000.0,
	}})
}

func TestAppliesTheLongTierWhenCacheCreationCrossesTheRequestBoundary(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "session.jsonl")
	writeJSONL(t, file, []map[string]any{
		tokenCount("2026-05-01T00:00:00.000Z", map[string]any{
			"last_token_usage": map[string]any{
				"input_tokens":             float64(272_000),
				"cache_write_input_tokens": float64(1),
				"output_tokens":            float64(0),
				"total_tokens":             float64(272_001),
			},
		}, "gpt-5.6-sol"),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-05-01",
		Model:     "gpt-5.6-sol",
		CostUSD:   (272_000*10 + 12.5) / 1_000_000.0,
	}})
}

func TestAcceptsTheCurrentCacheWriteFieldAsCacheCreationInput(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "session.jsonl")
	writeJSONL(t, file, []map[string]any{
		tokenCount("2026-05-01T00:00:00.000Z", map[string]any{
			"last_token_usage": map[string]any{
				"input_tokens":             float64(10),
				"cache_read_input_tokens":  float64(4),
				"cache_write_input_tokens": float64(3),
				"output_tokens":            float64(2),
				"total_tokens":             float64(19),
			},
		}, "gpt-5.6-sol"),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-05-01",
		Model:     "gpt-5.6-sol",
		CostUSD:   (10*5 + 4*0.5 + 3*6.25 + 2*30) / 1_000_000.0,
	}})
}

func TestIgnoresMetadataRowsWithPositiveTotalButNoBillableTokenComponents(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "session.jsonl")
	writeJSONL(t, file, []map[string]any{
		tokenCount("2026-05-01T00:00:00.000Z", map[string]any{
			"last_token_usage": map[string]any{
				"input_tokens":             float64(0),
				"cached_input_tokens":      float64(0),
				"cache_write_input_tokens": float64(0),
				"output_tokens":            float64(0),
				"reasoning_output_tokens":  float64(21_391),
				"total_tokens":             float64(21_391),
			},
		}, "gpt-5.6-sol"),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
	if len(costs) != 0 {
		t.Fatalf("costs = %+v, want none", costs)
	}
}

func TestTreatsAZeroTotalAsLegacyCompatibleInsteadOfAddingCachedInputTwice(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "session.jsonl")
	writeJSONL(t, file, []map[string]any{
		tokenCount("2026-05-01T00:00:00.000Z", map[string]any{
			"last_token_usage": map[string]any{
				"input_tokens":        float64(100),
				"cached_input_tokens": float64(40),
				"output_tokens":       float64(1),
				"total_tokens":        float64(0),
			},
		}, "gpt-5.6-sol"),
	})

	costs := mustCostsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
	assertCostsEqual(t, costs, []CodexContextPricingCost{{
		UsageDate: "2026-05-01",
		Model:     "gpt-5.6-sol",
		CostUSD:   (60*5 + 40*0.5 + 1*30) / 1_000_000.0,
	}})
}

func TestReportsTheLegacyTotalForACacheReadInsideInputTokens(t *testing.T) {
	cases := []struct {
		name         string
		usagePayload map[string]any
	}{
		{"a zero total", map[string]any{
			"input_tokens": float64(100), "cached_input_tokens": float64(40),
			"output_tokens": float64(1), "total_tokens": float64(0),
		}},
		{"no total field", map[string]any{
			"input_tokens": float64(100), "cached_input_tokens": float64(40),
			"output_tokens": float64(1),
		}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			root := t.TempDir()
			file := filepath.Join(root, "session.jsonl")
			writeJSONL(t, file, []map[string]any{
				tokenCount("2026-05-01T00:00:00.000Z", map[string]any{"last_token_usage": testCase.usagePayload}, "gpt-5.6-sol"),
			})

			usages, err := CollectCodexContextPricingUsagesFromFiles(CollectFilesInput{
				FilePaths: []string{file},
				Timezone:  "UTC",
			})
			if err != nil {
				t.Fatalf("collect usages: %v", err)
			}
			if len(usages) != 1 {
				t.Fatalf("usages = %+v, want one", usages)
			}
			usage := usages[0]
			if usage.InputTokens != 100 || usage.UncachedInputTokens != 60 ||
				usage.CacheReadTokens != 40 || usage.CacheCreationTokens != 0 ||
				usage.OutputTokens != 1 || usage.TotalTokens == nil || *usage.TotalTokens != 101 {
				t.Fatalf("usage = %+v", usage)
			}
		})
	}
}

func TestReadsACacheReadLargerThanInputTokensAsAdditive(t *testing.T) {
	cases := []struct {
		name         string
		usagePayload map[string]any
	}{
		{"a zero total", map[string]any{
			"input_tokens": float64(100_000), "cached_input_tokens": float64(200_000),
			"output_tokens": float64(1), "total_tokens": float64(0),
		}},
		{"no total field", map[string]any{
			"input_tokens": float64(100_000), "cached_input_tokens": float64(200_000),
			"output_tokens": float64(1),
		}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			root := t.TempDir()
			file := filepath.Join(root, "session.jsonl")
			writeJSONL(t, file, []map[string]any{
				tokenCount("2026-05-01T00:00:00.000Z", map[string]any{"last_token_usage": testCase.usagePayload}, "gpt-5.6-sol"),
			})

			costs := mustCostsFromFiles(t, CollectFilesInput{FilePaths: []string{file}, Timezone: "UTC"})
			// Additive: 100k uncached + 200k cache read = 300k context, past
			// the 272k threshold, so the long tier prices all three buckets.
			assertCostsEqual(t, costs, []CodexContextPricingCost{{
				UsageDate: "2026-05-01",
				Model:     "gpt-5.6-sol",
				CostUSD:   (100_000*10 + 200_000*1 + 1*45) / 1_000_000.0,
			}})
		})
	}
}

// contractMaxSnapshotCostUSD keeps the schema ceiling in one place for the
// invalid-cost test.
func contractMaxSnapshotCostUSD() float64 {
	return 1_000_000_000
}

func TestCodexSessionFingerprintMemoComputesEachFileOnceAcrossRepeatedDiscoveryInOneCollect(t *testing.T) {
	stateDir := t.TempDir()
	sessionsDir := filepath.Join(stateDir, "sessions")
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	sessionPath := filepath.Join(sessionsDir, "session.jsonl")
	writeRawFile(t, sessionPath, `{"type":"event_msg"}`+"\n")

	original := codexSessionFileFingerprint
	defer func() { codexSessionFileFingerprint = original }()
	calls := 0
	codexSessionFileFingerprint = func(filePath string) (CodexSessionFileFingerprint, error) {
		calls++
		return original(filePath)
	}

	memo := CreateCodexSessionFingerprintMemo()
	first, err := DiscoverCodexContextPricingFiles(DiscoverInput{
		CodexHomes: []string{stateDir}, CaptureFingerprints: true, FingerprintMemo: memo,
	})
	if err != nil {
		t.Fatalf("first discovery: %v", err)
	}
	second, err := DiscoverCodexContextPricingFiles(DiscoverInput{
		CodexHomes: []string{stateDir}, CaptureFingerprints: true, FingerprintMemo: memo,
	})
	if err != nil {
		t.Fatalf("second discovery: %v", err)
	}
	if calls != 1 {
		t.Fatalf("fingerprint computations = %d, want 1", calls)
	}
	if len(first.FilePaths) != 1 {
		t.Fatalf("file paths = %v, want one", first.FilePaths)
	}
	if _, ok := second.Fingerprints[resolvePath(first.FilePaths[0])]; !ok {
		t.Fatalf("missing fingerprint for %s", first.FilePaths[0])
	}

	// Control: the same two discoveries without a memo do compute twice, so the
	// assertion above is actually testing memoization and not vacuous.
	calls = 0
	if _, err := DiscoverCodexContextPricingFiles(DiscoverInput{CodexHomes: []string{stateDir}, CaptureFingerprints: true}); err != nil {
		t.Fatalf("control discovery: %v", err)
	}
	if _, err := DiscoverCodexContextPricingFiles(DiscoverInput{CodexHomes: []string{stateDir}, CaptureFingerprints: true}); err != nil {
		t.Fatalf("control discovery: %v", err)
	}
	if calls != 2 {
		t.Fatalf("control fingerprint computations = %d, want 2", calls)
	}
}

func TestCodexSessionFingerprintMemoRecomputesAChangedFileThroughTheStatIdentityCheck(t *testing.T) {
	stateDir := t.TempDir()
	filePath := filepath.Join(stateDir, "session.jsonl")
	writeRawFile(t, filePath, `{"type":"event_msg"}`+"\n")
	memo := CreateCodexSessionFingerprintMemo()
	before, err := memo.Get(filePath)
	if err != nil {
		t.Fatalf("first fingerprint: %v", err)
	}
	writeRawFile(t, filePath, `{"type":"event_msg"}`+"\n"+`{"type":"event_msg"}`+"\n")
	after, err := memo.Get(filePath)
	if err != nil {
		t.Fatalf("second fingerprint: %v", err)
	}
	if after.Size == before.Size {
		t.Fatalf("size did not change: %v", after.Size)
	}
	if after.TailSHA256 == before.TailSHA256 {
		t.Fatalf("tail hash did not change: %s", after.TailSHA256)
	}
}

func TestCodexSessionFingerprintMemoStateNeverCrossesCollects(t *testing.T) {
	stateDir := t.TempDir()
	sessionsDir := filepath.Join(stateDir, "sessions")
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	filePath := filepath.Join(sessionsDir, "session.jsonl")
	writeRawFile(t, filePath, `{"type":"event_msg"}`+"\n")

	first := CreateCodexSessionFingerprintMemo()
	if _, err := first.Get(filePath); err != nil {
		t.Fatalf("first memo: %v", err)
	}

	original := codexSessionFileFingerprint
	defer func() { codexSessionFileFingerprint = original }()
	calls := 0
	codexSessionFileFingerprint = func(filePath string) (CodexSessionFileFingerprint, error) {
		calls++
		return original(filePath)
	}

	second := CreateCodexSessionFingerprintMemo()
	if _, err := DiscoverCodexContextPricingFiles(DiscoverInput{
		CodexHomes: []string{stateDir}, CaptureFingerprints: true, FingerprintMemo: second,
	}); err != nil {
		t.Fatalf("discovery: %v", err)
	}
	// A brand-new memo recomputes: memo state must not leak across collects.
	if calls != 1 {
		t.Fatalf("fingerprint computations = %d, want 1", calls)
	}
}

func pricedModel(overrides func(*pricing.Model)) pricing.Model {
	model := pricing.Model{
		Provider:             "reseller",
		ModelID:              "test-model",
		InputCostPerMillion:  2,
		OutputCostPerMillion: 10,
		Pricing:              map[string]any{},
	}
	model.CacheReadCostPerMillion = floatPtr(0.1)
	if overrides != nil {
		overrides(&model)
	}
	return model
}

func TestDynamicPricingKeepsSingleRowsAndConflictingMultiProviderRowsAsBefore(t *testing.T) {
	models := []pricing.Model{
		pricedModel(func(model *pricing.Model) { model.Provider = "openai"; model.ModelID = "solo-model" }),
		pricedModel(func(model *pricing.Model) {
			model.Provider = "a"
			model.ModelID = "split-model"
			model.InputCostPerMillion = 2
		}),
		pricedModel(func(model *pricing.Model) {
			model.Provider = "b"
			model.ModelID = "split-model"
			model.InputCostPerMillion = 3
		}),
	}
	selected := SelectUnambiguousDynamicPricingModels(models)
	// The conflicting id drops out entirely (pre-existing behavior); only the
	// solo row survives.
	providers := []string{}
	for _, model := range selected {
		providers = append(providers, model.Provider)
	}
	if !reflect.DeepEqual(providers, []string{"openai"}) {
		t.Fatalf("providers = %v, want [openai]", providers)
	}
}

func TestDynamicPricingCollapsesMultiProviderRowsWhoseNonZeroPricesAllAgree(t *testing.T) {
	models := []pricing.Model{
		pricedModel(func(model *pricing.Model) { model.Provider = "openai"; model.ModelID = "sol" }),
		pricedModel(func(model *pricing.Model) { model.Provider = "reseller-a"; model.ModelID = "sol" }),
		pricedModel(func(model *pricing.Model) { model.Provider = "reseller-b"; model.ModelID = "sol" }),
	}
	selected := SelectUnambiguousDynamicPricingModels(models)
	if len(selected) != 1 {
		t.Fatalf("selected = %+v, want one", selected)
	}
	if selected[0].Provider != "openai" || selected[0].InputCostPerMillion != 2 {
		t.Fatalf("selected[0] = %+v", selected[0])
	}
}

func TestDynamicPricingIgnoresFreeTierZeroRowsWhenAPositivePricedRowExists(t *testing.T) {
	models := []pricing.Model{
		pricedModel(func(model *pricing.Model) { model.Provider = "vendor"; model.ModelID = "k3" }),
		pricedModel(func(model *pricing.Model) {
			model.Provider = "promo"
			model.ModelID = "k3"
			model.InputCostPerMillion = 0
			model.OutputCostPerMillion = 0
			model.CacheReadCostPerMillion = floatPtr(0)
		}),
	}
	selected := SelectUnambiguousDynamicPricingModels(models)
	if len(selected) != 1 || selected[0].Provider != "vendor" {
		t.Fatalf("selected = %+v, want the vendor row", selected)
	}
}

func TestDynamicPricingAZeroRowOnlyCollapsesWithAnotherZeroRow(t *testing.T) {
	models := []pricing.Model{
		pricedModel(func(model *pricing.Model) {
			model.Provider = "promo-a"
			model.ModelID = "free-tier"
			model.InputCostPerMillion = 0
			model.OutputCostPerMillion = 0
			model.CacheReadCostPerMillion = floatPtr(0)
		}),
		pricedModel(func(model *pricing.Model) {
			model.Provider = "promo-b"
			model.ModelID = "free-tier"
			model.InputCostPerMillion = 0
			model.OutputCostPerMillion = 0
			model.CacheReadCostPerMillion = floatPtr(0)
		}),
	}
	selected := SelectUnambiguousDynamicPricingModels(models)
	if len(selected) != 1 {
		t.Fatalf("selected = %+v, want one", selected)
	}
}

func TestDynamicPricingCachePricesMustAgreeTooNotJustInputOutput(t *testing.T) {
	models := []pricing.Model{
		pricedModel(func(model *pricing.Model) { model.Provider = "a"; model.ModelID = "cached" }),
		pricedModel(func(model *pricing.Model) {
			model.Provider = "b"
			model.ModelID = "cached"
			model.CacheReadCostPerMillion = floatPtr(0.2)
		}),
	}
	if selected := SelectUnambiguousDynamicPricingModels(models); len(selected) != 0 {
		t.Fatalf("selected = %+v, want none", selected)
	}
}

func TestDynamicPricingAZeroPricedOfficialRowMustNotRepresentAPositivePricedGroup(t *testing.T) {
	models := []pricing.Model{
		pricedModel(func(model *pricing.Model) {
			model.Provider = "openai"
			model.ModelID = "placeholder"
			model.InputCostPerMillion = 0
			model.OutputCostPerMillion = 0
			model.CacheReadCostPerMillion = floatPtr(0)
		}),
		pricedModel(func(model *pricing.Model) { model.Provider = "reseller"; model.ModelID = "placeholder" }),
	}
	selected := SelectUnambiguousDynamicPricingModels(models)
	if len(selected) != 1 {
		t.Fatalf("selected = %+v, want one", selected)
	}
	if selected[0].Provider != "reseller" || selected[0].InputCostPerMillion != 2 {
		t.Fatalf("selected[0] = %+v", selected[0])
	}
}

func TestDynamicPricingPrefersTheOfficialVendorRowAsTheCollapsedRepresentative(t *testing.T) {
	models := []pricing.Model{
		pricedModel(func(model *pricing.Model) { model.Provider = "zreseller"; model.ModelID = "gpt" }),
		pricedModel(func(model *pricing.Model) { model.Provider = "openai"; model.ModelID = "gpt" }),
	}
	selected := SelectUnambiguousDynamicPricingModels(models)
	if len(selected) != 1 || selected[0].Provider != "openai" {
		t.Fatalf("selected = %+v, want the openai row", selected)
	}
}

// Rows that agree on price can disagree on context window, and the
// representative carries its own into the rule. The pick must not depend on
// arrival order, which comes from the catalogue's ORDER BY.
func TestDynamicPricingRepresentativeIsIndependentOfRowOrder(t *testing.T) {
	zeta := pricedModel(func(model *pricing.Model) {
		model.Provider = "zeta"
		model.ModelID = "order-model"
		model.ContextWindow = 128_000
	})
	alpha := pricedModel(func(model *pricing.Model) {
		model.Provider = "alpha"
		model.ModelID = "order-model"
		model.ContextWindow = 400_000
	})

	forward := SelectUnambiguousDynamicPricingModels([]pricing.Model{zeta, alpha})
	backward := SelectUnambiguousDynamicPricingModels([]pricing.Model{alpha, zeta})
	if len(forward) != 1 || len(backward) != 1 {
		t.Fatalf("selected %d/%d rows, want 1 each", len(forward), len(backward))
	}
	if forward[0].Provider != backward[0].Provider || forward[0].ContextWindow != backward[0].ContextWindow {
		t.Fatalf("representative depends on row order: %s/%v vs %s/%v",
			forward[0].Provider, forward[0].ContextWindow, backward[0].Provider, backward[0].ContextWindow)
	}
	if forward[0].Provider != "alpha" {
		t.Fatalf("representative = %s, want the alphabetically first provider", forward[0].Provider)
	}
}
