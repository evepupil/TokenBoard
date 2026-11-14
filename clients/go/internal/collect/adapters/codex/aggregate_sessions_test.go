package codex

import (
	"path/filepath"
	"reflect"
	"testing"
)

// LoadGroupsPerKind parses every eligible file once and returns the daily and
// session groupings from that single pass. Both must match what two separate
// passes produce, field for field.
func TestLoadGroupsPerKindMatchesTwoSeparatePasses(t *testing.T) {
	root := t.TempDir()
	sameLine := headlessLine("2026-01-05T12:00:00Z", "gpt-5.4", 100, 20)
	first := writeSourceFile(t, root, "2026/01/05/a.jsonl", sameLine)
	second := writeSourceFile(t, root, "2026/01/05/b.jsonl", sameLine)
	third := writeSourceFile(t, root, "2026/01/06/c.jsonl",
		headlessLine("2026-01-06T03:00:00Z", "gpt-5.4", 7, 2))
	sources := []FileGroup{{Dir: root, Files: []string{first, second, third}}}

	wantDaily, err := LoadGroups(sources, ReportDaily, "UTC", "", "")
	if err != nil {
		t.Fatal(err)
	}
	wantSessions, err := LoadGroups(sources, ReportSession, "UTC", "", "")
	if err != nil {
		t.Fatal(err)
	}

	gotDaily, gotSessions, err := LoadGroupsPerKind(sources, "UTC", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotDaily, wantDaily) {
		t.Fatalf("daily groups differ from a dedicated pass:\ngot  %+v\nwant %+v", gotDaily, wantDaily)
	}
	if !reflect.DeepEqual(gotSessions, wantSessions) {
		t.Fatalf("session groups differ from a dedicated pass:\ngot  %+v\nwant %+v", gotSessions, wantSessions)
	}
}

// The window and the timezone apply to both groupings identically.
func TestLoadGroupsPerKindHonoursTheWindowForBothKinds(t *testing.T) {
	root := t.TempDir()
	inside := writeSourceFile(t, root, "2026/01/05/a.jsonl", headlessLine("2026-01-05T12:00:00Z", "gpt-5.4", 100, 20))
	outside := writeSourceFile(t, root, "2026/01/06/b.jsonl", headlessLine("2026-01-06T12:00:00Z", "gpt-5.4", 9, 1))
	_ = outside
	sources := []FileGroup{{Dir: root, Files: []string{inside}}}

	daily, sessions, err := LoadGroupsPerKind(sources, "UTC", "2026-01-05", "2026-01-05")
	if err != nil {
		t.Fatal(err)
	}
	if len(daily) != 1 || daily["2026-01-05"] == nil {
		t.Fatalf("daily = %+v, want one 2026-01-05 group", daily)
	}
	total := 0
	for _, group := range sessions {
		total += int(group.Input)
	}
	if total != 100 {
		t.Fatalf("session input total = %d, want 100", total)
	}
}

// assertBothKindsMatch runs the shared pass and both dedicated passes over the
// same sources and fails on any difference, including the window case where the
// replay plan prunes differently.
func assertBothKindsMatch(t *testing.T, sources []FileGroup, timezone, since, until string) {
	t.Helper()
	wantDaily, err := LoadGroups(sources, ReportDaily, timezone, since, until)
	if err != nil {
		t.Fatal(err)
	}
	wantSessions, err := LoadGroups(sources, ReportSession, timezone, since, until)
	if err != nil {
		t.Fatal(err)
	}
	gotDaily, gotSessions, err := LoadGroupsPerKind(sources, timezone, since, until)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotDaily, wantDaily) {
		t.Fatalf("daily differs from a dedicated pass:\ngot  %+v\nwant %+v", gotDaily, wantDaily)
	}
	if !reflect.DeepEqual(gotSessions, wantSessions) {
		t.Fatalf("session differs from a dedicated pass:\ngot  %+v\nwant %+v", gotSessions, wantSessions)
	}
}

// A compaction record is booked from its earliest file copy, and the copy that
// loses still carries a (different) service tier. The shared pass must reach the
// same attribution for both kinds.
func TestLoadGroupsPerKindMatchesCompactionAttribution(t *testing.T) {
	root := t.TempDir()
	record := func(timestamp, model string, input uint64, tier string) []string {
		settings := `{"type":"event_msg","timestamp":"` + timestamp + `","payload":{"type":"thread_settings_applied","thread_settings":{"service_tier":"` + tier + `"}}}`
		usage := `{"type":"token_usage_record","timestamp":"` + timestamp + `","payload":{"response_id":"resp-1","model":"` + model + `","usage":{"input_tokens":` + itoa(input) + `,"output_tokens":1}}}`
		marker := `{"type":"compacted","payload":{"compaction_response_id":"resp-1"}}`
		return []string{settings, usage, marker}
	}
	earliest := writeSourceFile(t, root, "2026/01/05/a.jsonl", record("2026-01-05T12:00:00.000Z", "gpt-5.4", 100, "standard")...)
	copied := writeSourceFile(t, root, "2026/01/06/b.jsonl", record("2026-01-06T12:00:00.000Z", "gpt-5.5", 900, "fast")...)
	assertBothKindsMatch(t, []FileGroup{{Dir: root, Files: []string{earliest, copied}}}, "UTC", "", "")
}

