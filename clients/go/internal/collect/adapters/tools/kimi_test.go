package tools

// The Kimi adapter's rules, pinned against ccusage v20.0.33 (commit 1308c416):
// rust/adapters/kimi/src/{paths,parser,loader}.rs.

import (
	"fmt"
	"path/filepath"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

func kimiOptions(t *testing.T, root string, mode nativepricing.CostMode) Options {
	t.Helper()
	return Options{
		Env: func(key string) (string, bool) {
			if key == "KIMI_DATA_DIR" {
				return root, true
			}
			return "", false
		},
		Timezone: "UTC",
		Mode:     mode,
		Corpus:   testCorpus(t),
	}
}

// kimiStatusUpdate renders an old-format wire line (message.type StatusUpdate).
func kimiStatusUpdate(seconds float64, messageID string, input, output, cacheCreation, cacheRead, total uint64) string {
	return fmt.Sprintf(
		`{"timestamp":%v,"message":{"type":"StatusUpdate","payload":{"token_usage":{"input_other":%d,"output":%d,"input_cache_creation":%d,"input_cache_read":%d,"total":%d},"message_id":%q}}}`,
		seconds, input, output, cacheCreation, cacheRead, total, messageID,
	)
}

// TestKimiWireDepthAcceptance pins is_kimi_wire_file (paths.rs:58-74): only
// files named wire.jsonl whose path relative to sessions has exactly 3 or 5
// normal components are read (old and new layouts).
func TestKimiWireDepthAcceptance(t *testing.T) {
	root := t.TempDir()
	sec := float64(1770983426.5)
	writeFile(t, filepath.Join(root, "sessions", "group", "old-session", "wire.jsonl"),
		kimiStatusUpdate(sec, "m-old", 10, 1, 0, 0, 0))
	writeFile(t, filepath.Join(root, "sessions", "ws", "new-session", "agents", "agent-1", "wire.jsonl"),
		kimiStatusUpdate(sec+1, "m-new", 10, 1, 0, 0, 0))
	writeFile(t, filepath.Join(root, "sessions", "a", "b", "c", "deep-session", "wire.jsonl"),
		kimiStatusUpdate(sec+2, "m-deep", 10, 1, 0, 0, 0))
	// Rejected: wrong file name, four components, two components.
	writeFile(t, filepath.Join(root, "sessions", "group", "old-session", "other.jsonl"),
		kimiStatusUpdate(sec+3, "m-other", 10, 1, 0, 0, 0))
	writeFile(t, filepath.Join(root, "sessions", "nested", "path", "session", "wire.jsonl"),
		kimiStatusUpdate(sec+4, "m-nested", 10, 1, 0, 0, 0))
	writeFile(t, filepath.Join(root, "sessions", "group", "wire.jsonl"),
		kimiStatusUpdate(sec+5, "m-shallow", 10, 1, 0, 0, 0))

	entries, err := LoadKimi(kimiOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 {
		t.Fatalf("entries = %+v, want the three accepted wire files", entries)
	}
	sessions := map[string]bool{}
	for _, entry := range entries {
		sessions[entry.SessionID] = true
	}
	for _, want := range []string{"old-session", "new-session", "deep-session"} {
		if !sessions[want] {
			t.Fatalf("sessions = %+v, want %q", sessions, want)
		}
	}
}

// TestKimiOldStatusUpdateMapping pins wire_line_to_entry_old (parser.rs:235-275):
// snake_case token_usage keys, a float-seconds timestamp truncated to
// milliseconds, the message id, and the leftover total folded into extra.
func TestKimiOldStatusUpdateMapping(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "config.json"), `{"model":"kimi-k2"}`)
	writeFile(t, filepath.Join(root, "sessions", "group", "session-a", "wire.jsonl"),
		kimiStatusUpdate(1770983426.420942, "msg-1", 100, 50, 20, 10, 200))

	entries, err := LoadKimi(kimiOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v", entries)
	}
	entry := entries[0]
	want := Usage{Input: 100, Output: 50, CacheCreation: 20, CacheRead: 10, Extra: 20}
	if entry.Usage != want {
		t.Fatalf("usage = %+v, want %+v", entry.Usage, want)
	}
	if entry.Timestamp != 1770983426420 || entry.Date != "2026-02-13" {
		t.Fatalf("timestamp = %d date = %q", entry.Timestamp, entry.Date)
	}
	if entry.SessionID != "session-a" || entry.Model != "kimi-k2" || entry.MessageID != "msg-1" {
		t.Fatalf("entry = %+v", entry)
	}
}

