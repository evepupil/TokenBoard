package codex

// The Codex line parser and cumulative-diff state machine, pinned against
// ccusage v20.0.33 (commit 1308c416): rust/adapters/codex/src/parser.rs,
// types.rs and crates/ccusage-core/src/date_utils.rs. Each test names the rule
// it protects; a silent difference here changes what a user is billed for.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const testTimestamp = "2026-01-05T12:00:00.000Z"

func mustValue(t *testing.T, text string) value {
	t.Helper()
	var object map[string]json.RawMessage
	if err := json.Unmarshal([]byte(text), &object); err != nil {
		t.Fatal(err)
	}
	return newValue(object)
}

func parseLines(t *testing.T, sessionsDir, path string, lines ...string) []Event {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(joinLines(lines...)), 0o644); err != nil {
		t.Fatal(err)
	}
	events := []Event{}
	if err := ParseFile(sessionsDir, path, nil, func(event Event) error {
		events = append(events, event)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return events
}

func joinLines(lines ...string) string {
	out := ""
	for _, line := range lines {
		out += line + "\n"
	}
	return out
}

func assertUsage(t *testing.T, got, want RawUsage) {
	t.Helper()
	if got != want {
		t.Fatalf("usage = %+v, want %+v", got, want)
	}
}

func assertUsages(t *testing.T, events []Event, want ...RawUsage) {
	t.Helper()
	if len(events) != len(want) {
		t.Fatalf("got %d events %+v, want %d", len(events), events, len(want))
	}
	for i := range want {
		if events[i].RawUsage != want[i] {
			t.Fatalf("event[%d].RawUsage = %+v, want %+v", i, events[i].RawUsage, want[i])
		}
	}
}

func parseMillis(t *testing.T, value string) int64 {
	t.Helper()
	millis, ok := ParseTimestamp(value)
	if !ok {
		t.Fatalf("ParseTimestamp(%q) failed", value)
	}
	return millis
}

// TestRawUsageAliasPrecedence pins CodexRawUsage's Deserialize impl
// (types.rs:278-356): every alias, in its declared order, and the derived
// total (a recorded zero total is unusable rather than a free turn).
func TestRawUsageAliasPrecedence(t *testing.T) {
	cases := []struct {
		name string
		json string
		want RawUsage
	}{
		{"canonical", `{"input_tokens":10,"cached_input_tokens":2,"cache_creation_input_tokens":3,"output_tokens":4,"reasoning_output_tokens":1,"total_tokens":99}`, RawUsage{Input: 10, CachedInput: 2, CacheCreation: 3, Output: 4, Reasoning: 1, Total: 99}},
		{"prompt/completion", `{"prompt_tokens":7,"completion_tokens":8,"reasoning_tokens":2}`, RawUsage{Input: 7, Output: 8, Reasoning: 2, Total: 15}},
		{"input/output", `{"input":5,"output":6}`, RawUsage{Input: 5, Output: 6, Total: 11}},
		{"cache read alias", `{"input_tokens":9,"cache_read_input_tokens":4}`, RawUsage{Input: 9, CachedInput: 4, Total: 9}},
		{"cached alias", `{"input_tokens":9,"cached_tokens":4}`, RawUsage{Input: 9, CachedInput: 4, Total: 9}},
		{"cache write alias", `{"input_tokens":9,"cache_write_input_tokens":3}`, RawUsage{Input: 9, CacheCreation: 3, Total: 9}},
		{"zero total is derived", `{"input_tokens":9,"output_tokens":4,"reasoning_output_tokens":2,"total_tokens":0}`, RawUsage{Input: 9, Output: 4, Reasoning: 2, Total: 13}},
	}
	for _, tc := range cases {
		usage, ok := rawUsageFrom(mustValue(t, tc.json))
		if !ok {
			t.Fatalf("%s: rawUsageFrom returned absent", tc.name)
		}
		assertUsage(t, usage, tc.want)
	}
}

// TestRawUsageClampsCachedAndCacheCreation pins the min clamps
// (types.rs:322-340): cached above input is capped, and cache creation is
// capped at the remaining uncached input.
func TestRawUsageClampsCachedAndCacheCreation(t *testing.T) {
	usage, _ := rawUsageFrom(mustValue(t, `{"input_tokens":10,"cached_input_tokens":20,"cache_write_input_tokens":20}`))
	assertUsage(t, usage, RawUsage{Input: 10, CachedInput: 10, Total: 10})

	usage, _ = rawUsageFrom(mustValue(t, `{"input_tokens":10,"cached_input_tokens":6,"cache_creation_input_tokens":20}`))
	assertUsage(t, usage, RawUsage{Input: 10, CachedInput: 6, CacheCreation: 4, Total: 10})
}

// TestLossyU64AcceptsIntegerStringsAndDropsNegatives pins
// deserialize_optional_u64_lossy (types.rs:452-539): integers and trimmed
// strings of digits parse; negatives, floats and booleans do not, and an
// invalid alias does not prevent a later alias from being used.
func TestLossyU64AcceptsIntegerStringsAndDropsNegatives(t *testing.T) {
	line := mustValue(t, `{"a":7,"b":" 8 ","c":-1,"d":1.5,"e":true,"f":"12x"}`)
	if n, ok := line.lossyU64("a"); !ok || n != 7 {
		t.Fatalf("integer = (%d,%v), want (7,true)", n, ok)
	}
	if n, ok := line.lossyU64("b"); !ok || n != 8 {
		t.Fatalf("string = (%d,%v), want (8,true)", n, ok)
	}
	for _, key := range []string{"c", "d", "e", "f", "missing"} {
		if n, ok := line.lossyU64(key); ok {
			t.Fatalf("%s = (%d,%v), want absent", key, n, ok)
		}
	}
	if n, ok := line.firstLossyU64("c", "a"); !ok || n != 7 {
		t.Fatalf("alias fallback = (%d,%v), want (7,true)", n, ok)
	}
}

// TestFieldNamesAreCaseSensitive pins serde's derived Deserialize: every
// declared field name is matched exactly, so a differently cased key is
// unknown and contributes nothing.
func TestFieldNamesAreCaseSensitive(t *testing.T) {
	usage, _ := rawUsageFrom(mustValue(t, `{"Input_Tokens":7,"OUTPUT_TOKENS":3}`))
	assertUsage(t, usage, RawUsage{})
}

// TestNonObjectPayloadIsTreatedAsMissing pins
// deserialize_optional_object_lossy (types.rs:358-450): payload, info, usage
// and metadata supplied as scalars or arrays are absent, not a line failure.
func TestNonObjectPayloadIsTreatedAsMissing(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "s.jsonl")
	lines := []string{
		`{"type":"event_msg","timestamp":"` + testTimestamp + `","payload":{"type":"token_count","info":"not-an-object"}}`,
		`{"type":"event_msg","timestamp":"` + testTimestamp + `","payload":{"type":"token_count","info":{"total_token_usage":7}}}`,
		`{"type":"event_msg","timestamp":"` + testTimestamp + `","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5,"output_tokens":2}}}}`,
		`{"type":"event_msg","timestamp":"` + testTimestamp + `","payload":[]}`,
	}
	got := parseLines(t, root, path, lines...)
	if len(got) != 1 {
		t.Fatalf("got %d events, want only the object-valued usage: %+v", len(got), got)
	}
	assertUsage(t, got[0].RawUsage, RawUsage{Input: 5, Output: 2, Total: 7})
}

