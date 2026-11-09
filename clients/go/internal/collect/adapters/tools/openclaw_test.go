package tools

// The OpenClaw adapter's rules, pinned against ccusage v20.0.33 (commit
// 1308c416): rust/adapters/openclaw/src/{paths,parser,loader,sqlite}.rs.

import (
	"database/sql"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// openclawOptions builds Options with an optional OPENCLAW_DIR and a
// caller-chosen home directory.
func openclawOptions(t *testing.T, home string, env *string, mode nativepricing.CostMode, corpus nativepricing.Corpus) Options {
	t.Helper()
	return Options{
		Env: func(key string) (string, bool) {
			if key == "OPENCLAW_DIR" && env != nil {
				return *env, true
			}
			return "", false
		},
		HomeDir:  func() (string, error) { return home, nil },
		Timezone: "UTC",
		Mode:     mode,
		Corpus:   corpus,
	}
}

// seedOpenclawAgentDatabase writes one per-agent SQLite store under root.
func seedOpenclawAgentDatabase(t *testing.T, root, agent string, rows [][2]string) {
	t.Helper()
	dir := filepath.Join(root, "agents", agent, "agent")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(dir, "openclaw-agent.sqlite")))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if _, err := database.Exec(
		`CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, seq))`); err != nil {
		t.Fatal(err)
	}
	for index, row := range rows {
		if _, err := database.Exec(
			`INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, 1769753935279)`,
			row[0], index, row[1]); err != nil {
			t.Fatal(err)
		}
	}
}

// TestOpenclawDisplayNamePrefixedPricingNameBare pins openclaw_entry_to_loaded
// (parser.rs:382-387): the row displays "[openclaw] model", but pricing uses the
// bare name unless the table prices the decorated one exactly. DeepSeek V4 on a
// 2026-08-17 Monday at 01:00 UTC bills at the peak 0.44e-6 input rate.
func TestOpenclawDisplayNamePrefixedPricingNameBare(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "agents", "main", "sessions", "abc.jsonl"),
		`{"type":"message","message":{"role":"assistant","model":"deepseek-v4-flash","usage":{"input":1000000,"output":0,"totalTokens":1000000},"timestamp":"2026-08-17T01:00:00Z"}}`+"\n")
	entries, err := LoadOpenclaw(openclawOptions(t, t.TempDir(), &root, nativepricing.ModeCalculate, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want one", entries)
	}
	entry := entries[0]
	if entry.Model != "[openclaw] deepseek-v4-flash" {
		t.Fatalf("model = %q, want the decorated display name", entry.Model)
	}
	if math.Abs(entry.CostUSD-0.44) > 1e-12 {
		t.Fatalf("cost = %v, want the bare model to price at 0.44", entry.CostUSD)
	}
	if entry.SessionID != "abc" || entry.ProjectPath != "OpenClaw" {
		t.Fatalf("entry = %+v", entry)
	}
}

// TestOpenclawDisplayNamePricingWhenTableKnowsIt pins the other half of
// parser.rs:382-387: an exact "[openclaw] model" key prices the decorated name.
func TestOpenclawDisplayNamePricingWhenTableKnowsIt(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "agents", "main", "sessions", "abc.jsonl"),
		`{"type":"message","message":{"role":"assistant","model":"acme-large","usage":{"input":1000,"output":0,"totalTokens":1000},"timestamp":1769753935279}}`+"\n")
	corpus := nativepricing.Corpus{Models: map[string]nativepricing.CorpusModel{
		"[openclaw] acme-large": {Input: 5e-6, Output: 1e-5, CacheRead: 5e-7, CacheCreate: 6e-6, FastMultiplier: 1, FlexMultiplier: 1},
		"acme-large":            {Input: 1e-6, Output: 2e-6, CacheRead: 1e-7, CacheCreate: 1.25e-6, FastMultiplier: 1, FlexMultiplier: 1},
	}}
	entries, err := LoadOpenclaw(openclawOptions(t, t.TempDir(), &root, nativepricing.ModeCalculate, corpus))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || math.Abs(entries[0].CostUSD-0.005) > 1e-12 {
		t.Fatalf("entries = %+v, want the decorated key's 0.005 rate", entries)
	}
}

