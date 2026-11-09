package copilot

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/adapters/tools"
	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// loaderCorpus is a three-model price table in the shape the embedded corpus
// builds, so the loader's pricing path needs no network or embedded assets.
func loaderCorpus(t *testing.T) nativepricing.Corpus {
	t.Helper()
	corpus, err := nativepricing.LoadEmbeddedCorpus()
	if err != nil {
		t.Fatal(err)
	}
	return corpus
}

// loadHome runs Reconcile plus the loader's own assembly over one fixture home.
func loadHome(t *testing.T, home string, since, until string, mode nativepricing.CostMode, corpus nativepricing.Corpus) []tools.Entry {
	t.Helper()
	sinceMs, untilMs := tools.DateRangeBoundsMs(since, until, "UTC")
	entries, err := Load(LoadInput{
		Options: tools.Options{
			Env: func(key string) (string, bool) {
				if key == "COPILOT_HOME" {
					return home, true
				}
				return "", false
			},
			Timezone: "UTC",
			Mode:     mode,
			Corpus:   corpus,
		},
		Since:   since,
		Until:   until,
		SinceMs: sinceMs,
		UntilMs: untilMs,
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return entries
}

func writeEvents(t *testing.T, home, session string, lines ...string) {
	t.Helper()
	writeFixtureFile(t, home, "session-state/"+session+"/events.jsonl", strings.Join(lines, "\n")+"\n")
}

func writeOTel(t *testing.T, home string, lines ...string) {
	t.Helper()
	writeFixtureFile(t, home, "otel/trace.jsonl", strings.Join(lines, "\n")+"\n")
}

// reportRows summarises loaded entries through the shared report layer, the
// way the provider does.
func reportRows(t *testing.T, entries []tools.Entry, kind tools.ReportKind) map[string]any {
	t.Helper()
	rows, totals := tools.Summarize(entries, kind)
	return tools.ReportJSON(rows, totals, kind, tools.RichSessionMetadata("copilot"))
}

// TestCopilotMergesThreePipelinesInOrder pins the merge order of
// load_entries_inner (loader.rs:116-124): session-state intervals, then the
// surviving OTel rows, then credit gaps, stably sorted by timestamp.
func TestCopilotMergesThreePipelinesInOrder(t *testing.T) {
	home := t.TempDir()
	writeEvents(t, home, "session-a",
		`{"type":"session.shutdown","id":"shutdown-1","timestamp":"2026-01-03T10:00:00.000Z","data":{"modelMetrics":{"claude-opus-4.6-1m":{"usage":{"inputTokens":200,"outputTokens":80,"cacheReadTokens":20,"cacheWriteTokens":30,"reasoningTokens":10},"requests":{"count":3}}}}}`,
	)
	writeEvents(t, home, "session-credits",
		`{"type":"session.usage_checkpoint","id":"checkpoint-c-1","timestamp":"2026-02-03T01:00:00.000Z","data":{"totalNanoAiu":5000000000}}`,
		`{"type":"session.shutdown","id":"shutdown-c","timestamp":"2026-02-03T02:00:00.000Z","data":{"totalNanoAiu":9000000000,"modelMetrics":{"gpt-5.4":{"usage":{"inputTokens":40,"outputTokens":10},"requests":{"count":2},"totalNanoAiu":3000000000}}}}`,
		`{"type":"session.usage_checkpoint","id":"checkpoint-c-2","timestamp":"2026-02-04T01:00:00.000Z","data":{"totalNanoAiu":11000000000}}`,
	)
	writeOTel(t, home,
		`{"type":"span","traceId":"trace-unmatched","spanId":"span-unmatched","name":"chat gpt-5.4","endTime":[1769995200,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"gpt-5.4","gen_ai.conversation.id":"session-c","gen_ai.usage.input_tokens":7,"gen_ai.usage.output_tokens":8}}`,
	)
	entries := loadHome(t, home, "", "", nativepricing.ModeAuto, loaderCorpus(t))
	type key struct {
		timestamp int64
		session   string
		model     string
		cost      bool
	}
	got := make([]key, 0, len(entries))
	for _, entry := range entries {
		got = append(got, key{entry.Timestamp, entry.SessionID, entry.Model, entry.ReportedCost != nil})
	}
	want := []key{
		{mustFixtureTime("2026-01-03T10:00:00.000Z"), "session-a", "claude-opus-4.6", false},
		// session-c has an OTel row and no session state, so its credit gaps
		// are not OTel's to own either way; the row sorts before the 02-03
		// shutdown.
		{mustFixtureTime("2026-02-02T01:20:00.000Z"), "session-c", "gpt-5.4", false},
		{mustFixtureTime("2026-02-03T02:00:00.000Z"), "session-credits", "gpt-5.4", false},
		{mustFixtureTime("2026-02-03T02:00:00.000Z"), "session-credits", "unknown", true},
		{mustFixtureTime("2026-02-04T01:00:00.000Z"), "session-credits", "unknown", true},
	}
	if len(got) != len(want) {
		t.Fatalf("entries = %+v, want %+v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("entries[%d] = %+v, want %+v (all %+v)", index, got[index], want[index], got)
		}
	}
}

// TestCopilotCreditGapOnlyHasCost pins usage_entry_to_loaded (loader.rs:458-521):
// a credit gap carries its dollar cost, no tokens and no message count; a token
// row carries no reported cost unless display mode reads it back.
func TestCopilotCreditGapOnlyHasCost(t *testing.T) {
	home := t.TempDir()
	writeEvents(t, home, "session-credits",
		`{"type":"session.usage_checkpoint","id":"checkpoint-c-1","timestamp":"2026-02-03T01:00:00.000Z","data":{"totalNanoAiu":5000000000}}`,
	)
	entries := loadHome(t, home, "", "", nativepricing.ModeAuto, loaderCorpus(t))
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want one gap", entries)
	}
	gap := entries[0]
	if gap.Model != "unknown" || gap.Usage.Total() != 0 || gap.MessageCount != nil || gap.MissingPricing {
		t.Fatalf("gap = %+v, want zero tokens, no message count, no missing pricing", gap)
	}
	if !floatNear(gap.CostUSD, 0.05) || gap.ReportedCost == nil || !floatNear(*gap.ReportedCost, 0.05) {
		t.Fatalf("gap cost = %v reported %v, want 0.05", gap.CostUSD, gap.ReportedCost)
	}
	if gap.ProjectPath != "GitHub Copilot CLI" || gap.Date != "2026-02-03" || gap.SessionID != "session-credits" {
		t.Fatalf("gap metadata = %+v", gap)
	}

	// Calculate mode: no reported cost survives the pricing walk for a row
	// with no tokens, and the cost stays the reported one because the gap is
	// priced through nativepricing.Cost with the reported cost in Auto only.
	calculated := loadHome(t, home, "", "", nativepricing.ModeCalculate, loaderCorpus(t))
	if len(calculated) != 1 || calculated[0].CostUSD != 0 {
		t.Fatalf("calculate mode = %+v, want one zero-cost gap", calculated)
	}
}

// TestCopilotExtraTokensJoinOutputForPricing pins usage_entry_to_loaded's cost
// usage (loader.rs:472-476): the extra total tokens fold into the output
// bucket before pricing, and the entry keeps them for the report.
func TestCopilotExtraTokensJoinOutputForPricing(t *testing.T) {
	home := t.TempDir()
	writeOTel(t, home,
		`{"type":"span","traceId":"t1","spanId":"s1","name":"chat claude-opus-4-6","endTime":[1775934000,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"claude-opus-4-6","gen_ai.conversation.id":"c1","gen_ai.usage.input_tokens":1000,"gen_ai.usage.output_tokens":500,"gen_ai.usage.total_tokens":1600}}`,
	)
	entries := loadHome(t, home, "", "", nativepricing.ModeAuto, loaderCorpus(t))
	if len(entries) != 1 {
		t.Fatalf("entries = %+v", entries)
	}
	entry := entries[0]
	if entry.Usage.Output != 500 || entry.Usage.Extra != 100 {
		t.Fatalf("usage = %+v, want output 500 extra 100", entry.Usage)
	}
	corpus := loaderCorpus(t)
	pricing, ok := corpus.FindAt("claude-opus-4-6", entry.Timestamp)
	if !ok {
		t.Fatal("claude-opus-4-6 not in the embedded corpus")
	}
	wantCost := nativepricing.CostFromPricing(nativepricing.Usage{
		Input: 1000, Output: 600, CacheRead: 0, CacheCreate5m: 0,
	}, pricing, false)
	if entry.CostUSD != wantCost {
		t.Fatalf("cost = %v, want %v (extra folded into output)", entry.CostUSD, wantCost)
	}
}

// TestCopilotModelMissingFromTheCorpusIsMarked pins
// missing_pricing_model_for_usage through the shared PriceEntry: a token row
// whose model has no price is flagged, a row with no tokens never is.
func TestCopilotModelMissingFromTheCorpusIsMarked(t *testing.T) {
	home := t.TempDir()
	writeOTel(t, home,
		`{"type":"span","traceId":"t1","spanId":"s1","name":"chat model-nobody-prices","endTime":[1775934000,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"model-nobody-prices","gen_ai.conversation.id":"c1","gen_ai.usage.input_tokens":10}}`,
	)
	entries := loadHome(t, home, "", "", nativepricing.ModeAuto, loaderCorpus(t))
	if len(entries) != 1 || !entries[0].MissingPricing {
		t.Fatalf("entries = %+v, want the row flagged missing", entries)
	}
	document := reportRows(t, entries, tools.Daily)
	totals, _ := document["totals"].(map[string]any)
	if unpriced, ok := totals["unpricedModels"].([]string); !ok || len(unpriced) != 1 || unpriced[0] != "model-nobody-prices" {
		t.Fatalf("unpricedModels = %v", totals["unpricedModels"])
	}
}

// TestCopilotReportShapeMatchesFocusedSnapshot mirrors the upstream
// focused-daily snapshot (crates/ccusage/tests/snapshots/copilot_cli__focused_daily_json.snap)
// over an equivalent synthetic tree, and the focused-session snapshot for the
// session shape. Sources: rust/adapters/copilot/tests/fixtures/**.
func TestCopilotReportShapeMatchesFocusedSnapshot(t *testing.T) {
	home := t.TempDir()
	writeOTel(t, home,
		`{"type":"span","traceId":"trace-match","spanId":"span-match","name":"chat claude-opus-4.6-1m-internal","endTime":[1767403200,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"claude-opus-4.6-1m-internal","gen_ai.conversation.id":"session-a","gen_ai.usage.input_tokens":999,"gen_ai.usage.output_tokens":999}}`,
		`{"type":"span","traceId":"trace-resumed","spanId":"span-resumed","name":"chat claude-opus-4.6-1m-internal","endTime":[1767406800,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"claude-opus-4.6-1m-internal","gen_ai.conversation.id":"session-a","gen_ai.usage.input_tokens":13,"gen_ai.usage.output_tokens":14}}`,
		`{"type":"span","traceId":"trace-unmatched","spanId":"span-unmatched","name":"chat gpt-5.4","endTime":[1769995200,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"gpt-5.4","gen_ai.conversation.id":"session-c","gen_ai.usage.input_tokens":7,"gen_ai.usage.output_tokens":8}}`,
	)
	writeEvents(t, home, "session-a",
		"not json",
		`{"type":"session.start","timestamp":"2026-01-02T01:20:00.000Z","data":{"prompt":"private prompt must not appear in reports"}}`,
		`{"type":"session.shutdown","id":"shutdown-a-old","timestamp":"2026-01-02T01:20:00.000Z","data":{"modelMetrics":{"claude-opus-4.6-1m":{"usage":{"inputTokens":100,"outputTokens":50,"cacheReadTokens":10,"cacheWriteTokens":20,"reasoningTokens":5},"requests":{"count":1,"cost":999}}},"privatePrompt":"do not expose"}}`,
		`{"type":"session.shutdown","id":"shutdown-a-latest","timestamp":"2026-01-03T01:20:00.000Z","data":{"modelMetrics":{"claude-opus-4.6-1m":{"usage":{"inputTokens":200,"outputTokens":80,"cacheReadTokens":20,"cacheWriteTokens":30,"reasoningTokens":10},"requests":{"count":3}}}}}`,
	)
	writeEvents(t, home, "session-b",
		`{"type":"session.shutdown","id":"shutdown-b","timestamp":"2026-02-01T01:20:00.000Z","data":{"modelMetrics":{"gpt-5.4":{"usage":{"inputTokens":90,"outputTokens":30,"cacheReadTokens":10,"cacheWriteTokens":15,"reasoningTokens":4}}}}}`,
	)
	entries := loadHome(t, home, "20260101", "20260228", nativepricing.ModeAuto, loaderCorpus(t))

	// No prompt text reaches an entry: the only per-entry strings are session,
	// model, dedup key and the report labels.
	for _, entry := range entries {
		for _, value := range []string{entry.SessionID, entry.Model, entry.MessageID, entry.ProjectPath, entry.Version} {
			if strings.Contains(value, "prompt") || strings.Contains(value, "do not expose") {
				t.Fatalf("entry leaks text: %+v", entry)
			}
		}
	}

	daily := reportRows(t, entries, tools.Daily)
	rows, _ := daily["daily"].([]map[string]any)
	got := []string{}
	for _, row := range rows {
		models := []string{}
		for _, breakdown := range row["modelBreakdowns"].([]map[string]any) {
			models = append(models, breakdown["modelName"].(string))
		}
		got = append(got, row["date"].(string)+" in="+utoa(row["inputTokens"].(uint64))+
			" out="+utoa(row["outputTokens"].(uint64))+" cacheRead="+utoa(row["cacheReadTokens"].(uint64))+
			" cacheCreate="+utoa(row["cacheCreationTokens"].(uint64))+" models="+strings.Join(models, "+"))
	}
	// session-a: see below. The gap-free session-b is credited by its shutdown
	// alone, and the OTel-only session-c keeps its own date.
	// session-a's intervals are the 2026-01-02 shutdown (its `requests.cost`
	// is an unknown field serde ignores, so the line counts) and the
	// 2026-01-03 shutdown after it. OTel's 2 calls do NOT outnumber the 3
	// requests they report, so the intervals stand and the two OTel rows are
	// suppressed (otel_after = the latest shutdown).
	want := []string{
		"2026-01-02 in=70 out=50 cacheRead=10 cacheCreate=20 models=claude-opus-4.6",
		"2026-01-03 in=93 out=44 cacheRead=10 cacheCreate=10 models=claude-opus-4.6",
		"2026-02-01 in=65 out=30 cacheRead=10 cacheCreate=15 models=gpt-5.4",
		// OTel-only session: its own date by endTime.
		"2026-02-02 in=7 out=8 cacheRead=0 cacheCreate=0 models=gpt-5.4",
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("daily rows =\n  %s\nwant\n  %s", strings.Join(got, "\n  "), strings.Join(want, "\n  "))
	}
}

// TestCopilotSessionReportShape pins the focused-monthly-and-session snapshot's
// session shape: rows keyed by sessionId, messageCount from the request counts,
// and lastActivity/firstActivity/projectPath (copilot's report passes
// include_session_metadata=true, report.rs:11-16).
func TestCopilotSessionReportShape(t *testing.T) {
	home := t.TempDir()
	writeEvents(t, home, "session-a",
		`{"type":"session.shutdown","id":"shutdown-a-old","timestamp":"2026-01-02T01:20:00.000Z","data":{"modelMetrics":{"claude-opus-4.6-1m":{"usage":{"inputTokens":100,"outputTokens":50,"cacheReadTokens":10,"cacheWriteTokens":20,"reasoningTokens":5},"requests":{"count":1}}}}}`,
		`{"type":"session.shutdown","id":"shutdown-a-latest","timestamp":"2026-01-03T01:20:00.000Z","data":{"modelMetrics":{"claude-opus-4.6-1m":{"usage":{"inputTokens":200,"outputTokens":80,"cacheReadTokens":20,"cacheWriteTokens":30,"reasoningTokens":10},"requests":{"count":3}}}}}`,
	)
	entries := loadHome(t, home, "20260101", "20260228", nativepricing.ModeAuto, loaderCorpus(t))
	sessions := reportRows(t, entries, tools.Session)
	rows, _ := sessions["sessions"].([]map[string]any)
	if len(rows) != 1 {
		t.Fatalf("session rows = %v", rows)
	}
	row := rows[0]
	// The two OTel rows of session-a survive (OTel's 2 calls outnumber the
	// shutdown intervals' 1 + 2, so the intervals drop) and their 1012 input
	// tokens sit beside the SESSIONS' report whose messageCount sums the
	// shutdown requests.
	if row["sessionId"] != "session-a" || row["messageCount"] != uint64(3) || row["inputTokens"] != uint64(150) {
		t.Fatalf("session row = %v, want session-a with 3 requests and 150 input tokens", row)
	}
	if row["lastActivity"] != "2026-01-03T01:20:00.000Z" || row["firstActivity"] != "2026-01-02T01:20:00.000Z" {
		t.Fatalf("session row times = %v..%v", row["firstActivity"], row["lastActivity"])
	}
	if row["projectPath"] != "GitHub Copilot CLI" {
		t.Fatalf("session row projectPath = %v", row["projectPath"])
	}
}

// TestCopilotFailedFileIsSkippedWithADebugLine pins read_source_file's error
// handling (loader.rs:49-68): one unreadable file loses its rows and a debug
// line, and the other files still load.
func TestCopilotFailedFileIsSkippedWithADebugLine(t *testing.T) {
	home := t.TempDir()
	writeOTel(t, home,
		`{"type":"span","traceId":"t1","spanId":"s1","endTime":[1775934000,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"m","gen_ai.usage.input_tokens":1}}`,
	)
	// A session-state events.jsonl that cannot be opened (mode 0). POSIX
	// permission bits are the only portable way to produce that fixture;
	// Windows ignores them, so the case is POSIX-only.
	if runtime.GOOS == "windows" {
		t.Skip("chmod 0 does not make a file unreadable on Windows")
	}
	blocked := writeFixtureFile(t, home, "session-state/s/events.jsonl", "{\"type\":\"session.shutdown\"}\n")
	if err := os.Chmod(blocked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(blocked, 0o600) })
	lines := []string{}
	entries, err := Load(LoadInput{
		Options: tools.Options{
			Env: func(key string) (string, bool) {
				if key == "COPILOT_HOME" {
					return home, true
				}
				return "", false
			},
			Timezone: "UTC",
			Mode:     nativepricing.ModeAuto,
			Corpus:   loaderCorpus(t),
			Debug:    func(line string) { lines = append(lines, line) },
		},
	})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(entries) != 1 || len(lines) != 1 || !strings.Contains(lines[0], "session-state") {
		t.Fatalf("entries = %d debug = %v, want the OTel row and one session-state debug line", len(entries), lines)
	}
}

