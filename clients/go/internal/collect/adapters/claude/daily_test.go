package claude

// Daily-report and shared-report cases. They port ccusage's aggregation
// (daily.rs:607-670, summary.rs:39-123) and JSON writing (output.rs:27-121),
// with Entry literals standing in for the loader output: the builders consume
// already-deduped, already-priced entries and never recompute a cost.

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"
)

// reportFixture carries the Entry fields the report builders read.
type reportFixture struct {
	messageID   string
	requestID   string
	model       string
	at          time.Time
	sessionID   string
	pathSession string
	project     string
	synthetic   bool
	fast        bool
	input       int64
	output      int64
	cache5m     int64
	cache1h     int64
	cacheRead   int64
	reported    *float64
	cost        float64
	missing     bool
}

func reportEntry(f reportFixture) Entry {
	at := f.at
	if at.IsZero() {
		at = time.Date(2026, 1, 2, 12, 0, 0, 0, time.UTC)
	}
	speed := ""
	if f.fast {
		speed = speedFast
	}
	return Entry{
		MessageID:      f.messageID,
		RequestID:      f.requestID,
		Model:          f.model,
		Timestamp:      at,
		SessionID:      f.sessionID,
		PathSessionID:  f.pathSession,
		ProjectPath:    f.project,
		IsSynthetic:    f.synthetic,
		Cost:           f.cost,
		MissingPricing: f.missing,
		Usage: Usage{
			Input:          f.input,
			Output:         f.output,
			CacheCreate5m:  f.cache5m,
			CacheCreate1h:  f.cache1h,
			CacheRead:      f.cacheRead,
			HasCacheCreate: f.cache1h != 0,
			ReportedCost:   f.reported,
			Speed:          speed,
			Fast:           f.fast,
		},
	}
}

func decodeReport(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("report is not valid JSON: %v\n%s", err, data)
	}
	return decoded
}

func reportObjects(t *testing.T, object map[string]any, key string) []map[string]any {
	t.Helper()
	array, ok := object[key].([]any)
	if !ok {
		t.Fatalf("%q is not an array: %T", key, object[key])
	}
	rows := make([]map[string]any, 0, len(array))
	for _, item := range array {
		row, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("%q holds a non-object: %T", key, item)
		}
		rows = append(rows, row)
	}
	return rows
}

// requireNumber compares by numeric value only: 0 and -0 are equal here, and
// the zero sign is pinned separately by requireNegativeZero (see
// TestEmptyWindowEmitsEmptyArraysAndZeroTotals).
func requireNumber(t *testing.T, object map[string]any, key string, want float64) {
	t.Helper()
	got, ok := object[key].(float64)
	if !ok {
		t.Fatalf("%q = %T, want a number", key, object[key])
	}
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("%q = %v, want %v", key, got, want)
	}
}

// requireNegativeZero asserts the JSON literal of object[key] carries the
// negative sign. encoding/json writes -0.0 as "-0" and +0.0 as "0", so this is
// the only way the sign of a zero total is observable in the report bytes.
func requireNegativeZero(t *testing.T, object map[string]any, key string) {
	t.Helper()
	number, ok := object[key].(json.Number)
	if !ok {
		t.Fatalf("%q = %T, want a json.Number", key, object[key])
	}
	if !strings.HasPrefix(number.String(), "-") {
		t.Fatalf("%q = %s, want a negative zero literal", key, number)
	}
	if value, err := number.Float64(); err != nil || value != 0 {
		t.Fatalf("%q = %s, want a zero literal", key, number)
	}
}

func requireStrings(t *testing.T, value any, want []string) {
	t.Helper()
	array, ok := value.([]any)
	if !ok {
		t.Fatalf("value = %T, want an array", value)
	}
	got := make([]string, 0, len(array))
	for _, item := range array {
		text, ok := item.(string)
		if !ok {
			t.Fatalf("array holds a non-string: %T", item)
		}
		got = append(got, text)
	}
	if len(got) != len(want) {
		t.Fatalf("array = %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("array = %v, want %v", got, want)
		}
	}
}

func breakdownNames(t *testing.T, breakdowns []map[string]any) []string {
	t.Helper()
	names := make([]string, 0, len(breakdowns))
	for _, breakdown := range breakdowns {
		name, ok := breakdown["modelName"].(string)
		if !ok {
			t.Fatalf("modelName = %T, want a string", breakdown["modelName"])
		}
		names = append(names, name)
	}
	return names
}

