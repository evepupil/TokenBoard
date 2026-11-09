package tools

// The Qwen adapter's rules, pinned against ccusage v20.0.33 (commit 1308c416):
// rust/adapters/qwen/src/{paths,parser,report,lib}.rs.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

func qwenOptions(t *testing.T, root string, mode nativepricing.CostMode) Options {
	t.Helper()
	return Options{
		Env: func(key string) (string, bool) {
			if key == "QWEN_DATA_DIR" {
				return root, true
			}
			return "", false
		},
		Timezone: "UTC",
		Mode:     mode,
		Corpus:   testCorpus(t),
	}
}

const qwenAssistantRecord = `{"type":"assistant","model":"qwen3-coder-plus","timestamp":"2026-02-23T14:24:56.857Z","usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":50,"thoughtsTokenCount":10,"cachedContentTokenCount":5}}`

// TestQwenOnlyThreeSegmentChatPath pins is_chat_file (paths.rs:48-60): only
// <root>/projects/<project>/chats/<file>.jsonl is read, so sibling and nested
// layouts under projects are ignored.
func TestQwenOnlyThreeSegmentChatPath(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "projects", "proj", "chats", "chat.jsonl"),
		`{"type":"assistant","sessionId":"s","model":"m","usageMetadata":{"promptTokenCount":10}}`)
	for _, rejected := range [][]string{
		{"projects", "proj", "chat.jsonl"},
		{"projects", "proj", "chats", "sub", "chat.jsonl"},
		{"projects", "proj", "notes", "chat.jsonl"},
		{"projects", "chats", "chat.jsonl"},
	} {
		writeFile(t, filepath.Join(append([]string{root}, rejected...)...), qwenAssistantRecord)
	}

	entries, err := LoadQwen(qwenOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want only the three-segment chat file", entries)
	}
	if entries[0].ProjectPath != "proj" {
		t.Fatalf("project = %q, want the chat's project directory", entries[0].ProjectPath)
	}
}

// TestQwenCostAlwaysUnavailable pins qwen's cost contract: the source never
// reports a USD cost (LoadedEntry.cost_usd is always None) so display mode
// yields zero, while auto/calculate price the token usage through the
// model -> qwen/<model> -> alibaba/<model> chain.
func TestQwenCostAlwaysUnavailable(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "projects", "proj", "chats", "chat.jsonl"), qwenAssistantRecord)

	display, err := LoadQwen(qwenOptions(t, root, nativepricing.ModeDisplay))
	if err != nil {
		t.Fatal(err)
	}
	if len(display) != 1 {
		t.Fatalf("display entries = %+v", display)
	}
	if display[0].ReportedCost != nil || display[0].CostUSD != 0 || display[0].MissingPricing {
		t.Fatalf("display entry = %+v, want no reported cost and zero cost", display[0])
	}

	calculated, err := LoadQwen(qwenOptions(t, root, nativepricing.ModeCalculate))
	if err != nil {
		t.Fatal(err)
	}
	if len(calculated) != 1 {
		t.Fatalf("calculate entries = %+v", calculated)
	}
	if calculated[0].ReportedCost != nil {
		t.Fatalf("reported cost = %v, want none", *calculated[0].ReportedCost)
	}
	pricing, ok := testCorpus(t).Find("qwen3-coder-plus")
	if !ok {
		t.Fatal("missing qwen3-coder-plus pricing")
	}
	// billable_usage folds the thoughts tokens into output (parser.rs:172-178).
	billed := nativepricing.Usage{Input: 100, Output: 60, CacheRead: 5}
	if want := nativepricing.CostFromPricing(billed, pricing, false); calculated[0].CostUSD != want {
		t.Fatalf("cost = %v, want %v", calculated[0].CostUSD, want)
	}
}

// TestQwenEmptyTotalsIsNull pins qwen's report special case (report.rs:11-20):
// an empty row set reports totals as JSON null, which no other tool adapter
// does.
func TestQwenEmptyTotalsIsNull(t *testing.T) {
	empty := QwenReportJSON(nil, Totals{}, Daily)
	if empty["totals"] != nil {
		t.Fatalf("totals = %#v, want nil", empty["totals"])
	}
	if rows, ok := empty["daily"].([]map[string]any); !ok || len(rows) != 0 {
		t.Fatalf("daily = %#v, want an empty array", empty["daily"])
	}

	rows, totals := Summarize([]Entry{{
		Timestamp: 1,
		Date:      "2026-02-23",
		Model:     "qwen3-coder-plus",
		Usage:     Usage{Input: 10},
	}}, Daily)
	document := QwenReportJSON(rows, totals, Daily)
	if _, ok := document["totals"].(map[string]any); !ok {
		t.Fatalf("totals = %#v, want the totals object", document["totals"])
	}
}

