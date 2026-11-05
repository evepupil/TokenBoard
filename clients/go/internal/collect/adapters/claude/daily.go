package claude

// The daily report ports `ccusage claude daily --json --breakdown`:
// summarize_daily_files (daily.rs:78-160), DailyAccumulator
// (daily.rs:607-670) and run_daily's JSON writer (commands/mod.rs:33-59,
// output.rs:27-60), against ccusage v20.0.33 (commit 1308c416).
//
// Input is the daily chain's deduped survivors: already priced, already
// deduped across every file and root, in first-seen order. This file only
// groups, sums, sorts and serializes.

import (
	"sort"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
)

// DailyOptions configures one daily build. Timezone is required: every date
// depends on it (format_date_tz, date_utils.rs:313-324), and the zero value
// would otherwise silently mean UTC. Since and Until are the already-validated
// --since/--until bounds, in either documented spelling.
type DailyOptions struct {
	Timezone string
	Since    string
	Until    string
}

// BuildDaily renders the daily report document:
//
//	{"daily": [...rows ascending by date...], "totals": {...}}
//
// Grouping is a BTreeMap keyed by the calendar date (daily.rs:131-145), and the
// --since/--until window is applied to the resulting rows afterwards
// (commands/mod.rs:37-42 -> filter_and_sort_summaries, summary.rs:291-305).
// Filtering the group keys here is the same operation, because a group's key IS
// the date every member entry was bucketed by; the filtering order matters in
// the session report (session.go), where the key spans dates.
func BuildDaily(entries []Entry, opts DailyOptions) []byte {
	dates := make([]string, 0, len(entries))
	groups := make(map[string]*accumulator, len(entries))
	for _, entry := range entries {
		date := sessionusage.FormatDate(entry.Timestamp, opts.Timezone)
		group, seen := groups[date]
		if !seen {
			group = &accumulator{}
			groups[date] = group
			dates = append(dates, date)
		}
		group.addEntry(entry)
	}

	sort.Strings(dates)
	daily := make([]any, 0, len(dates))
	rows := make([]rowView, 0, len(dates))
	for _, date := range dates {
		if !dateInRange(date, opts.Since, opts.Until) {
			continue
		}
		group := groups[date]
		view := rowView{
			counts:     group.counts,
			cost:       group.cost,
			breakdowns: group.sortedBreakdowns(),
		}
		rows = append(rows, view)
		daily = append(daily, dailyRowJSON(date, view, group.models))
	}
	return marshalReport(map[string]any{"daily": daily, "totals": totals(rows)})
}

// dailyRowJSON is summary_json plus the row's date (output.rs:27-56): the token
// block, the summed cost, modelsUsed in first-seen order and the breakdowns in
// descending cost order.
func dailyRowJSON(date string, view rowView, models []string) map[string]any {
	row := view.countsJSON()
	row["date"] = date
	row["totalCost"] = finiteOrNull(view.cost)
	row["modelsUsed"] = stringsJSON(models)
	row["modelBreakdowns"] = breakdownsJSON(view.breakdowns)
	return row
}