// TestOpenclawModelChangeUpdatesState pins is_model_change/model_change_source
// (parser.rs:216-241): model and provider records update the tracked state, read
// from the root or from the nested data object, before a later message uses it.
func TestOpenclawModelChangeUpdatesState(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "agents", "main", "sessions", "abc.jsonl"), strings.Join([]string{
		`{"type":"model_change","provider":"openai-codex","modelId":"gpt-5.2"}`,
		`{"type":"message","message":{"role":"assistant","usage":{"input":1660,"output":55,"cacheRead":108928,"cost":{"total":0.02}},"timestamp":1769753935279}}`,
		`{"type":"custom","customType":"model-snapshot","data":{"modelId":"claude-x","provider":"anthropic"}}`,
		`{"type":"message","message":{"role":"assistant","usage":{"input":10,"output":1},"timestamp":1769753935279}}`,
	}, "\n")+"\n")
	entries, err := LoadOpenclaw(openclawOptions(t, t.TempDir(), &root, nativepricing.ModeAuto, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want two", entries)
	}
	if entries[0].Model != "[openclaw] gpt-5.2" || entries[0].Version != "openai-codex" || entries[0].Date != "2026-01-30" {
		t.Fatalf("first entry = %+v", entries[0])
	}
	if entries[0].Usage.CacheRead != 108928 || math.Abs(entries[0].CostUSD-0.02) > 1e-12 {
		t.Fatalf("first entry = %+v, want the reported cache and cost", entries[0])
	}
	if entries[1].Model != "[openclaw] claude-x" || entries[1].Version != "anthropic" {
		t.Fatalf("second entry = %+v, want the nested model-snapshot's state", entries[1])
	}
}

// TestOpenclawMalformedMessageKeepsModelState pins the lenient message
// deserialization (parser.rs:41-46): a non-object message on a model-tracking
// line must not discard the model/provider update.
func TestOpenclawMalformedMessageKeepsModelState(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "agents", "main", "sessions", "abc.jsonl"), strings.Join([]string{
		`{"type":"model_change","modelId":"gpt-5.2","provider":"openai","message":"not-an-object"}`,
		`{"type":"message","message":{"role":"assistant","usage":{"input":10,"output":20}}}`,
	}, "\n")+"\n")
	entries, err := LoadOpenclaw(openclawOptions(t, t.TempDir(), &root, nativepricing.ModeAuto, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want one", entries)
	}
	if entries[0].Model != "[openclaw] gpt-5.2" || entries[0].Version != "openai" {
		t.Fatalf("entry = %+v, want the tracked model and provider", entries[0])
	}
}

// TestOpenclawExtraIsMaxTotalMinusBuckets pins the total_tokens clamp
// (parser.rs:295-306, 405-410): extra is the reported total above the bucket
// sum, and a total below the buckets adds nothing.
func TestOpenclawExtraIsMaxTotalMinusBuckets(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "agents", "main", "sessions", "abc.jsonl"), strings.Join([]string{
		`{"type":"message","message":{"role":"assistant","model":"gpt-5.2","usage":{"input":100,"output":50,"totalTokens":200},"timestamp":1769753935279}}`,
		`{"type":"message","message":{"role":"assistant","model":"gpt-5.2","usage":{"input":100,"output":50,"totalTokens":120},"timestamp":1769753935280}}`,
	}, "\n")+"\n")
	entries, err := LoadOpenclaw(openclawOptions(t, t.TempDir(), &root, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want two", entries)
	}
	if entries[0].Usage.Extra != 50 || entries[0].Usage.Total() != 200 {
		t.Fatalf("first usage = %+v, want 50 extra tokens", entries[0].Usage)
	}
	if entries[1].Usage.Extra != 0 || entries[1].Usage.Total() != 150 {
		t.Fatalf("second usage = %+v, want no extra tokens", entries[1].Usage)
	}
}

