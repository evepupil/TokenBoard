package tools

// The shared tool-adapter layer. Every assertion here mirrors a rule the Rust
// adapters share (adapters/common/src/{lib,jsonl,report}.rs and
// ccusage-core/src/{utils,date_utils,agent_report,output}.rs, ccusage v20.0.33
// commit 1308c416), because the eleven per-tool adapters all sit on this code.

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

func TestSplitEnvListTrimsAndDropsEmpty(t *testing.T) {
	got := SplitEnvList(" /a , ,/b,, ")
	want := []string{"/a", "/b"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("SplitEnvList = %q, want %q", got, want)
	}
	if got := SplitEnvList("   "); len(got) != 0 {
		t.Fatalf("blank env = %q, want zero roots", got)
	}
}

func TestDedupePathsKeepsFirstOccurrence(t *testing.T) {
	got := DedupePaths([]string{"/a", "/b", "/a", "/c", "/b"})
	if len(got) != 3 || got[0] != "/a" || got[1] != "/b" || got[2] != "/c" {
		t.Fatalf("DedupePaths = %q", got)
	}
}

func TestCollectFilesIsSortedAndSkipsSymlinks(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "b", "x.json"), "{}")
	writeFile(t, filepath.Join(root, "a", "y.json"), "{}")
	writeFile(t, filepath.Join(root, "a", "z.txt"), "")
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "escape.json"), "{}")
	if err := os.Symlink(filepath.Join(outside, "escape.json"), filepath.Join(root, "a", "link.json")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	files := CollectFiles(root, func(name string) bool { return strings.HasSuffix(name, ".json") })
	want := []string{
		filepath.Join(root, "a", "y.json"),
		filepath.Join(root, "b", "x.json"),
	}
	if len(files) != len(want) || files[0] != want[0] || files[1] != want[1] {
		t.Fatalf("CollectFiles = %q, want %q", files, want)
	}
}

func TestCollectFilesMissingRootIsEmpty(t *testing.T) {
	if files := CollectFiles(filepath.Join(t.TempDir(), "absent"), func(string) bool { return true }); len(files) != 0 {
		t.Fatalf("files = %q, want none", files)
	}
}

func decode(t *testing.T, text string) any {
	t.Helper()
	var value any
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("decode %q: %v", text, err)
	}
	return value
}

func TestLenientNumbersRejectNonU64(t *testing.T) {
	cases := []struct {
		text string
		want uint64
	}{
		{`7`, 7},
		{`7.0`, 0},
		{`7.5`, 0},
		{`"7"`, 0},
		{`-3`, 0},
		{`null`, 0},
	}
	for _, testCase := range cases {
		if got := LenientU64(decode(t, testCase.text)); got != testCase.want {
			t.Errorf("LenientU64(%s) = %d, want %d", testCase.text, got, testCase.want)
		}
	}
	if got := LenientU64(decode(t, `12.9`)); got != 0 {
		t.Errorf("LenientU64(12.9) = %d, want 0 (as_u64 rejects floats)", got)
	}
}

func TestLenientF64AcceptsNumbersOnly(t *testing.T) {
	if got, ok := LenientF64(decode(t, `1.5`)); !ok || got != 1.5 {
		t.Fatalf("LenientF64(1.5) = %v/%v", got, ok)
	}
	if _, ok := LenientF64(decode(t, `"1.5"`)); ok {
		t.Fatal("LenientF64 must reject strings")
	}
}

func TestLenientObjectAndNonEmptyString(t *testing.T) {
	if _, ok := LenientObject(decode(t, `"not an object"`)); ok {
		t.Fatal("LenientObject must reject non-objects")
	}
	if _, ok := LenientObject(decode(t, `null`)); ok {
		t.Fatal("LenientObject must reject null")
	}
	if _, ok := LenientObject(decode(t, `{}`)); !ok {
		t.Fatal("LenientObject must accept an object")
	}
	if _, ok := NonEmptyString(decode(t, `"  "`)); ok {
		t.Fatal("NonEmptyString must reject whitespace")
	}
	if got, ok := NonEmptyString(decode(t, `" x "`)); !ok || got != "x" {
		t.Fatalf("NonEmptyString = %q/%v, want trimmed", got, ok)
	}
}