// TestUnmodeledInvalidUTF8IsNotALineFailure pins the exact scope of serde_json's
// UTF-8 validation on a typed decode (de.rs + read.rs 1.0.154): keys of objects
// the struct walks and values handed to a typed string field are validated
// (parse_str -> as_str -> str::from_utf8), but members the struct does not
// model are skipped without decoding (ignore_value -> ignore_str), so invalid
// bytes there fail nothing. The committed fixture's 2026-05-24 line and its
// golden row (29 input tokens on that date) pin the first shape end to end;
// this test keeps it at the parser level.
func TestUnmodeledInvalidUTF8IsNotALineFailure(t *testing.T) {
	root := t.TempDir()

	// The invalid byte sits in `note`, a member of last_token_usage the typed
	// decode never reads: the line is billed.
	value := `{"type":"event_msg","timestamp":"` + testTimestamp + `","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":9,"note":"` + "\xff" + `"}}}}`
	got := parseLines(t, root, filepath.Join(root, "s.jsonl"), value)
	if len(got) != 1 {
		t.Fatalf("an unknown member with invalid UTF-8 produced %d events, want the line billed: %+v", len(got), got)
	}
	assertUsage(t, got[0].RawUsage, RawUsage{Input: 9, Total: 9})

	// A whole skipped member: the invalid byte sits inside an object nested
	// under an unknown key, which ignore_value skips without decoding.
	second := `{"type":"event_msg","timestamp":"` + testTimestamp + `","context":{"bad` + "\xff" + `key":1},"payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":7,"output_tokens":1}}}}`
	got = parseLines(t, root, filepath.Join(root, "s2.jsonl"), second)
	if len(got) != 1 {
		t.Fatalf("an unknown nested object with an invalid key produced %d events, want the line billed: %+v", len(got), got)
	}
	assertUsage(t, got[0].RawUsage, RawUsage{Input: 7, Output: 1, Total: 8})
}

