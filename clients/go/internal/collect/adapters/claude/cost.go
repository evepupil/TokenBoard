package claude

// The pricing pass is the layer between the parser and the dedupe index:
// ccusage prices every loaded entry before it is deduped (daily.rs:317-330,
// lib.rs:516-524) because the daily replacement ladder compares the cost
// (daily.rs:592-599). Ported from ccusage v20.0.33 (commit 1308c416),
// rust/crates/ccusage-core/src/cost.rs, on top of the S1 nativepricing corpus.
//
// Two behaviours live here rather than in nativepricing:
//
//   - the zero-token silence of missing_pricing_model_for_usage (cost.rs:58,
//     66-68), which nativepricing.Cost does not implement (the S1 design
//     registers it as S4 debt, docs/superpowers/specs/2026-11-03-native-usage-sources-design.md
//     §8.1), and
//   - the absent-model short circuit, which keeps an empty model name from
//     reaching Corpus.Find: the fuzzy finder would answer "" from an arbitrary
//     table row, while ccusage returns 0.0 before it ever looks (cost.rs:99-101).

import (
	"sync"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// CostMode is nativepricing's mode ladder (cost.rs:31-45): Display uses the
// reported cost, Auto prefers it and computes otherwise, Calculate always
// computes.
type CostMode = nativepricing.CostMode

// CostFunc prices one entry: the raw model name, the entry's usage and its
// timestamp. missing reports a usage that found no price; the report layer only
// records it (ModelBreakdown.missing_pricing) and never re-prices.
type CostFunc func(model string, u Usage, at time.Time) (cost float64, missing bool)

// NewCostFunc loads the embedded pricing corpus, applies the server's
// camelCase overrides, and returns a cost function pinned to mode.
//
// The mode is an argument because ccusage's `--mode` is per invocation
// (calculate_cost_for_usage_at, cost.rs:31-45) and the function has no other
// seam to reach it; Task 5 passes Options.Mode here. The brief's signature
// omitted it, which would have made all three modes unreachable.
//
// The error comes from WithOverrides' strict validation: a malformed rate must
// fail the collection rather than price a model from a half-applied override,
// which is what ccusage's serde would have done with the same config.
func NewCostFunc(overrides map[string]any, mode CostMode) (CostFunc, error) {
	corpus, err := nativepricing.LoadEmbeddedCorpus()
	if err != nil {
		return nil, err
	}
	corpus, err = corpus.WithOverrides(overrides)
	if err != nil {
		return nil, err
	}
	find := memoizeFind(corpus)
	findAt := memoizeFindAt(corpus)
	return func(model string, usage Usage, at time.Time) (float64, bool) {
		return priceUsage(find, findAt, mode, model, usage, at)
	}, nil
}

// findModel resolves a model name to its rates, reporting false for a name no
// table prices.
type findModel func(model string) (nativepricing.CorpusModel, bool)

// memoizeFind caches Corpus.Find per model name. One transcript repeats the
// same handful of model ids across tens of thousands of lines, and a miss (or
// a fuzzy hit) scans all 3423 corpus keys with string matching on every call;
// the corpus is immutable after construction, so one resolution per distinct
// name is exact.
//
// The mutex keeps the cache safe if a caller ever prices concurrently; the
// collection itself streams on one goroutine.
func memoizeFind(corpus nativepricing.Corpus) findModel {
	type resolution struct {
		pricing nativepricing.CorpusModel
		ok      bool
	}
	var mutex sync.Mutex
	cache := make(map[string]resolution, 32)
	return func(model string) (nativepricing.CorpusModel, bool) {
		mutex.Lock()
		hit, seen := cache[model]
		mutex.Unlock()
		if seen {
			return hit.pricing, hit.ok
		}
		pricing, ok := corpus.Find(model)
		mutex.Lock()
		cache[model] = resolution{pricing: pricing, ok: ok}
		mutex.Unlock()
		return pricing, ok
	}
}

// findAtFunc resolves a model at one instant (Corpus.FindAt).
type findAtFunc func(model string, millis int64) (nativepricing.CorpusModel, bool)

// memoizeFindAt caches Corpus.FindAt in hourly buckets per model. The DeepSeek
// schedule is constant on whole UTC hours (pricing.rs:335-347), so a bucket key
// is exact; one transcript repeats the same handful of model ids, and without
// the cache every priced line would rescan the corpus.
func memoizeFindAt(corpus nativepricing.Corpus) findAtFunc {
	type resolution struct {
		pricing nativepricing.CorpusModel
		ok      bool
	}
	type key struct {
		model      string
		hourBucket int64
	}
	var mutex sync.Mutex
	cache := make(map[key]resolution, 32)
	return func(model string, millis int64) (nativepricing.CorpusModel, bool) {
		bucket := key{model: model, hourBucket: floorDivHour(millis)}
		mutex.Lock()
		hit, seen := cache[bucket]
		mutex.Unlock()
		if seen {
			return hit.pricing, hit.ok
		}
		pricing, ok := corpus.FindAt(model, millis)
		mutex.Lock()
		cache[bucket] = resolution{pricing: pricing, ok: ok}
		mutex.Unlock()
		return pricing, ok
	}
}

// floorDivHour is Euclidean division by one hour in milliseconds, matching
// TimestampMs's floor semantics for instants before the epoch.
func floorDivHour(millis int64) int64 {
	quotient := millis / 3_600_000
	if millis%3_600_000 != 0 && millis < 0 {
		quotient--
	}
	return quotient
}

// PopulateCosts fills Cost and MissingPricing on a copy of entries.
//
// Order is load-bearing: call it on the parsed entries, then feed the result to
// Dedupe.Add, exactly like ccusage's read_daily_usage_file prices a line before
// push_deduped_daily_entry sees it (daily.rs:317-324). The input slice is left
// untouched; the returned slice is what the dedupe index consumes.
//
// cost must not be nil: a missing pricing pass would silently report every
// model as unpriced at zero cost.
func PopulateCosts(entries []Entry, cost CostFunc) []Entry {
	priced := make([]Entry, len(entries))
	copy(priced, entries)
	for index := range priced {
		priced[index].Cost, priced[index].MissingPricing = cost(
			priced[index].Model, priced[index].Usage, priced[index].Timestamp)
	}
	return priced
}

// priceUsage is calculate_cost_for_usage_at plus missing_pricing_model_for_usage
// for one entry (cost.rs:31-75).
//
// An absent model is only a dead end where upstream looks one up: Display and
// Auto consult cost_usd first and never reach the pricing tables (cost.rs:39-43),
// so a model-less line that stored a cost keeps it. Calculate always computes,
// and calculate_cost_from_tokens returns 0.0 before it looks anything up when
// the model is None (cost.rs:99-101) - that short circuit has to happen here,
// because Corpus.Find("") is not a miss: the fuzzy matcher treats the empty key
// as contained in every candidate and would price a model-less line from an
// arbitrary row.
//
// cost.rs resolves the model once and derives both the cost and the missing
// flag from that resolution; this function does the same through find, instead
// of looking the name up a second time for missingPricing.
func priceUsage(find findModel, findAt findAtFunc, mode CostMode, model string, usage Usage, at time.Time) (float64, bool) {
	if mode == nativepricing.ModeDisplay || (mode == nativepricing.ModeAuto && usage.ReportedCost != nil) {
		// Display bills the reported cost (or zero); Auto prefers it. Neither
		// touches the pricing tables, so there is nothing to resolve.
		if usage.ReportedCost == nil {
			return 0, false
		}
		return *usage.ReportedCost, false
	}
	if model == "" {
		return 0, false
	}
	// A model whose price depends on when the request ran is resolved per
	// event (find_at, pricing.rs:1458-1483); everything else shares the
	// per-model memo.
	var (
		pricing nativepricing.CorpusModel
		priced  bool
	)
	if !at.IsZero() && nativepricing.HasTimeDependentPricing(model) {
		pricing, priced = findAt(model, at.UnixMilli())
	} else {
		pricing, priced = find(model)
	}
	if !priced {
		// missing_pricing_model_for_usage silences a usage without tokens
		// (cost.rs:58, 66-68) and reports every other miss.
		return 0, usageTokenTotal(usage) != 0
	}
	return nativepricing.CostFromPricing(nativeUsage(usage), pricing, usage.Fast), false
}

// nativeUsage maps the parser's usage onto the pricing layer's. Entry.Usage
// already normalized the cache-creation pair (5m + 1h from a breakdown, the
// flat count as 5m otherwise), exactly what cost.rs:119-127 reads.
func nativeUsage(usage Usage) nativepricing.Usage {
	return nativepricing.Usage{
		Input:         usage.Input,
		Output:        usage.Output,
		CacheCreate5m: usage.CacheCreate5m,
		CacheCreate1h: usage.CacheCreate1h,
		CacheRead:     usage.CacheRead,
		ReportedCost:  usage.ReportedCost,
	}
}

// usageTokenTotal is total_usage_tokens (utils.rs:14-20): the four buckets,
// saturating, with cache creation read as the normalized pair.
func usageTokenTotal(usage Usage) int64 {
	total := saturatingAdd(usage.Input, usage.Output)
	total = saturatingAdd(total, usage.CacheCreate5m)
	total = saturatingAdd(total, usage.CacheCreate1h)
	return saturatingAdd(total, usage.CacheRead)
}
