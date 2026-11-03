package nativepricing

import (
	"math"
	"testing"
	"time"
)

// int64Value returns a pointer to value for the optional tier fields.
func int64Value(value int64) *int64 { return &value }

// sameBits compares two costs bit for bit. The parity goldens (Task 5) compare
// math.Float64bits, so a helper that tolerates rounding would hide exactly the
// drift they exist to catch.
func sameBits(left, right float64) bool {
	return math.Float64bits(left) == math.Float64bits(right)
}

// corpusPricing builds a one-model primary table so Cost's lookup has a row to
// answer with; the lookup itself is Task 2's subject.
func corpusPricing(model string, pricing CorpusModel) Corpus {
	return Corpus{Models: map[string]CorpusModel{model: pricing}}
}

// costOf runs Cost in one mode and fails when the model is unpriced, which is
// never what the per-branch tests mean to exercise.
func costOf(t *testing.T, corpus Corpus, model string, usage Usage, mode CostMode, fast, flex bool) float64 {
	t.Helper()
	cost, missing := Cost(corpus, model, usage, time.Time{}, mode, fast, flex)
	if missing {
		t.Fatalf("Cost(%q) reported missing pricing, want a priced model", model)
	}
	return cost
}

// calculate costs a usage through the whole-request entry point.
func calculate(t *testing.T, corpus Corpus, model string, usage Usage, fast, flex bool) float64 {
	t.Helper()
	return costOf(t, corpus, model, usage, ModeCalculate, fast, flex)
}

func TestCost_switchesTheWholeRequestAboveTheThreshold(t *testing.T) {
	pricing := CorpusModel{
		Input: 1e-6, Output: 10e-6, CacheCreate: 1.25e-6, CacheRead: 0.1e-6,
		InputAbove: floatValue(2e-6), OutputAbove: floatValue(20e-6),
		CacheCreateAbove: floatValue(2.5e-6), CacheReadAbove: floatValue(0.2e-6),
		LongContextThreshold: int64Value(900),
	}
	corpus := corpusPricing("two-stage", pricing)

	// The context is input + cache read + both cache-creation buckets, so this
	// usage sits exactly on the threshold: context = 600 + 200 + 100 + 0.
	atThreshold := Usage{Input: 600, Output: 100, CacheCreate5m: 100, CacheRead: 200}
	want := 600*1e-6 + 100*10e-6 + 100*1.25e-6 + 200*0.1e-6
	approx(t, calculate(t, corpus, "two-stage", atThreshold, false, false), want, "cost exactly at the threshold")

	// One more context token switches every bucket - including the ones already
	// inside the threshold - to the above band. A marginal tier would bill only
	// the one extra token above.
	above := atThreshold
	above.Input++
	want = 601*2e-6 + 100*20e-6 + 100*2.5e-6 + 200*0.2e-6
	approx(t, calculate(t, corpus, "two-stage", above, false, false), want, "cost one token above the threshold")

	// A bucket the model publishes no above rate for bills at its base rate even
	// in the long-context band.
	partial := CorpusModel{
		Input: 1e-6, Output: 10e-6, CacheCreate: 1.25e-6, CacheRead: 0.1e-6,
		InputAbove: floatValue(2e-6),
		// OutputAbove / CacheCreateAbove / CacheReadAbove stay nil.
		LongContextThreshold: int64Value(900),
	}
	partialCorpus := corpusPricing("two-stage", partial)
	want = 601*2e-6 + 100*10e-6 + 100*1.25e-6 + 200*0.1e-6
	approx(t, calculate(t, partialCorpus, "two-stage", above, false, false), want, "cost with a partial above band")
}

func TestCost_isMarginalForTheDefault200kTier(t *testing.T) {
	// No long-context threshold: the LiteLLM above bands keep their marginal
	// semantics at the default 200K boundary, bucket by bucket.
	pricing := CorpusModel{
		Input: 1e-6, Output: 1e-5, CacheCreate: 1.25e-6, CacheRead: 0.1e-6,
		InputAbove: floatValue(2e-6), CacheCreateAbove: floatValue(1.5e-6),
	}
	corpus := corpusPricing("marginal", pricing)
	usage := Usage{
		Input: 250_000, Output: 100_000,
		CacheCreate5m: 250_000, CacheCreate1h: 250_000,
		CacheRead: 300_000,
	}
	want := (200_000*1e-6 + 50_000*2e-6) + // input: banded
		100_000*1e-5 + // output: no above rate
		(200_000*1.25e-6 + 50_000*1.5e-6) + // cache creation 5m: banded
		(200_000*(1e-6*2) + 50_000*(2e-6*2)) + // cache creation 1h: input×2, above×2
		300_000*0.1e-6 // cache read: no above rate
	approx(t, calculate(t, corpus, "marginal", usage, false, false), want, "marginal cost")

	// A bucket exactly at the boundary stays on the base rate.
	atBoundary := Usage{Input: 200_000}
	approx(t, calculate(t, corpus, "marginal", atBoundary, false, false), 200_000*1e-6, "cost at the 200k boundary")
}

