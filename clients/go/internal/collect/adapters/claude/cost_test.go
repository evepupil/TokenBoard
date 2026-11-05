package claude

// Costing cases port rust/crates/ccusage-core/src/cost.rs: the three-mode
// ladder (cost.rs:31-45), the three extra silences of
// missing_pricing_model_for_usage (cost.rs:48-75) that nativepricing.Cost does
// not implement, and the order constraint that every entry is priced before
// dedupe because the daily replacement rung compares the cost
// (daily.rs:317-330, 592-599).

import (
	"math"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

const (
	// unpricedModel appears in neither embedded pricing snapshot and no
	// override in these tests names it, so Find always misses it.
	unpricedModel = "tokenboard-unpriced-test-model-2099"
	// pricedModel is an exact LiteLLM key: $3/M input, $15/M output,
	// $3.75/M cache creation, $0.30/M cache read.
	pricedModel = "claude-sonnet-4-5"
	// costEpsilon absorbs the rounding of rate * tokens, not a semantic gap.
	costEpsilon = 1e-12
)

func testCostFunc(t *testing.T, overrides map[string]any, mode CostMode) CostFunc {
	t.Helper()
	cost, err := NewCostFunc(overrides, mode)
	if err != nil {
		t.Fatalf("NewCostFunc: %v", err)
	}
	return cost
}

func usageWithReported(reported float64) Usage {
	return Usage{Input: 100, Output: 10, ReportedCost: &reported}
}

func requireCost(t *testing.T, name string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > costEpsilon {
		t.Fatalf("%s: cost = %v, want %v", name, got, want)
	}
}

// TestCostFuncMatchesCcusageMissingPricingRules pins every silence rule of
// missing_pricing_model_for_usage (cost.rs:48-75) plus the one non-silent
// case, because the adapter - not nativepricing - owns the zero-token gate
// (the S1 debt registered in the design spec, §8.1).
func TestCostFuncMatchesCcusageMissingPricingRules(t *testing.T) {
	withTokens := Usage{Input: 100, Output: 10}
	cases := []struct {
		name        string
		mode        CostMode
		model       string
		usage       Usage
		wantCost    float64
		wantMissing bool
	}{
		{
			name: "display never looks prices up",
			mode: nativepricing.ModeDisplay, model: unpricedModel, usage: withTokens,
		},
		{
			name: "display returns the reported cost",
			mode: nativepricing.ModeDisplay, model: unpricedModel, usage: usageWithReported(2.5),
			wantCost: 2.5,
		},
		{
			name: "auto trusts a reported cost",
			mode: nativepricing.ModeAuto, model: unpricedModel, usage: usageWithReported(2.5),
			wantCost: 2.5,
		},
		{
			name: "auto reports an unpriced model",
			mode: nativepricing.ModeAuto, model: unpricedModel, usage: withTokens,
			wantMissing: true,
		},
		{
			name: "auto stays quiet when the usage has no tokens",
			mode: nativepricing.ModeAuto, model: unpricedModel, usage: Usage{},
		},
		{
			name: "calculate reports an unpriced model",
			mode: nativepricing.ModeCalculate, model: unpricedModel, usage: withTokens,
			wantMissing: true,
		},
		{
			name: "calculate stays quiet when the usage has no tokens",
			mode: nativepricing.ModeCalculate, model: unpricedModel, usage: Usage{},
		},
		{
			name: "a priced model is never missing",
			mode: nativepricing.ModeCalculate, model: pricedModel, usage: withTokens,
			// 100 input at $3/M plus 10 output at $15/M.
			wantCost: 0.00045,
		},
		{
			name: "an absent model is never missing",
			mode: nativepricing.ModeCalculate, model: "", usage: withTokens,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			cost := testCostFunc(t, nil, testCase.mode)
			gotCost, gotMissing := cost(testCase.model, testCase.usage, time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC))
			requireCost(t, testCase.name, gotCost, testCase.wantCost)
			if gotMissing != testCase.wantMissing {
				t.Fatalf("%s: missing = %v, want %v", testCase.name, gotMissing, testCase.wantMissing)
			}
		})
	}
}

