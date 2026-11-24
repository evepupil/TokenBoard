package tools

// The Gemini CLI adapter's rules, pinned against ccusage v20.0.33 (commit
// 1308c416): rust/adapters/gemini/src/parser.rs.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

func geminiOptions(t *testing.T, root string, mode nativepricing.CostMode) Options {
	t.Helper()
	return geminiOptionsWith(t, root, mode, testCorpus(t))
}

func geminiOptionsWith(t *testing.T, root string, mode nativepricing.CostMode, corpus nativepricing.Corpus) Options {
	t.Helper()
	return Options{
		Env: func(key string) (string, bool) {
			if key == "GEMINI_DATA_DIR" {
				return root, true
			}
			return "", false
		},
		Timezone: "UTC",
		Mode:     mode,
		Corpus:   corpus,
	}
}

// TestGeminiJSONLStateMachineInheritsSessionAndModel pins parse_jsonl_file
// (parser.rs:165-219): a sessionId line and a model line set the state every
// later line inherits, and a repeated direct-event id replaces the earlier
// event in place instead of appending.
func TestGeminiJSONLStateMachineInheritsSessionAndModel(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "project", "chats", "stem.jsonl"), strings.Join([]string{
		`{"sessionId":"session-a","startTime":"2026-05-17T11:07:00.000Z"}`,
		`{"model":"gemini-3-flash-preview"}`,
		`{"id":"m1","timestamp":"2026-05-17T11:07:32.000Z","type":"gemini","tokens":{"input":100,"output":10}}`,
		`{"id":"m1","timestamp":"2026-05-17T11:08:00.000Z","type":"gemini","tokens":{"input":200,"output":20}}`,
		`{"timestamp":"2026-05-17T11:09:00.000Z","type":"gemini","tokens":{"input":5,"output":1}}`,
	}, "\n"))

	entries, err := LoadGemini(geminiOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want the replaced event plus the id-less one", entries)
	}
	replaced := entries[0]
	if replaced.SessionID != "session-a" || replaced.Model != "gemini-3-flash-preview" {
		t.Fatalf("entry = %+v, want the inherited session and model", replaced)
	}
	if replaced.Usage.Input != 200 || replaced.Usage.Output != 20 {
		t.Fatalf("usage = %+v, want the later event's tokens (in-place replacement)", replaced.Usage)
	}
	if !time.UnixMilli(replaced.Timestamp).Equal(time.Date(2026, 5, 17, 11, 8, 0, 0, time.UTC)) {
		t.Fatalf("timestamp = %d, want the replacing event's timestamp", replaced.Timestamp)
	}
	appended := entries[1]
	if appended.Usage.Input != 5 || appended.Model != "gemini-3-flash-preview" || appended.SessionID != "session-a" {
		t.Fatalf("entry = %+v, want the appended event inheriting both", appended)
	}
}

// TestGeminiJSONMessagesShareSessionTimestamp pins the whole-file messages
// branch (parser.rs:115-145): only type=="gemini" messages are read, each
// inherits startTime as its fallback timestamp, and a per-message timestamp
// wins over it.
func TestGeminiJSONMessagesShareSessionTimestamp(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "project", "chats", "thread.json"), `{
		"startTime": "2026-05-17T11:07:00.000Z",
		"messages": [
			{"type": "user", "text": "hi"},
			{"type": "gemini", "model": "gemini-2.5-pro", "tokens": {"input": 100, "output": 10}},
			{"type": "gemini", "model": "gemini-2.5-pro", "timestamp": "2026-05-18T00:00:00Z", "tokens": {"input": 5, "output": 1}}
		]
	}`)

	entries, err := LoadGemini(geminiOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want the two gemini messages", entries)
	}
	if !time.UnixMilli(entries[0].Timestamp).Equal(time.Date(2026, 5, 17, 11, 7, 0, 0, time.UTC)) {
		t.Fatalf("timestamp = %d, want the session startTime", entries[0].Timestamp)
	}
	if entries[0].Date != "2026-05-17" || entries[0].SessionID != "thread" {
		t.Fatalf("entry = %+v, want the file-stem session and startTime date", entries[0])
	}
	if entries[1].Date != "2026-05-18" {
		t.Fatalf("entry = %+v, want the message's own timestamp to win", entries[1])
	}
}

