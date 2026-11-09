package copilot

import (
	"encoding/json"
	"math"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// otelFixture writes one OTel exporter file and parses it.
func otelFixture(t *testing.T, lines ...string) []Entry {
	t.Helper()
	path := writeFixtureFile(t, t.TempDir(), "otel/exporter.jsonl", strings.Join(lines, "\n")+"\n")
	entries, err := parseOtelFile(path, 0)
	if err != nil {
		t.Fatalf("parseOtelFile: %v", err)
	}
	return entries
}

func otelKinds(entries []Entry) []string {
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		out = append(out, entry.DedupKey)
	}
	return out
}

// TestCopilotOtelsClassifiesFourKinds pins to_candidate's class ladder
// (parser.rs:400-416) and suppression (parser.rs:584-621): a span with
// operation `chat` or a `chat ` name is a chat call, a non-span inference log
// with the same trace or response id as a chat call is suppressed, an
// `invoke_agent` span is an agent summary, and a `copilot_chat.agent.turn` log
// is an agent turn.
func TestCopilotOtelsClassifiesFourKinds(t *testing.T) {
	entries := otelFixture(t,
		// A chat span by its name prefix alone (no operation attribute).
		`{"type":"span","traceId":"t-name","spanId":"s-name","name":"chat gpt-5","endTime":[1775934000,0],"attributes":{"gen_ai.request.model":"gpt-5","gen_ai.conversation.id":"c1","gen_ai.usage.input_tokens":10,"gen_ai.usage.output_tokens":1}}`,
		// An inference log whose trace matches a chat call: suppressed.
		`{"traceId":"t-name","spanId":"s-infer","time":1775934001,"attributes":{"event.name":"gen_ai.client.inference.operation.details","gen_ai.response.model":"gpt-5","gen_ai.conversation.id":"c1","gen_ai.usage.input_tokens":10,"gen_ai.usage.output_tokens":1}}`,
		// An inference log alone: kept under log:trace:span.
		`{"traceId":"t-infer","spanId":"s-infer","hrTime":[1775934002,0],"attributes":{"event.name":"gen_ai.client.inference.operation.details","gen_ai.response.model":"gpt-5","gen_ai.conversation.id":"c2","gen_ai.usage.input_tokens":20,"gen_ai.usage.output_tokens":2}}`,
		// An agent summary span, both by name and by operation attribute.
		`{"type":"span","traceId":"t-agent","spanId":"s-agent","name":"invoke_agent GitHub Copilot Chat","endTime":[1775934003,0],"attributes":{"gen_ai.operation.name":"invoke_agent","gen_ai.response.model":"gpt-5","gen_ai.conversation.id":"c3","gen_ai.usage.input_tokens":30,"gen_ai.usage.output_tokens":3}}`,
		// An agent turn log.
		`{"_hrTime":[1775934004,0],"attributes":{"event.name":"copilot_chat.agent.turn","gen_ai.response.model":"gpt-5","gen_ai.conversation.id":"c4","gen_ai.usage.input_tokens":40,"gen_ai.usage.output_tokens":4}}`,
		// Anything else is not a call.
		`{"type":"metric","attributes":{"gen_ai.usage.input_tokens":999}}`,
	)
	// The agent summary span shares no trace with the chat call, so it stays.
	// The agent turn has no trace and no turn.index: idx-<file index>:<line index>.
	if got, want := strings.Join(otelKinds(entries), ","), "t-name:s-name,log:t-infer:s-infer,t-agent:s-agent,agent-turn:c4:idx-4:4"; got != want {
		t.Fatalf("dedup keys = %s, want %s", got, want)
	}
	timestamps := []string{}
	for _, entry := range entries {
		timestamps = append(timestamps, entry.TimestampText)
	}
	if got := strings.Join(timestamps, ","); got != "2026-04-11T19:00:00.000Z,2026-04-11T19:00:02.000Z,2026-04-11T19:00:03.000Z,2026-04-11T19:00:04.000Z" {
		t.Fatalf("timestamps = %s", got)
	}
}

