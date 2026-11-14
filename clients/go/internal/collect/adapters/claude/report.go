package claude

// The report layer is the fourth layer of ccusage's Claude adapter: after the
// parser (entry.go), the dedupe index (dedupe.go) and the pricing pass
// (cost.go), it turns the surviving entries into the two JSON documents
// `ccusage claude daily --json --breakdown` and `ccusage claude session --json`
// print. Every rule cites ccusage v20.0.33 (commit 1308c416):
//
//	rust/adapters/claude/src/daily.rs         daily grouping, add_entry, sort
//	rust/crates/ccusage-core/src/summary.rs   UsageAccumulator, SessionAccumulator
//	rust/crates/ccusage-core/src/types.rs     saturating TokenCounts, ModelBreakdown
//	rust/crates/ccusage-core/src/output.rs    summary_json, session_summary_json, totals_json
//	rust/crates/ccusage-core/src/model_aliases.rs  CCUSAGE_MODEL_ALIASES
//	rust/crates/ccusage-core/src/date_utils.rs     date_within_range, rfc3339 millis
//	rust/crates/ccusage-cli/src/types.rs      normalize_date_bound
//
// The builders read Entry.Cost; they never price anything. ccusage prices an
// entry exactly once, before dedupe (daily.rs:317-330), because the daily
// replacement compares that cost (daily.rs:592-599); recomputing here would
// price a different number than the one that won the tie-break.
//
// JSON is assembled as map[string]any so encoding/json writes the keys in
// byte order, which is also the order serde_json writes them in: ccusage
// builds its output with json!(...), and Value's object is a BTreeMap because
// serde_json is compiled without preserve_order.