func TestPickU64TakesFirstPositive(t *testing.T) {
	value := decode(t, `[0, 5, 9]`)
	if got := PickU64(value.([]any)[0], value.([]any)[1], value.([]any)[2]); got != 5 {
		t.Fatalf("PickU64 = %d, want the first positive value", got)
	}
}

func TestParseTSTimestampRejectsMicrosecondsAndSpaceSeparator(t *testing.T) {
	accepted := []string{
		"2026-01-02T03:04:05Z",
		"2026-01-02T03:04:05+08:00",
		"2026-01-02T03:04:05.123Z",
		"2026-01-02T03:04:05.123-07:00",
	}
	for _, value := range accepted {
		if _, ok := ParseTSTimestamp(value); !ok {
			t.Errorf("ParseTSTimestamp(%q) must accept", value)
		}
	}
	rejected := []string{
		"2026-01-02T03:04:05.1234Z", // microseconds are out of the length gate
		"2026-01-02 03:04:05Z",
		"2026-01-02T03:04:05",
		"2026-01-02",
		"2026-01-02t03:04:05Z",
	}
	for _, value := range rejected {
		if _, ok := ParseTSTimestamp(value); ok {
			t.Errorf("ParseTSTimestamp(%q) must reject", value)
		}
	}
	millis, ok := ParseTSTimestamp("2026-01-02T03:04:05.123Z")
	if !ok || millis != time.Date(2026, 1, 2, 3, 4, 5, 123_000_000, time.UTC).UnixMilli() {
		t.Fatalf("millis = %d/%v", millis, ok)
	}
}

func TestFormatRFC3339MillisIsFixedWidthUTC(t *testing.T) {
	millis := time.Date(2026, 1, 2, 3, 4, 5, 120_000_000, time.UTC).UnixMilli()
	if got := FormatRFC3339Millis(millis); got != "2026-01-02T03:04:05.120Z" {
		t.Fatalf("FormatRFC3339Millis = %q", got)
	}
}

func TestFormatDateTZHonoursTimezone(t *testing.T) {
	// 2026-01-02T23:30Z is 2026-01-03 in +08:00.
	millis := time.Date(2026, 1, 2, 23, 30, 0, 0, time.UTC).UnixMilli()
	if got := FormatDateTZ(millis, "Asia/Shanghai"); got != "2026-01-03" {
		t.Fatalf("FormatDateTZ = %q, want the +08 date", got)
	}
	if got := FormatDateTZ(millis, "UTC"); got != "2026-01-02" {
		t.Fatalf("FormatDateTZ UTC = %q", got)
	}
	// An unknown name falls back to local time rather than failing (date_utils.rs:301-307).
	if got := FormatDateTZ(millis, "Not/AZone"); got == "" {
		t.Fatal("FormatDateTZ must fall back to local time")
	}
}

func TestApplyTotalFallbackAddsToOutputOnlyWhenEmpty(t *testing.T) {
	// total - known goes to output when output is zero, otherwise to extra
	// (utils.rs:22-38).
	usage := Usage{Input: 10, CacheRead: 5}
	ApplyTotalFallback(&usage, 40)
	if usage.Output != 25 || usage.Extra != 0 {
		t.Fatalf("usage = %+v, want output 25 when the output bucket is empty", usage)
	}
	usage = Usage{Input: 10, Output: 3}
	ApplyTotalFallback(&usage, 40)
	if usage.Output != 3 || usage.Extra != 27 {
		t.Fatalf("usage = %+v, want extra 27 when output is already set", usage)
	}
	// A total smaller than the known buckets adds nothing (saturating_sub).
	usage = Usage{Input: 10, Output: 20}
	ApplyTotalFallback(&usage, 5)
	if usage.Extra != 0 {
		t.Fatalf("usage = %+v, want no extra for an understated total", usage)
	}
}

