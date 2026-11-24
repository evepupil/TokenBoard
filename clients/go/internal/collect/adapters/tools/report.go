package tools

import (
	"sort"
	"unicode/utf8"
)

// includeSessionMetadata is the set of tool sources whose Rust adapter passes
// include_session_metadata=true to agent_summary_json, which emits
// lastActivity/firstActivity/projectPath on session rows. The three rich
// sources (qwen/report.rs:14, openclaw/report.rs:14, zcode/report.rs:14) pass
// `kind == AgentReportKind::Session`, and copilot (copilot/report.rs:11-16)
// does too; the other eight of the twelve pass false.
var richSessionMetadataSources = map[string]bool{
	"qwen": true, "openclaw": true, "zcode": true, "copilot": true,
}

// RichSessionMetadata reports whether command's session rows carry
// lastActivity/firstActivity/projectPath. The provider uses it to pass
// ReportJSON the same flag the Rust adapter's report_from_rows does.
func RichSessionMetadata(command string) bool {
	return richSessionMetadataSources[command]
}

// This file ports the report layer every tool adapter shares:
// summarize_entries (ccusage-core/src/summary.rs), agent_summary_json
// (agent_report.rs:5-48) and totals_json (output.rs:79-121).

// Summarize groups entries into report rows (summarize_entries,
// summary.rs:19-37). It drops nothing: every accepted entry contributes, and a
// source that produces a zero-valued one (gemini's thoughts-only event in
// display mode) still gets its row. The adapters only reject entries their Rust
// parser rejects.
func Summarize(entries []Entry, kind ReportKind) ([]Row, Totals) {
	order := []string{}
	index := map[string]*Row{}
	latest := map[string]bool{}
	// firstSet marks a row whose firstActivity is already the minimum. Rust keeps
	// it in an Option (summary.rs:137), so zero - and a negative timestamp - are
	// values like any other; `> 0` as the sentinel would let 0 and negatives
	// never win the minimum and print the next timestamp, or 1970, instead.
	firstSet := map[string]bool{}
	for _, entry := range entries {
		key := reportKey(entry, kind)
		row, ok := index[key]
		if !ok {
			row = &Row{Key: key}
			index[key] = row
			order = append(order, key)
		}
		row.Usage = addUsage(row.Usage, entry.Usage)
		row.Cost = addFloat(row.Cost, entry.CostUSD)
		row.Credits = addOptional(row.Credits, entry.Credits)
		row.MessageCount = addOptionalCount(row.MessageCount, entry.MessageCount)
		if kind == Session {
			// SessionAccumulator keeps the (timestamp, session, project) of the
			// latest entry and the earliest timestamp (summary.rs:133-156), so
			// projectPath follows the newest entry, not the first one seen. A
			// tie keeps the earlier entry (the update is strict `>`), and the
			// newest entry's empty project is kept as-is.
			if !latest[key] || entry.LastActivity > row.LastActivity {
				latest[key] = true
				row.LastActivity = entry.LastActivity
				row.ProjectPath = entry.ProjectPath
			}
			row.Version = firstNonEmpty(row.Version, entry.Version)
			if !firstSet[key] || entry.FirstActivity < row.FirstActivity {
				firstSet[key] = true
				row.FirstActivity = entry.FirstActivity
			}
		}
		addBreakdown(row, entry)
	}
	rows := make([]Row, 0, len(order))
	for _, key := range order {
		row := *index[key]
		// model_breakdowns is emitted by descending cost (summary.rs:113); the
		// sort is stable, so equal-cost models keep their first-appearance order.
		sort.SliceStable(row.Breakdowns, func(i, j int) bool {
			return row.Breakdowns[i].Cost > row.Breakdowns[j].Cost
		})
		rows = append(rows, row)
	}
	if kind == Monthly {
		// Every adapter's Monthly branch summarises the daily rows and folds
		// THOSE into month rows (amp/report.rs:31-41 via
		// summarize_summaries_by_bucket, summary.rs:178-206), so the month's
		// float sum is over daily rows, not over the raw entries, and a model
		// first enters modelsUsed on the earliest day that used it.
		rows = summarizeByBucket(rows)
	}
	sortSummaries(rows)
	return rows, totalsOf(rows)
}

// summarizeByBucket is summarize_summaries_by_bucket with BucketKind::Monthly
// (summary.rs:178-206) over rows already carrying a "YYYY-MM-DD" date:
// aggregate_summaries (summary.rs:208-291) folds each month's daily rows into
// one row, and the caller re-sorts.
func summarizeByBucket(daily []Row) []Row {
	// summarize_summaries_by_bucket reads a BTreeMap, so the month is folded from
	// the days in key order; arrival order would change modelsUsed and the
	// float sum.
	days := append([]Row(nil), daily...)
	sortSummaries(days)
	order := []string{}
	index := map[string]*Row{}
	for _, day := range days {
		key := reportKeyForDate(day.Key)
		row, ok := index[key]
		if !ok {
			row = &Row{Key: key}
			index[key] = row
			order = append(order, key)
		}
		row.Usage = addUsage(row.Usage, day.Usage)
		row.Cost = addFloat(row.Cost, day.Cost)
		row.Credits = addOptional(row.Credits, day.Credits)
		row.MessageCount = addOptionalCount(row.MessageCount, day.MessageCount)
		row.ModelsUsed = append(row.ModelsUsed, day.ModelsUsed...)
		for _, breakdown := range day.Breakdowns {
			mergeBreakdown(row, breakdown)
		}
	}
	rows := make([]Row, 0, len(order))
	for _, key := range order {
		row := *index[key]
		row.ModelsUsed = dedupeModels(row.ModelsUsed)
		sort.SliceStable(row.Breakdowns, func(i, j int) bool {
			return row.Breakdowns[i].Cost > row.Breakdowns[j].Cost
		})
		rows = append(rows, row)
	}
	return rows
}

