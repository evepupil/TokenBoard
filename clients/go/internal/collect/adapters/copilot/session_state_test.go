package copilot

import (
	"encoding/json"
	"math"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestCopilotShutdownSubtractsCacheFromInput mirrors
// parses_session_shutdown_model_metrics (parser.rs:848-889): Copilot counts
// cache reads and writes inside inputTokens, so the stored input is the
// uncached remainder.
func TestCopilotShutdownSubtractsCacheFromInput(t *testing.T) {
	usage := eventsFor(t, "session-1", []string{
		`{"type":"session.shutdown","id":"shutdown-1","timestamp":"2026-04-15T09:52:27.352Z","data":{"modelMetrics":{"test-model":{"usage":{"inputTokens":100,"outputTokens":50,"cacheReadTokens":10,"cacheWriteTokens":20,"reasoningTokens":5}}}}}`,
	})
	if len(usage.Entries) != 1 {
		t.Fatalf("entries = %d, want 1 (%+v)", len(usage.Entries), usage.Entries)
	}
	entry := usage.Entries[0]
	want := Entry{
		Timestamp:     1776246747352,
		TimestampText: "2026-04-15T09:52:27.352Z",
		SessionID:     "session-1",
		Model:         "test-model",
		Input:         70,
		Output:        50,
		CacheCreation: 20,
		CacheRead:     10,
		Reasoning:     5,
		RequestCount:  0,
		DedupKey:      "shutdown:session-1:shutdown-1:test-model",
	}
	if entry != want {
		t.Fatalf("entry = %+v, want %+v", entry, want)
	}
}

// TestCopilotShutdownTotalRequiresAllModels pins
// models_report_credits (parser.rs:285-333): a shutdown keeps its session total
// only when every counted model carries totalNanoAiu, and marks it unknown when
// the session total itself is missing.
func TestCopilotShutdownTotalRequiresAllModels(t *testing.T) {
	usage := eventsFor(t, "session-1", []string{
		`{"type":"session.shutdown","id":"without-model-total","timestamp":"2026-04-15T09:52:27.352Z","data":{"totalNanoAiu":93524970000,"modelMetrics":{"test-model":{"usage":{"inputTokens":100,"outputTokens":50}}}}}`,
		`{"type":"session.shutdown","id":"with-model-total","timestamp":"2026-04-16T09:52:27.352Z","data":{"totalNanoAiu":100000000000,"modelMetrics":{"test-model":{"usage":{"inputTokens":100,"outputTokens":50},"totalNanoAiu":42000000000}}}}`,
		`{"type":"session.shutdown","id":"without-session-total","timestamp":"2026-04-17T09:52:27.352Z","data":{"modelMetrics":{}}}`,
		`{"type":"session.shutdown","id":"zero-usage-does-not-count","timestamp":"2026-04-18T09:52:27.352Z","data":{"totalNanoAiu":7,"modelMetrics":{"empty-model":{"usage":{"inputTokens":0,"outputTokens":0}}}}}`,
	})
	if len(usage.CreditSnapshots) != 4 {
		t.Fatalf("snapshots = %d, want 4", len(usage.CreditSnapshots))
	}
	wants := []struct {
		key    string
		shut   bool
		total  *uint64
		strNil bool
	}{
		{"credits:session-1:without-model-total", true, nil, true},
		{"credits:session-1:with-model-total", true, ptrU64(100_000_000_000), false},
		{"credits:session-1:without-session-total", true, nil, true},
		{"credits:session-1:zero-usage-does-not-count", true, ptrU64(7), false},
	}
	for index, want := range wants {
		got := usage.CreditSnapshots[index]
		if got.DedupKey != want.key || got.IsShutdown != want.shut {
			t.Fatalf("snapshot[%d] = %+v, want key %q shutdown %v", index, got, want.key, want.shut)
		}
		if (got.TotalNanoAiu == nil) != want.strNil || (!want.strNil && *got.TotalNanoAiu != *want.total) {
			t.Fatalf("snapshot[%d].total = %v, want %v", index, ptrString(got.TotalNanoAiu), ptrString(want.total))
		}
	}
	// The model's own nano-AIU rides on the entry (parser.rs:305-328); the
	// zero-usage model of the last shutdown is dropped (parser.rs:295-303).
	if len(usage.Entries) != 2 {
		t.Fatalf("entries = %d, want 2", len(usage.Entries))
	}
	if usage.Entries[1].NanoAiu != 42_000_000_000 {
		t.Fatalf("entry[1].NanoAiu = %d, want 42000000000", usage.Entries[1].NanoAiu)
	}
	if usage.Entries[0].NanoAiu != 0 {
		t.Fatalf("entry[0].NanoAiu = %d, want 0 when the model has no total", usage.Entries[0].NanoAiu)
	}
}

// TestCopilotCheckpointWithoutTotalProducesNoSnapshot pins parser.rs:272-284:
// a checkpoint carries only the session total, and without one it produces no
// snapshot at all.
func TestCopilotCheckpointWithoutTotalProducesNoSnapshot(t *testing.T) {
	usage := eventsFor(t, "session-1", []string{
		`{"type":"session.usage_checkpoint","id":"checkpoint-1","timestamp":"2026-04-15T09:50:00.000Z","data":{"totalNanoAiu":51322830000}}`,
		`{"type":"session.usage_checkpoint","id":"checkpoint-2","timestamp":"2026-04-15T09:51:00.000Z","data":{}}`,
		`{"type":"session.usage_checkpoint","id":"checkpoint-3","timestamp":"2026-04-15T09:52:00.000Z","data":{"totalNanoAiu":-5}}`,
		`{"type":"session.usage_checkpoint","id":"checkpoint-4","timestamp":"2026-04-15T09:53:00.000Z","data":{"totalNanoAiu":1e400}}`,
		`{"type":"session.usage_checkpoint","id":"checkpoint-5","timestamp":"2026-04-15T09:54:00.000Z","data":{"totalNanoAiu":1234.6}}`,
		`{"type":"session.usage_checkpoint","timestamp":"2026-04-15T09:55:00.000Z","data":{"totalNanoAiu":9}}`,
	})
	if len(usage.Entries) != 0 {
		t.Fatalf("checkpoints produced %d entries, want 0", len(usage.Entries))
	}
	if len(usage.CreditSnapshots) != 3 {
		t.Fatalf("snapshots = %+v, want 3", usage.CreditSnapshots)
	}
	first := usage.CreditSnapshots[0]
	if first.DedupKey != "credits:session-1:checkpoint-1" || first.IsShutdown {
		t.Fatalf("snapshot[0] = %+v", first)
	}
	if last := usage.CreditSnapshots[1]; *last.TotalNanoAiu != 1235 {
		t.Fatalf("rounded total = %d, want 1235 (nano_aiu rounds)", *last.TotalNanoAiu)
	}
	// A checkpoint without an event id keys on the timestamp and total.
	anonymous := usage.CreditSnapshots[2]
	if anonymous.DedupKey != "credits:session-1:false:1776246900000:Some(9)" {
		t.Fatalf("anonymous checkpoint key = %q", anonymous.DedupKey)
	}
}

// TestCopilotSessionIDFromParentDir pins parser.rs:232-241: the session id is
// the trimmed parent directory name, and a file without one yields nothing.
func TestCopilotSessionIDFromParentDir(t *testing.T) {
	content := `{"type":"session.shutdown","id":"s","timestamp":"2026-04-15T09:52:27.352Z","data":{"modelMetrics":{"m":{"usage":{"inputTokens":1}}}}}`
	root := t.TempDir()
	// Leading spaces: Windows strips trailing spaces from directory names, so
	// the name has to trim on the other side to stay portable.
	named := writeFixtureFile(t, root, "  trimmed/events.jsonl", content)
	usage, err := parseSessionStateFile(named)
	if err != nil {
		t.Fatal(err)
	}
	if len(usage.Entries) != 1 || usage.Entries[0].SessionID != "trimmed" {
		t.Fatalf("entries = %+v, want one under session id %q", usage.Entries, "trimmed")
	}

	// A file directly inside a directory whose name trims to empty yields
	// nothing, without reading the file. A whitespace-only directory name
	// cannot exist on Windows (trailing spaces are stripped), so the fixture
	// is POSIX-only.
	if runtime.GOOS == "windows" {
		t.Skip("a whitespace-only directory name cannot be created on Windows")
	}
	blank := writeFixtureFile(t, filepath.Join(root, "  "), "events.jsonl", content)
	usage, err = parseSessionStateFile(blank)
	if err != nil {
		t.Fatalf("a blank session directory must not be an error: %v", err)
	}
	if len(usage.Entries) != 0 || len(usage.CreditSnapshots) != 0 {
		t.Fatalf("blank session directory yielded %+v", usage)
	}
}

// TestCopilotNanoAiuRejectsNonFinite pins nano_aiu (parser.rs:345-349): NaN,
// infinities and negatives are None; the rest round half away from zero to a
// u64.
func TestCopilotNanoAiuRejectsNonFinite(t *testing.T) {
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), -1} {
		if got, ok := nanoAiu(&value); ok {
			t.Fatalf("nanoAiu(%v) = (%d, true), want None", value, got)
		}
	}
	cases := map[float64]uint64{0: 0, 0.4: 0, 0.5: 1, 1.5: 2, 2.5: 3, 1e19: 10_000_000_000_000_000_000}
	for value, want := range cases {
		v := value
		got, ok := nanoAiu(&v)
		if !ok || got != want {
			t.Fatalf("nanoAiu(%v) = (%d, %v), want %d", value, got, ok, want)
		}
	}
	if _, ok := nanoAiu(nil); ok {
		t.Fatal("nanoAiu(nil) must be None")
	}
}