// TestKimiNewUsageRecordSkipsSessionScope pins wire_line_to_entry_new
// (parser.rs:190-233): only usageScope=="turn" records count, `time` is already
// milliseconds, the kimi-code/ prefix is stripped from the display model, and
// the default model fills in when the line carries none.
func TestKimiNewUsageRecordSkipsSessionScope(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "sessions", "workspace", "session-b", "agents", "agent-1", "wire.jsonl"),
		`{"type":"usage.record","model":"kimi-code/kimi-for-coding","usage":{"inputOther":3064,"output":76,"inputCacheRead":14848,"inputCacheCreation":0},"usageScope":"turn","time":1782113184943}
{"type":"usage.record","model":"kimi-code/kimi-for-coding","usage":{"inputOther":5000,"output":200,"inputCacheRead":20000,"inputCacheCreation":100},"usageScope":"session","time":1782113185000}
{"type":"usage.record","model":"kimi-code/kimi-for-coding","usage":{"inputOther":7000,"output":300,"inputCacheRead":1,"inputCacheCreation":0},"time":1782113186000}`)

	entries, err := LoadKimi(kimiOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want only the turn-scoped record", entries)
	}
	entry := entries[0]
	if entry.Model != "kimi-for-coding" || entry.SessionID != "session-b" {
		t.Fatalf("entry = %+v, want the stripped model and session directory", entry)
	}
	want := Usage{Input: 3064, Output: 76, CacheRead: 14848}
	if entry.Usage != want {
		t.Fatalf("usage = %+v, want %+v", entry.Usage, want)
	}
	if entry.Timestamp != 1782113184943 || entry.Date != "2026-06-22" {
		t.Fatalf("timestamp = %d date = %q", entry.Timestamp, entry.Date)
	}
}

// TestKimiModelK25K26TimeSwitchKeepsDisplayName pins model_candidates and
// kimi_for_coding_pricing_model (parser.rs:415-436): the default model is priced
// as moonshot/kimi-k2.5 before the cutoff and moonshot/kimi-k2.6 from it on,
// while the reported model name never changes.
func TestKimiModelK25K26TimeSwitchKeepsDisplayName(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "sessions", "g", "before", "wire.jsonl"),
		`{"type":"usage.record","usage":{"inputOther":100,"output":50,"inputCacheRead":10,"inputCacheCreation":20},"usageScope":"turn","time":1776698890071}`)
	writeFile(t, filepath.Join(root, "sessions", "g", "after", "wire.jsonl"),
		`{"type":"usage.record","usage":{"inputOther":100,"output":50,"inputCacheRead":10,"inputCacheCreation":20},"usageScope":"turn","time":1776698890072}`)

	entries, err := LoadKimi(kimiOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v", entries)
	}
	corpus := testCorpus(t)
	billed := nativepricing.Usage{Input: 100, Output: 50, CacheCreate5m: 20, CacheRead: 10}
	k25, ok := corpus.Find("moonshot/kimi-k2.5")
	if !ok {
		t.Fatal("missing moonshot/kimi-k2.5 pricing")
	}
	k26, ok := corpus.Find("moonshot/kimi-k2.6")
	if !ok {
		t.Fatal("missing moonshot/kimi-k2.6 pricing")
	}
	if want := nativepricing.CostFromPricing(billed, k25, false); entries[0].CostUSD != want {
		t.Fatalf("before-cutoff cost = %v, want the k2.5 rate %v", entries[0].CostUSD, want)
	}
	if want := nativepricing.CostFromPricing(billed, k26, false); entries[1].CostUSD != want {
		t.Fatalf("at-cutoff cost = %v, want the k2.6 rate %v", entries[1].CostUSD, want)
	}
	for _, entry := range entries {
		if entry.Model != "kimi-for-coding" {
			t.Fatalf("model = %q, want the display name unchanged", entry.Model)
		}
	}
}

// TestKimiExtraTokensAreNotBilled pins calculate_kimi_cost (parser.rs:372-396):
// the cost usage is built from the four named buckets only, so a total-token
// leftover stays in the report's extra bucket but never enters the price.
func TestKimiExtraTokensAreNotBilled(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "config.json"), `{"model":"kimi-k2.5"}`)
	writeFile(t, filepath.Join(root, "sessions", "g", "s", "wire.jsonl"),
		kimiStatusUpdate(1770983426.5, "msg", 100, 50, 0, 0, 500))

	entries, err := LoadKimi(kimiOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v", entries)
	}
	if entries[0].Usage.Extra != 350 {
		t.Fatalf("extra = %d, want the 350-token total leftover", entries[0].Usage.Extra)
	}
	pricing, ok := testCorpus(t).Find("moonshot/kimi-k2.5")
	if !ok {
		t.Fatal("missing moonshot/kimi-k2.5 pricing")
	}
	want := nativepricing.CostFromPricing(nativepricing.Usage{Input: 100, Output: 50}, pricing, false)
	if entries[0].CostUSD != want {
		t.Fatalf("cost = %v, want %v (extra not billed)", entries[0].CostUSD, want)
	}
}