func TestReportJSONUsesSessionsAndSessionIDKeys(t *testing.T) {
	document := ReportJSON(nil, Totals{}, Session, false)
	if _, ok := document["sessions"]; !ok {
		t.Fatalf("document = %+v, want the sessions key", document)
	}
	row := Row{Key: "s-1"}
	document = ReportJSON([]Row{row}, Totals{}, Session, false)
	rows := document["sessions"].([]map[string]any)
	if _, ok := rows[0]["sessionId"]; !ok {
		t.Fatalf("session row = %+v, want sessionId", rows[0])
	}
}

func TestSummarizeDropsEmptyEntriesAndSortsBreakdowns(t *testing.T) {
	entries := []Entry{
		{Timestamp: 1, Date: "2026-01-02", Model: "b", Usage: Usage{Input: 10}, CostUSD: 1},
		{Timestamp: 2, Date: "2026-01-02", Model: "a", Usage: Usage{Input: 10}, CostUSD: 2},
		{Timestamp: 3, Date: "2026-01-02", Model: "b", Usage: Usage{}, CostUSD: 0},
	}
	rows, totals := Summarize(entries, Daily)
	if len(rows) != 1 || rows[0].Key != "2026-01-02" {
		t.Fatalf("rows = %+v", rows)
	}
	if rows[0].Usage.Input != 20 || rows[0].Cost != 3 {
		t.Fatalf("row = %+v, want input 20 cost 3", rows[0])
	}
	if len(rows[0].Breakdowns) != 2 || rows[0].Breakdowns[0].Model != "a" {
		t.Fatalf("breakdowns = %+v, want cost-descending order", rows[0].Breakdowns)
	}
	if totals.Usage.Input != 20 {
		t.Fatalf("totals = %+v", totals)
	}
}

// TestSummarizeFirstActivityIsTheTrueMinimum pins SessionAccumulator's
// Option<TimestampMs> earliest (summary.rs:137, 161-166): zero and negative
// timestamps are values, not "unset", so an entry dated 0 makes firstActivity
// 0 and an entry dated before 1970 beats a later one. A `> 0` sentinel would
// silently report the next timestamp instead.
// TestPriceEntrySaturatesCountsPastInt64 pins the u64 -> int64 handoff
// (cost.rs:143-152 bills u64 counts): two buckets that each fit int64 but sum
// past it must still bill. A raw int64 conversion wraps negative, which
// tieredCost reads as no tokens and bills at zero.
func TestPriceEntrySaturatesCountsPastInt64(t *testing.T) {
	corpus := nativepricing.Corpus{Models: map[string]nativepricing.CorpusModel{
		"model": {Input: 1e-9, Output: 1e-9, CacheRead: 1e-9, CacheCreate: 1e-9,
			FastMultiplier: 1, FlexMultiplier: 1},
	}}
	entry := Entry{Usage: Usage{Output: math.MaxInt64, Extra: math.MaxInt64}}
	PriceEntry(corpus, &entry, []string{"model"}, time.Time{}, nativepricing.ModeCalculate, LookupFind)
	if entry.CostUSD <= 0 || math.IsInf(entry.CostUSD, 0) || math.IsNaN(entry.CostUSD) {
		t.Fatalf("cost = %v, want the saturating count billed", entry.CostUSD)
	}
	if entry.MissingPricing {
		t.Fatal("a priced model must not be reported missing")
	}
}