import (
	"encoding/json"
	"math"
	"sort"
	"strings"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// modelAliasesEnv is ccusage's CCUSAGE_MODEL_ALIASES (model_aliases.rs:8).
const modelAliasesEnv = "CCUSAGE_MODEL_ALIASES"

// fastSuffix is the marker suffix_string appends for the fast service tier
// (daily.rs:341-343, fast.rs:105-110).
const fastSuffix = "-fast"

// activityFormat is format_rfc3339_millis (date_utils.rs:356-368): the UTC
// instant with exactly three fractional digits.
const activityFormat = "2006-01-02T15:04:05.000Z"

// displayModel returns the name an entry is reported under, and whether it
// enters modelsUsed and the breakdowns (daily.rs:338-346, 620-633; the entry
// loader repeats the same mapping at lib.rs:535-543).
//
// A <synthetic> line and a line without a model have no display name: their
// tokens and cost still count towards the row, but they add no breakdown.
// A fast request gets the "-fast" suffix (upstream reads usage.speed here; the
// parser keeps Usage.Fast in step with that enum), and the suffixed name then
// goes through resolveModelName, exactly like the upstream accumulator resolves
// the display name it was handed.
func displayModel(entry Entry) (string, bool) {
	if entry.Advisor {
		// An advisor row reports the iteration's model verbatim: upstream sets
		// model to advisor.model (lib.rs:566, daily.rs:390) without the
		// `<synthetic>` filter or the "-fast" suffix, and only the
		// accumulator's alias resolution applies afterwards.
		return resolveModelName(entry.Model), true
	}
	if entry.IsSynthetic || entry.Model == "" {
		return "", false
	}
	name := entry.Model
	if entry.Usage.Speed == speedFast {
		name += fastSuffix
	}
	return resolveModelName(name), true
}

// resolveModelName delegates to the shared implementation in nativepricing,
// which also resolves aliases during FindAt. The environment variable and the
// "-fast" rule are unchanged (model_aliases.rs:14-26).
func resolveModelName(model string) string {
	return nativepricing.ResolveModelNameWithSuffix(model, fastSuffix)
}

// modelAliases delegates to the shared parser so the existing alias tests keep
// pinning the same behaviour.
func modelAliases(raw string) map[string]string {
	return nativepricing.ModelAliases(raw)
}

// dateInRange is date_within_range (date_utils.rs:196-203): both bounds are
// inclusive and compared as compact YYYYMMDD text. ccusage normalizes
// YYYY-MM-DD and YYYYMMDD bounds to YYYYMMDD when it parses them
// (normalize_date_bound, types.rs:82-112), so a dashed bound is compacted here
// as well; an invalid bound is the caller's business - the CLI already
// rejected it with AssertValidDateFilterRange.
func dateInRange(date, since, until string) bool {
	if since == "" && until == "" {
		return true
	}
	compact := strings.ReplaceAll(date, "-", "")
	if since != "" && compact < strings.ReplaceAll(since, "-", "") {
		return false
	}
	if until != "" && compact > strings.ReplaceAll(until, "-", "") {
		return false
	}
	return true
}

// tokenCounts is TokenCounts (types.rs:67-96) without extra_total_tokens, which
// the Claude adapter never fills: input, output, cache creation (5m + 1h when
// the usage carried a breakdown, the flat count otherwise, types.rs:41-50) and
// cache read, each accumulated with a saturating add.
type tokenCounts struct {
	input, output, cacheCreate, cacheRead int64
}

func (t *tokenCounts) addUsage(usage Usage) {
	t.input = saturatingAdd(t.input, usage.Input)
	t.output = saturatingAdd(t.output, usage.Output)
	t.cacheCreate = saturatingAdd(t.cacheCreate, usage.CacheCreate5m)
	t.cacheCreate = saturatingAdd(t.cacheCreate, usage.CacheCreate1h)
	t.cacheRead = saturatingAdd(t.cacheRead, usage.CacheRead)
}

// total is TokenCounts::total (types.rs:89-95) with extra_total_tokens at 0.
func (t tokenCounts) total() int64 {
	total := saturatingAdd(t.input, t.output)
	total = saturatingAdd(total, t.cacheCreate)
	return saturatingAdd(total, t.cacheRead)
}

// saturatingAdd clamps at math.MaxInt64 instead of wrapping. Upstream's
// counters are u64 and saturate at u64::MAX; the parser already rejects values
// above MaxInt64 (entry.go parseTokenCount), so clamping there is the same
// fail-closed direction on a narrower type.
//
// A non-positive right operand contributes nothing: the subtraction below would
// overflow and report MaxInt64 for every negative value. The parser never
// produces one, but BuildDaily and BuildSessions are exported and take
// caller-built entries.
func saturatingAdd(left, right int64) int64 {
	if right <= 0 {
		return left
	}
	if left > math.MaxInt64-right {
		return math.MaxInt64
	}
	return left + right
}

// breakdown is ModelBreakdown (types.rs:98-122). extra_total_tokens is left
// out because it is never filled, and missingPricing is only serialized when
// true (types.rs:109-111).
type breakdown struct {
	name        string
	input       int64
	output      int64
	cacheCreate int64
	cacheRead   int64
	cost        float64
	// missingPricing is only serialized when true (types.rs:109-111).
	missingPricing bool
}

// accumulator is DailyAccumulator.add_entry (daily.rs:616-644) and
// UsageAccumulator.add_entry (summary.rs:50-97). The two differ only in the
// saturating adds summary.rs uses; both land in the same numbers here.
type accumulator struct {
	counts     tokenCounts
	cost       float64
	models     []string
	breakdowns []*breakdown
	index      map[string]int
}

func (a *accumulator) addEntry(entry Entry) {
	usage := entry.Usage
	a.counts.addUsage(usage)
	a.cost += entry.Cost
	name, ok := displayModel(entry)
	if !ok {
		return
	}
	if a.index == nil {
		a.index = map[string]int{}
	}
	position, seen := a.index[name]
	if !seen {
		position = len(a.breakdowns)
		a.index[name] = position
		a.models = append(a.models, name)
		a.breakdowns = append(a.breakdowns, &breakdown{name: name})
	}
	item := a.breakdowns[position]
	item.input = saturatingAdd(item.input, usage.Input)
	item.output = saturatingAdd(item.output, usage.Output)
	item.cacheCreate = saturatingAdd(item.cacheCreate, usage.CacheCreate5m)
	item.cacheCreate = saturatingAdd(item.cacheCreate, usage.CacheCreate1h)
	item.cacheRead = saturatingAdd(item.cacheRead, usage.CacheRead)
	item.cost += entry.Cost
	if entry.MissingPricing {
		item.missingPricing = true
	}
}

// sortedBreakdowns returns the breakdowns in report order: descending cost by
// f64 total ordering, ties kept in first-seen order (`sort_by(|a, b|
// b.cost.total_cmp(&a.cost))` is a stable sort, daily.rs:647, summary.rs:100).
func (a *accumulator) sortedBreakdowns() []*breakdown {
	ordered := append([]*breakdown(nil), a.breakdowns...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return totalCmp(ordered[j].cost, ordered[i].cost) < 0
	})
	return ordered
}

// totalCmp is f64::total_cmp: -0.0 orders below +0.0 and NaN orders above
// every number (and equal NaNs by sign and payload), unlike the `<` operator.
// Costs are finite sums of finite inputs in practice, but ccusage sorts with
// total_cmp, so a pathological value must not reorder differently.
func totalCmp(left, right float64) int {
	leftBits, rightBits := orderedFloatBits(left), orderedFloatBits(right)
	switch {
	case leftBits < rightBits:
		return -1
	case leftBits > rightBits:
		return 1
	default:
		return 0
	}
}

