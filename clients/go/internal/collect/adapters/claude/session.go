package claude

// The session report ports `ccusage claude session --json`: run_session and
// load_session_rows (commands/mod.rs:146-206), SessionAccumulator
// (summary.rs:125-170) and session_summary_json (output.rs:58-77), against
// ccusage v20.0.33 (commit 1308c416).
//
// Two ordering rules differ from the daily chain and are easy to get backwards:
//
//   - the --since/--until window is applied to the loaded entries BEFORE they
//     are grouped (filter_loaded_entries_by_date, adapters/common/src/lib.rs:48-59,
//     runs at commands/mod.rs:185), so a session that spans the boundary keeps
//     only its in-window entries and its first/last activity come from those;
//   - the grouping key is the PATH-derived session id
//     (commands/mod.rs:186-199 reads `entry.session_id`, the Arc from the file
//     path), not the serialized sessionId that dedupe prefers
//     (lib.rs:405-411).

import (
	"sort"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
)

// SessionOptions configures one session build. Timezone is required for the
// same reason as in DailyOptions; Since and Until are the validated bounds.
type SessionOptions struct {
	Timezone string
	Since    string
	Until    string
}

// sessionKey is the (project_path, session_id) pair load_session_rows groups
// on (commands/mod.rs:189-192), both taken from the transcript path.
type sessionKey struct {
	projectPath string
	sessionID   string
}

// sessionAccumulator is SessionAccumulator (summary.rs:125-156): the shared
// usage accumulator plus the activity window. The two presence flags stand in
// for upstream's Option so a timestamp at the zero instant is still a real
// observation.
type sessionAccumulator struct {
	usage       accumulator
	latest      time.Time
	hasLatest   bool
	earliest    time.Time
	hasEarliest bool
}

func (s *sessionAccumulator) addEntry(entry Entry) {
	s.usage.addEntry(entry)
	// Latest replaces on strictly greater, earliest on strictly less
	// (summary.rs:136-152). On a tie the first entry wins, but nothing about a
	// tie is observable here: upstream also stores the entry's session id and
	// project path alongside the latest timestamp, and in this port both are
	// the group key itself, so only the timestamp differs - and equal
	// timestamps store the same instant either way.
	if !s.hasLatest || entry.Timestamp.After(s.latest) {
		s.latest = entry.Timestamp
		s.hasLatest = true
	}
	if !s.hasEarliest || entry.Timestamp.Before(s.earliest) {
		s.earliest = entry.Timestamp
		s.hasEarliest = true
	}
}

// sessionRow is one summary together with the key it was built under.
type sessionRow struct {
	key   sessionKey
	group *sessionAccumulator
}

// BuildSessions renders the session report document:
//
//	{"sessions": [...rows descending by cost...], "totals": {...}}
//
// Entries are filtered by their own date, grouped in first-seen order, sessions
// whose four token buckets sum to zero are dropped
// (commands/mod.rs:155-157), and the rest are sorted by total cost descending
// with a stable sort (commands/mod.rs:158-161).
func BuildSessions(entries []Entry, opts SessionOptions) []byte {
	order := make([]sessionKey, 0, len(entries))
	groups := make(map[sessionKey]*sessionAccumulator, len(entries))
	for _, entry := range entries {
		date := sessionusage.FormatDate(entry.Timestamp, opts.Timezone)
		if !dateInRange(date, opts.Since, opts.Until) {
			continue
		}
		key := sessionKey{projectPath: entry.ProjectPath, sessionID: entry.PathSessionID}
		group, seen := groups[key]
		if !seen {
			group = &sessionAccumulator{}
			groups[key] = group
			order = append(order, key)
		}
		group.addEntry(entry)
	}

	rows := make([]sessionRow, 0, len(order))
	for _, key := range order {
		group := groups[key]
		if group.usage.counts.total() == 0 {
			continue
		}
		rows = append(rows, sessionRow{key: key, group: group})
	}
	sort.SliceStable(rows, func(i, j int) bool {
		return totalCmp(rows[j].group.usage.cost, rows[i].group.usage.cost) < 0
	})

	sessions := make([]any, 0, len(rows))
	totalsRows := make([]rowView, 0, len(rows))
	for _, row := range rows {
		group := row.group
		view := rowView{
			counts:     group.usage.counts,
			cost:       group.usage.cost,
			breakdowns: group.usage.sortedBreakdowns(),
		}
		totalsRows = append(totalsRows, view)
		value := view.countsJSON()
		value["sessionId"] = row.key.sessionID
		value["projectPath"] = row.key.projectPath
		value["lastActivity"] = group.latest.UTC().Format(activityFormat)
		value["firstActivity"] = group.earliest.UTC().Format(activityFormat)
		value["totalCost"] = finiteOrNull(view.cost)
		value["modelsUsed"] = stringsJSON(group.usage.models)
		value["modelBreakdowns"] = breakdownsJSON(view.breakdowns)
		sessions = append(sessions, value)
	}
	return marshalReport(map[string]any{"sessions": sessions, "totals": totals(totalsRows)})
}