// TestGeminiStatsPathNormalizesCachedIntoInput pins parse_stats_events
// (parser.rs:271-313) and subtract_cached_overlap_tokens (parser.rs:400-404):
// the stats path always subtracts the cached overlap, reads result.stats when
// the top-level block is absent, and expands a models map in sorted key order.
func TestGeminiStatsPathNormalizesCachedIntoInput(t *testing.T) {
	t.Run("top-level stats", func(t *testing.T) {
		root := t.TempDir()
		writeFile(t, filepath.Join(root, "chats", "s.json"), `{
			"model": "gemini-2.5-pro",
			"timestamp": "2026-01-02T03:04:05Z",
			"stats": {"input": 1000, "cached": 400, "output": 50}
		}`)
		entries, err := LoadGemini(geminiOptions(t, root, nativepricing.ModeAuto))
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 1 {
			t.Fatalf("entries = %+v, want one", entries)
		}
		if entries[0].Usage.Input != 600 || entries[0].Usage.CacheRead != 400 || entries[0].Usage.Output != 50 {
			t.Fatalf("usage = %+v, want input 1000-400, cached 400, output 50", entries[0].Usage)
		}
		if entries[0].Model != "gemini-2.5-pro" || entries[0].Date != "2026-01-02" {
			t.Fatalf("entry = %+v", entries[0])
		}
	})

	t.Run("result.stats", func(t *testing.T) {
		root := t.TempDir()
		writeFile(t, filepath.Join(root, "chats", "s.json"), `{
			"model": "m",
			"timestamp": "2026-01-02T03:04:05Z",
			"result": {"stats": {"input": 10, "cached": 4}}
		}`)
		entries, err := LoadGemini(geminiOptions(t, root, nativepricing.ModeAuto))
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 1 || entries[0].Usage.Input != 6 || entries[0].Usage.CacheRead != 4 {
			t.Fatalf("entries = %+v, want the nested stats block normalised", entries)
		}
	})

	t.Run("models map", func(t *testing.T) {
		root := t.TempDir()
		writeFile(t, filepath.Join(root, "chats", "s.json"), `{
			"timestamp": "2026-01-02T03:04:05Z",
			"stats": {"models": {
				"gemini-2.5-pro": {"tokens": {"input": 100, "cached": 40, "output": 10}},
				"gemini-2.5-flash": {"tokens": {"input": 50, "output": 5}}
			}}
		}`)
		entries, err := LoadGemini(geminiOptions(t, root, nativepricing.ModeAuto))
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 2 {
			t.Fatalf("entries = %+v, want one per model", entries)
		}
		// serde_json's map iterates in key order, and both events share the
		// stats timestamp, so the stable sort keeps flash first.
		if entries[0].Model != "gemini-2.5-flash" || entries[1].Model != "gemini-2.5-pro" {
			t.Fatalf("models = %q, %q, want sorted key order", entries[0].Model, entries[1].Model)
		}
		if entries[1].Usage.Input != 60 || entries[1].Usage.CacheRead != 40 {
			t.Fatalf("usage = %+v, want the cached overlap subtracted", entries[1].Usage)
		}
	})
}

// TestGeminiDirectEventSubtractsToolFromCachedHeuristic pins build_event and
// normalize_session_input (parser.rs:315-416): when the reported total equals
// the cached-inclusive sum the cached overlap is separated out, tool tokens are
// added to input afterwards, and thoughts become the extra bucket.
func TestGeminiDirectEventSubtractsToolFromCachedHeuristic(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "project", "chats", "session-a.jsonl"), strings.Join([]string{
		`{"sessionId":"session-a"}`,
		`{"id":"msg-a","timestamp":"2026-05-17T11:07:32.000Z","type":"gemini","model":"gemini-3-flash-preview","tokens":{"input":15327,"output":23,"cached":11526,"thoughts":919,"tool":7,"total":16276}}`,
		`{"id":"msg-b","timestamp":"2026-05-17T11:08:32.000Z","type":"gemini","model":"gemini-3-flash-preview","tokens":{"input":100,"output":20,"cached":40,"thoughts":5,"tool":3,"total":168}}`,
	}, "\n"))

	entries, err := LoadGemini(geminiOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want two", entries)
	}
	heuristic := entries[0]
	if heuristic.Usage.Input != 3808 || heuristic.Usage.Output != 23 ||
		heuristic.Usage.CacheRead != 11526 || heuristic.Usage.Extra != 919 {
		t.Fatalf("usage = %+v, want 15327-11526+7 input and thoughts as extra", heuristic.Usage)
	}
	// The second total is not the cached-inclusive sum, so input is left alone
	// and only the tool tokens are added.
	plain := entries[1]
	if plain.Usage.Input != 103 || plain.Usage.CacheRead != 40 || plain.Usage.Extra != 5 {
		t.Fatalf("usage = %+v, want the un-normalised input plus tool tokens", plain.Usage)
	}
}