func TestSummarizeFirstActivityIsTheTrueMinimum(t *testing.T) {
	entries := []Entry{
		{Timestamp: 1_000, SessionID: "s", Model: "m", Usage: Usage{Input: 1}, LastActivity: 1_000, FirstActivity: 1_000},
		{Timestamp: 2_000, SessionID: "s", Model: "m", Usage: Usage{Input: 1}, LastActivity: 2_000, FirstActivity: 0},
		{Timestamp: 3_000, SessionID: "s", Model: "m", Usage: Usage{Input: 1}, LastActivity: 3_000, FirstActivity: -5_000},
	}
	rows, _ := Summarize(entries, Session)
	if rows[0].FirstActivity != -5_000 {
		t.Fatalf("firstActivity = %d, want the negative minimum", rows[0].FirstActivity)
	}
	zeroOnly := []Entry{
		{Timestamp: 1_000, SessionID: "z", Model: "m", Usage: Usage{Input: 1}, LastActivity: 1_000, FirstActivity: 0},
		{Timestamp: 2_000, SessionID: "z", Model: "m", Usage: Usage{Input: 1}, LastActivity: 2_000, FirstActivity: 1_000},
	}
	if got, _ := Summarize(zeroOnly, Session); got[0].FirstActivity != 0 {
		t.Fatalf("firstActivity = %d, want 0 rather than the next timestamp", got[0].FirstActivity)
	}
}

func TestSummarizeSessionRowsCarryMetadata(t *testing.T) {
	entries := []Entry{
		{Timestamp: 1_000, Model: "m", Usage: Usage{Input: 5}, SessionID: "s", ProjectPath: "proj",
			LastActivity: 2_000, FirstActivity: 1_000, Version: "1.2"},
	}
	rows, _ := Summarize(entries, Session)
	if rows[0].Key != "s" || rows[0].ProjectPath != "proj" ||
		rows[0].LastActivity != 2_000 || rows[0].FirstActivity != 1_000 || rows[0].Version != "1.2" {
		t.Fatalf("row = %+v", rows[0])
	}
	document := ReportJSON(rows, Totals{}, Session, true)
	row := document["sessions"].([]map[string]any)
	if got := row[0]["lastActivity"]; got != "1970-01-01T00:00:02.000Z" {
		t.Fatalf("lastActivity = %v, want the aggregated timestamp", got)
	}
	if got := row[0]["firstActivity"]; got != "1970-01-01T00:00:01.000Z" {
		t.Fatalf("firstActivity = %v, want the earliest activity", got)
	}
	if got := row[0]["projectPath"]; got != "proj" {
		t.Fatalf("projectPath = %v", got)
	}
	if _, ok := row[0]["version"]; ok {
		t.Fatal("agent_summary_json never emits version")
	}
}

// TestSummarizeSessionProjectPathComesFromTheLatestEntry pins
// SessionAccumulator::add_entry (summary.rs:133-152): the project path is the
// one carried by the LATEST entry of the session, not the first seen - a
// session that spans two projects reports the second one.
func TestSummarizeSessionProjectPathComesFromTheLatestEntry(t *testing.T) {
	entries := []Entry{
		{Timestamp: 1_000, Model: "m", Usage: Usage{Input: 5}, SessionID: "s", ProjectPath: "early-proj",
			LastActivity: 1_000, FirstActivity: 1_000},
		{Timestamp: 3_000, Model: "m", Usage: Usage{Input: 5}, SessionID: "s", ProjectPath: "late-proj",
			LastActivity: 3_000, FirstActivity: 3_000},
	}
	rows, _ := Summarize(entries, Session)
	if rows[0].ProjectPath != "late-proj" {
		t.Fatalf("projectPath = %q, want the latest entry's project", rows[0].ProjectPath)
	}
	if rows[0].LastActivity != 3_000 || rows[0].FirstActivity != 1_000 {
		t.Fatalf("row = %+v, want last=3000 first=1000", rows[0])
	}
	// The accumulator stores whatever the latest entry carried, empty included.
	blank := []Entry{
		{Timestamp: 1_000, Usage: Usage{Input: 5}, SessionID: "s", ProjectPath: "proj", LastActivity: 1_000},
		{Timestamp: 2_000, Usage: Usage{Input: 5}, SessionID: "s", LastActivity: 2_000},
	}
	if got, _ := Summarize(blank, Session); got[0].ProjectPath != "" {
		t.Fatalf("projectPath = %q, want the latest entry's empty project", got[0].ProjectPath)
	}
}