// TestBuildDailyGroupsByDateAndSortsBreakdownsByCostDesc pins the BTreeMap date
// grouping (daily.rs:131-145) and the descending cost sort of into_summary
// (daily.rs:646-648). The two tied breakdowns are named so that a name-based
// tie-break would put them the other way round: only the stable sort keeps the
// first-seen order that Rust's stable `sort_by` keeps.
func TestBuildDailyGroupsByDateAndSortsBreakdownsByCostDesc(t *testing.T) {
	day1 := time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)
	day2 := time.Date(2026, 1, 2, 9, 0, 0, 0, time.UTC)
	entries := []Entry{
		reportEntry(reportFixture{model: "model-cheap", at: day2, input: 10, cost: 0.01}),
		reportEntry(reportFixture{model: "model-pricey", at: day2, input: 20, cost: 0.5}),
		reportEntry(reportFixture{model: "model-zzz-tie", at: day2, input: 30, cost: 0.2}),
		reportEntry(reportFixture{model: "model-aaa-tie", at: day2, input: 40, cost: 0.2}),
		reportEntry(reportFixture{model: "model-only", at: day1, input: 50, cost: 0.3}),
	}

	report := decodeReport(t, BuildDaily(entries, DailyOptions{Timezone: "UTC"}))
	daily := reportObjects(t, report, "daily")
	if len(daily) != 2 {
		t.Fatalf("daily rows = %d, want 2", len(daily))
	}
	if daily[0]["date"] != "2026-01-01" || daily[1]["date"] != "2026-01-02" {
		t.Fatalf("dates = %v, %v; want ascending", daily[0]["date"], daily[1]["date"])
	}

	second := daily[1]
	requireStrings(t, second["modelsUsed"],
		[]string{"model-cheap", "model-pricey", "model-zzz-tie", "model-aaa-tie"})
	breakdowns := reportObjects(t, second, "modelBreakdowns")
	names := breakdownNames(t, breakdowns)
	want := []string{"model-pricey", "model-zzz-tie", "model-aaa-tie", "model-cheap"}
	for index := range want {
		if names[index] != want[index] {
			t.Fatalf("breakdowns = %v, want %v", names, want)
		}
	}

	requireNumber(t, second, "inputTokens", 100)
	requireNumber(t, second, "totalTokens", 100)
	requireNumber(t, second, "totalCost", 0.91)
}

// TestBuildDailyFiltersBySinceAndUntilOnTheComputedDate pins that the window
// compares the calendar date the timezone assigns the timestamp to, and that
// both documented bound spellings behave the same (date_within_range,
// date_utils.rs:196-203; bounds are normalized to YYYYMMDD at parse time,
// types.rs:82-105).
func TestBuildDailyFiltersBySinceAndUntilOnTheComputedDate(t *testing.T) {
	// 2026-01-03 08:30 in Tokyo, still 2026-01-02 in UTC.
	late := reportEntry(reportFixture{
		model: "model-a", at: time.Date(2026, 1, 2, 23, 30, 0, 0, time.UTC), input: 5, cost: 0.1,
	})

	tokyo := decodeReport(t, BuildDaily([]Entry{late}, DailyOptions{
		Timezone: "Asia/Tokyo", Since: "2026-01-03", Until: "2026-01-03",
	}))
	tokyoDaily := reportObjects(t, tokyo, "daily")
	if len(tokyoDaily) != 1 || tokyoDaily[0]["date"] != "2026-01-03" {
		t.Fatalf("Tokyo window kept %v, want the 2026-01-03 row", tokyoDaily)
	}

	for _, bound := range []struct{ since, until string }{
		{"2026-01-03", "2026-01-03"},
		{"20260103", "20260103"},
	} {
		utc := decodeReport(t, BuildDaily([]Entry{late}, DailyOptions{
			Timezone: "UTC", Since: bound.since, Until: bound.until,
		}))
		if rows := reportObjects(t, utc, "daily"); len(rows) != 0 {
			t.Fatalf("UTC window %v kept %v, want an empty report", bound, rows)
		}
	}

	untilOnly := decodeReport(t, BuildDaily([]Entry{late}, DailyOptions{
		Timezone: "UTC", Until: "2026-01-02",
	}))
	if rows := reportObjects(t, untilOnly, "daily"); len(rows) != 1 {
		t.Fatalf("until-only window kept %d rows, want 1", len(rows))
	}
}