// TestGeminiReportExtraIsRecomputedFromTotal pins event_to_loaded
// (parser.rs:455-462): the report's extra bucket is total - (input + output +
// cache read), not the fallback's thoughts, while the billed output keeps
// output + the fallback extra. A total below the named buckets therefore
// reports zero extra but still bills the reasoning tokens.
func TestGeminiReportExtraIsRecomputedFromTotal(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "chats", "a.jsonl"),
		`{"id":"m","timestamp":"2026-01-02T03:04:05Z","type":"gemini","model":"gemini-test","tokens":{"input":100,"output":50,"thoughts":5,"total":100}}`)

	corpus := nativepricing.Corpus{Models: map[string]nativepricing.CorpusModel{
		"google/gemini-test": {Input: 1e-6, Output: 2e-6},
	}}
	entries, err := LoadGemini(geminiOptionsWith(t, root, nativepricing.ModeAuto, corpus))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v", entries)
	}
	if entries[0].Usage.Extra != 0 {
		t.Fatalf("extra = %d, want the recomputed total-minus-buckets zero", entries[0].Usage.Extra)
	}
	pricing, _ := corpus.Find("google/gemini-test")
	want := nativepricing.CostFromPricing(nativepricing.Usage{Input: 100, Output: 55}, pricing, false)
	if entries[0].CostUSD != want {
		t.Fatalf("cost = %v, want %v (output + fallback extra)", entries[0].CostUSD, want)
	}
}

// TestGeminiModelCandidatesFirstMatchWins pins model_candidates
// (parser.rs:540-551): google/, gemini/, vertex_ai/, openrouter/google/ then the
// bare name, with the first resolvable candidate pricing the entry.
func TestGeminiModelCandidatesFirstMatchWins(t *testing.T) {
	writeLine := func(t *testing.T, root string) {
		t.Helper()
		writeFile(t, filepath.Join(root, "chats", "a.jsonl"),
			`{"id":"m","timestamp":"2026-01-02T03:04:05Z","type":"gemini","model":"gemini-test","tokens":{"input":1000,"output":100}}`)
	}
	rates := func(input, output float64) nativepricing.CorpusModel {
		return nativepricing.CorpusModel{Input: input, Output: output}
	}

	t.Run("google prefix wins over the bare name", func(t *testing.T) {
		root := t.TempDir()
		writeLine(t, root)
		corpus := nativepricing.Corpus{Models: map[string]nativepricing.CorpusModel{
			"google/gemini-test": rates(1e-6, 2e-6),
			"gemini-test":        rates(1e-2, 2e-2),
		}}
		entries, err := LoadGemini(geminiOptionsWith(t, root, nativepricing.ModeAuto, corpus))
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 1 {
			t.Fatalf("entries = %+v", entries)
		}
		pricing, _ := corpus.Find("google/gemini-test")
		want := nativepricing.CostFromPricing(nativepricing.Usage{Input: 1000, Output: 100}, pricing, false)
		if entries[0].CostUSD != want {
			t.Fatalf("cost = %v, want the google/ rate %v", entries[0].CostUSD, want)
		}
	})

	t.Run("second prefix wins when google is absent", func(t *testing.T) {
		root := t.TempDir()
		writeLine(t, root)
		// No bare entry: the only way this prices is through the gemini/ prefix.
		corpus := nativepricing.Corpus{Models: map[string]nativepricing.CorpusModel{
			"gemini/gemini-test": rates(3e-6, 4e-6),
		}}
		entries, err := LoadGemini(geminiOptionsWith(t, root, nativepricing.ModeAuto, corpus))
		if err != nil {
			t.Fatal(err)
		}
		pricing, _ := corpus.Find("gemini/gemini-test")
		want := nativepricing.CostFromPricing(nativepricing.Usage{Input: 1000, Output: 100}, pricing, false)
		if len(entries) != 1 || entries[0].CostUSD != want {
			t.Fatalf("entries = %+v, want the gemini/ rate %v", entries, want)
		}
	})

	t.Run("bare name is the last resort", func(t *testing.T) {
		root := t.TempDir()
		writeLine(t, root)
		corpus := nativepricing.Corpus{Models: map[string]nativepricing.CorpusModel{
			"gemini-test": rates(1e-2, 2e-2),
		}}
		entries, err := LoadGemini(geminiOptionsWith(t, root, nativepricing.ModeAuto, corpus))
		if err != nil {
			t.Fatal(err)
		}
		pricing, _ := corpus.Find("gemini-test")
		want := nativepricing.CostFromPricing(nativepricing.Usage{Input: 1000, Output: 100}, pricing, false)
		if len(entries) != 1 || entries[0].CostUSD != want {
			t.Fatalf("entries = %+v, want the bare rate %v", entries, want)
		}
	})

	t.Run("display mode prices nothing", func(t *testing.T) {
		root := t.TempDir()
		writeLine(t, root)
		corpus := nativepricing.Corpus{Models: map[string]nativepricing.CorpusModel{
			"google/gemini-test": rates(1e-6, 2e-6),
		}}
		entries, err := LoadGemini(geminiOptionsWith(t, root, nativepricing.ModeDisplay, corpus))
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 1 || entries[0].CostUSD != 0 || entries[0].MissingPricing {
			t.Fatalf("entries = %+v, want zero cost without missing pricing", entries)
		}
	})
}