// TestCostFuncAppliesOverridesAndModes checks that the camelCase override map
// reaches nativepricing (WithOverrides) and that the mode ladder still decides
// between reported and computed cost - including the fast multiplier, which
// scales the whole request (cost.rs:110-115).
func TestCostFuncAppliesOverridesAndModes(t *testing.T) {
	overrides := map[string]any{
		"override-only-model": map[string]any{
			"inputCostPerToken":  1e-5,
			"outputCostPerToken": 2e-5,
			"fastMultiplier":     2.0,
		},
	}
	usage := Usage{Input: 1000, Output: 500}
	at := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)

	calculate := testCostFunc(t, overrides, nativepricing.ModeCalculate)
	cost, missing := calculate("override-only-model", usage, at)
	requireCost(t, "override, calculate", cost, 0.02)
	if missing {
		t.Fatal("an overridden model must not be missing pricing")
	}

	fastUsage := usage
	fastUsage.Fast = true
	fastCost, _ := calculate("override-only-model", fastUsage, at)
	requireCost(t, "override, fast", fastCost, 0.04)

	reported := usage
	reported.ReportedCost = floatPtr(0.5)
	auto := testCostFunc(t, overrides, nativepricing.ModeAuto)
	cost, missing = auto("override-only-model", reported, at)
	requireCost(t, "auto prefers the reported cost", cost, 0.5)
	if missing {
		t.Fatal("auto with a reported cost must not report missing pricing")
	}

	display := testCostFunc(t, overrides, nativepricing.ModeDisplay)
	cost, missing = display("override-only-model", reported, at)
	requireCost(t, "display returns the reported cost", cost, 0.5)
	cost, missing = display("override-only-model", usage, at)
	requireCost(t, "display without a reported cost", cost, 0)
	if missing {
		t.Fatal("display must never report missing pricing")
	}

	calculateReported := usage
	calculateReported.ReportedCost = floatPtr(0.5)
	cost, _ = calculate("override-only-model", calculateReported, at)
	requireCost(t, "calculate ignores the reported cost", cost, 0.02)

	if _, err := NewCostFunc(map[string]any{
		"broken": map[string]any{"inputCostPerToken": "not-a-number"},
	}, nativepricing.ModeAuto); err == nil {
		t.Fatal("NewCostFunc must surface a strict override validation error")
	}
}

// TestPopulateCostsRunsBeforeDedupSoTheCostRungSeesIt is the end-to-end order
// constraint: ccusage prices every entry before push_deduped_daily_entry
// (daily.rs:317-324), and the third replacement rung compares that cost
// (daily.rs:592-599). With equal token totals and no speed, the cost rung is
// the only thing that can pick the second entry - so skipping PopulateCosts
// keeps the first-seen entry instead.
func TestPopulateCostsRunsBeforeDedupSoTheCostRungSeesIt(t *testing.T) {
	at := time.Date(2026, 1, 2, 12, 0, 0, 0, time.UTC)
	first := reportEntry(reportFixture{
		messageID: "msg_shared", requestID: "req_1", model: "model-low", at: at, input: 100,
	})
	second := reportEntry(reportFixture{
		messageID: "msg_shared", requestID: "req_1", model: "model-high", at: at, input: 100,
	})

	populated := PopulateCosts([]Entry{first, second}, func(model string, _ Usage, _ time.Time) (float64, bool) {
		if model == "model-high" {
			return 0.02, false
		}
		return 0.01, false
	})
	if first.Cost != 0 || second.Cost != 0 {
		t.Fatal("PopulateCosts must not mutate its input slice")
	}
	if populated[0].Cost != 0.01 || populated[1].Cost != 0.02 || populated[0].MissingPricing {
		t.Fatalf("PopulateCosts wrote %v/%v (missing %v), want 0.01/0.02",
			populated[0].Cost, populated[1].Cost, populated[0].MissingPricing)
	}
	if populated[0].Usage != first.Usage {
		t.Fatal("PopulateCosts must not touch Usage")
	}

	dedupe := NewDedupe(DedupeDaily)
	for _, entry := range populated {
		dedupe.Add(entry)
	}
	survivors := dedupe.Entries()
	if len(survivors) != 1 {
		t.Fatalf("survivors = %d, want 1", len(survivors))
	}
	if survivors[0].Model != "model-high" {
		t.Fatalf("survivor = %q, want the higher-cost model-high", survivors[0].Model)
	}
}

func floatPtr(value float64) *float64 { return &value }