// TestDailyTotalsAndUnpricedModels pins totals_json (output.rs:79-145): the
// totals are the sums of the kept rows, totalCost sums the row costs, and
// unpricedModels lists the display names of breakdowns that had a pricing miss,
// deduplicated and sorted.
func TestDailyTotalsAndUnpricedModels(t *testing.T) {
	day1 := time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)
	day2 := time.Date(2026, 1, 2, 9, 0, 0, 0, time.UTC)
	entries := []Entry{
		reportEntry(reportFixture{model: "model-priced", at: day1, input: 100, cost: 0.25}),
		reportEntry(reportFixture{model: "model-zeta-unpriced", at: day1, input: 10, missing: true}),
		reportEntry(reportFixture{model: "model-alpha-unpriced", at: day2, input: 7, missing: true}),
		reportEntry(reportFixture{model: "model-priced", at: day2, input: 50, cost: 0.5}),
	}

	report := decodeReport(t, BuildDaily(entries, DailyOptions{Timezone: "UTC"}))
	totals, ok := report["totals"].(map[string]any)
	if !ok {
		t.Fatalf("totals = %T, want an object", report["totals"])
	}
	requireNumber(t, totals, "inputTokens", 167)
	requireNumber(t, totals, "outputTokens", 0)
	requireNumber(t, totals, "cacheCreationTokens", 0)
	requireNumber(t, totals, "cacheReadTokens", 0)
	requireNumber(t, totals, "totalTokens", 167)
	requireNumber(t, totals, "totalCost", 0.75)
	requireStrings(t, totals["unpricedModels"], []string{"model-alpha-unpriced", "model-zeta-unpriced"})

	pricedOnly := decodeReport(t, BuildDaily(entries[:1], DailyOptions{Timezone: "UTC"}))
	pricedTotals := pricedOnly["totals"].(map[string]any)
	if _, present := pricedTotals["unpricedModels"]; present {
		t.Fatal("unpricedModels must be absent when every model was priced")
	}
}

// TestSyntheticEntriesCountTokensButNotBreakdown: a `<synthetic>` line has no
// model name (daily.rs:338-346), so its tokens count towards the row and the
// totals but never towards modelsUsed or a breakdown.
func TestSyntheticEntriesCountTokensButNotBreakdown(t *testing.T) {
	entry := reportEntry(reportFixture{
		model: "<synthetic>", synthetic: true, input: 100, output: 10, cacheRead: 5,
	})
	report := decodeReport(t, BuildDaily([]Entry{entry}, DailyOptions{Timezone: "UTC"}))
	daily := reportObjects(t, report, "daily")
	if len(daily) != 1 {
		t.Fatalf("daily rows = %d, want 1", len(daily))
	}
	requireNumber(t, daily[0], "totalTokens", 115)
	requireNumber(t, daily[0], "totalCost", 0)
	requireStrings(t, daily[0]["modelsUsed"], []string{})
	if breakdowns := reportObjects(t, daily[0], "modelBreakdowns"); len(breakdowns) != 0 {
		t.Fatalf("synthetic entry produced breakdowns: %v", breakdowns)
	}
}

// TestReportCacheCreationSumsTheBreakdownPair: cache creation is 5m + 1h when
// the line carried a breakdown and the flat count otherwise
// (types.rs:41-50). Entry.Usage already holds the normalized pair, so the
// report only adds it.
func TestReportCacheCreationSumsTheBreakdownPair(t *testing.T) {
	entry := reportEntry(reportFixture{model: "model-a", cache5m: 100, cache1h: 200, input: 1})
	report := decodeReport(t, BuildDaily([]Entry{entry}, DailyOptions{Timezone: "UTC"}))
	daily := reportObjects(t, report, "daily")
	requireNumber(t, daily[0], "cacheCreationTokens", 300)
	requireNumber(t, daily[0], "totalTokens", 301)
	breakdowns := reportObjects(t, daily[0], "modelBreakdowns")
	requireNumber(t, breakdowns[0], "cacheCreationTokens", 300)
}