// TestInvalidUTF8InWalkedPositionsFailsTheLine pins the other half of the
// serde contract: a key on any object the decode walks, or a string handed to a
// typed field, must be valid UTF-8, and the failure is the WHOLE line - the
// line's surviving fields must not be booked without the broken one.
func TestInvalidUTF8InWalkedPositionsFailsTheLine(t *testing.T) {
	root := t.TempDir()

	// A root-level key (the probe that first showed this: a turn_context line
	// with one invalid key byte falls back to the gpt-5 model, i.e. the line
	// was dropped). The usage in the same line must not be booked either.
	line := `{"type":"event_msg","timestamp":"` + testTimestamp + `","bad` + "\xff" + `key":1,"payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":9,"output_tokens":2}}}}`
	if got := parseLines(t, root, filepath.Join(root, "s.jsonl"), line); len(got) != 0 {
		t.Fatalf("a root key with invalid UTF-8 produced %d events, want the line dropped: %+v", len(got), got)
	}

	// A key inside a walked object: serde fails the line at that key, so the
	// valid output_tokens next to it must not be booked without the input.
	line = `{"type":"event_msg","timestamp":"` + testTimestamp + `","payload":{"type":"token_count","info":{"last_token_usage":{"inp` + "\xff" + `ut_tokens":9,"output_tokens":2}}}}`
	if got := parseLines(t, root, filepath.Join(root, "s2.jsonl"), line); len(got) != 0 {
		t.Fatalf("a walked-object key with invalid UTF-8 produced %d events, want the line dropped: %+v", len(got), got)
	}
}

// TestInvalidUTF8InAModeledStringKeepsThePreviousModel pins the turn_context
// half: serde fails that line (parse_str on the model name), so the session's
// current model survives the broken line untouched - it must not be replaced
// by a U+FFFD-repaired name that would split the model breakdown.
func TestInvalidUTF8InAModeledStringKeepsThePreviousModel(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "s.jsonl")
	lines := []string{
		`{"type":"turn_context","payload":{"model":"gpt-5.1-codex"}}`,
		`{"type":"event_msg","timestamp":"` + testTimestamp + `","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":5,"output_tokens":1}}}}`,
		`{"type":"turn_context","payload":{"model":"gpt-5.1-codex` + "\xff" + `"}}`,
		`{"type":"event_msg","timestamp":"` + testTimestamp + `","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":6,"output_tokens":1}}}}`,
	}
	got := parseLines(t, root, path, lines...)
	if len(got) != 2 {
		t.Fatalf("got %d events, want both token_count lines with the broken one dropped: %+v", len(got), got)
	}
	for index, event := range got {
		if event.Model != "gpt-5.1-codex" {
			t.Fatalf("event %d model = %q, want the previous model (gpt-5.1-codex)", index, event.Model)
		}
	}
}

