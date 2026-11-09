package nativepricing

import (
	"math"
	"time"
)

// CostMode selects where a cost comes from, mirroring ccusage's CostMode, which
// is defined in crates/ccusage-cli/src/types.rs:243 and re-exported as
// ccusage_core::cli (rust/crates/ccusage-core/src/lib.rs:24-26). S1 needs all
// three because the parity goldens compare reported and computed costs side by
// side; the adapters pick the mode in S2/S3.
type CostMode int

const (
	// ModeAuto uses a reported cost when the usage carries one and computes it
	// otherwise.
	ModeAuto CostMode = iota
	// ModeCalculate always computes the cost, ignoring any reported one.
	ModeCalculate
	// ModeDisplay always uses the reported cost and never prices anything.
	ModeDisplay
)

// Usage is the token accounting one priced request contributes.
//
// Cache creation is split by TTL because the two buckets bill at different
// rates: ccusage takes the 5m/1h breakdown when the usage has one and otherwise
// books the whole cache-creation count as 5m, so a caller without a breakdown
// sets CacheCreate5m to the total and leaves CacheCreate1h at zero.
//
// ReportedCost is the cost the source tool stored for the request, when it had
// one; ModeAuto trusts it and ModeDisplay insists on it.
type Usage struct {
	Input         int64
	Output        int64
	CacheCreate5m int64
	CacheCreate1h int64
	CacheRead     int64
	ReportedCost  *float64
}

// ccusage's pricing.rs defaults and cost.rs constants.
const (
	// defaultLongContextThresholdTokens is DEFAULT_LONG_CONTEXT_THRESHOLD_TOKENS
	// (pricing.rs:220), the boundary that gives LiteLLM's `*_above_200k_tokens`
	// fields their marginal semantics.
	defaultLongContextThresholdTokens int64 = 200_000
	// cacheCreate1hInputMultiplier is CACHE_CREATE_1H_INPUT_MULTIPLIER
	// (cost.rs:8): a one-hour cache write costs twice the input rate.
	cacheCreate1hInputMultiplier = 2.0
)

// CostFromPricing prices one usage against an already-resolved model. It is the
// pure port of calculate_cost_from_pricing (cost.rs:118-197): no lookups, no
// side effects, so the Codex adapter can bill each service-tier bucket with it.
//
// Two tiering rules live here. A model that publishes a long_context_threshold
// switches the whole request to its above bands once the request's context -
// input plus cache read plus both cache-creation buckets - exceeds it. Every
// other model keeps the marginal 200K bands of its LiteLLM `*_above_200k_tokens`
// rates, bucket by bucket (tiered_cost, cost.rs:201-213).
//
// fast multiplies the finished cost when the request used the fast service
// tier; it is the only multiplier on the Claude path (cost.rs:104-108). flex is
// deliberately absent: ccusage applies it per bucket as ×(flex-1) inside the
// Codex adapter (adapters/codex/src/report.rs:273-274), and adding a whole-cost
// multiplier here would bill a different number.
func CostFromPricing(u Usage, p CorpusModel, fast bool) float64 {
	cacheCreate1hRate := p.Input * cacheCreate1hInputMultiplier
	var cacheCreate1hAbove *float64
	if p.InputAbove != nil {
		above := *p.InputAbove * cacheCreate1hInputMultiplier
		cacheCreate1hAbove = &above
	}

	var total float64
	if p.LongContextThreshold != nil {
		// A negative bucket cannot come from a transcript (serde's u64 rejects
		// it) but CostFromPricing is exported for adapters that parse their own
		// sources; clamp like tieredCost does so a corrupt int64 cannot turn
		// into a negative cost.
		clamp := func(tokens int64) int64 {
			if tokens <= 0 {
				return 0
			}
			return tokens
		}
		input, output := clamp(u.Input), clamp(u.Output)
		cacheCreate5m, cacheCreate1h := clamp(u.CacheCreate5m), clamp(u.CacheCreate1h)
		cacheRead := clamp(u.CacheRead)
		// The tier is chosen by the request's whole context, cached or not: a
		// turn re-reading millions of cached tokens is a long-context request.
		contextTokens := saturatingAdd(input, cacheRead, cacheCreate5m, cacheCreate1h)
		longContext := contextTokens > *p.LongContextThreshold
		rate := func(base float64, above *float64) float64 {
			if longContext && above != nil {
				return *above
			}
			return base
		}
		total = addTerms(
			roundedProduct(input, rate(p.Input, p.InputAbove)),
			roundedProduct(output, rate(p.Output, p.OutputAbove)),
			roundedProduct(cacheCreate5m, rate(p.CacheCreate, p.CacheCreateAbove)),
			roundedProduct(cacheCreate1h, rate(cacheCreate1hRate, cacheCreate1hAbove)),
			roundedProduct(cacheRead, rate(p.CacheRead, p.CacheReadAbove)),
		)
	} else {
		threshold := defaultLongContextThresholdTokens
		total = addTerms(
			tieredCost(u.Input, p.Input, p.InputAbove, threshold),
			tieredCost(u.Output, p.Output, p.OutputAbove, threshold),
			tieredCost(u.CacheCreate5m, p.CacheCreate, p.CacheCreateAbove, threshold),
			tieredCost(u.CacheCreate1h, cacheCreate1hRate, cacheCreate1hAbove, threshold),
			tieredCost(u.CacheRead, p.CacheRead, p.CacheReadAbove, threshold),
		)
	}

	if fast {
		total = total * p.FastMultiplier
	}
	return total
}