// orderedFloatBits is the IEEE-754 totalOrder key (the transformation
// f64::total_cmp applies before comparing the bit patterns as i64):
// negative values flip every bit but the sign, everything else flips only the
// sign, so the unsigned keys ascend in total order.
func orderedFloatBits(value float64) uint64 {
	bits := math.Float64bits(value)
	if bits&(1<<63) != 0 {
		return ^bits
	}
	return bits | (1 << 63)
}

// finiteOrNull replaces a non-finite float with nil. serde_json prints NaN and
// the infinities as null when it serializes an f64, and encoding/json refuses
// them outright, so the report carries null in the same places ccusage does.
func finiteOrNull(value float64) any {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	return value
}

// totals is totals_json (output.rs:79-145) over rows already filtered and
// ordered: saturating token sums, the plain float sum of the row costs in row
// order, and unpricedModels - the display names of breakdowns that had a
// pricing miss, deduplicated and sorted - only when there is one. credits are
// never filled by the Claude adapter, so the key never appears.
func totals(rows []rowView) map[string]any {
	var counts tokenCounts
	// Rust's `Iterator::sum::<f64>()` folds from -0.0, not 0.0, so ccusage
	// prints "totalCost": -0.0 for an empty report and keeps the sign of a
	// zero total. Starting from -0.0 reproduces that bit (output.rs:110).
	totalCost := math.Copysign(0, -1)
	unpriced := map[string]struct{}{}
	for _, row := range rows {
		counts.input = saturatingAdd(counts.input, row.counts.input)
		counts.output = saturatingAdd(counts.output, row.counts.output)
		counts.cacheCreate = saturatingAdd(counts.cacheCreate, row.counts.cacheCreate)
		counts.cacheRead = saturatingAdd(counts.cacheRead, row.counts.cacheRead)
		totalCost += row.cost
		for _, item := range row.breakdowns {
			if item.missingPricing {
				unpriced[item.name] = struct{}{}
			}
		}
	}
	value := map[string]any{
		"inputTokens":         counts.input,
		"outputTokens":        counts.output,
		"cacheCreationTokens": counts.cacheCreate,
		"cacheReadTokens":     counts.cacheRead,
		"totalTokens":         counts.total(),
		"totalCost":           finiteOrNull(totalCost),
	}
	if len(unpriced) > 0 {
		names := make([]string, 0, len(unpriced))
		for name := range unpriced {
			names = append(names, name)
		}
		sort.Strings(names)
		value["unpricedModels"] = names
	}
	return value
}

// rowView is what a builder hands totals: the row's buckets, cost and
// already-sorted breakdowns.
type rowView struct {
	counts     tokenCounts
	cost       float64
	breakdowns []*breakdown
}

// countsJSON is the token block summary_json and session_summary_json share
// (output.rs:28-37, 59-66).
func (v rowView) countsJSON() map[string]any {
	return map[string]any{
		"inputTokens":         v.counts.input,
		"outputTokens":        v.counts.output,
		"cacheCreationTokens": v.counts.cacheCreate,
		"cacheReadTokens":     v.counts.cacheRead,
		"totalTokens":         v.counts.total(),
	}
}

// breakdownsJSON serializes sorted breakdowns (types.rs:98-112).
func breakdownsJSON(ordered []*breakdown) []any {
	items := make([]any, 0, len(ordered))
	for _, item := range ordered {
		value := map[string]any{
			"modelName":           item.name,
			"inputTokens":         item.input,
			"outputTokens":        item.output,
			"cacheCreationTokens": item.cacheCreate,
			"cacheReadTokens":     item.cacheRead,
			"cost":                finiteOrNull(item.cost),
		}
		if item.missingPricing {
			value["missingPricing"] = true
		}
		items = append(items, value)
	}
	return items
}

// stringsJSON keeps an empty list as `[]` rather than `null`.
func stringsJSON(values []string) []any {
	if values == nil {
		return []any{}
	}
	items := make([]any, 0, len(values))
	for _, value := range values {
		items = append(items, value)
	}
	return items
}

// marshalReport serializes the document tree. The tree holds only strings,
// bools, int64, finite-or-null floats, maps and slices, so encoding/json cannot
// fail; a failure would mean the builders placed something else, which is a
// construction bug and must not degrade into an empty report.
func marshalReport(document map[string]any) []byte {
	data, err := json.Marshal(document)
	if err != nil {
		panic("claude: report document is not marshalable: " + err.Error())
	}
	return data
}