// TestDuplicateKeysTakeTheLastValueAsADocumentedDeviation records the one
// intentional difference from serde: a duplicated field name is a "duplicate
// field" error there (the line is dropped), while encoding/json keeps the last
// value. Codex never writes duplicate keys, so the deviation is unreachable on
// real logs; this test makes it explicit rather than hidden.
func TestDuplicateKeysTakeTheLastValueAsADocumentedDeviation(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "s.jsonl")
	line := `{"type":"event_msg","timestamp":"` + testTimestamp + `","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":9,"input_tokens":4,"output_tokens":2}}}}`
	got := parseLines(t, root, path, line)
	if len(got) != 1 {
		t.Fatalf("got %d events, want the last value to win: %+v", len(got), got)
	}
	assertUsage(t, got[0].RawUsage, RawUsage{Input: 4, Output: 2, Total: 6})
}

// TestTimestampLengthGate pins parse_ts_timestamp (date_utils.rs:111-144):
// only four byte lengths, exactly three fractional digits, valid separators,
// real calendar dates, no leap seconds, and a strict ±HH:MM offset.
func TestTimestampLengthGate(t *testing.T) {
	valid := []string{
		"2026-01-05T12:00:00Z",
		"2026-01-05T12:00:00.123Z",
		"2026-01-05T12:00:00+08:00",
		"2026-01-05T12:00:00.123-05:30",
	}
	for _, value := range valid {
		if _, ok := ParseTimestamp(value); !ok {
			t.Fatalf("ParseTimestamp(%q) rejected a valid shape", value)
		}
	}
	invalid := []string{
		"2026-01-05T12:00:00.1Z",
		"2026-01-05T12:00:00.12Z",
		"2026-01-05T12:00:00.1234Z",
		"2026-01-05T12:00:00",
		"2026-01-05T12:00:60Z",
		"2026-01-05T24:00:00Z",
		"2026-02-30T12:00:00Z",
		"2025-02-29T12:00:00Z",
		"2026-01-05 12:00:00Z",
		"2026-01-05T12:00:00+24:00",
		"2026-01-05T12:00:00+08:60",
		"2026-01-05T12:00:00+0800",
	}
	for _, value := range invalid {
		if _, ok := ParseTimestamp(value); ok {
			t.Fatalf("ParseTimestamp(%q) accepted an invalid shape", value)
		}
	}
	if millis, ok := ParseTimestamp("1970-01-01T00:00:00.000Z"); !ok || millis != 0 {
		t.Fatalf("epoch = (%d,%v), want (0,true)", millis, ok)
	}
	if got, want := parseMillis(t, "2026-01-05T12:00:00+01:00"), parseMillis(t, "2026-01-05T11:00:00Z"); got != want {
		t.Fatalf("offset = %d, want %d", got, want)
	}
	if got := NormalizeTimestamp("2026-01-05T12:00:00+01:00"); got != "2026-01-05T11:00:00.000Z" {
		t.Fatalf("NormalizeTimestamp = %q, want canonical millis", got)
	}
	if got := NormalizeTimestamp("nonsense"); got != "" {
		t.Fatalf("NormalizeTimestamp(invalid) = %q, want empty", got)
	}
}

func tokenCountLine(timestamp, info string) string {
	return `{"type":"event_msg","timestamp":"` + timestamp + `","payload":{"type":"token_count","info":` + info + `}}`
}