// mergeBreakdown folds one daily model breakdown into the month row, in first
// appearance order (aggregate_summaries:258-286).
func mergeBreakdown(row *Row, breakdown Breakdown) {
	for index := range row.Breakdowns {
		target := &row.Breakdowns[index]
		if target.Model == breakdown.Model {
			target.Usage = addUsage(target.Usage, breakdown.Usage)
			target.Cost = addFloat(target.Cost, breakdown.Cost)
			target.Missing = target.Missing || breakdown.Missing
			return
		}
	}
	row.Breakdowns = append(row.Breakdowns, breakdown)
}

// dedupeModels keeps the first occurrence of each model name.
func dedupeModels(models []string) []string {
	seen := map[string]bool{}
	out := models[:0]
	for _, model := range models {
		if seen[model] {
			continue
		}
		seen[model] = true
		out = append(out, model)
	}
	return out
}

// totalsOf is totals_json (output.rs:79-121): the block is a fold over the
// emitted rows, in their sorted order, never over the entries. Float addition
// is not associative, so a row-order fold can land one bit away from an
// entry-order one; ccusage's answer is the row order, and a caller that
// filters rows (qwen's session window) must recompute totals from the
// survivors rather than reuse the unfiltered block.
func totalsOf(rows []Row) Totals {
	totals := Totals{}
	for _, row := range rows {
		totals.Usage = addUsage(totals.Usage, row.Usage)
		totals.Cost = addFloat(totals.Cost, row.Cost)
		totals.Credits = addOptional(totals.Credits, row.Credits)
	}
	return totals
}

// TotalsFromRows exposes totalsOf for callers that filter rows after
// Summarize (qwen's session window): ccusage's report builder derives totals
// from the filtered rows, so a reused pre-filter block would overcount.
func TotalsFromRows(rows []Row) Totals {
	return totalsOf(rows)
}

// reportKey is the per-entry grouping key: the local date, or the session id.
// Monthly has no entry-level key: its rows are folded from the daily rows
// afterwards (summarizeByBucket).
func reportKey(entry Entry, kind ReportKind) string {
	if kind == Session {
		return entry.SessionID
	}
	return entry.Date
}

// reportKeyForDate is summarize_summaries_by_bucket's month key: the first
// seven bytes of the date, or the whole date when it is shorter or the
// boundary splits a character (summary.rs:189's `date.get(..7).unwrap_or`).
func reportKeyForDate(date string) string {
	if len(date) < 7 {
		return date
	}
	if len(date) > 7 && !utf8.RuneStart(date[7]) {
		return date
	}
	return date[:7]
}

// sortSummaries is sort_summaries (summary.rs:307-315): period keys ascending
// by string order.
func sortSummaries(rows []Row) {
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Key < rows[j].Key })
}

func addBreakdown(row *Row, entry Entry) {
	for index := range row.Breakdowns {
		breakdown := &row.Breakdowns[index]
		if breakdown.Model == entry.Model {
			breakdown.Usage = addUsage(breakdown.Usage, entry.Usage)
			breakdown.Cost = addFloat(breakdown.Cost, entry.CostUSD)
			breakdown.Missing = breakdown.Missing || entry.MissingPricing
			return
		}
	}
	row.Breakdowns = append(row.Breakdowns, Breakdown{
		Model: entry.Model, Usage: entry.Usage, Cost: entry.CostUSD, Missing: entry.MissingPricing,
	})
	row.ModelsUsed = append(row.ModelsUsed, entry.Model)
}

func addUsage(left, right Usage) Usage {
	return Usage{
		Input:         SaturatingAddU64(left.Input, right.Input),
		Output:        SaturatingAddU64(left.Output, right.Output),
		CacheCreation: SaturatingAddU64(left.CacheCreation, right.CacheCreation),
		CacheRead:     SaturatingAddU64(left.CacheRead, right.CacheRead),
		Extra:         SaturatingAddU64(left.Extra, right.Extra),
	}
}

// addFloat sums in entry order with the same round-per-step discipline as the
// rest of the cost layer.
func addFloat(left, right float64) float64 {
	return left + right
}

func addOptional(left, right *float64) *float64 {
	if right == nil {
		return left
	}
	total := *right
	if left != nil {
		total = *left + *right
	}
	return &total
}