// Cost prices model for u and reports whether the model went unpriced.
//
// The mode decides which cost wins (calculate_cost_for_usage_at, cost.rs:31-45):
// Display returns the reported cost or zero, Auto prefers the reported cost and
// computes only without one, and Calculate always computes. A miss in the
// pricing tables yields zero cost and missingPricing, which callers surface as
// "this model has no rates" - a model the tables do find, even one priced at
// zero, is never reported missing (cost.rs:95-112).
//
// The flag is about the model alone: ccusage's missing_pricing_model_for_usage
// also stays quiet when the usage carries no tokens at all and resolves model
// aliases for its message (cost.rs:48-71). The design's rule is the simpler one
// - a miss is a miss - so an adapter that wants ccusage's diagnostic wording and
// its empty-usage exception owns both.
//
// A non-zero at selects FindAt, so a DeepSeek V4 request is priced by the
// schedule that applied when it ran (find_at, pricing.rs:1458-1483); the zero
// time keeps the static Find path. flex stays reserved for the Codex
// service-tier delta, which the Codex adapter applies per bucket itself
// (report.rs:273-274).
func Cost(c Corpus, model string, u Usage, at time.Time, mode CostMode, fast, flex bool) (cost float64, missingPricing bool) {
	if mode == ModeDisplay {
		return reportedCost(u), false
	}
	if mode == ModeAuto && u.ReportedCost != nil {
		return *u.ReportedCost, false
	}
	// calculate_cost_from_tokens returns 0 before it looks anything up when the
	// model is None (cost.rs:99-101). The guard is repeated here because
	// Find("") is not a miss: the fuzzy matcher treats the empty name as
	// contained in a `@`-prefixed models.dev key, so a caller without the
	// adapter's own empty-name check would price an arbitrary row.
	if model == "" {
		return 0, false
	}
	var (
		pricing CorpusModel
		ok      bool
	)
	if !at.IsZero() {
		pricing, ok = c.FindAt(model, at.UnixMilli())
	} else {
		pricing, ok = c.Find(model)
	}
	if !ok {
		return 0, true
	}
	return CostFromPricing(u, pricing, fast), false
}

// reportedCost is ccusage's cost_usd.unwrap_or(0.0).
func reportedCost(u Usage) float64 {
	if u.ReportedCost == nil {
		return 0
	}
	return *u.ReportedCost
}