// TestTokenCountDifferencesCumulativeTotals pins the token_count arm
// (parser.rs:479-526): consecutive cumulative snapshots are subtracted
// per-field with clamping, an all-zero difference is dropped, and
// previous_totals is updated even then - the following snapshot is
// differentiated against the dropped one, not against an older total.
func TestTokenCountDifferencesCumulativeTotals(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "s.jsonl")
	lines := []string{
		tokenCountLine("2026-01-05T12:00:00.000Z", `{"total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":30,"reasoning_output_tokens":5,"total_tokens":130}}`),
		tokenCountLine("2026-01-05T12:00:01.000Z", `{"total_token_usage":{"input_tokens":140,"cached_input_tokens":25,"output_tokens":45,"reasoning_output_tokens":8,"total_tokens":185}}`),
		// Lower than the previous total: every difference saturates to zero
		// (parser.rs:1285-1315 uses saturating_sub per field), so the event is
		// dropped - but the total still becomes the baseline for the next
		// line, whose difference is therefore 10, not 0.
		tokenCountLine("2026-01-05T12:00:02.000Z", `{"total_token_usage":{"input_tokens":90,"cached_input_tokens":25,"output_tokens":45,"reasoning_output_tokens":8,"total_tokens":135}}`),
		tokenCountLine("2026-01-05T12:00:03.000Z", `{"total_token_usage":{"input_tokens":100,"cached_input_tokens":25,"output_tokens":45,"reasoning_output_tokens":8,"total_tokens":145}}`),
	}
	got := parseLines(t, root, path, lines...)
	assertUsages(t, got,
		RawUsage{Input: 100, CachedInput: 20, Output: 30, Reasoning: 5, Total: 130},
		RawUsage{Input: 40, CachedInput: 5, Output: 15, Reasoning: 3, Total: 55},
		RawUsage{Input: 10, Total: 10},
	)
}

// TestTokenCountPrefersLastUsageWhenTotalAdvanced pins advanced detection
// (parser.rs:489-505): when the cumulative total changes, last_token_usage is
// taken as-is; when it does not, last_token_usage is ignored and the
// difference - here zero - decides.
func TestTokenCountPrefersLastUsageWhenTotalAdvanced(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "s.jsonl")
	lines := []string{
		tokenCountLine("2026-01-05T12:00:00.000Z", `{"total_token_usage":{"input_tokens":100,"output_tokens":30,"total_tokens":130},"last_token_usage":{"input_tokens":100,"output_tokens":30,"total_tokens":130}}`),
		tokenCountLine("2026-01-05T12:00:01.000Z", `{"total_token_usage":{"input_tokens":140,"output_tokens":45,"total_tokens":185},"last_token_usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}`),
		tokenCountLine("2026-01-05T12:00:02.000Z", `{"total_token_usage":{"input_tokens":140,"output_tokens":45,"total_tokens":185},"last_token_usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13}}`),
	}
	got := parseLines(t, root, path, lines...)
	assertUsages(t, got,
		RawUsage{Input: 100, Output: 30, Total: 130},
		RawUsage{Input: 7, Output: 3, Total: 10},
	)
}

// TestTokenCountZeroGateUsesFiveFields pins the five-field gate
// (parser.rs:521-527): an event whose only non-zero counter is total_tokens is
// dropped, while a headless line with only total_tokens passes its six-field
// gate.
func TestTokenCountZeroGateUsesFiveFields(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "s.jsonl")
	lines := []string{
		tokenCountLine("2026-01-05T12:00:00.000Z", `{"total_token_usage":{"total_tokens":130}}`),
		`{"usage":{"total_tokens":77}}`,
	}
	got := parseLines(t, root, path, lines...)
	assertUsages(t, got, RawUsage{Total: 77})
}