// TestOpenclawTimestampScalarOrRFC3339ThenMtime pins timestamp_from_value
// (parser.rs:420-441): integer milliseconds, then the strict RFC3339 gate, then
// the file mtime as the fallback.
func TestOpenclawTimestampScalarOrRFC3339ThenMtime(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "agents", "main", "sessions", "scalar.jsonl"),
		`{"type":"message","message":{"role":"assistant","model":"m","usage":{"input":1},"timestamp":1769753935279}}`+"\n")
	writeFile(t, filepath.Join(root, "agents", "main", "sessions", "rfc3339.jsonl"),
		`{"type":"message","message":{"role":"assistant","model":"m","usage":{"input":1},"timestamp":"2026-02-03T04:05:06Z"}}`+"\n")
	writeFile(t, filepath.Join(root, "agents", "main", "sessions", "rootlevel.jsonl"),
		`{"type":"message","timestamp":1769753935279,"message":{"role":"assistant","model":"m","usage":{"input":1}}}`+"\n")
	writeFile(t, filepath.Join(root, "agents", "main", "sessions", "mtime.jsonl"),
		`{"type":"message","message":{"role":"assistant","model":"m","usage":{"input":1}}}`+"\n")
	mtime := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	if err := os.Chtimes(filepath.Join(root, "agents", "main", "sessions", "mtime.jsonl"), mtime, mtime); err != nil {
		t.Fatal(err)
	}
	entries, err := LoadOpenclaw(openclawOptions(t, t.TempDir(), &root, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 4 {
		t.Fatalf("entries = %+v, want four", entries)
	}
	want := map[string]string{
		"scalar":    "2026-01-30",
		"rfc3339":   "2026-02-03",
		"rootlevel": "2026-01-30",
		"mtime":     "2026-03-04",
	}
	for _, entry := range entries {
		if entry.Date != want[entry.SessionID] {
			t.Fatalf("session %q date = %q, want %q", entry.SessionID, entry.Date, want[entry.SessionID])
		}
	}
}

// TestOpenclawSqliteReplacesJsonlBySessionAndMessage pins the loader merge
// (loader.rs:71-99): a SQLite-era transcript row replaces the migrated JSONL
// copy of the same event, and its provider-billed cost wins.
func TestOpenclawSqliteReplacesJsonlBySessionAndMessage(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "agents", "main", "sessions", "session.jsonl"),
		`{"type":"message","message":{"role":"assistant","model":"gpt-5.2","usage":{"input":10,"output":20,"cost":{"total":0.50}},"timestamp":1769753935279}}`+"\n")
	seedOpenclawAgentDatabase(t, root, "main", [][2]string{{
		"session",
		`{"id":"evt-sqlite","type":"message","message":{"role":"assistant","model":"gpt-5.2","usage":{"input":10,"output":20,"cost":{"total":0.51}},"timestamp":1769753935279}}`,
	}})
	entries, err := LoadOpenclaw(openclawOptions(t, t.TempDir(), &root, nativepricing.ModeAuto, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want the SQLite row to replace its JSONL duplicate", entries)
	}
	if entries[0].MessageID != "evt-sqlite" {
		t.Fatalf("message id = %q, want the SQLite event id", entries[0].MessageID)
	}
	if math.Abs(entries[0].CostUSD-0.51) > 1e-12 {
		t.Fatalf("cost = %v, want the provider-billed SQLite cost", entries[0].CostUSD)
	}
}

// TestOpenclawSqliteOnlyLoadsWhenNoJsonlExists pins the SQLite path standing on
// its own (sqlite.rs:80-178), including model-change tracking inside the store.
func TestOpenclawSqliteOnlyLoadsWhenNoJsonlExists(t *testing.T) {
	root := t.TempDir()
	seedOpenclawAgentDatabase(t, root, "main", [][2]string{
		{"session-sqlite", `{"id":"evt-1","type":"model_change","modelId":"deepseek-v4-flash","provider":"deepseek"}`},
		{"session-sqlite", `{"id":"evt-2","type":"message","message":{"role":"assistant","usage":{"input":100,"output":50,"cost":{"total":1.80}},"timestamp":1769753935279}}`},
		{"session-sqlite", `not-json`},
	})
	entries, err := LoadOpenclaw(openclawOptions(t, t.TempDir(), &root, nativepricing.ModeAuto, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want the one assistant event", entries)
	}
	entry := entries[0]
	if entry.SessionID != "session-sqlite" || entry.Model != "[openclaw] deepseek-v4-flash" || entry.Version != "deepseek" {
		t.Fatalf("entry = %+v", entry)
	}
	if math.Abs(entry.CostUSD-1.80) > 1e-12 || entry.MessageID != "evt-2" {
		t.Fatalf("entry = %+v, want the reported cost and event id", entry)
	}
}

// TestOpenclawSqliteWithoutTranscriptEventsIsIgnored pins table_exists
// (sqlite.rs:180-190).
func TestOpenclawSqliteWithoutTranscriptEventsIsIgnored(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "agents", "main", "agent")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(dir, "openclaw-agent.sqlite")))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`CREATE TABLE unrelated (id TEXT)`); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	entries, err := LoadOpenclaw(openclawOptions(t, t.TempDir(), &root, nativepricing.ModeAuto, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("entries = %+v, want none", entries)
	}
}