// TestKimiDuplicateWireLinesFirstWins pins kimi_entry_key (parser.rs:310-323)
// and the loader's sequential first-wins dedup (loader.rs:33-47): the key is the
// nine-part tuple, so two session directories with the same name and identical
// lines collapse to one entry while a different message id survives.
func TestKimiDuplicateWireLinesFirstWins(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "sessions", "group1", "s", "wire.jsonl"),
		kimiStatusUpdate(1770983426.5, "msg-1", 10, 2, 3, 4, 0))
	writeFile(t, filepath.Join(root, "sessions", "group2", "s", "wire.jsonl"),
		kimiStatusUpdate(1770983426.5, "msg-1", 10, 2, 3, 4, 0))
	writeFile(t, filepath.Join(root, "sessions", "group2", "t", "wire.jsonl"),
		kimiStatusUpdate(1770983426.5, "msg-2", 10, 2, 3, 4, 0))

	entries, err := LoadKimi(kimiOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want the duplicate collapsed", entries)
	}
	seen := map[string]int{}
	for _, entry := range entries {
		seen[entry.SessionID]++
	}
	if seen["s"] != 1 || seen["t"] != 1 {
		t.Fatalf("sessions = %+v, want one entry per distinct key", seen)
	}
}

// TestKimiBadLinesAreSkipped pins read_wire_file's per-line tolerance
// (parser.rs:121-130): a malformed line and a zero-token StatusUpdate are both
// dropped without failing the file (the Rust fixture in loader.rs:115-127).
func TestKimiBadLinesAreSkipped(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "sessions", "group", "session-a", "wire.jsonl"),
		"not json\n"+`{"timestamp":1770983427,"message":{"type":"StatusUpdate","payload":{"token_usage":{"input_other":0,"output":0,"input_cache_read":0,"input_cache_creation":0}}}}`)

	entries, err := LoadKimi(kimiOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("entries = %+v, want none", entries)
	}
}

// TestKimiConfigRootDerivedFromDepth pins read_model_from_config and
// kimi_root_from_wire_path (parser.rs:132-165): the config.json sits at the
// discovered root for both layouts, and an unreadable or model-less config falls
// back to kimi-for-coding.
func TestKimiConfigRootDerivedFromDepth(t *testing.T) {
	t.Run("both layouts read the root config", func(t *testing.T) {
		root := t.TempDir()
		writeFile(t, filepath.Join(root, "config.json"), `{"model":"kimi-k2"}`)
		// A config nested inside a session directory must not be consulted.
		writeFile(t, filepath.Join(root, "sessions", "ws", "new-session", "config.json"), `{"model":"decoy"}`)
		writeFile(t, filepath.Join(root, "sessions", "g", "old-session", "wire.jsonl"),
			kimiStatusUpdate(1770983426.5, "m-old", 10, 1, 0, 0, 0))
		writeFile(t, filepath.Join(root, "sessions", "ws", "new-session", "agents", "a1", "wire.jsonl"),
			kimiStatusUpdate(1770983427.5, "m-new", 10, 1, 0, 0, 0))

		entries, err := LoadKimi(kimiOptions(t, root, nativepricing.ModeAuto))
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 2 {
			t.Fatalf("entries = %+v", entries)
		}
		for _, entry := range entries {
			if entry.Model != "kimi-k2" {
				t.Fatalf("model = %q, want the root config", entry.Model)
			}
		}
	})

	t.Run("bad config falls back to the default model", func(t *testing.T) {
		root := t.TempDir()
		writeFile(t, filepath.Join(root, "config.json"), `{"model":`)
		writeFile(t, filepath.Join(root, "sessions", "g", "s", "wire.jsonl"),
			kimiStatusUpdate(1770983426.5, "m", 10, 1, 0, 0, 0))

		entries, err := LoadKimi(kimiOptions(t, root, nativepricing.ModeAuto))
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 1 || entries[0].Model != "kimi-for-coding" {
			t.Fatalf("entries = %+v, want the default model", entries)
		}
	})
}