// TestCompactionMarkerEmitsPendingRecord pins both compaction orderings
// (parser.rs:342-447): a token_usage_record awaiting a later compacted marker
// is emitted when the marker arrives, and a marker that arrived first makes
// the record emit immediately; a duplicate record never emits twice.
func TestCompactionMarkerEmitsPendingRecord(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "s.jsonl")
	record := func(id string) string {
		return `{"type":"token_usage_record","timestamp":"` + testTimestamp + `","payload":{"response_id":"` + id + `","usage":{"input_tokens":5,"output_tokens":2}}}`
	}
	marker := func(id string) string {
		return `{"type":"compacted","payload":{"compaction_response_id":"` + id + `"}}`
	}
	got := parseLines(t, root, path, record("pending"), marker("pending"), marker("first"), record("first"), record("first"))
	if len(got) != 2 {
		t.Fatalf("got %d events, want exactly the two paired records: %+v", len(got), got)
	}
	for i, id := range []string{"pending", "first"} {
		if got[i].ResponseID != id {
			t.Fatalf("event[%d].ResponseID = %q, want %q", i, got[i].ResponseID, id)
		}
		assertUsage(t, got[i].RawUsage, RawUsage{Input: 5, Output: 2, Total: 7})
	}
}

// TestUnmatchedUsageRecordIsNeverCounted pins the pending map
// (parser.rs:363-447): a token_usage_record without its compacted marker is
// held forever and never becomes an event, and an all-zero record is dropped
// before it can be held.
func TestUnmatchedUsageRecordIsNeverCounted(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "s.jsonl")
	lines := []string{
		`{"type":"token_usage_record","timestamp":"` + testTimestamp + `","payload":{"response_id":"unmatched","usage":{"input_tokens":5,"output_tokens":2}}}`,
		`{"type":"compacted","payload":{"compaction_response_id":"someone-else"}}`,
		`{"type":"token_usage_record","timestamp":"` + testTimestamp + `","payload":{"response_id":"zero","usage":{"input_tokens":0,"output_tokens":0}}}`,
	}
	got := parseLines(t, root, path, lines...)
	if len(got) != 0 {
		t.Fatalf("unmatched records produced %d events: %+v", len(got), got)
	}
}

// TestThreadSettingsKeepsPreviousTierWhenFieldMissing pins
// thread_settings_applied (parser.rs:464-478): a missing service_tier leaves
// the previous tier standing, an unrecognized one clears it, and recognized
// spellings map onto the three tiers.
func TestThreadSettingsKeepsPreviousTierWhenFieldMissing(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "s.jsonl")
	usage := tokenCountLine(testTimestamp, `{"last_token_usage":{"input_tokens":5,"output_tokens":2}}`)
	// Every event_msg needs a timestamp before its payload is read
	// (parser.rs:455-460), settings events included.
	settings := func(kind string) string {
		return `{"type":"event_msg","timestamp":"` + testTimestamp + `","payload":{"type":"thread_settings_applied"` + kind + `}}`
	}
	lines := []string{
		settings(`,"thread_settings":{"service_tier":"priority"}`),
		usage,
		settings(""),
		usage,
		settings(`,"thread_settings":{"service_tier":"unrecognized"}`),
		usage,
	}
	got := parseLines(t, root, path, lines...)
	if len(got) != 3 {
		t.Fatalf("got %d events, want 3: %+v", len(got), got)
	}
	if got[0].ServiceTier == nil || *got[0].ServiceTier != TierFast {
		t.Fatalf("first tier = %v, want fast", got[0].ServiceTier)
	}
	if got[1].ServiceTier == nil || *got[1].ServiceTier != TierFast {
		t.Fatalf("missing tier cleared the previous value: %v", got[1].ServiceTier)
	}
	if got[2].ServiceTier != nil {
		t.Fatalf("unrecognized tier = %v, want none", got[2].ServiceTier)
	}
}