// TestOpenclawCollectsArchivedSessionFiles pins is_openclaw_session_file and
// extract_session_id (paths.rs:44-97, parser.rs:443-457).
func TestOpenclawCollectsArchivedSessionFiles(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{
		"plain.jsonl",
		"archived.jsonl.deleted.1700000000000",
		"reset.jsonl.reset.2026-03-20T06-34-44.520Z",
		"ignored.json",
	} {
		writeFile(t, filepath.Join(root, "agents", "main", "sessions", name),
			`{"type":"message","message":{"role":"assistant","model":"m","usage":{"input":1},"timestamp":1769753935279}}`+"\n")
	}
	entries, err := LoadOpenclaw(openclawOptions(t, t.TempDir(), &root, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 {
		t.Fatalf("entries = %+v, want three session files", entries)
	}
	sessions := map[string]bool{}
	for _, entry := range entries {
		sessions[entry.SessionID] = true
	}
	for _, want := range []string{"plain", "archived", "reset"} {
		if !sessions[want] {
			t.Fatalf("sessions = %v, want %q", sessions, want)
		}
	}
}

// TestOpenclawSessionRowsCarryActivity pins the rich session metadata
// (parser.rs:312-325 with SessionAccumulator, summary.rs:126-170).
func TestOpenclawSessionRowsCarryActivity(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "agents", "main", "sessions", "abc.jsonl"), strings.Join([]string{
		`{"type":"message","message":{"role":"assistant","model":"m","usage":{"input":1},"timestamp":1769753935279}}`,
		`{"type":"message","message":{"role":"assistant","model":"m","usage":{"input":1},"timestamp":1769753000000}}`,
	}, "\n")+"\n")
	entries, err := LoadOpenclaw(openclawOptions(t, t.TempDir(), &root, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	rows, _ := Summarize(entries, Session)
	if len(rows) != 1 {
		t.Fatalf("rows = %+v, want one session row", rows)
	}
	if rows[0].Key != "abc" || rows[0].ProjectPath != "OpenClaw" {
		t.Fatalf("row = %+v", rows[0])
	}
	if rows[0].FirstActivity != 1769753000000 || rows[0].LastActivity != 1769753935279 {
		t.Fatalf("activity = %d..%d", rows[0].FirstActivity, rows[0].LastActivity)
	}
}

// TestOpenclawDedupesRepeatedRecords pins entry_id's content identity
// (parser.rs:469-491): identical records collapse, and a differing cost keeps
// both because the cost is part of the identity.
func TestOpenclawDedupesRepeatedRecords(t *testing.T) {
	root := t.TempDir()
	line := `{"type":"message","message":{"role":"assistant","model":"gpt-5.2","usage":{"input":1,"output":1,"cost":{"total":0.5}},"timestamp":1769753935279}}`
	writeFile(t, filepath.Join(root, "agents", "main", "sessions", "session.jsonl"), line+"\n"+line+"\n")
	entries, err := LoadOpenclaw(openclawOptions(t, t.TempDir(), &root, nativepricing.ModeAuto, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want one", entries)
	}
}

// TestOpenclawRootsPreferEnvThenDefaults pins paths() (paths.rs:11-42): a
// non-blank OPENCLAW_DIR is the only root, a blank one falls back to the four
// default directories that exist.
func TestOpenclawRootsPreferEnvThenDefaults(t *testing.T) {
	envRoot := t.TempDir()
	writeFile(t, filepath.Join(envRoot, "agents", "main", "sessions", "env.jsonl"),
		`{"type":"message","message":{"role":"assistant","model":"m","usage":{"input":1},"timestamp":1769753935279}}`+"\n")
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".openclaw", "agents", "main", "sessions", "default.jsonl"),
		`{"type":"message","message":{"role":"assistant","model":"m","usage":{"input":1},"timestamp":1769753935279}}`+"\n")
	writeFile(t, filepath.Join(home, ".clawdbot", "agents", "main", "sessions", "clawdbot.jsonl"),
		`{"type":"message","message":{"role":"assistant","model":"m","usage":{"input":1},"timestamp":1769753935279}}`+"\n")

	entries, err := LoadOpenclaw(openclawOptions(t, home, &envRoot, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].SessionID != "env" {
		t.Fatalf("entries = %+v, want only the env root", entries)
	}

	blank := "   "
	entries, err = LoadOpenclaw(openclawOptions(t, home, &blank, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want both default roots", entries)
	}
}

// TestOpenclawSkipsNonAssistantAndBadUsage pins the message gates
// (parser.rs:274-281, 296): non-assistant roles, lines without usage, and
// zero-token usage add nothing.
func TestOpenclawSkipsNonAssistantAndBadUsage(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "agents", "main", "sessions", "session.jsonl"), strings.Join([]string{
		`{"type":"message","message":{"role":"user","usage":{"input":100}},"timestamp":1769753935279}`,
		`{"type":"message","message":{"role":"assistant"},"timestamp":1769753935279}`,
		`{"type":"message","message":{"role":"assistant","usage":{"input":0,"output":0}},"timestamp":1769753935279}`,
		`not-json`,
		`{"type":"message","message":{"role":"assistant","model":"m","usage":{"input":5}},"timestamp":1769753935279}`,
	}, "\n")+"\n")
	entries, err := LoadOpenclaw(openclawOptions(t, t.TempDir(), &root, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Usage.Input != 5 {
		t.Fatalf("entries = %+v, want only the valid assistant record", entries)
	}
}
