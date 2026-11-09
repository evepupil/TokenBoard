package codex

// The Codex fork replay plan, pinned against ccusage v20.0.33 (commit
// 1308c416): rust/adapters/codex/src/replay.rs. The plan decides which of a
// forked session's leading events were replayed from its parent and must not be
// counted twice, so every rule below cites the line it comes from.

import (
	"os"
	"path/filepath"
	"testing"
)

func writeReplayFile(t *testing.T, root, relative string, lines ...string) string {
	t.Helper()
	path := filepath.Join(root, relative)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(joinLines(lines...)), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func sessionMeta(timestamp, id, parentID string) string {
	forked := ""
	if parentID != "" {
		forked = `,"forked_from_id":"` + parentID + `"`
	}
	return `{"type":"session_meta","timestamp":"` + timestamp + `","payload":{"id":"` + id + `"` + forked + `}}`
}

func lastUsageLine(timestamp string, total uint64) string {
	return tokenCountLine(timestamp,
		`{"total_token_usage":{"input_tokens":`+itoa(total)+`,"total_tokens":`+itoa(total)+`},"last_token_usage":{"input_tokens":`+itoa(total)+`,"total_tokens":`+itoa(total)+`}}`)
}

func itoa(value uint64) string {
	if value == 0 {
		return "0"
	}
	digits := []byte{}
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

func planFor(t *testing.T, groups ...FileGroup) *ReplayPlan {
	t.Helper()
	return NewReplayPlan(groups)
}

// TestReplayPrefixStopsAtFirstEventAfterFork pins replay_prefix
// (replay.rs:159-178): the prefix covers the parent's events up to the first
// one strictly after forked_at, so an event exactly at the fork instant is
// still replayed and excluded from the child.
func TestReplayPrefixStopsAtFirstEventAfterFork(t *testing.T) {
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
	plan := planFor(t, FileGroup{Dir: sessions, Files: []string{parent, child}})
	got := plan.Prefix(child)
	assertUsageSlice(t, got, []RawUsage{
		{Input: 10, Total: 10},
		{Input: 20, Total: 20},
	})
}

func assertUsageSlice(t *testing.T, got, want []RawUsage) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("prefix = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("prefix[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
}

// TestReplayWithoutParentForksFromEmptyPrefix pins replay_prefix's
// unavailable-parent arm (replay.rs:159-172): a fork whose parent log is not in
// the scan set yields an empty, non-nil prefix - not "not a fork" - which makes
// the parser fall back to the rewritten-burst heuristic.
func TestReplayWithoutParentForksFromEmptyPrefix(t *testing.T) {
	root := t.TempDir()
	sessions := filepath.Join(root, "sessions")
	child := writeReplayFile(t, sessions, "2026/01/05/child.jsonl",
		sessionMeta("2026-01-05T12:00:10.000Z", "child", "ghost"),
		lastUsageLine("2026-01-05T12:00:10.000Z", 20),
	)
	plan := planFor(t, FileGroup{Dir: sessions, Files: []string{child}})
	prefix := plan.Prefix(child)
	if prefix == nil {
		t.Fatal("Prefix(child with a missing parent) = nil, want an empty non-nil slice")
	}
	if len(prefix) != 0 {
		t.Fatalf("prefix = %+v, want empty", prefix)
	}
	if plan.IsReplayedCompaction(child, "anything") {
		t.Fatal("a child without a readable parent cannot have replayed compactions")
	}
}

// TestReplayIgnoresParentThatIsNotInTheScanSet pins for_bounded_files
// (replay.rs:118-152): the index is built from the available (unfiltered) set,
// so a parent outside that set is invisible and the fork gets an empty prefix.
func TestReplayIgnoresParentThatIsNotInTheScanSet(t *testing.T) {
	root := t.TempDir()
	sessions := filepath.Join(root, "sessions")
	writeReplayFile(t, sessions, "2026/01/05/parent.jsonl",
		sessionMeta("2026-01-05T12:00:00.000Z", "parent", ""),
		lastUsageLine("2026-01-05T12:00:00.000Z", 10),
	)
	child := writeReplayFile(t, sessions, "2026/01/05/child.jsonl",
		sessionMeta("2026-01-05T12:00:10.000Z", "child", "parent"),
		lastUsageLine("2026-01-05T12:00:10.000Z", 10),
	)
	plan := NewBoundedReplayPlan(
		[]FileGroup{{Dir: sessions, Files: []string{child}}},
		[]FileGroup{{Dir: sessions, Files: []string{child}}},
	)
	prefix := plan.Prefix(child)
	if prefix == nil || len(prefix) != 0 {
		t.Fatalf("prefix = %#v, want an empty non-nil slice", prefix)
	}
}

// TestBoundedPlanStillReadsUnprunedParents pins for_bounded_files' purpose
// (replay.rs:118-152): a child survives date pruning, its parent does not, and
// the plan still reads that parent's usage from the available set.
func TestBoundedPlanStillReadsUnprunedParents(t *testing.T) {
	root := t.TempDir()
	sessions := filepath.Join(root, "sessions")
	parent := writeReplayFile(t, sessions, "2026/01/05/parent.jsonl",
		sessionMeta("2026-01-05T12:00:00.000Z", "parent", ""),
		lastUsageLine("2026-01-05T12:00:00.000Z", 10),
		lastUsageLine("2026-01-05T12:00:01.000Z", 20),
	)
	child := writeReplayFile(t, sessions, "2026/01/05/child.jsonl",
		sessionMeta("2026-01-05T12:00:05.000Z", "child", "parent"),
		lastUsageLine("2026-01-05T12:00:05.000Z", 20),
	)
	plan := NewBoundedReplayPlan(
		[]FileGroup{{Dir: sessions, Files: []string{child}}},
		[]FileGroup{{Dir: sessions, Files: []string{parent, child}}},
	)
	assertUsageSlice(t, plan.Prefix(child), []RawUsage{
		{Input: 10, Total: 10},
		{Input: 20, Total: 20},
	})
}

// TestReplayReadsTheSubagentParentPointer pins the second parent source
// (replay.rs:298-306): when forked_from_id is absent, the JSON pointer
// payload.source.subagent.thread_spawn.parent_thread_id names the parent.
func TestReplayReadsTheSubagentParentPointer(t *testing.T) {
	root := t.TempDir()
	sessions := filepath.Join(root, "sessions")
	parent := writeReplayFile(t, sessions, "2026/01/05/parent.jsonl",
		sessionMeta("2026-01-05T12:00:00.000Z", "parent", ""),
		lastUsageLine("2026-01-05T12:00:00.000Z", 10),
	)
	child := writeReplayFile(t, sessions, "2026/01/05/child.jsonl",
		`{"type":"session_meta","timestamp":"2026-01-05T12:00:05.000Z","payload":{"id":"child","source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}}}`,
		lastUsageLine("2026-01-05T12:00:05.000Z", 10),
	)
	plan := planFor(t, FileGroup{Dir: sessions, Files: []string{parent, child}})
	assertUsageSlice(t, plan.Prefix(child), []RawUsage{{Input: 10, Total: 10}})
}

// TestReplayedCompactionBeforeForkIsDropped pins is_replayed_compaction
// (replay.rs:182-200): the parent's compaction identity counts as replayed when
// it was recorded at or before the fork, or when its timestamp is unusable; a
// compaction recorded after the fork, an unknown id, and a parent-less child do
// not.
func TestReplayedCompactionBeforeForkIsDropped(t *testing.T) {
	root := t.TempDir()
	sessions := filepath.Join(root, "sessions")
	record := func(id, timestamp string) string {
		return `{"type":"token_usage_record","timestamp":"` + timestamp + `","payload":{"response_id":"` + id + `","usage":{"input_tokens":5,"output_tokens":2}}}`
	}
	marker := func(id string) string {
		return `{"type":"compacted","payload":{"compaction_response_id":"` + id + `"}}`
	}
	parent := writeReplayFile(t, sessions, "2026/01/05/parent.jsonl",
		sessionMeta("2026-01-05T12:00:00.000Z", "parent", ""),
		record("before", "2026-01-05T12:00:00.000Z"), marker("before"),
		record("at-fork", "2026-01-05T12:00:10.000Z"), marker("at-fork"),
		record("after", "2026-01-05T12:00:20.000Z"), marker("after"),
		record("unusable", "not-a-timestamp"), marker("unusable"),
	)
	child := writeReplayFile(t, sessions, "2026/01/05/child.jsonl",
		sessionMeta("2026-01-05T12:00:10.000Z", "child", "parent"),
	)
	leaf := writeReplayFile(t, sessions, "2026/01/05/leaf.jsonl",
		sessionMeta("2026-01-05T12:00:15.000Z", "leaf", ""),
	)
	plan := planFor(t, FileGroup{Dir: sessions, Files: []string{parent, child, leaf}})

	for _, id := range []string{"before", "at-fork", "unusable"} {
		if !plan.IsReplayedCompaction(child, id) {
			t.Fatalf("IsReplayedCompaction(%q) = false, want true", id)
		}
	}
	for _, id := range []string{"after", "unknown"} {
		if plan.IsReplayedCompaction(child, id) {
			t.Fatalf("IsReplayedCompaction(%q) = true, want false", id)
		}
	}
	if plan.IsReplayedCompaction(leaf, "before") {
		t.Fatal("a session without a parent cannot have replayed compactions")
	}
	if plan.IsReplayedCompaction(child, "") {
		t.Fatal("an empty response id is never a replayed compaction")
	}
}
