package tools

// The Amp adapter's rules, pinned against ccusage v20.0.33 (commit 1308c416):
// rust/adapters/amp/src/parser.rs.

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

func testCorpus(t *testing.T) nativepricing.Corpus {
	t.Helper()
	corpus, err := nativepricing.LoadEmbeddedCorpus()
	if err != nil {
		t.Fatal(err)
	}
	return corpus
}

// ampOptions builds Options with AMP_DATA_DIR pointing at root.
func ampOptions(t *testing.T, root string, mode nativepricing.CostMode) Options {
	t.Helper()
	return Options{
		Env: func(key string) (string, bool) {
			if key == "AMP_DATA_DIR" {
				return root, true
			}
			return "", false
		},
		Timezone: "UTC",
		Mode:     mode,
		Corpus:   testCorpus(t),
	}
}

func writeAmpThread(t *testing.T, root, name, content string) {
	t.Helper()
	writeFile(t, filepath.Join(root, "threads", name), content)
}

// TestAmpReportsAnUnreadableThreadFile pins the read-failure rule: a parse
// problem is skipped quietly (the ccusage rule), but a file that cannot be read
// at all under-counts the user's usage silently, so it is recorded for the
// provider to report. The other files still count.
func TestAmpReportsAnUnreadableThreadFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("chmod does not deny the owner a read on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root reads a mode-000 file")
	}
	root := t.TempDir()
	writeAmpThread(t, root, "T-good.json",
		`{"id":"thread-good","messages":[{"role":"assistant","timestamp":"2026-01-02T03:04:05.000Z","model":"gpt-5.5","usage":{"inputTokens":10}}]}`)
	writeAmpThread(t, root, "T-broken.json",
		`{"id":"thread-broken","messages":[]}`)
	broken := filepath.Join(root, "threads", "T-broken.json")
	// Discovery accepts the name; the read then fails with EACCES, which is an
	// I/O failure rather than the disappeared-file race.
	if err := os.Chmod(broken, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(broken, 0o600) })
	var readErrors []ReadError
	options := ampOptions(t, root, nativepricing.ModeAuto)
	options.ReadErrors = &readErrors

	entries, err := LoadAmp(options)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want the readable thread only", entries)
	}
	if len(readErrors) != 1 || !strings.Contains(readErrors[0].Line, "T-broken.json") {
		t.Fatalf("readErrors = %v, want one line naming the unreadable file", readErrors)
	}
	if strings.Contains(readErrors[0].Line, root) {
		t.Fatalf("readErrors[0] = %q, want the base name rather than the full path", readErrors[0].Line)
	}
}

// TestAmpStopsScanningWhenTheBudgetExpires pins the cancellation seam: the
// subprocess path killed the child at TimeoutMs, and the in-process replacement
// has to notice the dead budget between files instead of finishing the tree.
func TestAmpStopsScanningWhenTheBudgetExpires(t *testing.T) {
	root := t.TempDir()
	for index := 0; index < 32; index++ {
		writeAmpThread(t, root, "T-"+strconv.Itoa(index)+".json",
			`{"id":"thread-`+strconv.Itoa(index)+`","messages":[{"role":"assistant","timestamp":"2026-01-02T03:04:05.000Z","model":"gpt-5.5","usage":{"inputTokens":10}}]}`)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	options := ampOptions(t, root, nativepricing.ModeAuto)
	options.Context = ctx

	entries, err := LoadAmp(options)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if len(entries) != 0 {
		t.Fatalf("entries = %d, want none from a cancelled scan", len(entries))
	}
}

// TestAmpLedgerPathJoinsCacheByMessageID pins the legacy ledger schema
// (parser.rs:121-221): tokens use the legacy keys and the cache buckets come
// from the assistant message whose integer messageId the event's toMessageId
// names.
func TestAmpLedgerPathJoinsCacheByMessageID(t *testing.T) {
	root := t.TempDir()
	writeAmpThread(t, root, "T-1.json", `{
		"id": "thread-1",
		"messages": [{"role": "assistant", "messageId": 5,
			"usage": {"cacheCreationInputTokens": 3, "cacheReadInputTokens": 4}}],
		"usageLedger": {"events": [{"timestamp": "2026-01-02T03:04:05.000Z", "model": "gpt-5.5",
			"tokens": {"input": 10, "output": 5, "total": 22}, "toMessageId": 5}]}
	}`)

	entries, err := LoadAmp(ampOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want one", entries)
	}
	entry := entries[0]
	if entry.Usage.Input != 10 || entry.Usage.Output != 5 ||
		entry.Usage.CacheCreation != 3 || entry.Usage.CacheRead != 4 || entry.Usage.Extra != 0 {
		t.Fatalf("usage = %+v, want the legacy mapping with the joined cache buckets", entry.Usage)
	}
	if entry.SessionID != "thread-1" || entry.Date != "2026-01-02" || entry.Model != "gpt-5.5" {
		t.Fatalf("entry = %+v", entry)
	}
	if !time.UnixMilli(entry.Timestamp).Equal(time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)) {
		t.Fatalf("timestamp = %d", entry.Timestamp)
	}
}

