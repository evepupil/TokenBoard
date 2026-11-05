package claude

// Session-report cases. They port commands/mod.rs:146-206 (run_session and
// load_session_rows), summary.rs:125-170 (SessionAccumulator) and
// output.rs:58-77 (session_summary_json), with Entry literals standing in for
// the loader output.

import (
	"testing"
	"time"
)

// TestBuildSessionsGroupsByPathSessionIDNotTheSerializedOne pins the grouping
// key: (project_path, session_id) where session_id is the value derived from
// the file path, not the serialized sessionId (commands/mod.rs:186-199 -
// `entry.session_id` is the Arc path value, while `entry.data.session_id` is
// what loaded_entry_session_id prefers for dedupe, lib.rs:405-411).
func TestBuildSessionsGroupsByPathSessionIDNotTheSerializedOne(t *testing.T) {
	day := time.Date(2026, 1, 2, 9, 0, 0, 0, time.UTC)
	entries := []Entry{
		reportEntry(reportFixture{
			model: "model-a", at: day, input: 10, cost: 0.1, project: "demo",
			pathSession: "from-path", sessionID: "serialized-one",
		}),
		reportEntry(reportFixture{
			model: "model-a", at: day.Add(time.Minute), input: 20, cost: 0.2, project: "demo",
			pathSession: "from-path", sessionID: "serialized-two",
		}),
		reportEntry(reportFixture{
			model: "model-a", at: day, input: 30, cost: 0.3, project: "other",
			pathSession: "from-path", sessionID: "serialized-one",
		}),
	}

	report := decodeReport(t, BuildSessions(entries, SessionOptions{Timezone: "UTC"}))
	sessions := reportObjects(t, report, "sessions")
	if len(sessions) != 2 {
		t.Fatalf("sessions = %d, want 2 (path session id + project)", len(sessions))
	}
	for _, row := range sessions {
		if row["sessionId"] != "from-path" {
			t.Fatalf("sessionId = %v, want the path-derived from-path", row["sessionId"])
		}
	}
	if sessions[0]["projectPath"] != "demo" || sessions[1]["projectPath"] != "other" {
		t.Fatalf("rows = %v then %v, want cost-descending demo then other",
			sessions[0]["projectPath"], sessions[1]["projectPath"])
	}
	requireNumber(t, sessions[1], "inputTokens", 30)
	requireNumber(t, sessions[1], "totalCost", 0.3)
}

// TestBuildSessionsDropsZeroTokenSessionsAndSortsByCostDesc pins run_session's
// retain (commands/mod.rs:155-157: a session whose four token buckets sum to
// zero is dropped, cost or not) and the total-cost sort (commands/mod.rs:158-161).
func TestBuildSessionsDropsZeroTokenSessionsAndSortsByCostDesc(t *testing.T) {
	day := time.Date(2026, 1, 2, 9, 0, 0, 0, time.UTC)
	entries := []Entry{
		reportEntry(reportFixture{model: "model-a", at: day, input: 10, cost: 0.05, project: "demo", pathSession: "cheap"}),
		// Every bucket zero, but a stored cost: still dropped (commands/mod.rs:155-157).
		reportEntry(reportFixture{model: "model-a", at: day, cost: 0.7, project: "demo", pathSession: "zero-tokens"}),
		reportEntry(reportFixture{model: "model-a", at: day, input: 10, cost: 0.9, project: "demo", pathSession: "pricey"}),
		reportEntry(reportFixture{model: "model-a", at: day, input: 10, cost: 0.3, project: "demo", pathSession: "middle"}),
	}

	report := decodeReport(t, BuildSessions(entries, SessionOptions{Timezone: "UTC"}))
	sessions := reportObjects(t, report, "sessions")
	order := make([]string, 0, len(sessions))
	for _, row := range sessions {
		order = append(order, row["sessionId"].(string))
	}
	want := []string{"pricey", "middle", "cheap"}
	if len(order) != len(want) {
		t.Fatalf("sessions = %v, want %v", order, want)
	}
	for index := range want {
		if order[index] != want[index] {
			t.Fatalf("sessions = %v, want %v", order, want)
		}
	}
	totals := report["totals"].(map[string]any)
	requireNumber(t, totals, "totalCost", 1.25)
	requireNumber(t, totals, "inputTokens", 30)
}