func TestDisplayModelSuffixesFastAndDropsSynthetic(t *testing.T) {
	// The alias stream is process state; keep this case on the identity map.
	t.Setenv(modelAliasesEnv, "")

	cases := []struct {
		name        string
		entry       Entry
		wantName    string
		wantInModel bool
	}{
		{
			name:     "synthetic entries have no display model",
			entry:    reportEntry(reportFixture{model: "<synthetic>", synthetic: true}),
			wantName: "",
		},
		{
			name:     "an absent model has no display model",
			entry:    reportEntry(reportFixture{model: ""}),
			wantName: "",
		},
		{
			name:        "a fast request gains the suffix",
			entry:       reportEntry(reportFixture{model: "claude-sonnet-4-5", fast: true}),
			wantName:    "claude-sonnet-4-5-fast",
			wantInModel: true,
		},
		{
			name:        "a standard request keeps its name",
			entry:       reportEntry(reportFixture{model: "claude-sonnet-4-5"}),
			wantName:    "claude-sonnet-4-5",
			wantInModel: true,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			name, ok := displayModel(testCase.entry)
			if name != testCase.wantName || ok != testCase.wantInModel {
				t.Fatalf("displayModel = (%q, %v), want (%q, %v)",
					name, ok, testCase.wantName, testCase.wantInModel)
			}
		})
	}
}

// TestResolveModelNameParsesBothForms covers both spellings model_aliases.rs
// accepts: a JSON object when the value parses as one, and the delimited form
// otherwise (including a brace-wrapped delimited list).
func TestResolveModelNameParsesBothForms(t *testing.T) {
	cases := []struct {
		name string
		env  string
		want map[string]string
	}{
		{
			name: "json object",
			env:  `{"private-alpha":"gpt-5.5","other":"claude-sonnet-4-5"}`,
			want: map[string]string{"private-alpha": "gpt-5.5", "other": "claude-sonnet-4-5"},
		},
		{
			name: "delimited pairs",
			env:  " private-alpha = gpt-5.5, other-alpha=claude-sonnet-4 ; third=x\nfourth=y ",
			want: map[string]string{
				"private-alpha": "gpt-5.5",
				"other-alpha":   "claude-sonnet-4",
				"third":         "x",
				"fourth":        "y",
			},
		},
		{
			name: "brace-wrapped delimited pairs",
			env:  "{private-alpha=gpt-5.5, other-alpha=claude-sonnet-4}",
			want: map[string]string{"private-alpha": "gpt-5.5", "other-alpha": "claude-sonnet-4"},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Setenv(modelAliasesEnv, testCase.env)
			aliases := modelAliases(testCase.env)
			if len(aliases) != len(testCase.want) {
				t.Fatalf("aliases = %v, want %v", aliases, testCase.want)
			}
			for from, to := range testCase.want {
				if aliases[from] != to {
					t.Fatalf("aliases[%q] = %q, want %q", from, aliases[from], to)
				}
				if got := resolveModelName(from); got != to {
					t.Fatalf("resolveModelName(%q) = %q, want %q", from, got, to)
				}
			}
		})
	}
}

// TestResolveModelNameHandlesTheFastSuffix: a "-fast" name that is not itself
// an alias key is resolved through its base model and gets the suffix back
// (model_aliases.rs:20-24).
func TestResolveModelNameHandlesTheFastSuffix(t *testing.T) {
	t.Setenv(modelAliasesEnv, `{"private-alpha":"gpt-5.5","beta":"gamma"}`)

	// A direct hit on the name as written wins before any suffix handling.
	if got := resolveModelName("beta"); got != "gamma" {
		t.Fatalf("direct hit = %q, want gamma", got)
	}
	// A "-fast" name that is not itself a key is retried as its base, and the
	// alias gains the suffix back (model_aliases.rs:20-24).
	if got := resolveModelName("private-alpha-fast"); got != "gpt-5.5-fast" {
		t.Fatalf("base alias resolution = %q, want gpt-5.5-fast", got)
	}
	if got := resolveModelName("beta-fast"); got != "gamma-fast" {
		t.Fatalf("base lookup from a -fast name = %q, want gamma-fast", got)
	}
	if got := resolveModelName("unknown-model-fast"); got != "unknown-model-fast" {
		t.Fatalf("an unmatched name keeps its suffix: got %q", got)
	}
}

func TestResolveModelNameIsIdentityWithoutTheVariable(t *testing.T) {
	t.Setenv(modelAliasesEnv, "")

	for _, model := range []string{"claude-sonnet-4-5", "claude-sonnet-4-5-fast", "<synthetic>"} {
		if got := resolveModelName(model); got != model {
			t.Fatalf("resolveModelName(%q) = %q, want the name unchanged", model, got)
		}
	}
	// A malformed JSON object falls back to the delimited parser, which finds
	// no pair here, so the map stays empty.
	t.Setenv(modelAliasesEnv, `{"a":1}`)
	if got := resolveModelName("a"); got != "a" {
		t.Fatalf("a non-string JSON value must send ccusage to the delimited parser: got %q", got)
	}
}