// TestAmpFallsBackToMessagesWhenLedgerHasNoEventsArray pins the current schema
// fallback (parser.rs:104-116): a ledger whose events is not an array, or no
// ledger at all, reads the assistant messages directly.
func TestAmpFallsBackToMessagesWhenLedgerHasNoEventsArray(t *testing.T) {
	for name, thread := range map[string]string{
		"missing ledger":    `{"id":"t","messages":[{"role":"assistant","timestamp":"2026-01-02T03:04:05Z","model":"gpt-5.5","usage":{"inputTokens":10,"outputTokens":5}}]}`,
		"ledger not object": `{"id":"t","messages":[{"role":"assistant","timestamp":"2026-01-02T03:04:05Z","model":"gpt-5.5","usage":{"inputTokens":10,"outputTokens":5}}],"usageLedger":"not-an-object"}`,
		"events not array":  `{"id":"t","messages":[{"role":"assistant","timestamp":"2026-01-02T03:04:05Z","model":"gpt-5.5","usage":{"inputTokens":10,"outputTokens":5}}],"usageLedger":{"events":{}}}`,
	} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			writeAmpThread(t, root, "T-1.json", thread)
			entries, err := LoadAmp(ampOptions(t, root, nativepricing.ModeAuto))
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 1 || entries[0].Usage.Input != 10 || entries[0].Usage.Output != 5 {
				t.Fatalf("entries = %+v, want the messages path", entries)
			}
		})
	}
}

// TestAmpDropsAllZeroEntry pins parser.rs:159-166/262-269.
func TestAmpDropsAllZeroEntry(t *testing.T) {
	root := t.TempDir()
	writeAmpThread(t, root, "T-1.json", `{
		"id": "t",
		"messages": [{"role":"assistant","timestamp":"2026-01-02T03:04:05Z","model":"gpt-5.5","usage":{"inputTokens":0,"outputTokens":0}}]
	}`)
	entries, err := LoadAmp(ampOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("entries = %+v, want none", entries)
	}
}

// TestAmpCostHonoursMode pins calculate_cost's mode handling (amp parser.rs:196):
// Display yields zero because the source never reports a USD cost.
func TestAmpCostHonoursMode(t *testing.T) {
	root := t.TempDir()
	writeAmpThread(t, root, "T-1.json", `{
		"id": "t",
		"messages": [{"role":"assistant","timestamp":"2026-01-02T03:04:05Z","model":"gpt-5.5","usage":{"inputTokens":1000,"outputTokens":500}}]
	}`)
	auto, err := LoadAmp(ampOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(auto) != 1 || auto[0].CostUSD <= 0 {
		t.Fatalf("auto entries = %+v, want a priced entry", auto)
	}
	display, err := LoadAmp(ampOptions(t, root, nativepricing.ModeDisplay))
	if err != nil {
		t.Fatal(err)
	}
	if len(display) != 1 || display[0].CostUSD != 0 {
		t.Fatalf("display entries = %+v, want zero cost", display)
	}
}

// TestAmpCreditsSurviveWithZero pins json_value_f64's Some(0.0) case
// (parser.rs:212/320).
// TestAmpPricesAtTheEventTimestamp pins calculate_cost -> find_at
// (cost.rs:9-17): amp passes the event's parsed timestamp, so a scheduled
// model (deepseek-v4-flash) bills at the rate in force then, not the static
// table. The probe's two instants straddle a known peak/off-peak boundary.
func TestAmpPricesAtTheEventTimestamp(t *testing.T) {
	root := t.TempDir()
	timestamps := []string{"2026-08-17T01:00:00.000Z", "2026-08-17T04:00:00.000Z"}
	for index, timestamp := range timestamps {
		writeAmpThread(t, root, "T-"+strconv.Itoa(index)+".json", `{
			"id": "t-`+strconv.Itoa(index)+`",
			"messages": [{"role":"assistant","timestamp":"`+timestamp+`",
				"model":"deepseek-v4-flash","usage":{"inputTokens":1000000}}]
		}`)
	}
	entries, err := LoadAmp(ampOptions(t, root, nativepricing.ModeCalculate))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want two", entries)
	}
	corpus := testCorpus(t)
	byTimestamp := map[int64]float64{}
	for _, entry := range entries {
		byTimestamp[entry.Timestamp] = entry.CostUSD
	}
	for _, text := range timestamps {
		millis, ok := ParseTSTimestamp(text)
		if !ok {
			t.Fatalf("fixture timestamp %q does not parse", text)
		}
		pricing, ok := corpus.FindAt("deepseek-v4-flash", millis)
		if !ok {
			t.Fatal("deepseek-v4-flash has no scheduled pricing")
		}
		want := nativepricing.CostFromPricing(nativepricing.Usage{Input: 1_000_000}, pricing, false)
		if got := byTimestamp[millis]; got != want {
			t.Fatalf("cost at %s = %v, want the scheduled rate %v", text, got, want)
		}
	}
	if byTimestamp[mustParseTimestamp(t, timestamps[0])] == byTimestamp[mustParseTimestamp(t, timestamps[1])] {
		t.Fatal("the two instants must yield different scheduled rates")
	}
}

