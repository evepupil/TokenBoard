package codex

// The report layer of ccusage's Codex adapter, ported from v20.0.33
// (commit 1308c416): rust/adapters/codex/src/report.rs. It turns the aggregated
// groups into the JSON document `ccusage codex daily --json --breakdown`
// prints, with the bucket-cost formula that the DeepSeek schedule and the fast /
// flex service tiers need.
//
// Nothing here re-reads a transcript: the groups already carry every counter
// the formulas sum.

import (
	"sort"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// SpeedPolicy is CodexSpeedPolicy (speed.rs:8-13).
type SpeedPolicy struct {
	// Forced pins one tier; Auto keeps the per-event recorded tiers.
	Forced bool
	Tier   Tier
}

// ReportJSON is report_from_groups (report.rs:16-35): one row per group, keyed
// by the kind's period key, plus totals.
func ReportJSON(groups map[string]*Group, kind ReportKind, pricing *nativepricing.Corpus, speed SpeedPolicy, mode nativepricing.CostMode) map[string]any {
	periods := SortedPeriods(groups)
	rows := make([]any, 0, len(periods))
	totals := totalsAccumulator{}
	for _, period := range periods {
		group := groups[period]
		rows = append(rows, groupJSON(period, group, kind, pricing, speed, mode))
		totals.add(group)
		totals.cost += groupCost(group, pricing, speed)
	}
	document := map[string]any{rowsKey(kind): rows}
	totalsValue := totals.json()
	if mode != nativepricing.ModeDisplay {
		if unpriced := missingPricingModels(groups, pricing); len(unpriced) > 0 {
			totalsValue["unpricedModels"] = unpriced
		}
	}
	document["totals"] = totalsValue
	return document
}

func rowsKey(kind ReportKind) string {
	switch kind {
	case ReportWeekly:
		return "weekly"
	case ReportMonthly:
		return "monthly"
	case ReportSession:
		return "sessions"
	}
	return "daily"
}

func periodKey(kind ReportKind) string {
	switch kind {
	case ReportWeekly:
		return "week"
	case ReportMonthly:
		return "month"
	case ReportSession:
		return "sessionId"
	}
	return "date"
}

func groupJSON(period string, group *Group, kind ReportKind, pricing *nativepricing.Corpus, speed SpeedPolicy, mode nativepricing.CostMode) map[string]any {
	models := make(map[string]any, len(group.Models))
	for model, usage := range group.Models {
		value := modelUsageJSON(usage)
		if mode != nativepricing.ModeDisplay && modelMissingPricing(model, usage, pricing) {
			value["missingPricing"] = true
		}
		models[model] = value
	}
	row := map[string]any{
		periodKey(kind):         period,
		"inputTokens":           nonCachedInput(group.Input, group.CachedInput, group.CacheCreation),
		"cacheCreationTokens":   group.CacheCreation,
		"cacheReadTokens":       group.CachedInput,
		"outputTokens":          group.Output,
		"reasoningOutputTokens": group.Reasoning,
		"totalTokens":           group.Total,
		"costUSD":               groupCost(group, pricing, speed),
		"models":                models,
	}
	if kind == ReportSession {
		row["lastActivity"] = group.LastActivity
		if separator := lastSlash(period); separator >= 0 {
			row["sessionFile"] = period[separator+1:]
			row["directory"] = period[:separator]
		} else {
			row["sessionFile"] = period
			row["directory"] = ""
		}
	}
	return row
}

// lastSlash is str::rfind('/').
func lastSlash(value string) int {
	for index := len(value) - 1; index >= 0; index-- {
		if value[index] == '/' {
			return index
		}
	}
	return -1
}

// nonCachedInput is non_cached_input_tokens (report.rs:122-128): input minus
// both cache buckets, saturating.
func nonCachedInput(input, cached, creation uint64) uint64 {
	both := saturatingAddU64(cached, creation)
	if both >= input {
		return 0
	}
	return input - both
}

func modelUsageJSON(usage *ModelUsage) map[string]any {
	return map[string]any{
		"inputTokens":           nonCachedInput(usage.Input, usage.CachedInput, usage.CacheCreation),
		"cacheCreationTokens":   usage.CacheCreation,
		"cacheReadTokens":       usage.CachedInput,
		"outputTokens":          usage.Output,
		"reasoningOutputTokens": usage.Reasoning,
		"totalTokens":           usage.Total,
		"isFallback":            usage.IsFallback,
	}
}

// totalsAccumulator is totals_json (report.rs:147-181): per-field saturating
// sums over the groups plus the summed group costs.
type totalsAccumulator struct {
	input, cached, creation, output, reasoning, total uint64
	cost                                              float64
}

func (t *totalsAccumulator) add(group *Group) {
	t.input = saturatingAddU64(t.input, nonCachedInput(group.Input, group.CachedInput, group.CacheCreation))
	t.cached = saturatingAddU64(t.cached, group.CachedInput)
	t.creation = saturatingAddU64(t.creation, group.CacheCreation)
	t.output = saturatingAddU64(t.output, group.Output)
	t.reasoning = saturatingAddU64(t.reasoning, group.Reasoning)
	t.total = saturatingAddU64(t.total, group.Total)
}

func (t totalsAccumulator) json() map[string]any {
	return map[string]any{
		"inputTokens":           t.input,
		"cacheCreationTokens":   t.creation,
		"cacheReadTokens":       t.cached,
		"outputTokens":          t.output,
		"reasoningOutputTokens": t.reasoning,
		"totalTokens":           t.total,
		"costUSD":               t.cost,
	}
}

// ModelCost is calculate_codex_model_cost (report.rs:183-206): a model with
// time buckets is priced bucket by bucket at that bucket's instant, and a model
// without them is priced once.
func ModelCost(model string, usage *ModelUsage, corpus *nativepricing.Corpus, now time.Time, speed SpeedPolicy) float64 {
	if len(usage.Timestamped) > 0 {
		timestamps := make([]int64, 0, len(usage.Timestamped))
		for timestamp := range usage.Timestamped {
			timestamps = append(timestamps, timestamp)
		}
		sort.Slice(timestamps, func(i, j int) bool { return timestamps[i] < timestamps[j] })
		var total float64
		for _, timestamp := range timestamps {
			pricing, ok := corpus.FindAt(model, timestamp)
			if !ok {
				continue
			}
			total += timestampedCost(usage.Timestamped[timestamp], pricing, speed)
		}
		return total
	}
	pricing, ok := corpus.Find(model)
	if !ok {
		return 0
	}
	return usageCost(modelBucket(usage), usage.RecordedStandard, usage.RecordedFlex, usage.RecordedFast, pricing, speed)
}

// groupCost is calculate_group_cost (report.rs:389-399): the sum over the
// group's models. now is unused here because every cost comes from a bucket
// timestamp; the parameter stays for the plan's interface.
func groupCost(group *Group, corpus *nativepricing.Corpus, speed SpeedPolicy) float64 {
	// Rust sums a BTreeMap, so the models arrive in ascending name order and
	// the float sum is reproducible. Ranging over the Go map instead lets
	// iteration order leak into costUSD (TestGroupCostSumsModelsInSortedOrder).
	models := make([]string, 0, len(group.Models))
	for model := range group.Models {
		models = append(models, model)
	}
	sort.Strings(models)
	var total float64
	for _, model := range models {
		total += ModelCost(model, group.Models[model], corpus, time.UnixMilli(0), speed)
	}
	return total
}

func timestampedCost(usage *TimestampedUsage, pricing nativepricing.CorpusModel, speed SpeedPolicy) float64 {
	return usageCost(usage.Usage, usage.RecordedStandard, usage.RecordedFlex, usage.RecordedFast, pricing, speed)
}

func modelBucket(usage *ModelUsage) Bucket {
	return Bucket{
		Input:                    usage.Input,
		CachedInput:              usage.CachedInput,
		CacheCreation:            usage.CacheCreation,
		Output:                   usage.Output,
		LongContextInput:         usage.LongContextInput,
		LongContextCachedInput:   usage.LongContextCachedInput,
		LongContextCacheCreation: usage.LongContextCacheCreation,
		LongContextOutput:        usage.LongContextOutput,
	}
}

// usageCost is calculate_codex_usage_cost (report.rs:227-268): the standard
// bucket at full price, the service tiers at their incremental multiplier, and
// a forced tier that re-books the whole model.
func usageCost(total, recordedStandard, recordedFlex, recordedFast Bucket, pricing nativepricing.CorpusModel, speed SpeedPolicy) float64 {
	standardCost := bucketCost(total, pricing)
	if speed.Forced && speed.Tier == TierStandard {
		return standardCost
	}
	unclassified := subtractBuckets(total, addBuckets(recordedStandard, addBuckets(recordedFlex, recordedFast)))
	var flexUsage, fastUsage Bucket
	switch {
	case speed.Forced && speed.Tier == TierFlex:
		flexUsage = total
	case speed.Forced && speed.Tier == TierFast:
		fastUsage = total
	case speed.Tier == TierFlex:
		flexUsage = addBuckets(recordedFlex, unclassified)
		fastUsage = recordedFast
	case speed.Tier == TierFast:
		flexUsage = recordedFlex
		fastUsage = addBuckets(recordedFast, unclassified)
	default:
		flexUsage = recordedFlex
		fastUsage = recordedFast
	}
	return nativepricing.Sum(
		standardCost,
		nativepricing.Product(bucketCost(flexUsage, pricing), pricing.FlexMultiplier-1),
		nativepricing.Product(bucketCost(fastUsage, pricing), pricing.FastMultiplier-1),
	)
}

// bucketCost is calculate_codex_bucket_cost (report.rs:389-391 in the Rust
// source's formula section, 353-392): a long-context request bills entirely at
// its above bands, so the aggregated usage splits into two independent buckets.
// The eight-term sum keeps the Rust source's addition order because floating
// addition is not associative.
func bucketCost(usage Bucket, pricing nativepricing.CorpusModel) float64 {
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
	// Every product goes through nativepricing.Product: Go fuses `a*b + c` into
	// FMADDD on arm64 while Rust rounds the product first, so the unguarded form
	// drifts by 1 ULP exactly where ccusage does not. TestBucketCostIsNotFused
	// pins the bits.
	return nativepricing.Sum(
		nativepricing.Product(float64(shortNonCached), pricing.Input),
		nativepricing.Product(float64(shortCached), cacheRead),
		nativepricing.Product(float64(shortCreation), cacheCreation),
		nativepricing.Product(float64(saturatingSubU64(usage.Output, longOutput)), pricing.Output),
		nativepricing.Product(float64(longNonCached), longInputRate),
		nativepricing.Product(float64(longCached), longCacheRead),
		nativepricing.Product(float64(longCreation), longCacheCreationRate),
		nativepricing.Product(float64(longOutput), longOutputRate),
	)
}

func addBuckets(left, right Bucket) Bucket {
	return Bucket{
		Input:                    saturatingAddU64(left.Input, right.Input),
		CachedInput:              saturatingAddU64(left.CachedInput, right.CachedInput),
		CacheCreation:            saturatingAddU64(left.CacheCreation, right.CacheCreation),
		Output:                   saturatingAddU64(left.Output, right.Output),
		LongContextInput:         saturatingAddU64(left.LongContextInput, right.LongContextInput),
		LongContextCachedInput:   saturatingAddU64(left.LongContextCachedInput, right.LongContextCachedInput),
		LongContextCacheCreation: saturatingAddU64(left.LongContextCacheCreation, right.LongContextCacheCreation),
		LongContextOutput:        saturatingAddU64(left.LongContextOutput, right.LongContextOutput),
	}
}

func subtractBuckets(total, excluded Bucket) Bucket {
	return Bucket{
		Input:                    saturatingSubU64(total.Input, excluded.Input),
		CachedInput:              saturatingSubU64(total.CachedInput, excluded.CachedInput),
		CacheCreation:            saturatingSubU64(total.CacheCreation, excluded.CacheCreation),
		Output:                   saturatingSubU64(total.Output, excluded.Output),
		LongContextInput:         saturatingSubU64(total.LongContextInput, excluded.LongContextInput),
		LongContextCachedInput:   saturatingSubU64(total.LongContextCachedInput, excluded.LongContextCachedInput),
		LongContextCacheCreation: saturatingSubU64(total.LongContextCacheCreation, excluded.LongContextCacheCreation),
		LongContextOutput:        saturatingSubU64(total.LongContextOutput, excluded.LongContextOutput),
	}
}

func saturatingSubU64(left, right uint64) uint64 {
	if right > left {
		return 0
	}
	return left - right
}

func minU64(left, right uint64) uint64 {
	if left < right {
		return left
	}
	return right
}

// modelMissingPricing is codex_model_missing_pricing (report.rs:401-412):
// missing_pricing_model_for_token_total against the model's larger of the
// recorded total and the input+output sum, with the pricing table as the
// answerer. A zero total is silent, exactly as upstream.
func modelMissingPricing(model string, usage *ModelUsage, corpus *nativepricing.Corpus) bool {
	tokens := maxU64(usage.Total, saturatingAddU64(usage.Input, usage.Output))
	if tokens == 0 {
		return false
	}
	_, ok := corpus.Find(model)
	return !ok
}

func missingPricingModels(groups map[string]*Group, corpus *nativepricing.Corpus) []string {
	seen := map[string]struct{}{}
	for _, group := range groups {
		for model, usage := range group.Models {
			if modelMissingPricing(model, usage, corpus) {
				seen[model] = struct{}{}
			}
		}
	}
	models := make([]string, 0, len(seen))
	for model := range seen {
		models = append(models, model)
	}
	sort.Strings(models)
	return models
}

func maxU64(left, right uint64) uint64 {
	if left > right {
		return left
	}
	return right
}