func TestCost_billsOneHourCacheCreationAtDoubleInput(t *testing.T) {
	// CacheCreate is deliberately not input×1.25 so a mix-up shows up.
	pricing := CorpusModel{Input: 1e-6, CacheCreate: 5e-6}
	corpus := corpusPricing("one-hour", pricing)

	approx(t, calculate(t, corpus, "one-hour", Usage{CacheCreate1h: 100}, false, false),
		100*2e-6, "one-hour cache creation bills at input×2")
	approx(t, calculate(t, corpus, "one-hour", Usage{CacheCreate5m: 100}, false, false),
		100*5e-6, "five-minute cache creation bills at the cache-create rate")

	// Above the threshold the one-hour rate doubles the above input rate.
	tiered := CorpusModel{
		Input: 1e-6, CacheCreate: 1.25e-6,
		InputAbove:       floatValue(3e-6),
		CacheCreateAbove: floatValue(1.5e-6),
	}
	tieredCorpus := corpusPricing("one-hour", tiered)
	want := 200_000*(1e-6*2) + 50_000*(3e-6*2) // the above rate is doubled, not the base one
	approx(t, calculate(t, tieredCorpus, "one-hour", Usage{CacheCreate1h: 250_000}, false, false),
		want, "one-hour cache creation above the 200k boundary")
}

func TestCost_appliesFastMultiplierToWholeCost(t *testing.T) {
	pricing := CorpusModel{
		Input: 1e-6, Output: 1e-5, CacheCreate: 1.25e-6, CacheRead: 0.1e-6,
		FastMultiplier: 6, FlexMultiplier: 0.5,
	}
	corpus := corpusPricing("fast-model", pricing)
	usage := Usage{Input: 1000, Output: 100, CacheCreate5m: 2000, CacheRead: 4000}

	base := calculate(t, corpus, "fast-model", usage, false, false)
	fast := calculate(t, corpus, "fast-model", usage, true, false)
	approx(t, fast, base*6, "fast multiplies the whole cost")

	// The Claude path never applies flex: only the Codex adapter does, as a
	// per-bucket ×(flex-1) delta (adapters/codex/src/report.rs:273-274).
	flexOnly := calculate(t, corpus, "fast-model", usage, false, true)
	if !sameBits(flexOnly, base) {
		t.Fatalf("flex changed the Claude cost: got %v, want %v", flexOnly, base)
	}
	both := calculate(t, corpus, "fast-model", usage, true, true)
	approx(t, both, base*6, "flex adds nothing on top of fast")
}

func TestCost_saturatesInsteadOfWrapping(t *testing.T) {
	if got := saturatingAdd(math.MaxInt64, 1, math.MaxInt64); got != math.MaxInt64 {
		t.Fatalf("saturatingAdd overflowed: got %d, want %d", got, math.MaxInt64)
	}
	if got := saturatingAdd(1, 2, 3); got != 6 {
		t.Fatalf("saturatingAdd(1,2,3) = %d, want 6", got)
	}

	// The tier is picked by the whole context, so a saturating sum must stay
	// above the threshold instead of wrapping negative (which would silently
	// bill the base band).
	pricing := CorpusModel{
		Input: 1e-6, Output: 10e-6, CacheCreate: 1.25e-6, CacheRead: 0.1e-6,
		InputAbove: floatValue(2e-6), LongContextThreshold: int64Value(200_000),
	}
	corpus := corpusPricing("huge", pricing)
	usage := Usage{
		Input: math.MaxInt64, Output: math.MaxInt64,
		CacheCreate5m: math.MaxInt64, CacheCreate1h: math.MaxInt64, CacheRead: math.MaxInt64,
	}
	cost := CostFromPricing(usage, pricing, false)
	// The one-hour bucket bills at the above input rate doubled, not at the
	// above cache-create rate.
	want := float64(math.MaxInt64)*2e-6 +
		float64(math.MaxInt64)*10e-6 +
		float64(math.MaxInt64)*1.25e-6 +
		float64(math.MaxInt64)*4e-6 +
		float64(math.MaxInt64)*0.1e-6
	if math.IsInf(cost, 0) || math.IsNaN(cost) {
		t.Fatalf("cost = %v, want a finite long-context total", cost)
	}
	approx(t, cost, want, "saturated long-context cost")
	approx(t, calculate(t, corpus, "huge", usage, false, false), want, "Cost must saturate like CostFromPricing")
}