func mustParseTimestamp(t *testing.T, value string) int64 {
	t.Helper()
	millis, ok := ParseTSTimestamp(value)
	if !ok {
		t.Fatalf("timestamp %q does not parse", value)
	}
	return millis
}

func TestAmpCreditsSurviveWithZero(t *testing.T) {
	root := t.TempDir()
	writeAmpThread(t, root, "T-1.json", `{
		"id": "t",
		"messages": [{"role":"assistant","timestamp":"2026-01-02T03:04:05Z","model":"gpt-5.5","usage":{"inputTokens":10,"credits":0}}]
	}`)
	entries, err := LoadAmp(ampOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Credits == nil || *entries[0].Credits != 0 {
		t.Fatalf("entries = %+v, want Some(0) credits", entries)
	}
}

// TestAmpBadThreadFileDropsWholeFile pins serde's all-or-nothing read
// (parser.rs:96-98).
func TestAmpBadThreadFileDropsWholeFile(t *testing.T) {
	root := t.TempDir()
	writeAmpThread(t, root, "bad.json", `{"id": "t", "messages": [`)
	writeAmpThread(t, root, "good.json", `{"id":"g","messages":[{"role":"assistant","timestamp":"2026-01-02T03:04:05Z","model":"gpt-5.5","usage":{"inputTokens":10}}]}`)
	entries, err := LoadAmp(ampOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].SessionID != "g" {
		t.Fatalf("entries = %+v, want only the good thread", entries)
	}
}

var _ = os.Getenv

// TestAmpRejectsTrailingGarbage pins serde_json::from_slice's whole-document
// read (parser.rs:95-98): a thread file with a second JSON value or junk after
// the object fails the parse and contributes no entries. A streaming decoder
// that stops after the first value would count it.
// TestAmpDropsAFileThatIsNotUTF8 pins from_slice's byte-level contract
// (parser.rs:96): a document with a stray byte fails to deserialize, so the
// whole thread yields nothing. Decoding through a string would replace the byte
// with U+FFFD and keep the messages - usage included.
func TestAmpDropsAFileThatIsNotUTF8(t *testing.T) {
	root := t.TempDir()
	writeAmpThread(t, root, "stray.json", "{\"id\":\"t\",\"message\":\"bad\xff\",\"messages\":[{\"role\":\"assistant\",\"timestamp\":\"2026-01-02T03:04:05Z\",\"model\":\"gpt-5.5\",\"usage\":{\"inputTokens\":10}}]}")
	entries, err := LoadAmp(ampOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("entries = %+v, want none from a file that is not UTF-8", entries)
	}
}

func TestAmpRejectsTrailingGarbage(t *testing.T) {
	root := t.TempDir()
	writeAmpThread(t, root, "trailing.json", `{"id":"t","messages":[{"role":"assistant","timestamp":"2026-01-02T03:04:05Z","model":"gpt-5.5","usage":{"inputTokens":10}}]} {"id":"u"}`)
	writeAmpThread(t, root, "junk.json", `{"id":"j","messages":[{"role":"assistant","timestamp":"2026-01-02T03:04:05Z","model":"gpt-5.5","usage":{"inputTokens":10}}]} x`)
	entries, err := LoadAmp(ampOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("entries = %+v, want none from files with trailing content", entries)
	}
}