func TestEmptyWindowEmitsEmptyArraysAndZeroTotals(t *testing.T) {
	t.Setenv(modelAliasesEnv, "")

	dailyBytes := BuildDaily(nil, DailyOptions{Timezone: "UTC"})
	daily := decodeReport(t, dailyBytes)
	dailyRows, ok := daily["daily"].([]any)
	if !ok || dailyRows == nil {
		t.Fatalf("daily = %T (%v), want a non-null empty array", daily["daily"], daily["daily"])
	}
	if len(dailyRows) != 0 {
		t.Fatalf("daily rows = %d, want 0", len(dailyRows))
	}
	dailyTotals := daily["totals"].(map[string]any)
	if len(dailyTotals) != 6 {
		t.Fatalf("totals keys = %v, want the six token/cost keys", dailyTotals)
	}
	for _, key := range []string{"inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "totalTokens", "totalCost"} {
		requireNumber(t, dailyTotals, key, 0)
	}

	sessionBytes := BuildSessions(nil, SessionOptions{Timezone: "UTC"})
	sessions := decodeReport(t, sessionBytes)
	sessionRows, ok := sessions["sessions"].([]any)
	if !ok || sessionRows == nil {
		t.Fatalf("sessions = %T (%v), want a non-null empty array", sessions["sessions"], sessions["sessions"])
	}
	if len(sessionRows) != 0 {
		t.Fatalf("session rows = %d, want 0", len(sessionRows))
	}
	sessionTotals := sessions["totals"].(map[string]any)
	if len(sessionTotals) != 6 {
		t.Fatalf("session totals keys = %v, want the six token/cost keys", sessionTotals)
	}

	// ccusage prints "totalCost": -0.0 for an empty report because Rust's
	// Iterator::sum::<f64>() folds from -0.0 (output.rs:110). requireNumber
	// cannot see that - 0 and -0 compare equal - so the literal's sign is
	// pinned here.
	requireNegativeZero(t, numberedTotals(t, dailyBytes), "totalCost")
	requireNegativeZero(t, numberedTotals(t, sessionBytes), "totalCost")
}

// numberedTotals re-decodes a report with json.Number so the zero literal's
// spelling survives, and returns its totals object.
func numberedTotals(t *testing.T, data []byte) map[string]any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var decoded map[string]any
	if err := decoder.Decode(&decoded); err != nil {
		t.Fatalf("report is not valid JSON: %v", err)
	}
	totals, ok := decoded["totals"].(map[string]any)
	if !ok {
		t.Fatalf("totals = %T, want an object", decoded["totals"])
	}
	return totals
}

// TestReportsAreAlphabeticallyKeyed walks the JSON token stream: encoding/json
// sorts map keys, and ccusage's serde_json Value (a BTreeMap without
// preserve_order) prints the same alphabetical order, so the goldens and this
// build agree byte for byte on key order.
func TestReportsAreAlphabeticallyKeyed(t *testing.T) {
	t.Setenv(modelAliasesEnv, "")

	day := time.Date(2026, 1, 2, 9, 0, 0, 0, time.UTC)
	entries := []Entry{
		reportEntry(reportFixture{model: "model-a", at: day, input: 10, cost: 0.1, project: "demo", pathSession: "session-a"}),
		reportEntry(reportFixture{model: "model-b", at: day, input: 20, missing: true, project: "demo", pathSession: "session-a"}),
	}
	requireAlphabeticalKeys(t, BuildDaily(entries, DailyOptions{Timezone: "UTC"}))
	requireAlphabeticalKeys(t, BuildSessions(entries, SessionOptions{Timezone: "UTC"}))
}

// requireAlphabeticalKeys asserts every object in the document lists its keys
// in ascending byte order.
func requireAlphabeticalKeys(t *testing.T, data []byte) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	var walk func() error
	walk = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			var keys []string
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				keys = append(keys, keyToken.(string))
				if err := walk(); err != nil {
					return err
				}
			}
			for index := 1; index < len(keys); index++ {
				if keys[index-1] >= keys[index] {
					t.Fatalf("object keys are not alphabetical: %v", keys)
				}
			}
			_, err := decoder.Token() // '}'
			return err
		case '[':
			for decoder.More() {
				if err := walk(); err != nil {
					return err
				}
			}
			_, err := decoder.Token() // ']'
			return err
		}
		return nil
	}
	if err := walk(); err != nil {
		t.Fatalf("walking the report failed: %v", err)
	}
}