func TestCost_distinguishesUnknownFromFreeModel(t *testing.T) {
	// A model both snapshots price at zero is rubric-priced, not unpriced.
	corpus := corpusPricing("free-model", CorpusModel{Input: 0, Output: 0})
	usage := Usage{Input: 100, Output: 10}

	cost, missing := Cost(corpus, "free-model", usage, time.Time{}, ModeCalculate, false, false)
	if missing {
		t.Fatal("a found model with zero rates is not missing pricing")
	}
	if cost != 0 {
		t.Fatalf("cost for a free model = %v, want 0", cost)
	}

	cost, missing = Cost(corpus, "unknown-model", usage, time.Time{}, ModeCalculate, false, false)
	if !missing {
		t.Fatal("an unknown model must report missing pricing")
	}
	if cost != 0 {
		t.Fatalf("cost for an unknown model = %v, want 0", cost)
	}
}

func TestCost_displayModeUsesReportedCost(t *testing.T) {
	pricing := CorpusModel{Input: 1e-6, Output: 1e-5, CacheCreate: 1.25e-6, CacheRead: 0.1e-6}
	corpus := corpusPricing("priced", pricing)
	usage := Usage{Input: 1000, Output: 100, ReportedCost: floatValue(1.5)}
	computed := CostFromPricing(usage, pricing, false)
	if sameBits(computed, 1.5) {
		t.Fatal("the fixture must not compute to the reported value, or the modes cannot be told apart")
	}

	// Display never looks prices up, not even for an unknown model.
	if got, missing := Cost(corpus, "unknown-model", usage, time.Time{}, ModeDisplay, false, false); !sameBits(got, 1.5) || missing {
		t.Fatalf("ModeDisplay = (%v, %v), want (1.5, false)", got, missing)
	}
	// Auto trusts a reported cost and computes only without one.
	if got, missing := Cost(corpus, "priced", usage, time.Time{}, ModeAuto, false, false); !sameBits(got, 1.5) || missing {
		t.Fatalf("ModeAuto with a reported cost = (%v, %v), want (1.5, false)", got, missing)
	}
	if got, _ := Cost(corpus, "priced", Usage{Input: 1000, Output: 100}, time.Time{}, ModeAuto, false, false); !sameBits(got, computed) {
		t.Fatalf("ModeAuto without a reported cost = %v, want %v", got, computed)
	}
	// Calculate always computes, reported or not.
	if got := costOf(t, corpus, "priced", usage, ModeCalculate, false, false); !sameBits(got, computed) {
		t.Fatalf("ModeCalculate = %v, want %v", got, computed)
	}
	// Display without a reported cost is zero.
	if got, _ := Cost(corpus, "priced", Usage{Input: 1000}, time.Time{}, ModeDisplay, false, false); got != 0 {
		t.Fatalf("ModeDisplay without a reported cost = %v, want 0", got)
	}
	// A reported cost suppresses the missing-pricing flag the same way it
	// suppresses calculation (cost.rs:48-52).
	if _, missing := Cost(corpus, "unknown-model", usage, time.Time{}, ModeAuto, false, false); missing {
		t.Fatal("Auto mode trusts a stored cost; it must not report missing pricing")
	}
}

// referenceProduct is the test's own multiply: noinline so the caller cannot
// fold it into an FMA with the accumulator.
//
//go:noinline
func referenceProduct(count int64, rate float64) float64 {
	return float64(count) * rate
}

// referenceSum is a plain addition of two already-rounded values. noinline for
// the same reason: an opaque result cannot be fused with a multiply.
//
//go:noinline
func referenceSum(left, right float64) float64 {
	return left + right
}