// TestAutoReviewModelFallbackTable pins codex_log_model_fallback
// (parser.rs:833-846) against the seven embedded release dates; the model is
// rewritten only for codex-auto-review events, every hit is a fallback, and an
// unusable date falls back to gpt-5.
func TestAutoReviewModelFallbackTable(t *testing.T) {
	cases := []struct {
		date string
		want string
	}{
		{"2026-08-01", "gpt-5.6-luna"},
		{"2026-07-30", "gpt-5.6-luna"},
		{"2026-03-05", "gpt-5.4"},
		{"2026-03-04", "gpt-5.3-codex"},
		{"2026-02-05", "gpt-5.3-codex"},
		{"2025-12-11", "gpt-5.2-codex"},
		{"2025-11-13", "gpt-5.1-codex"},
		{"2025-09-15", "gpt-5-codex"},
		{"2025-08-07", "gpt-5"},
		{"2025-08-06", "gpt-5"},
		{"not-a-date", "gpt-5"},
	}
	for _, tc := range cases {
		model, ok := logModelFallback(codexAutoReviewModel, tc.date+"T00:00:00.000Z")
		if !ok || model != tc.want {
			t.Fatalf("date %s = (%q,%v), want %q", tc.date, model, ok, tc.want)
		}
	}
	if _, ok := logModelFallback("gpt-5.4", "2026-08-01T00:00:00.000Z"); ok {
		t.Fatal("an unrelated model must not be rewritten")
	}
}

// TestMissingModelUsesGpt5SentinelAndMarksFallback pins
// resolve_codex_usage_model (parser.rs:794-831): the first model-less event
// introduces the "gpt-5" sentinel, later model-less events stay marked as
// fallbacks, and a turn_context carrying its own model clears that state.
func TestMissingModelUsesGpt5SentinelAndMarksFallback(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "s.jsonl")
	usage := tokenCountLine(testTimestamp, `{"last_token_usage":{"input_tokens":5,"output_tokens":2}}`)
	lines := []string{
		usage,
		usage,
		`{"type":"turn_context","payload":{"model":"o3"}}`,
		usage,
	}
	got := parseLines(t, root, path, lines...)
	if len(got) != 3 {
		t.Fatalf("got %d events, want 3: %+v", len(got), got)
	}
	if !got[0].IsFallbackModel || !got[1].IsFallbackModel || got[0].Model != "gpt-5" || got[1].Model != "gpt-5" {
		t.Fatalf("sentinel events = %+v / %+v, want gpt-5 fallbacks", got[0], got[1])
	}
	if got[2].Model != "o3" || got[2].IsFallbackModel {
		t.Fatalf("after turn_context = %+v, want o3 without fallback", got[2])
	}
}

func replayUsageLine(timestamp, totals string) string {
	return tokenCountLine(timestamp, `{"total_token_usage":`+totals+`}`)
}

// TestExecFallbackReadsUsageWhenTheTypedShapeIsRejected pins the headless
// fallback (parser.rs:290-300): a line the typed decode rejects - here a
// timestamp that is neither a string nor an unsigned integer - is still read
// through the shape-lenient value path, so an exec usage entry is not lost.
func TestExecFallbackReadsUsageWhenTheTypedShapeIsRejected(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "s.jsonl")
	lines := []string{
		`{"timestamp":1.5,"model":"gpt-5.1-codex","usage":{"input_tokens":12,"output_tokens":3}}`,
	}
	got := parseLines(t, root, path, lines...)
	assertUsages(t, got, RawUsage{Input: 12, Output: 3, Total: 15})
	if got[0].Model != "gpt-5.1-codex" || got[0].IsFallbackModel {
		t.Fatalf("event = %+v, want the parsed model without a fallback", got[0])
	}
}