// Service tiers merge across duplicate copies, and the merged tier is what the
// second pass credits.
func TestLoadGroupsPerKindMatchesServiceTierMerge(t *testing.T) {
	root := t.TempDir()
	first := writeSourceFile(t, root, "2026/01/05/a.jsonl", tokenCountWithTier("2026-01-05T12:00:00Z", "fast", 500)...)
	second := writeSourceFile(t, root, "2026/01/05/b.jsonl", tokenCountWithTier("2026-01-05T12:00:00Z", "standard", 500)...)
	assertBothKindsMatch(t, []FileGroup{{Dir: root, Files: []string{first, second}}}, "UTC", "", "")
}

// A forked session replays its parent's events as a prefix. The shared pass
// must apply the same replay plan to both kinds.
func TestLoadGroupsPerKindMatchesForkReplay(t *testing.T) {
	root := t.TempDir()
	sessions := filepath.Join(root, "sessions")
	parent := writeReplayFile(t, sessions, "2026/01/05/parent.jsonl",
		sessionMeta("2026-01-05T12:00:00.000Z", "parent", ""),
		lastUsageLine("2026-01-05T12:00:00.000Z", 10),
		lastUsageLine("2026-01-05T12:00:10.000Z", 20),
		lastUsageLine("2026-01-05T12:00:11.000Z", 30),
	)
	child := writeReplayFile(t, sessions, "2026/01/05/child.jsonl",
		sessionMeta("2026-01-05T12:00:10.000Z", "child", "parent"),
		lastUsageLine("2026-01-05T12:00:10.000Z", 20),
		lastUsageLine("2026-01-05T12:00:12.000Z", 40),
	)
	assertBothKindsMatch(t, []FileGroup{{Dir: sessions, Files: []string{parent, child}}}, "UTC", "", "")
}

// A bounded window prunes the children but still reads pruned parents through
// the bounded replay plan; both kinds must see the same pruning.
func TestLoadGroupsPerKindMatchesBoundedWindow(t *testing.T) {
	root := t.TempDir()
	sessions := filepath.Join(root, "sessions")
	parent := writeReplayFile(t, sessions, "2026/01/04/parent.jsonl",
		sessionMeta("2026-01-04T12:00:00.000Z", "parent", ""),
		lastUsageLine("2026-01-04T12:00:00.000Z", 10),
	)
	child := writeReplayFile(t, sessions, "2026/01/05/child.jsonl",
		sessionMeta("2026-01-05T12:00:00.000Z", "child", "parent"),
		lastUsageLine("2026-01-05T12:00:00.000Z", 10),
		lastUsageLine("2026-01-05T12:00:05.000Z", 25),
	)
	assertBothKindsMatch(t, []FileGroup{{Dir: sessions, Files: []string{parent, child}}}, "UTC", "2026-01-05", "2026-01-05")
}

// A local compaction's usage can be absorbed by the parent's cumulative
// token_count snapshot, so the parent never emits a response-id record for it;
// the fork's child then copies the record and marker as a pair. The replay plan
// is what stops that copy from being billed again, and both report kinds must
// apply it - the sequential aggregateFile path does (aggregate.go), so the
// shared pass must too.
func TestLoadGroupsPerKindMatchesReplayedCompaction(t *testing.T) {
	root := t.TempDir()
	sessions := filepath.Join(root, "sessions")
	settings := `{"type":"event_msg","timestamp":"2026-01-05T00:00:00.000Z","payload":{"type":"thread_settings_applied","thread_settings":{"service_tier":"standard"}}}`
	// The record's usage equals the last_token_usage of the token_count that
	// absorbs it, which is what keeps the parent from emitting the record.
	record := `{"type":"token_usage_record","timestamp":"2026-01-05T00:10:00.000Z","payload":{"response_id":"resp-1","model":"gpt-5.4","usage":{"input_tokens":100,"total_tokens":100}}}`
	marker := `{"type":"compacted","payload":{"compaction_response_id":"resp-1"}}`
	parent := writeReplayFile(t, sessions, "2026/01/05/parent.jsonl",
		sessionMeta("2026-01-05T00:00:00.000Z", "parent", ""),
		settings,
		lastUsageLine("2026-01-05T00:00:01.000Z", 5),
		record,
		lastUsageLine("2026-01-05T00:10:00.000Z", 100),
		marker,
	)
	child := writeReplayFile(t, sessions, "2026/01/05/child.jsonl",
		sessionMeta("2026-01-05T00:20:00.000Z", "child", "parent"),
		settings,
		lastUsageLine("2026-01-05T00:20:01.000Z", 5),
		record,
		marker,
	)
	sources := []FileGroup{{Dir: sessions, Files: []string{parent, child}}}
	if !NewReplayPlan(sources).IsReplayedCompaction(child, "resp-1") {
		t.Fatal("precondition: the child's copy must be a replayed compaction")
	}
	assertBothKindsMatch(t, sources, "UTC", "", "")
}