// referenceOp is one multiply-accumulate step: the unfused variant rounds the
// product before adding, the fused one is a single IEEE fused multiply-add.
type referenceOp func(count int64, rate float64, accumulated float64) float64

func unfusedStep(count int64, rate float64, accumulated float64) float64 {
	return accumulated + referenceProduct(count, rate)
}

func fusedStep(count int64, rate float64, accumulated float64) float64 {
	return math.FMA(float64(count), rate, accumulated)
}

// referenceGrouping selects how the marginal branch combines a bucket's two
// banded terms. ccusage returns each tiered_cost as an independent value and adds
// it to the running total - total + (low + high), which cost.go's
// addTerms(tieredCost(...), ...) reproduces. Folding the threshold term into the
// running total instead (high + (low + total)) is a different association and
// rounds one ULP off on ordinary inputs, which is exactly the drift that forks
// snapshotHash.
type referenceGrouping int

const (
	groupingIndependent referenceGrouping = iota
	groupingReassociated
)

// referenceCost mirrors calculate_cost_from_pricing term for term. step picks the
// arithmetic - mul-then-add, which ccusage and cost.go must both produce, or
// fused multiply-add, which an arm64 FMADDD build would produce for the same
// expression - and grouping picks the marginal branch's association.
//
// Every multiplication goes through referenceProduct, so the fused twin differs
// only where the reference has a real multiply-accumulate: the buckets that feed
// the running total directly. A banded bucket is two rounded products added
// together, and both arithmetics round it the same way, so a fixture whose
// buckets are all past the boundary can pin the association but not the fusion.
func referenceCost(usage Usage, pricing CorpusModel, step referenceOp, grouping referenceGrouping) float64 {
	rate := func(base float64, above *float64, longContext bool) float64 {
		if longContext && above != nil {
			return *above
		}
		return base
	}
	// marginal adds one bucket to the running total the way tiered_cost does: over
	// the boundary the first `threshold` tokens bill at the base rate and the rest
	// at the above rate, as an independent value the caller then sums.
	marginal := func(total float64, tokens int64, base float64, above *float64, threshold int64) float64 {
		if tokens <= 0 {
			return total
		}
		if above != nil && tokens > threshold {
			low := referenceProduct(threshold, base)
			high := referenceProduct(tokens-threshold, *above)
			if grouping == groupingReassociated {
				return referenceSum(high, referenceSum(low, total))
			}
			return referenceSum(total, referenceSum(low, high))
		}
		return step(tokens, base, total)
	}

	cacheCreate1hRate := pricing.Input * 2
	var cacheCreate1hAbove *float64
	if pricing.InputAbove != nil {
		above := *pricing.InputAbove * 2
		cacheCreate1hAbove = &above
	}
	if pricing.LongContextThreshold != nil {
		context := usage.Input + usage.CacheRead + usage.CacheCreate5m + usage.CacheCreate1h
		long := context > *pricing.LongContextThreshold
		total := 0.0
		total = step(usage.Input, rate(pricing.Input, pricing.InputAbove, long), total)
		total = step(usage.Output, rate(pricing.Output, pricing.OutputAbove, long), total)
		total = step(usage.CacheCreate5m, rate(pricing.CacheCreate, pricing.CacheCreateAbove, long), total)
		total = step(usage.CacheCreate1h, rate(cacheCreate1hRate, cacheCreate1hAbove, long), total)
		return step(usage.CacheRead, rate(pricing.CacheRead, pricing.CacheReadAbove, long), total)
	}
	const threshold = 200_000
	total := 0.0
	total = marginal(total, usage.Input, pricing.Input, pricing.InputAbove, threshold)
	total = marginal(total, usage.Output, pricing.Output, pricing.OutputAbove, threshold)
	total = marginal(total, usage.CacheCreate5m, pricing.CacheCreate, pricing.CacheCreateAbove, threshold)
	total = marginal(total, usage.CacheCreate1h, cacheCreate1hRate, cacheCreate1hAbove, threshold)
	return marginal(total, usage.CacheRead, pricing.CacheRead, pricing.CacheReadAbove, threshold)
}