// TestReportJSONOmitsSessionMetadataUnlessTheSourceReportsIt pins the flag
// agent_summary_json takes (agent_report.rs:27-46): only qwen/openclaw/zcode's
// Rust adapters pass true, so a caller passing false gets session rows without
// the three metadata keys even when the row carries values.
func TestReportJSONOmitsSessionMetadataUnlessTheSourceReportsIt(t *testing.T) {
	row := Row{Key: "s", LastActivity: 2_000, FirstActivity: 1_000, ProjectPath: "proj"}
	document := ReportJSON([]Row{row}, Totals{}, Session, false)
	session := document["sessions"].([]map[string]any)[0]
	for _, key := range []string{"lastActivity", "firstActivity", "projectPath"} {
		if _, ok := session[key]; ok {
			t.Fatalf("session row = %v, want no %s when include_session_metadata is false", session, key)
		}
	}
	for _, command := range []string{"amp", "droid", "codebuff", "hermes", "goose", "kilo", "gemini", "kimi"} {
		if RichSessionMetadata(command) {
			t.Fatalf("%s must not report session metadata", command)
		}
	}
	for _, command := range []string{"qwen", "openclaw", "zcode"} {
		if !RichSessionMetadata(command) {
			t.Fatalf("%s must report session metadata", command)
		}
	}
}

func TestReportJSONOmitsOptionalFieldsWhenNil(t *testing.T) {
	row := Row{Key: "2026-01-02"}
	document := ReportJSON([]Row{row}, Totals{}, Daily, false)
	value := document["daily"].([]map[string]any)[0]
	if _, ok := value["credits"]; ok {
		t.Fatal("credits must be omitted when nil")
	}
	if _, ok := value["messageCount"]; ok {
		t.Fatal("messageCount must be omitted when nil")
	}
	if _, ok := value["unpricedModels"]; ok {
		t.Fatal("unpricedModels must be omitted when empty")
	}
}

func TestTotalsCarryCreditsOnlyWhenPositive(t *testing.T) {
	document := ReportJSON(nil, Totals{Credits: floatPointer(0)}, Daily, false)
	if _, ok := document["totals"].(map[string]any)["credits"]; ok {
		t.Fatal("a zero credit total must be omitted")
	}
	document = ReportJSON(nil, Totals{Credits: floatPointer(1.5)}, Daily, false)
	if got := document["totals"].(map[string]any)["credits"]; got != 1.5 {
		t.Fatalf("credits = %v, want 1.5", got)
	}
}

// TestReportJSONEmitsEveryUnpricedBreakdown pins the emit path: totals_json
// does not consult the cost mode (output.rs:79-121). Which rows carry
// Missing is the adapters' business - PriceEntry, kilo and openclaw leave it
// false in display mode, while hermes, goose, droid and codebuff diagnose it in
// every mode, because their Rust missing_*_pricing helpers never check the
// mode.
func TestReportJSONEmitsEveryUnpricedBreakdown(t *testing.T) {
	rows := []Row{
		{Key: "2026-01-02", Breakdowns: []Breakdown{
			{Model: "m2", Missing: true},
			{Model: "m1", Missing: true},
			{Model: "m2", Missing: true},
			{Model: "ok"},
		}},
	}
	for _, mode := range []nativepricing.CostMode{nativepricing.ModeCalculate, nativepricing.ModeDisplay} {
		document := ReportJSON(rows, Totals{}, Daily, false)
		got, ok := document["totals"].(map[string]any)["unpricedModels"]
		if !ok {
			t.Fatalf("%v: expected unpricedModels", mode)
		}
		list := got.([]string)
		if len(list) != 2 || list[0] != "m1" || list[1] != "m2" {
			t.Fatalf("%v: unpricedModels = %q, want a sorted set", mode, list)
		}
	}
}