// TestBuildSessionsFiltersEntriesBeforeGrouping pins the ordering that differs
// from daily (adapters/common/src/lib.rs:48-59 runs before commands/mod.rs:186-199
// groups): the window is applied to each entry's own date, so a session that
// spans the boundary keeps only the entries inside it - and its
// firstActivity/lastActivity come from those entries alone.
func TestBuildSessionsFiltersEntriesBeforeGrouping(t *testing.T) {
	inside := time.Date(2026, 1, 3, 10, 0, 0, 0, time.UTC)
	outside := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	entries := []Entry{
		reportEntry(reportFixture{model: "model-a", at: outside, input: 100, cost: 1, project: "demo", pathSession: "spanning"}),
		reportEntry(reportFixture{model: "model-a", at: inside, input: 50, cost: 0.5, project: "demo", pathSession: "spanning"}),
	}

	report := decodeReport(t, BuildSessions(entries, SessionOptions{
		Timezone: "UTC", Since: "2026-01-03", Until: "2026-01-03",
	}))
	sessions := reportObjects(t, report, "sessions")
	if len(sessions) != 1 {
		t.Fatalf("sessions = %d, want 1", len(sessions))
	}
	requireNumber(t, sessions[0], "inputTokens", 50)
	requireNumber(t, sessions[0], "totalCost", 0.5)
	if sessions[0]["firstActivity"] != "2026-01-03T10:00:00.000Z" ||
		sessions[0]["lastActivity"] != "2026-01-03T10:00:00.000Z" {
		t.Fatalf("activity = %v..%v, want the filtered entry only",
			sessions[0]["firstActivity"], sessions[0]["lastActivity"])
	}
}

// TestLastActivityIsMaxTimestampInUTCAndTiesKeepFirst pins format_rfc3339_millis
// (date_utils.rs:356-368) and the strict-greater replacement in
// SessionAccumulator::add_entry (summary.rs:136-152): a tie keeps the first
// entry seen.
func TestLastActivityIsMaxTimestampInUTCAndTiesKeepFirst(t *testing.T) {
	t.Setenv(modelAliasesEnv, "")
	// 2026-01-03 07:00 in Tokyo with 5ms is 2026-01-02T22:00:00.005Z.
	first := time.Date(2026, 1, 2, 22, 0, 0, 5_000_000, time.UTC)
	latest := time.Date(2026, 1, 3, 1, 30, 0, 250_000_000, time.UTC)
	entries := []Entry{
		reportEntry(reportFixture{model: "model-a", at: first, input: 1, project: "demo", pathSession: "s"}),
		reportEntry(reportFixture{model: "model-a", at: latest, input: 1, project: "demo", pathSession: "s"}),
		reportEntry(reportFixture{model: "model-a", at: latest, input: 1, project: "demo", pathSession: "s"}),
	}

	report := decodeReport(t, BuildSessions(entries, SessionOptions{Timezone: "Asia/Tokyo"}))
	sessions := reportObjects(t, report, "sessions")
	if sessions[0]["firstActivity"] != "2026-01-02T22:00:00.005Z" {
		t.Fatalf("firstActivity = %v", sessions[0]["firstActivity"])
	}
	if sessions[0]["lastActivity"] != "2026-01-03T01:30:00.250Z" {
		t.Fatalf("lastActivity = %v, want UTC milliseconds format", sessions[0]["lastActivity"])
	}
}

// TestSessionRowCarriesBreakdownsAndTotals pins the rest of the session row
// shape: modelsUsed in first-seen order, breakdowns sorted by cost, and totals
// computed over the kept rows.
func TestSessionRowCarriesBreakdownsAndTotals(t *testing.T) {
	t.Setenv(modelAliasesEnv, "")
	day := time.Date(2026, 1, 2, 9, 0, 0, 0, time.UTC)
	entries := []Entry{
		reportEntry(reportFixture{model: "model-low", at: day, input: 10, cost: 0.01, project: "demo", pathSession: "s"}),
		reportEntry(reportFixture{model: "model-high", at: day, input: 20, cost: 0.4, project: "demo", pathSession: "s"}),
		reportEntry(reportFixture{model: "model-low", at: day, input: 5, cost: 0.02, project: "demo", pathSession: "s"}),
	}
	report := decodeReport(t, BuildSessions(entries, SessionOptions{Timezone: "UTC"}))
	sessions := reportObjects(t, report, "sessions")
	requireStrings(t, sessions[0]["modelsUsed"], []string{"model-low", "model-high"})
	names := breakdownNames(t, reportObjects(t, sessions[0], "modelBreakdowns"))
	if len(names) != 2 || names[0] != "model-high" || names[1] != "model-low" {
		t.Fatalf("breakdowns = %v, want model-high then model-low", names)
	}
	requireNumber(t, sessions[0], "totalCost", 0.43)
	totals := report["totals"].(map[string]any)
	requireNumber(t, totals, "totalCost", 0.43)
	requireNumber(t, totals, "totalTokens", 35)
}