// TestCostFromPricing_isFMAFreeOnArm64 pins the two ways this formula can drift
// from ccusage by one ULP, either of which forks snapshotHash:
//
//   - Go fuses a*b+c into FMADDD on arm64 where Rust never fuses, so a fused term
//     rounds once instead of twice. Every product therefore goes through an
//     opaque helper, and the accumulation must match the multiply-then-add
//     reference bit for bit.
//   - ccusage sums five independent tiered_cost values left to right, so a bucket
//     past the boundary contributes total+(low+high). A port that folds the
//     threshold term into the running total (high+(low+total)) is a different
//     association and rounds one ULP off on ordinary inputs.
//
// Each fixture declares which hazard it can expose, and the test verifies that
// declaration against the references themselves, so no fixture can quietly
// become vacuous.
func TestCostFromPricing_isFMAFreeOnArm64(t *testing.T) {
	marginalPricing := CorpusModel{
		Input: 3e-6, Output: 1.5e-5, CacheCreate: 3.75e-6, CacheRead: 0.3e-6,
		InputAbove: floatValue(6e-6), OutputAbove: floatValue(3e-5),
		CacheCreateAbove: floatValue(4.5e-6), CacheReadAbove: floatValue(0.6e-6),
	}
	wholeRequestPricing := marginalPricing
	wholeRequestPricing.LongContextThreshold = int64Value(200_000)

	cases := map[string]struct {
		pricing CorpusModel
		usage   Usage
		// fmaDiffers records whether the unfused reference and its fused twin
		// round differently: only a bucket whose product feeds the running total
		// directly can show that.
		fmaDiffers bool
		// groupingDiffers records whether the independent and re-associated sums
		// round differently: only a bucket past the boundary has an association
		// to get wrong.
		groupingDiffers bool
	}{
		"marginal band, every bucket inside the boundary": {
			pricing:    marginalPricing,
			usage:      Usage{Input: 133_333, Output: 177_777, CacheCreate5m: 111_119, CacheCreate1h: 122_223, CacheRead: 144_447},
			fmaDiffers: true,
		},
		"marginal band, just past the boundary": {
			pricing:         marginalPricing,
			usage:           Usage{Input: 200_015, Output: 200_080, CacheCreate5m: 200_005, CacheRead: 199_999},
			groupingDiffers: true,
		},
		"marginal band, every bucket past the boundary": {
			pricing:         marginalPricing,
			usage:           Usage{Input: 200_015, Output: 200_080, CacheCreate5m: 200_005, CacheCreate1h: 200_009, CacheRead: 199_999},
			groupingDiffers: true,
		},
		"whole-request band": {
			pricing:    wholeRequestPricing,
			usage:      Usage{Input: 333_331, Output: 777_773, CacheCreate5m: 111_119, CacheCreate1h: 222_229, CacheRead: 444_443},
			fmaDiffers: true,
		},
	}
	fmaCovered, groupingCovered := false, false
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			unfused := referenceCost(testCase.usage, testCase.pricing, unfusedStep, groupingIndependent)
			fused := referenceCost(testCase.usage, testCase.pricing, fusedStep, groupingIndependent)
			folded := referenceCost(testCase.usage, testCase.pricing, unfusedStep, groupingReassociated)
			if got := !sameBits(unfused, fused); got != testCase.fmaDiffers {
				t.Fatalf("fma sensitivity = %v, want %v (unfused %#x, fused %#x)",
					got, testCase.fmaDiffers, math.Float64bits(unfused), math.Float64bits(fused))
			}
			if got := !sameBits(unfused, folded); got != testCase.groupingDiffers {
				t.Fatalf("grouping sensitivity = %v, want %v (independent %#x, re-associated %#x)",
					got, testCase.groupingDiffers, math.Float64bits(unfused), math.Float64bits(folded))
			}
			got := CostFromPricing(testCase.usage, testCase.pricing, false)
			if !sameBits(got, unfused) {
				t.Fatalf("CostFromPricing = %v (%#x), want the mul-then-add, independently summed reference %v (%#x); the fused value is %#x and the re-associated one %#x",
					got, math.Float64bits(got), unfused, math.Float64bits(unfused),
					math.Float64bits(fused), math.Float64bits(folded))
			}
		})
		fmaCovered = fmaCovered || testCase.fmaDiffers
		groupingCovered = groupingCovered || testCase.groupingDiffers
	}
	// Keep at least one fixture per hazard: an all-vacuous table would pass
	// against a fused or re-associated implementation.
	if !fmaCovered || !groupingCovered {
		t.Fatalf("fixtures cover fma=%v grouping=%v, want both hazards covered", fmaCovered, groupingCovered)
	}
}