// TestGeminiBadLinesAndFilesAreSkipped pins the loader's per-file tolerance
// (loader.rs:30-36, jsonl.rs:47-62): one malformed line or file never fails the
// load, and a whole-file document with trailing data is rejected the way
// serde_json::from_str rejects it.
func TestGeminiBadLinesAndFilesAreSkipped(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "chats", "mixed.jsonl"), strings.Join([]string{
		`not json`,
		``,
		`{"type":"gemini","model":"m","timestamp":"2026-01-02T03:04:05Z","tokens":{"input":5,"output":1}}`,
	}, "\n"))
	writeFile(t, filepath.Join(root, "chats", "torn.json"),
		`{"type":"gemini","model":"m","tokens":{"input":5,"output":1}} trailing`)
	writeFile(t, filepath.Join(root, "chats", "torn.jsonl"), `{"type":"gemini"`)

	entries, err := LoadGemini(geminiOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Usage.Input != 5 {
		t.Fatalf("entries = %+v, want only the valid line", entries)
	}
}

// TestGeminiBadTimestampFallsBackToMtime pins file_modified_timestamp
// (parser.rs:431-439) and the strict parse_ts_timestamp gate: a microsecond
// precision or space-separated timestamp is rejected and the file mtime is used
// instead.
func TestGeminiBadTimestampFallsBackToMtime(t *testing.T) {
	mtime := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	cases := map[string]string{
		"microseconds": `{"sessionId":"s","id":"m","type":"gemini","model":"m","timestamp":"2026-05-17T11:07:32.123456Z","tokens":{"input":10,"output":1}}`,
		"space":        `{"sessionId":"s","id":"m","type":"gemini","model":"m","timestamp":"2026-05-17 11:07:32Z","tokens":{"input":10,"output":1}}`,
		"missing":      `{"sessionId":"s","id":"m","type":"gemini","model":"m","tokens":{"input":10,"output":1}}`,
	}
	for name, line := range cases {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			file := filepath.Join(root, "chats", "a.jsonl")
			writeFile(t, file, line)
			if err := os.Chtimes(file, mtime, mtime); err != nil {
				t.Fatal(err)
			}
			entries, err := LoadGemini(geminiOptions(t, root, nativepricing.ModeAuto))
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 1 {
				t.Fatalf("entries = %+v", entries)
			}
			if entries[0].Timestamp != mtime.UnixMilli() || entries[0].Date != "2026-03-04" {
				t.Fatalf("timestamp = %d date = %q, want the file mtime", entries[0].Timestamp, entries[0].Date)
			}
		})
	}
}

// TestGeminiKeepsAThoughtsOnlyDisplayRow pins event acceptance plus
// summarize_entries (parser.rs:337-345, summary.rs:19-37): Rust accepts an
// event whose only signal is a thoughts token, and summarize_entries has no
// empty-row filter, so display mode still prints a zero row for that date. The
// Go report must keep it too instead of dropping it in Summarize.
func TestGeminiKeepsAThoughtsOnlyDisplayRow(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "project", "chats", "stem.jsonl"),
		`{"model":"gemini-3-flash-preview","timestamp":"2026-05-17T11:07:32.000Z","type":"gemini","tokens":{"thoughts":1,"total":0}}`)
	entries, err := LoadGemini(geminiOptions(t, root, nativepricing.ModeDisplay))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want the thoughts-only event", entries)
	}
	rows, totals := Summarize(entries, Daily)
	if len(rows) != 1 {
		t.Fatalf("rows = %+v, want the zero row Rust prints", rows)
	}
	document := ReportJSON(rows, totals, Daily, false)
	if got := len(document["daily"].([]map[string]any)); got != 1 {
		t.Fatalf("daily rows = %d, want 1", got)
	}
}
