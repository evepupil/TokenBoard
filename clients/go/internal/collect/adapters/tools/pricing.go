package tools

import (
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// This file is the shared bridge from an Entry to nativepricing. Tool adapters
// differ in which lookup they use (Find, FindAt, FindExact,
// FindExactWithFallback) and in their candidate-name chains, so the chain is a
// parameter here and each adapter supplies its own.

// LookupFunc resolves one candidate name to rates. A zero at means "static
// pricing" for lookups that accept a timestamp.
type LookupFunc func(corpus nativepricing.Corpus, model string, at time.Time) (nativepricing.CorpusModel, bool)

// LookupFind is PricingMap::find (fuzzy stages included).
func LookupFind(corpus nativepricing.Corpus, model string, _ time.Time) (nativepricing.CorpusModel, bool) {
	return corpus.Find(model)
}

// LookupFindAt is find_at: a non-zero instant selects the schedule in force
// then, otherwise the static table.
func LookupFindAt(corpus nativepricing.Corpus, model string, at time.Time) (nativepricing.CorpusModel, bool) {
	if at.IsZero() {
		return corpus.Find(model)
	}
	return corpus.FindAt(model, at.UnixMilli())
}

// LookupFindExact is PricingMap::find_exact (no fuzzy, no aliases).
func LookupFindExact(corpus nativepricing.Corpus, model string, _ time.Time) (nativepricing.CorpusModel, bool) {
	return corpus.FindExact(model)
}

// LookupFindExactWithFallback is find_exact_with_fallback (pricing.rs:1496-1533).
func LookupFindExactWithFallback(corpus nativepricing.Corpus, model string, _ time.Time) (nativepricing.CorpusModel, bool) {
	return corpus.FindExactWithFallback(model)
}

// PriceEntry fills entry.CostUSD and entry.MissingPricing from the first
// candidate the lookup resolves, following calculate_cost_for_usage_at
// (cost.rs:31-46): Display trusts the reported cost, Auto prefers it, and
// everything else prices the tokens with the reported cost folded into output.
// Missing stays false when the usage carries no tokens at all
// (missing_pricing_model_for_usage's empty-usage exception, cost.rs:48-71).
func PriceEntry(corpus nativepricing.Corpus, entry *Entry, candidates []string, at time.Time, mode nativepricing.CostMode, lookup LookupFunc) {
	usage := nativepricing.Usage{
		Input:         TokenCount(entry.Usage.Input),
		Output:        TokenCount(SaturatingAddU64(entry.Usage.Output, entry.Usage.Extra)),
		CacheCreate5m: TokenCount(entry.Usage.CacheCreation),
		CacheRead:     TokenCount(entry.Usage.CacheRead),
		ReportedCost:  entry.ReportedCost,
	}
	if mode == nativepricing.ModeDisplay {
		entry.CostUSD = reportedOrZero(entry.ReportedCost)
		entry.MissingPricing = false
		return
	}
	if mode == nativepricing.ModeAuto && entry.ReportedCost != nil {
		entry.CostUSD = *entry.ReportedCost
		entry.MissingPricing = false
		return
	}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		pricing, ok := lookup(corpus, candidate, at)
		if !ok {
			continue
		}
		entry.CostUSD = nativepricing.CostFromPricing(usage, pricing, false)
		entry.MissingPricing = false
		return
	}
	entry.CostUSD = 0
	entry.MissingPricing = entry.Usage.Total() > 0
}

func reportedOrZero(cost *float64) float64 {
	if cost == nil {
		return 0
	}
	return *cost
}

// PriceAt returns the timestamp a source bills at, or the zero time when the
// source has none (static pricing).
func PriceAt(millis int64) time.Time {
	if millis <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(millis)
}