// TestCopilotEmptyHomeProducesNoEntries pins that a missing COPILOT_HOME is a
// clean empty report.
func TestCopilotEmptyHomeProducesNoEntries(t *testing.T) {
	entries, err := Load(LoadInput{Options: tools.Options{
		Env: func(key string) (string, bool) {
			if key == "COPILOT_HOME" {
				return filepath.Join(t.TempDir(), "absent"), true
			}
			return "", false
		},
		Timezone: "UTC",
	}})
	if err != nil || len(entries) != 0 {
		t.Fatalf("Load = (%v, %v), want no entries and no error", entries, err)
	}
}

// TestCopilotSessionStateUnreadableTimeFallsBackToTheFileTime pins parser.rs's
// timestamp fallthrough: an event whose timestamp cannot be parsed is dated at
// the file's mtime, not dropped.
func TestCopilotSessionStateUnreadableTimeFallsBackToTheFileTime(t *testing.T) {
	// The line carries the event name the prefilter looks for and the rest of
	// its fields; the timestamp string alone is unreadable.
	path := writeFixtureFile(t, t.TempDir(), "session-x/events.jsonl",
		`{"type":"session.shutdown","id":"session.shutdown","timestamp":"yesterday","data":{"modelMetrics":{"m":{"usage":{"inputTokens":5}}}}}`+"\n")
	usage, err := parseSessionStateFile(path, 1_700_000_000_000)
	if err != nil {
		t.Fatal(err)
	}
	if len(usage.Entries) != 1 || usage.Entries[0].Timestamp != 1_700_000_000_000 {
		t.Fatalf("entries = %+v, want the mtime fallback", usage.Entries)
	}
}