func addOptionalCount(left, right *uint64) *uint64 {
	if right == nil {
		return left
	}
	total := *right
	if left != nil {
		total = *left + *right
	}
	return &total
}

func firstNonEmpty(current, next string) string {
	if current != "" {
		return current
	}
	return next
}

// ApplyTotalFallback is apply_total_token_fallback (utils.rs:22-38): when the
// source reported a total larger than the named buckets, the remainder goes to
// output if the output bucket is empty, otherwise to extra.
func ApplyTotalFallback(usage *Usage, total uint64) {
	known := usage.Total()
	missing := SaturatingSubU64(total, known)
	if missing == 0 {
		return
	}
	if usage.Output == 0 {
		usage.Output = missing
		return
	}
	usage.Extra = SaturatingAddU64(usage.Extra, missing)
}

// ReportJSON is report_from_rows: the document `ccusage <tool> <kind> --json`
// prints. Session documents key rows under "sessions" and each row under
// "sessionId"; there is no "session" spelling anywhere.
//
// sessionMetadata selects whether session rows carry
// lastActivity/firstActivity/projectPath (agent_summary_json's
// include_session_metadata, agent_report.rs:27-46). Only the three rich
// sources (qwen, openclaw, zcode, copilot set it): their Rust adapters pass
// `kind == AgentReportKind::Session`; the other eight of the twelve pass
// false, so their session rows keep only the shared fields.
func ReportJSON(rows []Row, totals Totals, kind ReportKind, sessionMetadata bool) map[string]any {
	out := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		out = append(out, rowJSON(row, kind, sessionMetadata))
	}
	document := map[string]any{rowsKey(kind): out}
	totalsValue := map[string]any{
		"inputTokens":         totals.Usage.Input,
		"outputTokens":        totals.Usage.Output,
		"cacheCreationTokens": totals.Usage.CacheCreation,
		"cacheReadTokens":     totals.Usage.CacheRead,
		"totalTokens":         totals.Usage.Total(),
		"totalCost":           totals.Cost,
	}
	if totals.Credits != nil && *totals.Credits > 0 {
		totalsValue["credits"] = *totals.Credits
	}
	// unpriced_models (output.rs:122-136): every model with a missing-pricing
	// breakdown, as a sorted set. totals_json takes no cost mode, so the block
	// does not depend on one - the adapters decide whether a row is missing
	// (PriceEntry/kilo/openclaw silence it in display mode, hermes/goose/droid/
	// codebuff do not).
	if unpriced := unpricedModels(rows); len(unpriced) > 0 {
		totalsValue["unpricedModels"] = unpriced
	}
	document["totals"] = totalsValue
	return document
}

func unpricedModels(rows []Row) []string {
	seen := map[string]bool{}
	for _, row := range rows {
		for _, breakdown := range row.Breakdowns {
			if breakdown.Missing {
				seen[breakdown.Model] = true
			}
		}
	}
	out := make([]string, 0, len(seen))
	for model := range seen {
		out = append(out, model)
	}
	sort.Strings(out)
	return out
}

func rowsKey(kind ReportKind) string {
	switch kind {
	case Monthly:
		return "monthly"
	case Session:
		return "sessions"
	}
	return "daily"
}

func periodKey(kind ReportKind) string {
	switch kind {
	case Monthly:
		return "month"
	case Session:
		return "sessionId"
	}
	return "date"
}

func rowJSON(row Row, kind ReportKind, sessionMetadata bool) map[string]any {
	value := map[string]any{
		periodKey(kind):       row.Key,
		"inputTokens":         row.Usage.Input,
		"outputTokens":        row.Usage.Output,
		"cacheCreationTokens": row.Usage.CacheCreation,
		"cacheReadTokens":     row.Usage.CacheRead,
		"totalTokens":         row.Usage.Total(),
		"totalCost":           row.Cost,
		"modelsUsed":          append([]string{}, row.ModelsUsed...),
		"modelBreakdowns":     breakdownJSON(row.Breakdowns),
	}
	if row.Credits != nil {
		value["credits"] = *row.Credits
	}
	if row.MessageCount != nil {
		value["messageCount"] = *row.MessageCount
	}
	if kind == Session && sessionMetadata {
		value["lastActivity"] = FormatRFC3339Millis(row.LastActivity)
		value["firstActivity"] = FormatRFC3339Millis(row.FirstActivity)
		value["projectPath"] = row.ProjectPath
	}
	return value
}

func breakdownJSON(breakdowns []Breakdown) []map[string]any {
	out := make([]map[string]any, 0, len(breakdowns))
	for _, breakdown := range breakdowns {
		value := map[string]any{
			"modelName":           breakdown.Model,
			"inputTokens":         breakdown.Usage.Input,
			"outputTokens":        breakdown.Usage.Output,
			"cacheCreationTokens": breakdown.Usage.CacheCreation,
			"cacheReadTokens":     breakdown.Usage.CacheRead,
			"cost":                breakdown.Cost,
		}
		if breakdown.Missing {
			value["missingPricing"] = true
		}
		out = append(out, value)
	}
	return out
}