// TestReplaySkipsMatchingParentPrefix pins CodexReplayState::MatchingParent
// (parser.rs:229-245): matching six-field usage is consumed in order; the
// first mismatch at index 0 falls back to the rewritten-burst heuristic, and a
// mismatch after a match ends the replay entirely.
func TestReplaySkipsMatchingParentPrefix(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "s.jsonl")
	lines := []string{
		replayUsageLine("2026-01-05T12:00:00.000Z", `{"input_tokens":10,"output_tokens":2,"total_tokens":12}`),
		replayUsageLine("2026-01-05T12:00:01.000Z", `{"input_tokens":17,"output_tokens":5,"total_tokens":22}`),
		replayUsageLine("2026-01-05T12:00:10.000Z", `{"input_tokens":20,"output_tokens":7,"total_tokens":27}`),
	}
	if err := os.WriteFile(path, []byte(joinLines(lines...)), 0o644); err != nil {
		t.Fatal(err)
	}
	prefix := []RawUsage{
		{Input: 10, Output: 2, Total: 12},
		{Input: 7, Output: 3, Total: 10},
	}
	events := []Event{}
	if err := ParseFile(root, path, prefix, func(e Event) error { events = append(events, e); return nil }); err != nil {
		t.Fatal(err)
	}
	assertUsages(t, events, RawUsage{Input: 3, Output: 2, Total: 5})
}

func parseFileWithEmptyPrefix(t *testing.T, sessionsDir, path string, lines ...string) []Event {
	t.Helper()
	if err := os.WriteFile(path, []byte(joinLines(lines...)), 0o644); err != nil {
		t.Fatal(err)
	}
	events := []Event{}
	if err := ParseFile(sessionsDir, path, []RawUsage{}, func(e Event) error {
		events = append(events, e)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return events
}

// TestReplayRewrittenBurstWithinOneSecond pins detect_rewritten_burst
// (parser.rs:131-178) and CodexReplayState::SkippingRewrittenBurst: a fork
// whose parent log is unavailable skips the dense head of rewritten usage and
// accounts from the first event met after the burst.
func TestReplayRewrittenBurstWithinOneSecond(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "s.jsonl")
	lines := []string{
		replayUsageLine("2026-01-05T12:00:00.000Z", `{"input_tokens":10,"output_tokens":2,"total_tokens":12}`),
		replayUsageLine("2026-01-05T12:00:00.500Z", `{"input_tokens":17,"output_tokens":5,"total_tokens":22}`),
		replayUsageLine("2026-01-05T12:00:00.900Z", `{"input_tokens":20,"output_tokens":7,"total_tokens":27}`),
		replayUsageLine("2026-01-05T12:00:20.000Z", `{"input_tokens":25,"output_tokens":9,"total_tokens":34}`),
	}
	events := parseFileWithEmptyPrefix(t, root, path, lines...)
	if len(events) != 1 {
		t.Fatalf("got %d events, want only the post-burst one: %+v", len(events), events)
	}
	if events[0].Timestamp != "2026-01-05T12:00:20.000Z" {
		t.Fatalf("first emitted = %q, want the event after the >1s pause", events[0].Timestamp)
	}
}

// TestReplayBurstEndsAtFirstSlowEvent pins the pause check
// (parser.rs:246-262): the first event more than a second after the previous
// one ends the burst and is itself accounted for; later events are not
// filtered by replay state at all.
func TestReplayBurstEndsAtFirstSlowEvent(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "s.jsonl")
	lines := []string{
		replayUsageLine("2026-01-05T12:00:00.000Z", `{"input_tokens":10,"output_tokens":2,"total_tokens":12}`),
		replayUsageLine("2026-01-05T12:00:00.500Z", `{"input_tokens":17,"output_tokens":5,"total_tokens":22}`),
		replayUsageLine("2026-01-05T12:00:05.000Z", `{"input_tokens":20,"output_tokens":7,"total_tokens":27}`),
		replayUsageLine("2026-01-05T12:00:05.100Z", `{"input_tokens":25,"output_tokens":9,"total_tokens":34}`),
	}
	events := parseFileWithEmptyPrefix(t, root, path, lines...)
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2: %+v", len(events), events)
	}
	if events[0].Timestamp != "2026-01-05T12:00:05.000Z" || events[1].Timestamp != "2026-01-05T12:00:05.100Z" {
		t.Fatalf("emitted timestamps = %q / %q, want the post-pause pair", events[0].Timestamp, events[1].Timestamp)
	}
}