// tieredCost mirrors tiered_cost (cost.rs:201-213): below or on the boundary one
// bucket bills entirely at the base rate, above it the first `threshold` tokens
// bill at the base rate and the rest at the above rate. A model with no above
// rate bills at base throughout.
//
// ccusage's counters are u64, so it only has to special-case zero; a negative
// count cannot reach it. Here it is treated as zero as well, so a corrupt int64
// cannot turn into a negative cost.
func tieredCost(tokens int64, base float64, above *float64, threshold int64) float64 {
	if tokens <= 0 {
		return 0
	}
	if above != nil && tokens > threshold {
		return addTerms(
			roundedProduct(threshold, base),
			roundedProduct(tokens-threshold, *above),
		)
	}
	return roundedProduct(tokens, base)
}

// roundedProduct multiplies a token count by a rate through an opaque call.
//
// arm64 is why this exists: Go's compiler fuses `a*b + c` into FMADDD there,
// rounding once where Rust - and therefore ccusage - rounds twice, which drifts
// the cost by 1 ULP and forks snapshotHash. The formula already keeps every
// product out of an addition's value graph - each is a call argument - and the
// arm64 build of CostFromPricing, tieredCost and addTerms carries no FMADD, so
// the noinline and the bit round-trip are the guarantee that a later rewrite
// (an inlined fold over the terms, say) cannot quietly introduce one.
// TestCostFromPricing_isFMAFreeOnArm64 pins the multiply-then-add result bit for
// bit.
//
//go:noinline
func roundedProduct(count int64, rate float64) float64 {
	product := float64(count) * rate
	return math.Float64frombits(math.Float64bits(product))
}

// Product is roundedProduct's guarded form for cost formulas that live outside
// this package: the Codex adapter's bucket and multiplier terms (codex
// report.go). The same arm64 hazard applies there - Go fuses `count*rate + total`
// into FMADDD, Rust rounds twice - and the adapter must not re-derive the guard
// itself. TestCodexBucketAndUsageCostAreNotFused pins the bit pattern from the
// adapter side.
//
//go:noinline
func Product(left, right float64) float64 {
	product := left * right
	return math.Float64frombits(math.Float64bits(product))
}

// Sum sums terms left to right through the same opaque round-trip as addTerms.
// Unlike +, a term cannot fuse into the accumulator because both sides are
// plain float64 values, but keeping the round-trip makes the intent uniform
// with Product and survives a future rewrite that folds a product in.
func Sum(first float64, rest ...float64) float64 {
	return addTerms(first, rest...)
}

// addTerms sums terms left to right, in the order ccusage writes them. The terms
// arrive as opaque results, so no term can fuse with the accumulator; the
// round-trip on each step keeps that true for the intermediate sums too.
func addTerms(first float64, rest ...float64) float64 {
	total := math.Float64frombits(math.Float64bits(first))
	for _, term := range rest {
		total = math.Float64frombits(math.Float64bits(total + term))
	}
	return total
}

// saturatingAdd sums token counts without wrapping. The counters come from
// lenient parsing, and a corrupt line must not wrap the context sum below a
// long-context threshold (cost.rs:126-132 saturates for the same reason).
// Negative counts are skipped: ccusage's counters are unsigned and cannot carry
// one, and dropping it keeps a damaged negative from shrinking the context into
// the short band.
//
// A negative value is a u64 count past 2^63-1 read as a signed number (raw
// transcript numbers are the only caller that can produce one): Rust's operand
// is u64, so such a value stands for u64::MAX and saturates the sum rather than
// vanishing. Dropping it would understate the context and may pick the wrong
// long-context tier.
func saturatingAdd(values ...int64) int64 {
	total := int64(0)
	for _, value := range values {
		if value < 0 {
			return math.MaxInt64
		}
		if total > math.MaxInt64-value {
			return math.MaxInt64
		}
		total += value
	}
	return total
}