// TestCopilotOtelInputSubtractsCacheBuckets pins the input split for OTel rows
// (parser.rs:418-451): cache reads and writes are taken out of inputTokens, the
// cache-write key falls back to cache_creation, and the empty-usage gate drops
// a row whose buckets are all zero.
func TestCopilotOtelInputSubtractsCacheBuckets(t *testing.T) {
	entries := otelFixture(t,
		`{"type":"span","traceId":"t1","spanId":"s1","endTime":[1775934000,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"m","gen_ai.usage.input_tokens":20000,"gen_ai.usage.output_tokens":300,"gen_ai.usage.cache_read.input_tokens":12000,"gen_ai.usage.cache_write.input_tokens":7990}}`,
		`{"type":"span","traceId":"t2","spanId":"s2","endTime":[1775934001,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"m","gen_ai.usage.input_tokens":100,"gen_ai.usage.output_tokens":0,"gen_ai.usage.cache_creation.input_tokens":30}}`,
		// Input smaller than the buckets saturates to zero.
		`{"type":"span","traceId":"t3","spanId":"s3","endTime":[1775934002,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"m","gen_ai.usage.input_tokens":5,"gen_ai.usage.cache_read.input_tokens":50}}`,
		// No tokens at all: not a usage record.
		`{"type":"span","traceId":"t4","spanId":"s4","endTime":[1775934003,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"m","gen_ai.usage.input_tokens":0}}`,
	)
	if len(entries) != 3 {
		t.Fatalf("entries = %d, want 3", len(entries))
	}
	type split struct{ input, read, write, output uint64 }
	want := []split{{10, 12000, 7990, 300}, {70, 0, 30, 0}, {0, 50, 0, 0}}
	for index, expected := range want {
		got := split{entries[index].Input, entries[index].CacheRead, entries[index].CacheCreation, entries[index].Output}
		if got != expected {
			t.Fatalf("entries[%d] split = %+v, want %+v", index, got, expected)
		}
	}
}

// TestCopilotReasoningOnlyExtraWhenTotalExcludesIt mirrors
// includes_separate_otel_reasoning_tokens_in_total_and_cost and
// does_not_double_count_reasoning_tokens (loader.rs:714-806): reasoning is never
// added to output; it only becomes extra tokens when the reported total shows
// it is not already inside the named buckets.
func TestCopilotReasoningOnlyExtraWhenTotalExcludesIt(t *testing.T) {
	cases := []struct {
		name       string
		attributes string
		output     uint64
		extra      uint64
		reasoning  uint64
	}{
		// Parts sum to 70+50+20+10 = 150, reasoning 5 on top.
		{"total includes reasoning", `,"gen_ai.usage.total_tokens":150`, 50, 0, 5},
		{"total excludes reasoning", `,"gen_ai.usage.total_tokens":145`, 50, 0, 5},
		{"total counts reasoning twice", `,"gen_ai.usage.total_tokens":155`, 50, 5, 5},
		{"no total", ``, 50, 0, 5},
		// Parts missing: the total lands in output (output was zero) and the
		// separate reasoning stays a separate bucket.
		{"fallback fills output", `,"gen_ai.usage.total_tokens":567,"gen_ai.usage.reasoning_tokens":5`, 567, 0, 5},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			attributes := `{"gen_ai.operation.name":"chat","gen_ai.response.model":"m","gen_ai.usage.input_tokens":100,"gen_ai.usage.output_tokens":50,"gen_ai.usage.cache_read.input_tokens":10,"gen_ai.usage.cache_creation.input_tokens":20,"gen_ai.usage.reasoning.output_tokens":5` + test.attributes + `}`
			if strings.Contains(test.name, "fallback") {
				attributes = `{"gen_ai.operation.name":"chat","gen_ai.response.model":"m"` + test.attributes + `}`
			}
			lines := []string{`{"type":"span","traceId":"t1","spanId":"s1","endTime":[1775934000,0],"attributes":` + attributes + `}`}
			entries := otelFixture(t, lines...)
			if len(entries) != 1 {
				t.Fatalf("entries = %d, want 1", len(entries))
			}
			entry := entries[0]
			if entry.Output != test.output || entry.Extra != test.extra || entry.Reasoning != test.reasoning {
				t.Fatalf("output/extra/reasoning = %d/%d/%d, want %d/%d/%d",
					entry.Output, entry.Extra, entry.Reasoning, test.output, test.extra, test.reasoning)
			}
		})
	}
}