// TestQwenSessionFilterUsesLastActivity pins filter_session_summaries
// (qwen/src/lib.rs:53-67): the session report narrows by each row's lastActivity
// instead of by entry dates. The comparison is lexicographic on the
// `-`-stripped strings, so a full RFC3339 lastActivity sorts after a bare date
// bound of the same day: `since` includes that day, `until` excludes it.
func TestQwenSessionFilterUsesLastActivity(t *testing.T) {
	at := func(day int) int64 {
		return time.Date(2026, 2, day, 12, 0, 0, 0, time.UTC).UnixMilli()
	}
	rows := []Row{
		{Key: "before", LastActivity: at(22)},
		{Key: "inside", LastActivity: at(23)},
		{Key: "after", LastActivity: at(24)},
	}

	if got := FilterQwenSessionRows(rows, "2026-02-23", ""); len(got) != 2 || got[0].Key != "inside" || got[1].Key != "after" {
		t.Fatalf("rows = %+v, want the since bound to include its own day", got)
	}
	if got := FilterQwenSessionRows(rows, "", "2026-02-24"); len(got) != 2 || got[0].Key != "before" || got[1].Key != "inside" {
		t.Fatalf("rows = %+v, want the until bound to exclude its own day", got)
	}
	if got := FilterQwenSessionRows(rows, "2026-02-22", "2026-02-24"); len(got) != 2 {
		t.Fatalf("rows = %+v, want both bounds applied", got)
	}
	if got := FilterQwenSessionRows(rows, "", ""); len(got) != len(rows) {
		t.Fatalf("rows = %+v, want every row when no bound is set", got)
	}
	if got := FilterQwenSessionRows([]Row{{Key: "zero"}}, "2026-01-01", ""); len(got) != 0 {
		t.Fatalf("rows = %+v, want a missing lastActivity to fall outside the range", got)
	}
}

// TestQwenProjectAndSessionDefaults pins parse_line's fallbacks
// (parser.rs:154-171): the project comes from the projects/<project>/chats path
// window, the session id defaults to <project>-<file stem>, the model defaults
// to unknown, and an unparsable timestamp falls back to the file mtime.
func TestQwenProjectAndSessionDefaults(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "projects", "beta", "chats", "chat-7.jsonl")
	writeFile(t, file, `{"type":"assistant","timestamp":"2026-02-23 14:24:56","usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}`)
	mtime := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	if err := os.Chtimes(file, mtime, mtime); err != nil {
		t.Fatal(err)
	}

	entries, err := LoadQwen(qwenOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v", entries)
	}
	entry := entries[0]
	if entry.SessionID != "beta-chat-7" || entry.Model != "unknown" || entry.ProjectPath != "beta" {
		t.Fatalf("entry = %+v, want the project/stem/model defaults", entry)
	}
	if entry.Timestamp != mtime.UnixMilli() || entry.Date != "2026-03-04" {
		t.Fatalf("timestamp = %d date = %q, want the mtime fallback", entry.Timestamp, entry.Date)
	}
	if entry.Usage != (Usage{Input: 10, Output: 2}) {
		t.Fatalf("usage = %+v", entry.Usage)
	}
}

// TestQwenDedupKeepsFirstSortedFile pins entry_id (parser.rs:290-302): records
// that agree on session, timestamp text, model, input, output, cache read and
// extra collapse to one entry, first sorted file wins.
func TestQwenDedupKeepsFirstSortedFile(t *testing.T) {
	root := t.TempDir()
	line := strings.Join([]string{
		`{"type":"assistant","sessionId":"s","model":"m","timestamp":"2026-02-23T14:24:56.857Z",`,
		`"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}`,
	}, "")
	writeFile(t, filepath.Join(root, "projects", "alpha", "chats", "a.jsonl"), line)
	writeFile(t, filepath.Join(root, "projects", "zeta", "chats", "z.jsonl"), line)

	entries, err := LoadQwen(qwenOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want the duplicate collapsed", entries)
	}
	if entries[0].ProjectPath != "alpha" {
		t.Fatalf("project = %q, want the first sorted file to win", entries[0].ProjectPath)
	}
}