// eventsFor writes one session's events.jsonl and parses it.
func eventsFor(t *testing.T, session string, lines []string) (usage SourceUsage) {
	t.Helper()
	return eventsAt(t, writeFixtureFile(t, t.TempDir(), session+"/events.jsonl", strings.Join(lines, "\n")))
}

func eventsAt(t *testing.T, path string) SourceUsage {
	t.Helper()
	usage, err := parseSessionStateFile(path)
	if err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return usage
}

func ptrU64(value uint64) *uint64 { return &value }

func ptrString(value *uint64) string {
	if value == nil {
		return "<nil>"
	}
	out, _ := json.Marshal(*value)
	return string(out)
}

// TestCopilotSessionStateDropsOnlyNonStringFields pins the lenient typed-event
// gate (parser.rs:164-226): every declared field goes through a lenient
// deserializer, so a wrongly typed `type` or `id` still drops the line
// (non_empty_string), while a non-object `data`, a string `totalNanoAiu`, an
// array `modelMetrics` and an unknown `cost` field inside `requests` are all
// tolerated - serde ignores unknown fields and lenient_object turns a
// non-object into None, so the shutdown survives with no credits.
func TestCopilotSessionStateDropsOnlyNonStringFields(t *testing.T) {
	usage := eventsFor(t, "session-1", []string{
		`{"type":"session.shutdown","id":"data-is-string","timestamp":"2026-04-15T09:52:27.352Z","data":"session.shutdown"}`,
		`{"type":"session.shutdown","id":"total-is-string","timestamp":"2026-04-15T09:52:28.352Z","data":{"totalNanoAiu":"12"}}`,
		`{"type":"session.shutdown","id":"model-metrics-is-array","timestamp":"2026-04-15T09:52:29.352Z","data":{"modelMetrics":[]}}`,
		`{"type":"42","timestamp":"2026-04-15T09:52:30.352Z","data":{}}`,
		`{"type":"session.shutdown","id":7,"timestamp":"2026-04-15T09:52:30.852Z","data":{}}`,
		`{"type":"session.shutdown","id":"kept","timestamp":"2026-04-15T09:52:31.352Z","data":{"totalNanoAiu":12}}`,
		`{"type":"session.shutdown","id":"cost-ignored","timestamp":"2026-04-15T09:52:32.352Z","data":{"totalNanoAiu":12,"modelMetrics":{"gpt-5.4":{"totalNanoAiu":12,"usage":{"inputTokens":10,"cost":999},"requests":{"count":1,"cost":999}}}}}`,
	})
	got := []string{}
	for _, snapshot := range usage.CreditSnapshots {
		got = append(got, snapshot.DedupKey+"="+ptrString(snapshot.TotalNanoAiu))
	}
	want := []string{
		"credits:session-1:data-is-string=<nil>",
		"credits:session-1:total-is-string=<nil>",
		"credits:session-1:model-metrics-is-array=<nil>",
		// A numeric id falls back to the content key, as Rust's
		// `event.id.as_deref()` does on a None.
		"credits:session-1:true:1776246750852:None=<nil>",
		"credits:session-1:kept=12",
		"credits:session-1:cost-ignored=12",
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("snapshots =\n  %s\nwant\n  %s", strings.Join(got, "\n  "), strings.Join(want, "\n  "))
	}
	if len(usage.Entries) != 1 || usage.Entries[0].Input != 10 || usage.Entries[0].Model != "gpt-5.4" {
		t.Fatalf("entries = %+v, want the one gpt-5.4 usage record", usage.Entries)
	}
}