// TestCopilotTimestampPriorityAndMagnitudeGuess pins timestamp_from_record
// (parser.rs:794-839): endTime, startTime, hrTime, _hrTime, time, timestamp,
// observedTimestamp, timeUnixNano; `[seconds, nanos]` arrays; scalar magnitudes
// ns/µs/ms/s by size; and the file mtime fallback when nothing parses.
func TestCopilotTimestampPriorityAndMagnitudeGuess(t *testing.T) {
	attrs := `"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"m","gen_ai.usage.input_tokens":1}`
	base := time.Date(2026, 4, 11, 19, 0, 0, 0, time.UTC).UnixMilli()
	cases := []struct {
		name   string
		fields string
		want   int64
	}{
		{"endTime beats startTime", `"endTime":[1775934123,500000000],"startTime":[1775934000,0]`, base + 123500},
		{"startTime before hrTime", `"startTime":[1775934001,0],"hrTime":[1775934002,0]`, base + 1000},
		{"hrTime before _hrTime", `"hrTime":[1775934003,0],"_hrTime":[1775934004,0]`, base + 3000},
		{"_hrTime wins over a second-resolution time", `"_hrTime":[1775934005,0],"time":1775934015`, base + 5000},
		{"_hrTime wins inside the array group", `"_hrTime":[1775934005,0],"timestamp":1775934012`, base + 5000},
		{"timestamp seconds", `"timestamp":1775934010`, base + 10000},
		{"timestamp microseconds", `"timestamp":1775934009500000`, base + 9500},
		{"timestamp terabytes", `"timestamp":1775934009600000000`, base + 9600},
		{"observedTimestamp", `"observedTimestamp":1775934011`, base + 11000},
		{"timeUnixNano", `"timeUnixNano":1775934014000000000`, base + 14000},
		// An unparseable higher-priority value falls through: a one-element
		// array is not a parts pair, and a null is absent.
		{"broken endTime falls through", `"endTime":[1775934123],"time":1775934007000,"timeUnixNano":1775934017000000000`, base + 17000},
		{"null fields are absent", `"endTime":null,"startTime":null,"timestamp":1775934008`, base + 8000},
		{"string seconds", `"timestamp":"1775934013"`, base + 13000},
	}
	lines := make([]string, 0, len(cases))
	for index, test := range cases {
		lines = append(lines, `{"type":"span","traceId":"t`+strconv.Itoa(index)+`","spanId":"s`+strconv.Itoa(index)+`",`+test.fields+`,`+attrs+`}`)
	}
	entries := otelFixture(t, lines...)
	if len(entries) != len(cases) {
		t.Fatalf("entries = %d, want %d", len(entries), len(cases))
	}
	for index, test := range cases {
		if entries[index].Timestamp != test.want {
			t.Fatalf("%s: timestamp = %d, want %d", test.name, entries[index].Timestamp, test.want)
		}
	}

	// Nothing parses: every row falls back to the file's modification time.
	path := writeFixtureFile(t, t.TempDir(), "otel/fresh.jsonl",
		`{"type":"span","traceId":"t-none","spanId":"s-none",`+attrs+`}`+"\n"+
			`{"type":"span","traceId":"t-bad","spanId":"s-bad","endTime":[1],"timeUnixNano":0,`+attrs+`}`+"\n")
	modTime := time.Date(2026, 4, 11, 20, 0, 0, 0, time.UTC)
	if err := os.Chtimes(path, modTime, modTime); err != nil {
		t.Fatal(err)
	}
	entries, err := parseOtelFile(path, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Timestamp != modTime.UnixMilli() || entries[1].Timestamp != modTime.UnixMilli() {
		t.Fatalf("fallback timestamps = %d/%d, want the mtime %d", entries[0].Timestamp, entries[1].Timestamp, modTime.UnixMilli())
	}

	// A supplied ceiling is only the last resort when the mtime is unreadable;
	// a readable mtime still wins.
	entries, err = parseOtelFile(path, 1234)
	if err != nil {
		t.Fatal(err)
	}
	if entries[0].Timestamp != modTime.UnixMilli() {
		t.Fatalf("timestamp = %d, want the mtime even with a ceiling", entries[0].Timestamp)
	}
	entries, err = parseOtelFile("/definitely/not/a/real/file.jsonl", 1234)
	if err == nil || entries != nil {
		t.Fatalf("a missing file must be an error, got %v / %v", entries, err)
	}
}

// TestCopilotSessionIDTieTakesLastAttribute pins best_session_attr
// (parser.rs:624-631, 787-792): priority wins, and among equal priorities the
// LAST listed attribute wins - `session.id` beats `gen_ai.conversation.id`
// however the attributes are spelled. The trace context then carries the best
// session of the trace to records that have none.
func TestCopilotSessionIDTieTakesLastAttribute(t *testing.T) {
	entries := otelFixture(t,
		// Priority 3 tie: the last listed attribute wins.
		`{"type":"span","traceId":"t-tie","spanId":"s1","endTime":[1775934000,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"m","gen_ai.conversation.id":"conv","copilot_chat.session_id":"chat-session","session.id":"session-id","github.copilot.interaction_id":"interaction","gen_ai.response.id":"resp","gen_ai.usage.input_tokens":1}}`,
		// Priority 2 beats priority 1.
		`{"type":"span","traceId":"t-prio","spanId":"s2","endTime":[1775934001,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"m","github.copilot.interaction_id":"interaction-2","gen_ai.response.id":"resp-2","gen_ai.usage.input_tokens":2}}`,
		// No session attribute: the trace's best session (priority 3 from the
		// first record; this record's priority-1 response id does not replace
		// it, but its own priority-1 value would if no trace context existed).
		`{"type":"span","traceId":"t-tie","spanId":"s3","endTime":[1775934002,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"m","gen_ai.response.id":"resp-3","gen_ai.usage.input_tokens":3}}`,
		`{"type":"span","traceId":"t-prio-1","spanId":"s6","endTime":[1775934005,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"m","gen_ai.response.id":"resp-6","gen_ai.usage.input_tokens":6}}`,
		// No session and no trace context: the trace id, then unknown-session.
		`{"type":"span","traceId":"t-only","spanId":"s4","endTime":[1775934003,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"m","gen_ai.usage.input_tokens":4}}`,
		`{"type":"span","spanId":"s5","endTime":[1775934004,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"m","gen_ai.usage.input_tokens":5}}`,
	)
	sessions := []string{}
	for _, entry := range entries {
		sessions = append(sessions, entry.SessionID)
	}
	want := "session-id,interaction-2,resp-3,resp-6,t-only,unknown-session"
	if got := strings.Join(sessions, ","); got != want {
		t.Fatalf("sessions = %s, want %s", got, want)
	}
}

// TestCopilotModelSuffixNormalization pins normalize_copilot_model
// (parser.rs:633-643): trim, then one `-1m-internal` or `-1m` suffix, longest
// first; the response model wins over the request model, and a trace context's
// model fills in for records without one.
func TestCopilotModelSuffixNormalization(t *testing.T) {
	cases := map[string]string{
		" claude-opus-4.7-1m-internal ": "claude-opus-4.7",
		"claude-opus-4.6-1m":            "claude-opus-4.6",
		"gpt-5.4":                       "gpt-5.4",
		// Only ONE suffix is stripped (strip_suffix().or_else(), parser.rs:633-640):
		// `-1m-internal` hits first and the leftover `-1m` stays.
		"x-1m-1m-internal": "x-1m",
		"x-1m-internal-1m": "x-1m-internal",
	}
	for input, want := range cases {
		if got := normalizeCopilotModel(input); got != want {
			t.Fatalf("normalizeCopilotModel(%q) = %q, want %q", input, got, want)
		}
	}
	entries := otelFixture(t,
		`{"type":"span","traceId":"t-model","spanId":"s1","endTime":[1775934000,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"claude-opus-4.6-1m-internal","gen_ai.request.model":"request-model","session.id":"c1","gen_ai.usage.input_tokens":1}}`,
		`{"type":"span","traceId":"t-model","spanId":"s2","endTime":[1775934001,0],"attributes":{"gen_ai.operation.name":"chat","session.id":"c1","gen_ai.usage.input_tokens":2}}`,
		`{"type":"span","traceId":"t-missing","spanId":"s3","endTime":[1775934002,0],"attributes":{"gen_ai.operation.name":"chat","session.id":"c1","gen_ai.usage.input_tokens":3}}`,
	)
	models := []string{entries[0].Model, entries[1].Model, entries[2].Model}
	if got := strings.Join(models, ","); got != "claude-opus-4.6,claude-opus-4.6,unknown" {
		t.Fatalf("models = %s", got)
	}
}

// TestCopilotOtelPrefilterSkipsLinesWithoutAttributes pins LinePrefilter's
// `"attributes"` gate (parser.rs:129-131) and jsonl::records' per-line skip: a
// junk line or a line without the attributes object is dropped, the rest of the
// file still parses.
func TestCopilotOtelPrefilterSkipsLinesWithoutAttributes(t *testing.T) {
	entries := otelFixture(t,
		"not json",
		`{"type":"span","traceId":"t-no-attrs","spanId":"s"}`,
		// Data after the JSON value (even a second object) is trailing
		// content, and serde_json::from_slice refuses it: the line drops.
		`{"type":"span","traceId":"t2","spanId":"s2","endTime":[1775934001,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"m","gen_ai.usage.input_tokens":1}} garbage`,
		// An unknown field is not a structural mismatch.
		`{"type":"span","traceId":"t3","spanId":"s3","endTime":[1775934002,0],"privatePrompt":"x","attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"m","gen_ai.usage.input_tokens":1}}`,
	)
	if len(entries) != 1 || entries[0].DedupKey != "t3:s3" {
		t.Fatalf("entries = %+v, want only t3:s3", entries)
	}
}

// TestCopilotOtelDeclaredMembersAcceptSerdeShapes pins CopilotRecord's field
// types (parser.rs:22-53): every declared member except attributes is
// Option<Value>, which serde reads whatever the value is - a numeric `kind` or
// a null `body` does not make the line fail. attributes is Option<Map>, so a
// non-object there does drop the line. Rejecting a line serde keeps loses the
// usage it carries; keeping one serde drops lets its trace suppress another
// row's usage.
func TestCopilotOtelDeclaredMembersAcceptSerdeShapes(t *testing.T) {
	entries := otelFixture(t,
		// Option<Value> members with non-string values still parse.
		`{"type":"span","name":null,"spanId":"s1","traceId":"t1","kind":9,"duration":3,"body":null,"endTime":[1775934001,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"m","gen_ai.usage.input_tokens":1}}`,
		// attributes is Option<Map>, so a scalar there fails the line.
		`{"type":"span","spanId":"s2","traceId":"t2","endTime":[1775934002,0],"attributes":9}`,
		// ...but null is None, not a type error.
		`{"type":"span","spanId":"s3","traceId":"t3","attributes":null}`,
	)
	if len(entries) != 1 || entries[0].DedupKey != "t1:s1" {
		t.Fatalf("entries = %+v, want only t1:s1 kept", entries)
	}
}

// TestCopilotTimestampFromPartsRejectsOverflow pins timestamp_from_parts
// (parser.rs:798-812): Rust chains checked_mul(1000) and checked_add, so a
// parts pair whose sum leaves u64 answers None and the record falls back to
// the next timestamp source. Only the multiply was guarded here, so a
// seconds value at the boundary plus real nanos wrapped to a tiny millis.
func TestCopilotTimestampFromPartsRejectsOverflow(t *testing.T) {
	// seconds*1000 fits, but adding nanos/1e6 overflows u64.
	if _, ok := timestampFromParts([]any{json.Number("18446744073709551"), json.Number("999999999")}); ok {
		t.Fatal("an overflowing parts pair must not produce a timestamp")
	}
	// The boundary that DOES fit keeps working: i64::MAX milliseconds.
	if millis, ok := timestampFromParts([]any{json.Number("9223372036854775"), json.Number("807000000")}); !ok || millis != math.MaxInt64 {
		t.Fatalf("boundary parts = %d/%v, want i64::MAX (checked_add succeeds)", millis, ok)
	}
}