func floatPointer(value float64) *float64 { return &value }

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// Guard against accidental float math in the shared layer: the report totals
// are plain additions in entry order, which the per-source goldens pin.
func TestTotalsSumInEntryOrder(t *testing.T) {
	entries := []Entry{
		{Date: "d", Model: "m", CostUSD: math.Inf(1)},
	}
	_, totals := Summarize(entries, Daily)
	if !math.IsInf(totals.Cost, 1) {
		t.Fatalf("totals cost = %v, want the raw sum", totals.Cost)
	}
}

// TestUsageTotalSaturatesLikeRust pins total_tokens (types.rs:115-121): the
// bucket sum saturates instead of wrapping, and the fallback's "known" count
// uses the same saturated total, so a source reporting u64::MAX across several
// buckets still prints u64::MAX rather than a small wrapped number.
func TestUsageTotalSaturatesLikeRust(t *testing.T) {
	usage := Usage{Input: math.MaxUint64 - 5, Output: 100, CacheCreation: 1, CacheRead: 1, Extra: 1}
	if got := usage.Total(); got != math.MaxUint64 {
		t.Fatalf("Total() = %d, want saturation to MaxUint64", got)
	}
	ApplyTotalFallback(&usage, math.MaxUint64)
	if got := usage.Total(); got != math.MaxUint64 {
		t.Fatalf("Total() after fallback = %d, want MaxUint64", got)
	}
	if usage.Output != 100 {
		t.Fatalf("output = %d, want the known count to saturate (no fallback room)", usage.Output)
	}
}

// TestSummarizeMonthAddsUpTheDaysNotTheEntries pins summarize_summaries_by_bucket
// (summary.rs:178-206) over summarize_entries' daily pass (amp/report.rs:31-41,
// qwen/report.rs:24-31): a month's row is the sum of its daily rows, in date
// order, not a fold over the raw entries. Float addition is not associative, so
// the two orders differ in the last bit, and a model first seen on the later
// day must still be listed after one first seen on the earlier day.
//
// No runner reaches Monthly today (parseNativeToolArgs accepts daily and
// session only), so this pins the ported function's contract for the module
// documented as the shared report layer.
func TestSummarizeMonthAddsUpTheDaysNotTheEntries(t *testing.T) {
	tiny := math.Pow(2, -53)
	// Entries arrive newest-day-first, so a fold in arrival order would list a
	// before b. Rust summarises the days into a BTreeMap and folds that, so the
	// month sees 01-01 (b) before 01-02 (a).
	entries := []Entry{
		{Date: "2026-01-02", Model: "a", CostUSD: tiny},
		{Date: "2026-01-01", Model: "b", CostUSD: 1},
		{Date: "2026-01-02", Model: "a", CostUSD: tiny},
	}
	rows, totals := Summarize(entries, Monthly)
	if len(rows) != 1 || rows[0].Key != "2026-01" {
		t.Fatalf("rows = %+v, want one January row", rows)
	}
	// The daily row for 01-02 carries tiny+tiny = 2^-52; adding that to 1
	// rounds up, while folding the two raw entries into 1 does not.
	if rows[0].Cost != 1+2*tiny {
		t.Fatalf("cost = %v, want the day-by-day sum %v", rows[0].Cost, 1+2*tiny)
	}
	if got := strings.Join(rows[0].ModelsUsed, ","); got != "b,a" {
		t.Fatalf("modelsUsed = %q, want the date-ordered first appearance", got)
	}
	if got := rows[0].Breakdowns; len(got) != 2 || got[0].Model != "b" || got[1].Model != "a" {
		t.Fatalf("breakdowns = %+v, want cost-descending b then a", got)
	}
	if got := rows[0].Breakdowns[1].Cost; got != 2*tiny {
		t.Fatalf("a breakdown cost = %v, want the day's two tokens", got)
	}
	if totals.Cost != 1+2*tiny {
		t.Fatalf("totals = %+v", totals)
	}
}
