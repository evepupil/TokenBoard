package codex

// The bucket-cost formula and the speed detection, pinned against ccusage
// v20.0.33 (commit 1308c416): rust/adapters/codex/src/report.rs:183-399 and
// speed.rs.

import (
	"math"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// TestBucketCostSplitsLongContextAtThreshold pins calculate_codex_bucket_cost
// (report.rs:353-392): a long-context request bills entirely at its above
// bands, the short part at the flat rates, and the eight-term sum follows the
// Rust addition order.
func TestBucketCostSplitsLongContextAtThreshold(t *testing.T) {
	pricing := nativepricing.CorpusModel{
		Input: 1e-6, Output: 2e-6, CacheRead: 0.1e-6, CacheCreate: 1.25e-6,
		CacheReadExplicit: true,
		InputAbove:        rateOf(2e-6), OutputAbove: rateOf(4e-6),
		CacheReadAbove: rateOf(0.2e-6), CacheCreateAbove: rateOf(2.5e-6),
	}
	usage := Bucket{
		Input: 10_000, CachedInput: 1_000, CacheCreation: 500, Output: 2_000,
		LongContextInput:         5_000,
		LongContextCachedInput:   400,
		LongContextCacheCreation: 200,
		LongContextOutput:        1_000,
	}
	// Short: non-cached 10_000-5_000-600-300=4_100 @1, cached 600 @0.1,
	// creation 300 @1.25, output 1_000 @2.
	// Long: non-cached 5_000-400-200=4_400 @2, cached 400 @0.2,
	// creation 200 @2.5, output 1_000 @4.
	want := 4_100*1e-6 + 600*0.1e-6 + 300*1.25e-6 + 1_000*2e-6 +
		4_400*2e-6 + 400*0.2e-6 + 200*2.5e-6 + 1_000*4e-6
	got := bucketCost(usage, pricing)
	if math.Abs(got-want) > 1e-15 {
		t.Fatalf("bucket cost = %.12g, want %.12g", got, want)
	}
}

// TestCacheReadFallsBackToInputRateWhenNotExplicit pins the cache-read rate
// selection (report.rs:354-367): a derived cache rate bills at the input rate,
// and the long-context band follows the same rule.
func TestCacheReadFallsBackToInputRateWhenNotExplicit(t *testing.T) {
	pricing := nativepricing.CorpusModel{Input: 1e-6, Output: 2e-6, CacheRead: 9e-9, CacheCreate: 1.25e-6}
	usage := Bucket{Input: 1_000, Output: 100, LongContextInput: 1_000, LongContextOutput: 100}
	// Everything is long-context: non-cached 1_000 at the (missing) above rate
	// falling back to flat input, and 100 output at flat output.
	want := 1_000*1e-6 + 100*2e-6
	got := bucketCost(usage, pricing)
	if math.Abs(got-want) > 1e-15 {
		t.Fatalf("flat cache-read fallback = %.12g, want %.12g", got, want)
	}

	// An explicit rate bills cache reads at that rate; with no long-context
	// part the short bucket decides the whole cost.
	pricing.CacheReadExplicit = true
	pricing.CacheRead = 0.5e-6
	short := Bucket{Input: 1_000, CachedInput: 300}
	want = 700*1e-6 + 300*0.5e-6
	got = bucketCost(short, pricing)
	if math.Abs(got-want) > 1e-15 {
		t.Fatalf("explicit cache-read = %.12g, want %.12g", got, want)
	}
}

// TestSpeedMultiplierIsIncremental pins the ×(multiplier − 1) terms
// (report.rs:260-267): the standard bucket is charged once, and each tier adds
// only its delta.
func TestSpeedMultiplierIsIncremental(t *testing.T) {
	pricing := nativepricing.CorpusModel{
		Input: 1e-6, Output: 2e-6, CacheRead: 0.1e-6, CacheCreate: 1.25e-6,
		CacheReadExplicit: true, FastMultiplier: 2, FlexMultiplier: 8,
	}
	total := Bucket{Input: 1_000, Output: 100}
	fast := Bucket{Input: 400, Output: 40}
	flex := Bucket{Input: 200, Output: 20}
	// Standard bucket at full price; fast adds 400 @2e-6+... × (2-1) worth of
	// delta on the fast bucket, flex ×(8-1) on its own.
	standard := bucketCost(total, pricing)
	fastDelta := bucketCost(fast, pricing) * (2 - 1)
	flexDelta := bucketCost(flex, pricing) * (8 - 1)
	got := usageCost(total, flex, flex, fast, pricing, SpeedPolicy{Tier: TierStandard})
	want := standard + flexDelta + fastDelta
	if math.Abs(got-want) > 1e-15 {
		t.Fatalf("incremental cost = %.12g, want %.12g", got, want)
	}
}

// TestForcedStandardIgnoresRecordedTiers pins the Forced(Standard) early return
// (report.rs:240-242): only the whole-model bucket at flat price, no tier
// deltas, no unclassified redistribution.
func TestForcedStandardIgnoresRecordedTiers(t *testing.T) {
	pricing := nativepricing.CorpusModel{
		Input: 1e-6, Output: 2e-6, CacheRead: 0.1e-6, CacheCreate: 1.25e-6,
		CacheReadExplicit: true, FastMultiplier: 5, FlexMultiplier: 5,
	}
	total := Bucket{Input: 1_000, Output: 100}
	recorded := Bucket{Input: 300, Output: 30}
	forced := usageCost(total, recorded, recorded, recorded, pricing, SpeedPolicy{Forced: true, Tier: TierStandard})
	if math.Abs(forced-bucketCost(total, pricing)) > 1e-15 {
		t.Fatalf("forced standard = %.12g, want the flat standard cost", forced)
	}
	// Auto with the same recorded buckets would add tier deltas; prove the
	// forced value differs from it so the test cannot pass trivially.
	auto := usageCost(total, recorded, recorded, recorded, pricing, SpeedPolicy{Tier: TierStandard})
	if math.Abs(auto-forced) < 1e-15 {
		t.Fatal("auto and forced standard coincide; the test cannot tell them apart")
	}
}

// TestAutoSpeedUsesRecordedTiersAndUnclassifiedFallsBack pins the Auto(Fast) /
// Auto(Flex) redistribution (report.rs:243-259): the unclassified remainder is
// attributed to the detected tier and its multiplier delta applies to it.
func TestAutoSpeedUsesRecordedTiersAndUnclassifiedFallsBack(t *testing.T) {
	pricing := nativepricing.CorpusModel{
		Input: 1e-6, Output: 0, CacheRead: 0, CacheCreate: 0,
		CacheReadExplicit: true, FastMultiplier: 2, FlexMultiplier: 1,
	}
	total := Bucket{Input: 1_000}
	recordedFast := Bucket{Input: 300}
	// Auto(Fast): unclassified 700 joins the fast bucket → 1_000 @2e-6 ×1.
	got := usageCost(total, Bucket{}, Bucket{}, recordedFast, pricing, SpeedPolicy{Tier: TierFast})
	want := bucketCost(total, pricing) + bucketCost(addBuckets(recordedFast, subtractBuckets(total, recordedFast)), pricing)*(2-1)
	if math.Abs(got-want) > 1e-15 {
		t.Fatalf("auto fast = %.12g, want %.12g", got, want)
	}
	// Auto(Standard): the unclassified 700 stays at standard price only.
	got = usageCost(total, Bucket{}, Bucket{}, recordedFast, pricing, SpeedPolicy{Tier: TierStandard})
	want = bucketCost(total, pricing) + bucketCost(recordedFast, pricing)*(2-1)
	if math.Abs(got-want) > 1e-15 {
		t.Fatalf("auto standard = %.12g, want %.12g", got, want)
	}
}

func rateOf(value float64) *float64 { return &value }

// oldScheduleMillis is inside the pre-cutoff window; peakScheduleMillis is a
// Monday peak hour after the cutoff.
func oldScheduleMillis(t *testing.T) int64 {
	t.Helper()
	instant, err := time.Parse(time.RFC3339, "2026-07-01T02:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	return instant.UnixMilli()
}

func peakScheduleMillis(t *testing.T) int64 {
	t.Helper()
	instant, err := time.Parse(time.RFC3339, "2026-08-17T02:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	return instant.UnixMilli()
}

// TestTimestampedModelsArePricedPerBucket pins calculate_codex_model_cost's
// time-bucket arm (report.rs:183-198): each bucket is priced with FindAt at its
// own instant, so the same tokens bill differently across the cutoff.
func TestTimestampedModelsArePricedPerBucket(t *testing.T) {
	corpus := testCorpus(t)
	usage := &ModelUsage{Timestamped: map[int64]*TimestampedUsage{}}
	// 1M input, 1M output: the old schedule bills 0.42, the peak schedule 1.76.
	usage.Timestamped[oldScheduleMillis(t)] = &TimestampedUsage{Usage: Bucket{Input: 1_000_000, Output: 1_000_000}}
	usage.Timestamped[peakScheduleMillis(t)] = &TimestampedUsage{Usage: Bucket{Input: 1_000_000, Output: 1_000_000}}
	got := ModelCost("deepseek-v4-flash", usage, corpus, time.Time{}, SpeedPolicy{})
	want := (0.14e-6+0.28e-6)*1_000_000 + (0.44e-6+1.32e-6)*1_000_000
	if math.Abs(got-want) > 1e-12 {
		t.Fatalf("timestamped cost = %.12g, want %.12g", got, want)
	}
}

// TestUnpricedModelCostsNothing pins the Find miss arm (report.rs:200-205): a
// model no table prices contributes zero, not an error.
func TestUnpricedModelCostsNothing(t *testing.T) {
	corpus := testCorpus(t)
	usage := &ModelUsage{Input: 100, Output: 10, Total: 110}
	if got := ModelCost("tokenboard-unpriced-2099", usage, corpus, time.Time{}, SpeedPolicy{}); got != 0 {
		t.Fatalf("unpriced model cost = %v, want 0", got)
	}
}
