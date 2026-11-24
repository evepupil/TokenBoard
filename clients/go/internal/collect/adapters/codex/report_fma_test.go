package codex

// The Codex cost formulas are the first ones outside internal/nativepricing,
// so they need the same arm64 guard that package keeps: Go fuses `a*b + c`
// into FMADDD where Rust (and therefore ccusage) rounds the product first and
// then adds, which drifts the cost by 1 ULP and forks snapshotHash. These
// tests mirror each formula's term list twice - once rounding like Rust, once
// with math.FMA like a fused arm64 build - and require the production code to
// answer with the Rust rounding. The fusion sensitivity is asserted too, so a
// fixture cannot quietly stop covering the hazard.

import (
	"math"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

func floatPointer(value float64) *float64 { return &value }

func sameCostBits(left, right float64) bool {
	return math.Float64bits(left) == math.Float64bits(right)
}

// costStep folds one product into the running total. unfusedCostStep is
// ccusage's arithmetic (multiply, round, add, round); fusedCostStep is what an
// unguarded arm64 build does (multiply-add, rounded once).
type costStep func(total float64, count uint64, rate float64) float64

func unfusedCostStep(total float64, count uint64, rate float64) float64 {
	product := float64(count) * rate
	product = math.Float64frombits(math.Float64bits(product))
	return math.Float64frombits(math.Float64bits(total + product))
}

func fusedCostStep(total float64, count uint64, rate float64) float64 {
	return math.FMA(float64(count), rate, total)
}

// referenceBucketCost recomputes bucketCost's eight-term sum with a chosen
// folding strategy: same clamps, same term order.
func referenceBucketCost(usage Bucket, pricing nativepricing.CorpusModel, step costStep) float64 {
	cacheRead := pricing.CacheRead
	if !pricing.CacheReadExplicit {
		cacheRead = pricing.Input
	}
	cacheCreation := pricing.CacheCreate
	longInputRate := pricing.Input
	if pricing.InputAbove != nil {
		longInputRate = *pricing.InputAbove
	}
	longOutputRate := pricing.Output
	if pricing.OutputAbove != nil {
		longOutputRate = *pricing.OutputAbove
	}
	longCacheRead := cacheRead
	if pricing.CacheReadExplicit && pricing.CacheReadAbove != nil {
		longCacheRead = *pricing.CacheReadAbove
	} else if !pricing.CacheReadExplicit {
		longCacheRead = longInputRate
	}
	longCacheCreationRate := cacheCreation
	if pricing.CacheCreateAbove != nil {
		longCacheCreationRate = *pricing.CacheCreateAbove
	}
	longInput := minU64(usage.LongContextInput, usage.Input)
	longCached := minU64(minU64(usage.LongContextCachedInput, usage.CachedInput), longInput)
	longCreation := minU64(minU64(usage.LongContextCacheCreation, usage.CacheCreation), saturatingSubU64(longInput, longCached))
	longOutput := minU64(usage.LongContextOutput, usage.Output)
	shortCached := saturatingSubU64(usage.CachedInput, longCached)
	shortCreation := saturatingSubU64(usage.CacheCreation, longCreation)
	shortNonCached := saturatingSubU64(saturatingSubU64(usage.Input, longInput), saturatingAddU64(shortCached, shortCreation))
	longNonCached := saturatingSubU64(longInput, saturatingAddU64(longCached, longCreation))

	total := float64(shortNonCached) * pricing.Input
	total = math.Float64frombits(math.Float64bits(total))
	total = step(total, shortCached, cacheRead)
	total = step(total, shortCreation, cacheCreation)
	total = step(total, saturatingSubU64(usage.Output, longOutput), pricing.Output)
	total = step(total, longNonCached, longInputRate)
	total = step(total, longCached, longCacheRead)
	total = step(total, longCreation, longCacheCreationRate)
	return step(total, longOutput, longOutputRate)
}

func fmaTestPricing() nativepricing.CorpusModel {
	return nativepricing.CorpusModel{
		Input: 3e-6, Output: 1.5e-5, CacheCreate: 3.75e-6, CacheRead: 0.3e-6,
		CacheReadExplicit: true,
		InputAbove:        floatPointer(6e-6),
		OutputAbove:       floatPointer(3e-5),
		CacheCreateAbove:  floatPointer(4.5e-6),
		CacheReadAbove:    floatPointer(0.6e-6),
		FastMultiplier:    2.5,
	}
}

func fmaTestUsage() Bucket {
	// Chosen by search so that a fused arm64 build returns a different bit
	// pattern from the multiply-then-add reference; the sensitivity is asserted
	// in both tests below.
	return Bucket{
		Input:                    287_670,
		CachedInput:              63_122,
		CacheCreation:            126_467,
		Output:                   474_375,
		LongContextInput:         105_887,
		LongContextCachedInput:   13_710,
		LongContextCacheCreation: 58_959,
		LongContextOutput:        304_103,
	}
}

// TestBucketCostIsNotFused pins calculate_codex_bucket_cost to Rust's
// multiply-then-add rounding. A fused build returns a different bit pattern for
// this fixture, so the guard cannot be dropped silently.
func TestBucketCostIsNotFused(t *testing.T) {
	pricing := fmaTestPricing()
	usage := fmaTestUsage()
	unfused := referenceBucketCost(usage, pricing, unfusedCostStep)
	fused := referenceBucketCost(usage, pricing, fusedCostStep)
	if sameCostBits(unfused, fused) {
		t.Fatalf("fixture is not FMA-sensitive: unfused %#x, fused %#x",
			math.Float64bits(unfused), math.Float64bits(fused))
	}
	got := bucketCost(usage, pricing)
	if !sameCostBits(got, unfused) {
		t.Fatalf("bucketCost = %v (%#x), want the multiply-then-add value %v (%#x); the fused value is %#x",
			got, math.Float64bits(got), unfused, math.Float64bits(unfused), math.Float64bits(fused))
	}
}

// TestUsageCostIsNotFused pins the service-tier multiplier products in
// calculate_codex_usage_cost the same way: standard + bucket*(multiplier-1)
// must round the product before adding.
func TestUsageCostIsNotFused(t *testing.T) {
	pricing := fmaTestPricing()
	// A second searched bucket: this one is only sensitive in the
	// multiplier-product step (bucket*(2.5-1) added to standard), not in the
	// bucket sum itself.
	usage := Bucket{
		Input:                    1_021_165,
		CachedInput:              594_792,
		CacheCreation:            130_645,
		Output:                   411_103,
		LongContextInput:         376_371,
		LongContextCachedInput:   352_452,
		LongContextCacheCreation: 6_173,
		LongContextOutput:        232_853,
	}
	standard := referenceBucketCost(usage, pricing, unfusedCostStep)
	fastBucket := referenceBucketCost(usage, pricing, unfusedCostStep)

	unfusedTotal := standard
	product := fastBucket * (pricing.FastMultiplier - 1)
	product = math.Float64frombits(math.Float64bits(product))
	unfusedTotal = math.Float64frombits(math.Float64bits(unfusedTotal + product))
	fusedTotal := math.FMA(fastBucket, pricing.FastMultiplier-1, standard)
	if sameCostBits(unfusedTotal, fusedTotal) {
		t.Fatalf("fixture is not FMA-sensitive: unfused %#x, fused %#x",
			math.Float64bits(unfusedTotal), math.Float64bits(fusedTotal))
	}

	speed := SpeedPolicy{Forced: true, Tier: TierFast}
	got := usageCost(usage, Bucket{}, Bucket{}, Bucket{}, pricing, speed)
	if !sameCostBits(got, unfusedTotal) {
		t.Fatalf("usageCost = %v (%#x), want the multiply-then-add value %v (%#x); the fused value is %#x",
			got, math.Float64bits(got), unfusedTotal, math.Float64bits(unfusedTotal), math.Float64bits(fusedTotal))
	}
}
