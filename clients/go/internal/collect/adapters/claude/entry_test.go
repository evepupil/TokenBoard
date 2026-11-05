package claude

// The line parser is where ccusage's Claude adapter decides whether one
// transcript line counts at all, so every expectation here is pinned against
// ccusage v20.0.33 (commit 1308c416): rust/adapters/claude/src/lib.rs,
// rust/adapters/claude/src/daily.rs, rust/crates/ccusage-core/src/types.rs and
// rust/crates/ccusage-core/src/date_utils.rs.

import (
	"math"
	"strings"
	"testing"
	"time"
)

const validTimestamp = "2026-10-30T12:34:56.789Z"

// validLine is the control line every rejection test is contrasted with: it is
// accepted by both ParseLine and ParseDailyLine.
func validLine() string {
	return `{"sessionId":"sess-1","version":"2.0.30","timestamp":"` + validTimestamp +
		`","requestId":"req-1","costUSD":0.25,"isSidechain":false,"message":{"id":"msg_1","model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":5}}}`
}

// lineWithUsage keeps the envelope valid and swaps the usage object, which is
// how the token-shape cases are written.
func lineWithUsage(usage string) string {
	return `{"sessionId":"sess-1","version":"2.0.30","timestamp":"` + validTimestamp +
		`","requestId":"req-1","message":{"id":"msg_1","model":"claude-sonnet-4-5","usage":` + usage + `}}`
}

// lineWithMessage swaps the message object.
func lineWithMessage(message string) string {
	return `{"sessionId":"sess-1","version":"2.0.30","timestamp":"` + validTimestamp +
		`","requestId":"req-1","message":` + message + `}`
}

// dailyWrapperLine is the AgentProgress shape daily.rs:182-227 accepts and the
// entry loader does not.
func dailyWrapperLine(inner string) string {
	return `{"sessionId":"sess-1","data":{"message":` + inner + `}}`
}

func TestParseLineReadsTheEnvelopeAndUsage(t *testing.T) {
	entry, ok := ParseLine(validLine())
	if !ok {
		t.Fatalf("ParseLine rejected the control line")
	}
	if entry.MessageID != "msg_1" {
		t.Errorf("MessageID = %q, want msg_1", entry.MessageID)
	}
	if entry.RequestID != "req-1" {
		t.Errorf("RequestID = %q, want req-1", entry.RequestID)
	}
	if entry.SessionID != "sess-1" {
		t.Errorf("SessionID = %q, want sess-1", entry.SessionID)
	}
	if entry.Model != "claude-sonnet-4-5" {
		t.Errorf("Model = %q, want claude-sonnet-4-5", entry.Model)
	}
	if entry.Sidechain {
		t.Errorf("Sidechain = true, want false")
	}
	if entry.IsSynthetic {
		t.Errorf("IsSynthetic = true, want false")
	}
	// ProjectPath belongs to the caller (Task 5), which knows the file path.
	if entry.ProjectPath != "" {
		t.Errorf("ProjectPath = %q, want the zero value", entry.ProjectPath)
	}
	wantTime := time.Date(2026, 10, 30, 12, 34, 56, 789_000_000, time.UTC)
	if !entry.Timestamp.Equal(wantTime) {
		t.Errorf("Timestamp = %s, want %s", entry.Timestamp, wantTime)
	}
	if entry.Timestamp.Location() != time.UTC {
		t.Errorf("Timestamp location = %s, want UTC", entry.Timestamp.Location())
	}
	if entry.Usage.Input != 10 || entry.Usage.Output != 20 || entry.Usage.CacheRead != 5 {
		t.Errorf("Usage = %+v, want input 10 output 20 cache read 5", entry.Usage)
	}
	if entry.Usage.CacheCreate5m != 0 || entry.Usage.CacheCreate1h != 0 {
		t.Errorf("Usage cache creation = %+v, want zero", entry.Usage)
	}
	if entry.Usage.HasCacheCreate {
		t.Errorf("HasCacheCreate = true without a cache_creation object")
	}
	if entry.Usage.ReportedCost == nil || *entry.Usage.ReportedCost != 0.25 {
		t.Errorf("ReportedCost = %v, want 0.25 from validLine's costUSD", entry.Usage.ReportedCost)
	}
	if entry.Usage.Speed != "" || entry.Usage.Fast {
		t.Errorf("Usage speed = %q fast = %v, want the absent speed", entry.Usage.Speed, entry.Usage.Fast)
	}

	entry, ok = ParseLine(`{"sessionId":"s","timestamp":"` + validTimestamp +
		`","costUSD":0.25,"message":{"model":"m","usage":{"input_tokens":1,"output_tokens":2}}}`)
	if !ok {
		t.Fatalf("ParseLine rejected a line carrying costUSD")
	}
	if entry.Usage.ReportedCost == nil || *entry.Usage.ReportedCost != 0.25 {
		t.Fatalf("ReportedCost = %v, want 0.25", entry.Usage.ReportedCost)
	}
}

func TestParseLineRejectsUsageWithSpace(t *testing.T) {
	// The marker is checked as raw bytes, so any whitespace between the key and
	// the colon-and-brace pair misses it (lib.rs:509-512).
	cases := []struct {
		name string
		line string
	}{
		{"space after the colon", `{"sessionId":"s","timestamp":"` + validTimestamp + `","message":{"model":"m","usage": {"input_tokens":1,"output_tokens":2}}}`},
		{"space before the colon", `{"sessionId":"s","timestamp":"` + validTimestamp + `","message":{"model":"m","usage" :{"input_tokens":1,"output_tokens":2}}}`},
		{"newline after the colon", `{"sessionId":"s","timestamp":"` + validTimestamp + `","message":{"model":"m","usage":` + "\n" + `{"input_tokens":1,"output_tokens":2}}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, ok := ParseLine(tc.line); ok {
				t.Fatalf("ParseLine accepted a line without the exact %q marker", `"usage":{`)
			}
			if _, ok := ParseDailyLine(tc.line); ok {
				t.Fatalf("ParseDailyLine accepted a line without the exact %q marker", `"usage":{`)
			}
		})
	}

	// The marker itself is what matters, not where on the line it sits: a
	// newline anywhere else in the line is not the adapter's concern, because
	// byte_lines (fast.rs:82-99) splits on newlines and never hands the parser
	// one mid-line unless the transcript is malformed.
	if _, ok := ParseLine(`{"sessionId":"s",` + "\n" + `"timestamp":"` + validTimestamp + `","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":2}}}`); !ok {
		t.Fatalf("ParseLine rejected a line whose marker is intact")
	}
	if _, ok := ParseLine(lineWithUsage(`{"input_tokens":1,"output_tokens":2}`)); !ok {
		t.Fatalf("ParseLine rejected the no-space control line")
	}
}

func TestParseLineNullBlacklistAnyDepth(t *testing.T) {
	usage := `{"input_tokens":1,"output_tokens":2}`
	cases := []struct {
		name string
		line string
		want bool
	}{
		{"control", validLine(), true},
		{"message id", lineWithMessage(`{"id":null,"model":"m","usage":` + usage + `}`), false},
		{"message model", lineWithMessage(`{"id":"msg_1","model":null,"usage":` + usage + `}`), false},
		{"session id", `{"sessionId":null,"timestamp":"` + validTimestamp + `","message":{"model":"m","usage":` + usage + `}}`, false},
		{"version", `{"sessionId":"s","version":null,"timestamp":"` + validTimestamp + `","message":{"model":"m","usage":` + usage + `}}`, false},
		{"request id", `{"sessionId":"s","requestId":null,"timestamp":"` + validTimestamp + `","message":{"model":"m","usage":` + usage + `}}`, false},
		{"cost usd", `{"sessionId":"s","costUSD":null,"timestamp":"` + validTimestamp + `","message":{"model":"m","usage":` + usage + `}}`, false},
		{"api error flag", `{"sessionId":"s","isApiErrorMessage":null,"timestamp":"` + validTimestamp + `","message":{"model":"m","usage":` + usage + `}}`, false},
		{"speed", lineWithUsage(`{"input_tokens":1,"output_tokens":2,"speed":null}`), false},
		{"cache read", lineWithUsage(`{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":null}`), false},
		{"cache creation flat", lineWithUsage(`{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":null}`), false},
		{
			"nested anywhere",
			lineWithMessage(`{"id":"msg_1","model":"m","usage":` + usage + `,"content":[{"deep":{"cwd":null}}]}`),
			false,
		},
		{
			"iteration model exempt",
			lineWithUsage(`{"input_tokens":1,"output_tokens":2,"iterations":[{"type":"advisor_message","model":null,"input_tokens":3,"output_tokens":4}]}`),
			true,
		},
		{
			"iteration speed still checked",
			lineWithUsage(`{"input_tokens":1,"output_tokens":2,"iterations":[{"type":"message","speed":null,"input_tokens":3,"output_tokens":4}]}`),
			false,
		},
		{
			"iteration id still checked",
			lineWithUsage(`{"input_tokens":1,"output_tokens":2,"iterations":[{"type":"advisor_message","id":null,"model":"m","input_tokens":3,"output_tokens":4}]}`),
			false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, ok := ParseLine(tc.line); ok != tc.want {
				t.Fatalf("ParseLine ok = %v, want %v", ok, tc.want)
			}
		})
	}

	// The AgentProgress path is a second exempt iterations array
	// (lib.rs:833-836). Both exemptions share one scanner, so pin it through
	// the daily parser as well.
	wrapped := dailyWrapperLine(`{"timestamp":"` + validTimestamp + `","message":{"id":"msg_2","model":"m","usage":{"input_tokens":1,"output_tokens":2,"iterations":[{"type":"advisor_message","model":null,"input_tokens":3,"output_tokens":4}]}}}`)
	if _, ok := ParseDailyLine(wrapped); !ok {
		t.Fatalf("ParseDailyLine dropped a wrapper line whose iteration model is null")
	}
	if _, ok := ParseLine(wrapped); ok {
		t.Fatalf("ParseLine accepted an AgentProgress wrapper")
	}
	wrappedSpeed := dailyWrapperLine(`{"timestamp":"` + validTimestamp + `","message":{"id":"msg_2","model":"m","usage":{"input_tokens":1,"output_tokens":2,"iterations":[{"type":"message","speed":null,"input_tokens":3,"output_tokens":4}]}}}`)
	if _, ok := ParseDailyLine(wrappedSpeed); ok {
		t.Fatalf("ParseDailyLine accepted a null speed inside an iteration")
	}
}

func TestParseLineDuplicateKeysDropped(t *testing.T) {
	cases := []struct {
		name string
		line string
	}{
		{"duplicate top-level key", `{"sessionId":"s","timestamp":"` + validTimestamp + `","timestamp":"` + validTimestamp + `","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":2}}}`},
		{"duplicate usage key", lineWithUsage(`{"input_tokens":1,"input_tokens":2,"output_tokens":2}`)},
		{"duplicate unknown nested key", lineWithMessage(`{"id":"msg_1","model":"m","usage":{"input_tokens":1,"output_tokens":2},"content":[{"text":"a","text":"b"}]}`)},
		{"duplicate iteration key", lineWithUsage(`{"input_tokens":1,"output_tokens":2,"iterations":[{"type":"advisor_message","type":"advisor_message","model":"m","input_tokens":3,"output_tokens":4}]}`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, ok := ParseLine(tc.line); ok {
				t.Fatalf("ParseLine accepted a line with duplicate object members")
			}
		})
	}

	if _, ok := ParseLine(lineWithUsage(`{"input_tokens":1,"output_tokens":2,"iterations":[{"type":"message","input_tokens":3,"output_tokens":4}]}`)); !ok {
		t.Fatalf("ParseLine rejected the duplicate-free control line")
	}
}

func TestParseLineSkipsInvalidVersionAndEmptyIDs(t *testing.T) {
	usage := `{"input_tokens":1,"output_tokens":2}`
	cases := []struct {
		name string
		line string
		want bool
	}{
		{"valid version", validLine(), true},
		{"version with four components", `{"sessionId":"s","version":"2.0.30.1","timestamp":"` + validTimestamp + `","message":{"model":"m","usage":` + usage + `}}`, true},
		{"version with a prerelease suffix", `{"sessionId":"s","version":"2.0.30-beta.1","timestamp":"` + validTimestamp + `","message":{"model":"m","usage":` + usage + `}}`, true},
		{"version without a patch", `{"sessionId":"s","version":"2.0","timestamp":"` + validTimestamp + `","message":{"model":"m","usage":` + usage + `}}`, false},
		{"version with a v prefix", `{"sessionId":"s","version":"v2.0.30","timestamp":"` + validTimestamp + `","message":{"model":"m","usage":` + usage + `}}`, false},
		{"version with a non-numeric patch", `{"sessionId":"s","version":"2.0.x","timestamp":"` + validTimestamp + `","message":{"model":"m","usage":` + usage + `}}`, false},
		{"empty version", `{"sessionId":"s","version":"","timestamp":"` + validTimestamp + `","message":{"model":"m","usage":` + usage + `}}`, false},
		{"empty session id", `{"sessionId":"","timestamp":"` + validTimestamp + `","message":{"model":"m","usage":` + usage + `}}`, false},
		{"empty request id", `{"sessionId":"s","requestId":"","timestamp":"` + validTimestamp + `","message":{"model":"m","usage":` + usage + `}}`, false},
		{"empty message id", lineWithMessage(`{"id":"","model":"m","usage":` + usage + `}`), false},
		{"empty message model", lineWithMessage(`{"id":"msg_1","model":"","usage":` + usage + `}`), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, ok := ParseLine(tc.line); ok != tc.want {
				t.Fatalf("ParseLine ok = %v, want %v", ok, tc.want)
			}
		})
	}
}

func TestValidSemverPrefix(t *testing.T) {
	cases := map[string]bool{
		"2.0.30":        true,
		"2.0.30.1":      true,
		"2.0.30-beta":   true,
		"0.0.0":         true,
		"12.34.5678":    true,
		"2.0":           false,
		"2":             false,
		"2.0.":          false,
		"v2.0.30":       false,
		"2..30":         false,
		".0.30":         false,
		"2.0.30 ":       true, // trailing bytes are not part of the prefix rule
		"":              false,
		"2.0.x":         false,
		" 2.0.30":       false,
		"2.0.30\n2.0.3": true,
	}
	for value, want := range cases {
		if got := validSemverPrefix(value); got != want {
			t.Errorf("validSemverPrefix(%q) = %v, want %v", value, got, want)
		}
	}
}

func TestParseTimestampLengthGate(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  time.Time // zero means "must be rejected"
	}{
		{"seconds and Z", "2026-10-30T12:34:56Z", time.Date(2026, 10, 30, 12, 34, 56, 0, time.UTC)},
		{"millis and Z", "2026-10-30T12:34:56.789Z", time.Date(2026, 10, 30, 12, 34, 56, 789_000_000, time.UTC)},
		{"zero millis and Z", "2026-10-30T12:34:56.000Z", time.Date(2026, 10, 30, 12, 34, 56, 0, time.UTC)},
		{"seconds and offset", "2026-10-30T12:34:56+08:00", time.Date(2026, 10, 30, 4, 34, 56, 0, time.UTC)},
		{"millis and offset", "2026-10-30T12:34:56.789-05:30", time.Date(2026, 10, 30, 18, 4, 56, 789_000_000, time.UTC)},
		{"boundary offset", "2026-10-30T12:34:56+23:59", time.Date(2026, 10, 29, 12, 35, 56, 0, time.UTC)},
		{"leap day", "2028-02-29T00:00:00Z", time.Date(2028, 2, 29, 0, 0, 0, 0, time.UTC)},
		{"one fractional digit", "2026-10-30T12:34:56.7Z", time.Time{}},
		{"two fractional digits", "2026-10-30T12:34:56.78Z", time.Time{}},
		{"six fractional digits", "2026-10-30T12:34:56.123456Z", time.Time{}},
		{"no timezone", "2026-10-30T12:34:56", time.Time{}},
		{"no timezone with millis", "2026-10-30T12:34:56.789", time.Time{}},
		{"semver", "v1.2.3", time.Time{}},
		{"lowercase z", "2026-10-30t12:34:56z", time.Time{}},
		{"space separator", "2026-10-30 12:34:56Z", time.Time{}},
		{"offset without colon", "2026-10-30T12:34:56+0800", time.Time{}},
		{"offset hour out of range", "2026-10-30T12:34:56+24:00", time.Time{}},
		{"offset minute out of range", "2026-10-30T12:34:56+08:60", time.Time{}},
		{"hour out of range", "2026-10-30T24:00:00Z", time.Time{}},
		{"second out of range", "2026-10-30T12:34:60Z", time.Time{}},
		{"month out of range", "2026-13-30T12:34:56Z", time.Time{}},
		{"day out of range", "2026-02-30T12:34:56Z", time.Time{}},
		{"non leap day", "2026-02-29T12:34:56Z", time.Time{}},
		{"zero month", "2026-00-30T12:34:56Z", time.Time{}},
		{"empty", "", time.Time{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := ParseTimestamp(tc.value)
			if tc.want.IsZero() {
				if ok {
					t.Fatalf("ParseTimestamp(%q) = %s, want a rejection", tc.value, got)
				}
				return
			}
			if !ok {
				t.Fatalf("ParseTimestamp(%q) rejected a valid value", tc.value)
			}
			if !got.Equal(tc.want) {
				t.Fatalf("ParseTimestamp(%q) = %s, want %s", tc.value, got.UTC(), tc.want)
			}
			if got.Location() != time.UTC {
				t.Fatalf("ParseTimestamp(%q) location = %s, want UTC", tc.value, got.Location())
			}
		})
	}

	// An invalid timestamp inside an otherwise valid line drops the line.
	bad := `{"sessionId":"s","timestamp":"2026-10-30T12:34:56.7Z","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":2}}}`
	if _, ok := ParseLine(bad); ok {
		t.Fatalf("ParseLine accepted a line with a one-digit millisecond field")
	}
}

func TestCacheCreationEphemeralFieldsAreU64(t *testing.T) {
	// ephemeral_5m_input_tokens / ephemeral_1h_input_tokens are u64
	// (types.rs:52-58), so a negative, fractional or overflowing value fails
	// the whole line instead of being zeroed.
	for _, value := range []string{"-1", "1.5", "1e3", "18446744073709551615", `"7"`, "null"} {
		t.Run(value, func(t *testing.T) {
			for _, field := range []string{"ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"} {
				line := lineWithUsage(`{"input_tokens":1,"output_tokens":2,"cache_creation":{"` + field + `":` + value + `}}`)
				entries := ParseLineEntries(line)
				if len(entries) != 0 {
					t.Fatalf("%s = %s was accepted (%+v), want the line dropped", field, value, entries[0].Usage)
				}
			}
		})
	}

	// A valid breakdown still parses.
	entries := ParseLineEntries(lineWithUsage(`{"input_tokens":1,"output_tokens":2,"cache_creation":{"ephemeral_5m_input_tokens":3,"ephemeral_1h_input_tokens":4}}`))
	if len(entries) != 1 {
		t.Fatalf("got %d entries, want one", len(entries))
	}
	if entries[0].Usage.CacheCreate5m != 3 || entries[0].Usage.CacheCreate1h != 4 {
		t.Fatalf("cache creation = %+v, want (3, 4)", entries[0].Usage)
	}
}

func TestCacheCreationBreakdownWinsOverFlat(t *testing.T) {
	cases := []struct {
		name     string
		usage    string
		want5m   int64
		want1h   int64
		wantFlat bool
	}{
		{
			"breakdown wins over the flat field",
			`{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":1000,"cache_creation":{"ephemeral_5m_input_tokens":300,"ephemeral_1h_input_tokens":700}}`,
			300, 700, true,
		},
		{
			"flat field alone becomes five minutes",
			`{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":1000}`,
			1000, 0, false,
		},
		{
			"empty breakdown zeroes the cache creation tokens",
			`{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":1000,"cache_creation":{}}`,
			0, 0, true,
		},
		{
			"one hour only",
			`{"input_tokens":1,"output_tokens":2,"cache_creation":{"ephemeral_1h_input_tokens":42}}`,
			0, 42, true,
		},
		{
			"null breakdown falls back to the flat field",
			`{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":7,"cache_creation":null}`,
			7, 0, false,
		},
		{
			"neither field present",
			`{"input_tokens":1,"output_tokens":2}`,
			0, 0, false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			entry, ok := ParseLine(lineWithUsage(tc.usage))
			if !ok {
				t.Fatalf("ParseLine rejected the line")
			}
			if entry.Usage.CacheCreate5m != tc.want5m || entry.Usage.CacheCreate1h != tc.want1h {
				t.Fatalf("cache creation = (%d, %d), want (%d, %d)",
					entry.Usage.CacheCreate5m, entry.Usage.CacheCreate1h, tc.want5m, tc.want1h)
			}
			if entry.Usage.HasCacheCreate != tc.wantFlat {
				t.Fatalf("HasCacheCreate = %v, want %v", entry.Usage.HasCacheCreate, tc.wantFlat)
			}
		})
	}
}

func TestSyntheticAndFastModelFlags(t *testing.T) {
	cases := []struct {
		name      string
		model     string
		speed     string
		wantSpeed string
		wantFast  bool
		wantSynth bool
		wantModel string
	}{
		{"synthetic model keeps its raw name", "<synthetic>", "", "", false, true, "<synthetic>"},
		{"fast speed", "claude-opus-4-1", `,"speed":"fast"`, "fast", true, false, "claude-opus-4-1"},
		{"standard speed", "claude-opus-4-1", `,"speed":"standard"`, "standard", false, false, "claude-opus-4-1"},
		{"absent speed", "claude-opus-4-1", "", "", false, false, "claude-opus-4-1"},
		{"fast synthetic", "<synthetic>", `,"speed":"fast"`, "fast", true, true, "<synthetic>"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			line := lineWithMessage(`{"id":"msg_1","model":"` + tc.model + `","usage":{"input_tokens":1,"output_tokens":2` + tc.speed + `}}`)
			entry, ok := ParseLine(line)
			if !ok {
				t.Fatalf("ParseLine rejected the line")
			}
			if entry.Model != tc.wantModel {
				t.Fatalf("Model = %q, want %q", entry.Model, tc.wantModel)
			}
			if entry.IsSynthetic != tc.wantSynth {
				t.Fatalf("IsSynthetic = %v, want %v", entry.IsSynthetic, tc.wantSynth)
			}
			if entry.Usage.Speed != tc.wantSpeed {
				t.Fatalf("Speed = %q, want %q", entry.Usage.Speed, tc.wantSpeed)
			}
			if entry.Usage.Fast != tc.wantFast {
				t.Fatalf("Fast = %v, want %v", entry.Usage.Fast, tc.wantFast)
			}
		})
	}

	// Any other speed string is a deserialization failure (types.rs:60-65).
	for _, speed := range []string{"turbo", "FAST", "fast "} {
		line := lineWithUsage(`{"input_tokens":1,"output_tokens":2,"speed":"` + speed + `"}`)
		if _, ok := ParseLine(line); ok {
			t.Fatalf("ParseLine accepted speed %q", speed)
		}
	}
}

func TestParseLineRequiresTimestampMessageAndTokens(t *testing.T) {
	cases := []struct {
		name string
		line string
	}{
		{"missing timestamp", `{"sessionId":"s","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":2}}}`},
		{"missing message", `{"sessionId":"s","timestamp":"` + validTimestamp + `"}`},
		{"null message", `{"sessionId":"s","timestamp":"` + validTimestamp + `","message":null}`},
		{"missing usage", lineWithMessage(`{"id":"msg_1","model":"m"}`)},
		{"null usage", lineWithMessage(`{"id":"msg_1","model":"m","usage":null}`)},
		{"missing input tokens", lineWithUsage(`{"output_tokens":2}`)},
		{"missing output tokens", lineWithUsage(`{"input_tokens":1}`)},
		{"null input tokens", lineWithUsage(`{"input_tokens":null,"output_tokens":2}`)},
		{"string input tokens", lineWithUsage(`{"input_tokens":"1","output_tokens":2}`)},
		{"fractional input tokens", lineWithUsage(`{"input_tokens":1.5,"output_tokens":2}`)},
		{"negative input tokens", lineWithUsage(`{"input_tokens":-1,"output_tokens":2}`)},
		{"exponent input tokens", lineWithUsage(`{"input_tokens":1e3,"output_tokens":2}`)},
		{"non-numeric session id", `{"sessionId":5,"timestamp":"` + validTimestamp + `","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":2}}}`},
		{"non-boolean sidechain", `{"isSidechain":"true","sessionId":"s","timestamp":"` + validTimestamp + `","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":2}}}`},
		{"non-string model", lineWithMessage(`{"id":"msg_1","model":5,"usage":{"input_tokens":1,"output_tokens":2}}`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, ok := ParseLine(tc.line); ok {
				t.Fatalf("ParseLine accepted an incomplete line")
			}
		})
	}
}

func TestParseLineLargeTokenCounts(t *testing.T) {
	entry, ok := ParseLine(lineWithUsage(`{"input_tokens":9007199254740993,"output_tokens":1}`))
	if !ok {
		t.Fatalf("ParseLine rejected a large but valid token count")
	}
	if entry.Usage.Input != 9007199254740993 {
		t.Fatalf("Input = %d, want 9007199254740993 (no float64 round trip)", entry.Usage.Input)
	}
	// Values above int64 cannot be represented by the adapter's Usage fields;
	// they are rejected rather than wrapped.
	if _, ok := ParseLine(lineWithUsage(`{"input_tokens":18446744073709551615,"output_tokens":1}`)); ok {
		t.Fatalf("ParseLine accepted a token count that overflows int64")
	}
}

func TestParseLineReportsSidechain(t *testing.T) {
	entry, ok := ParseLine(`{"sessionId":"s","isSidechain":true,"timestamp":"` + validTimestamp + `","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":2}}}`)
	if !ok {
		t.Fatalf("ParseLine rejected the line")
	}
	if !entry.Sidechain {
		t.Fatalf("Sidechain = false, want true")
	}
	// isSidechain is not on the null blacklist (lib.rs:867-886), and
	// Option<bool> reads null as absent, so the line survives with a false
	// flag - only an empty-string or mistyped member would drop it.
	entry, ok = ParseLine(`{"sessionId":"s","isSidechain":null,"timestamp":"` + validTimestamp + `","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":2}}}`)
	if !ok {
		t.Fatalf("ParseLine rejected isSidechain null")
	}
	if entry.Sidechain {
		t.Fatalf("Sidechain = true for a null isSidechain, want the absent value")
	}
	if _, ok := ParseLine(`{"sessionId":"s","isSidechain":"true","timestamp":"` + validTimestamp + `","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":2}}}`); ok {
		t.Fatalf("ParseLine accepted a non-boolean isSidechain")
	}
}

func TestAdvisorIterationsBecomeSeparateEntries(t *testing.T) {
	usage := `{"input_tokens":1,"output_tokens":2,"iterations":[` +
		`{"type":"message","model":"skipped","input_tokens":9,"output_tokens":9},` +
		`{"type":"advisor_message","model":"claude-opus-4-1","input_tokens":30,"output_tokens":40,"cache_read_input_tokens":50,"speed":"fast"},` +
		`{"type":"advisor_message","model":"","input_tokens":1,"output_tokens":1},` +
		`{"type":"advisor_message","model":"claude-haiku-4-5","input_tokens":5,"output_tokens":6}]}`
	line := `{"sessionId":"sess-9","version":"2.0.30","timestamp":"` + validTimestamp +
		`","requestId":"req-9","isSidechain":true,"costUSD":0.5,"message":{"id":"msg_9","model":"claude-sonnet-4-5","usage":` + usage + `}}`

	entries := ParseLineEntries(line)
	if len(entries) == 0 {
		t.Fatalf("ParseLineEntries dropped the line")
	}
	if len(entries) != 3 {
		t.Fatalf("got %d entries, want the parent plus two advisors", len(entries))
	}

	parent := entries[0]
	if parent.MessageID != "msg_9" || parent.Model != "claude-sonnet-4-5" {
		t.Fatalf("parent = %+v, want msg_9 / claude-sonnet-4-5", parent)
	}
	if parent.Usage.Input != 1 || parent.Usage.Output != 2 {
		t.Fatalf("parent usage = %+v, want its own top-level usage", parent.Usage)
	}
	if parent.Usage.ReportedCost == nil || *parent.Usage.ReportedCost != 0.5 {
		t.Fatalf("parent ReportedCost = %v, want 0.5", parent.Usage.ReportedCost)
	}

	// Indexes count advisor entries only, in order (lib.rs:559-565).
	first := entries[1]
	if first.MessageID != "msg_9:advisor:0" {
		t.Fatalf("first advisor MessageID = %q, want msg_9:advisor:0", first.MessageID)
	}
	if first.Model != "claude-opus-4-1" {
		t.Fatalf("first advisor Model = %q", first.Model)
	}
	if first.RequestID != "req-9" || first.SessionID != "sess-9" {
		t.Fatalf("advisor did not inherit request/session ids: %+v", first)
	}
	if !first.Sidechain {
		t.Fatalf("advisor did not inherit isSidechain")
	}
	if !first.Timestamp.Equal(parent.Timestamp) {
		t.Fatalf("advisor timestamp = %s, want %s", first.Timestamp, parent.Timestamp)
	}
	if first.Usage.ReportedCost != nil {
		t.Fatalf("advisor ReportedCost = %v, want nil", *first.Usage.ReportedCost)
	}
	if first.Usage.Input != 30 || first.Usage.Output != 40 || first.Usage.CacheRead != 50 {
		t.Fatalf("advisor usage = %+v, want the iteration tokens", first.Usage)
	}
	if first.Usage.Speed != "fast" || !first.Usage.Fast {
		t.Fatalf("advisor speed = %q fast = %v, want fast", first.Usage.Speed, first.Usage.Fast)
	}

	second := entries[2]
	if second.MessageID != "msg_9:advisor:1" || second.Model != "claude-haiku-4-5" {
		t.Fatalf("second advisor = %+v", second)
	}
	if second.Usage.Input != 5 || second.Usage.Output != 6 {
		t.Fatalf("second advisor usage = %+v", second.Usage)
	}

	// ParseLine exposes only the parent entry.
	single, ok := ParseLine(line)
	if !ok || single.MessageID != "msg_9" {
		t.Fatalf("ParseLine = %+v, %v; want the parent entry", single, ok)
	}

	// A parent without a message id cannot name its advisors.
	noID := `{"sessionId":"s","timestamp":"` + validTimestamp +
		`","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":2,"iterations":[{"type":"advisor_message","model":"a","input_tokens":3,"output_tokens":4}]}}}`
	entries = ParseLineEntries(noID)
	if len(entries) == 0 {
		t.Fatalf("ParseLine rejected the id-less parent")
	}
	if len(entries) != 2 {
		t.Fatalf("got %d entries, want parent and advisor", len(entries))
	}
	if entries[1].MessageID != "" || entries[1].Model != "a" {
		t.Fatalf("advisor without a parent id = %+v, want an empty message id", entries[1])
	}

	// Iterations that are malformed cannot be split off at all; the parent
	// still stands (lib.rs:635-641).
	malformed := `{"sessionId":"s","timestamp":"` + validTimestamp +
		`","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":2,"iterations":[{"type":"advisor_message","model":"a"}]}}}`
	entries = ParseLineEntries(malformed)
	if len(entries) == 0 {
		t.Fatalf("ParseLine rejected a line whose iterations lack tokens")
	}
	if len(entries) != 1 {
		t.Fatalf("got %d entries, want the parent only", len(entries))
	}
}

func TestAdvisorIterationSchemaIsAllOrNothing(t *testing.T) {
	base := func(iterations string) string {
		return `{"sessionId":"s","timestamp":"` + validTimestamp +
			`","message":{"id":"msg_1","model":"m","usage":{"input_tokens":1,"output_tokens":2,"iterations":[` + iterations + `]}}}`
	}
	// A missing `type` fails the whole envelope, so no advisor row is added but
	// the parent still stands (lib.rs:621-628, 635-641).
	entries := ParseLineEntries(base(`{"model":"a","input_tokens":3,"output_tokens":4}`))
	if len(entries) != 1 {
		t.Fatalf("got %d entries, want the parent only", len(entries))
	}
	// A malformed iteration token field discards every advisor row, including
	// the well-formed ones earlier in the array.
	entries = ParseLineEntries(base(`{"type":"advisor_message","model":"a","input_tokens":1,"output_tokens":2},` +
		`{"type":"advisor_message","model":"b","input_tokens":"3","output_tokens":4}`))
	if len(entries) != 1 {
		t.Fatalf("got %d entries, want the parent only", len(entries))
	}
	// A non-array iterations member is ignored, not fatal.
	entries = ParseLineEntries(`{"sessionId":"s","timestamp":"` + validTimestamp +
		`","message":{"id":"msg_1","model":"m","usage":{"input_tokens":1,"output_tokens":2,"iterations":{"type":"advisor_message","model":"a","input_tokens":3,"output_tokens":4}}}}`)
	if len(entries) != 1 {
		t.Fatalf("got %d entries, want the parent only", len(entries))
	}

	// A synthetic parent does not mark its advisors synthetic: the flag tracks
	// the entry's own model.
	line := `{"sessionId":"s","timestamp":"` + validTimestamp +
		`","message":{"id":"msg_1","model":"<synthetic>","usage":{"input_tokens":1,"output_tokens":2,"iterations":[{"type":"advisor_message","model":"claude-opus-4-1","input_tokens":3,"output_tokens":4}]}}}`
	entries = ParseLineEntries(line)
	if len(entries) != 2 {
		t.Fatalf("got %d entries, want the parent and one advisor", len(entries))
	}
	if !entries[0].IsSynthetic {
		t.Fatalf("parent IsSynthetic = false, want the <synthetic> marker")
	}
	if entries[1].IsSynthetic {
		t.Fatalf("advisor inherited the parent's synthetic marker")
	}
}

func TestCacheCreationMustBeAnObject(t *testing.T) {
	// Option<CacheCreationRaw> only accepts an object or null: a string or
	// array fails deserialization (types.rs:37-38).
	for _, value := range []string{`"x"`, `5`, `[]`, `true`} {
		line := lineWithUsage(`{"input_tokens":1,"output_tokens":2,"cache_creation":` + value + `}`)
		if _, ok := ParseLine(line); ok {
			t.Fatalf("ParseLine accepted cache_creation %s", value)
		}
	}
	// An empty object still wins over a flat value and yields zeroes.
	entry, ok := ParseLine(lineWithUsage(`{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":9,"cache_creation":{}}`))
	if !ok || !entry.Usage.HasCacheCreate || entry.Usage.CacheCreate5m != 0 {
		t.Fatalf("cache_creation {} = %+v, want HasCacheCreate with zeroes", entry.Usage)
	}
}

func TestParseLinePrefersTheDirectShapeOverTheWrapper(t *testing.T) {
	// serde's untagged enum takes the first variant that deserializes, so a
	// line carrying both a top-level message and the AgentProgress envelope is
	// read as a direct entry (daily.rs:182-187).
	line := `{"sessionId":"direct","timestamp":"` + validTimestamp +
		`","message":{"id":"msg_direct","model":"m","usage":{"input_tokens":1,"output_tokens":2}},` +
		`"data":{"message":{"timestamp":"` + validTimestamp +
		`","message":{"id":"msg_wrapped","model":"m","usage":{"input_tokens":9,"output_tokens":9}}}}}`
	entry, ok := ParseDailyLine(line)
	if !ok {
		t.Fatalf("ParseDailyLine rejected the line")
	}
	if entry.MessageID != "msg_direct" || entry.Usage.Input != 1 {
		t.Fatalf("entry = %+v, want the direct interpretation", entry)
	}
}

func TestBothEntriesFormsReturnParentAndAdvisorRows(t *testing.T) {
	// ccusage's entry loader splits advisor iterations as well (lib.rs:559-598,
	// the loader behind `claude session`), so both collector chains must see
	// the advisor rows. This pins the exported multi-entry API: a regression to
	// a parent-only view would under-count advisor usage in both reports.
	usage := `{"input_tokens":1,"output_tokens":2,"iterations":[{"type":"advisor_message","model":"claude-opus-4-1","input_tokens":30,"output_tokens":40}]}`
	direct := `{"sessionId":"sess-1","timestamp":"` + validTimestamp +
		`","requestId":"req-1","message":{"id":"msg_7","model":"claude-sonnet-4-5","usage":` + usage + `}}`

	for _, tc := range []struct {
		name  string
		parse func(string) []Entry
		line  string
	}{
		{"session chain", ParseLineEntries, direct},
		{"daily chain", ParseDailyLineEntries, direct},
	} {
		t.Run(tc.name, func(t *testing.T) {
			entries := tc.parse(tc.line)
			if len(entries) != 2 {
				t.Fatalf("got %d entries, want the parent plus one advisor", len(entries))
			}
			if entries[0].Model != "claude-sonnet-4-5" || entries[0].Usage.Input != 1 {
				t.Fatalf("parent = %+v, want the top-level usage", entries[0])
			}
			advisor := entries[1]
			if advisor.Model != "claude-opus-4-1" || advisor.Usage.Input != 30 || advisor.Usage.Output != 40 {
				t.Fatalf("advisor = %+v, want the iteration usage", advisor)
			}
			if advisor.MessageID != entries[0].MessageID+":advisor:0" {
				t.Fatalf("advisor MessageID = %q, want %q", advisor.MessageID, entries[0].MessageID+":advisor:0")
			}
			if advisor.Usage.ReportedCost != nil {
				t.Fatalf("advisor ReportedCost = %v, want nil", *advisor.Usage.ReportedCost)
			}
		})
	}

	// The AgentProgress wrapper yields the parent only: upstream's advisor pass
	// parses the raw line's top-level message (daily.rs:368), which a wrapper
	// does not have, so its iterations are never split (lib.rs:635-641).
	wrapped := ParseDailyLineEntries(dailyWrapperLine(`{"timestamp":"` + validTimestamp +
		`","requestId":"req-2","message":{"id":"msg_8","model":"claude-sonnet-4-5","usage":` + usage + `}}`))
	if len(wrapped) != 1 || wrapped[0].MessageID != "msg_8" {
		t.Fatalf("wrapper entries = %+v, want the parent only", wrapped)
	}

	// The parent-only convenience wrappers expose the parent alone and are not
	// for collector use; this documents the difference the doc comments warn
	// about.
	if entry, ok := ParseLine(direct); !ok || entry.MessageID != "msg_7" {
		t.Fatalf("ParseLine = %+v, %v; want the parent", entry, ok)
	}
	if entry, ok := ParseDailyLine(direct); !ok || entry.MessageID != "msg_7" {
		t.Fatalf("ParseDailyLine = %+v, %v; want the parent", entry, ok)
	}
}

func TestBothEntriesFormsRejectTheSameLines(t *testing.T) {
	// Both forms share the scanner, so every gate applies to both.
	for _, line := range []string{
		`{"sessionId":"s","timestamp":"` + validTimestamp + `","message":{"model":"m","usage": {"input_tokens":1,"output_tokens":2}}}`,
		`{"sessionId":"s","timestamp":"2026-10-30T12:34:56.7Z","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":2}}}`,
		`{"sessionId":"","timestamp":"` + validTimestamp + `","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":2}}}`,
		`{"sessionId":"s","timestamp":"` + validTimestamp + `","message":{"id":null,"model":"m","usage":{"input_tokens":1,"output_tokens":2}}}`,
		`{"sessionId":"s","timestamp":"` + validTimestamp + `","timestamp":"` + validTimestamp + `","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":2}}}`,
		`{"sessionId":"s","timestamp":"` + validTimestamp + `","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":2,"cache_creation":{"ephemeral_5m_input_tokens":-1}}}}`,
	} {
		if entries := ParseLineEntries(line); len(entries) != 0 {
			t.Fatalf("ParseLineEntries accepted a line the gates reject: %d entries", len(entries))
		}
		if entries := ParseDailyLineEntries(line); len(entries) != 0 {
			t.Fatalf("ParseDailyLineEntries accepted a line the gates reject: %d entries", len(entries))
		}
	}
}

func TestParseDailyLineAcceptsAgentProgressWrapper(t *testing.T) {
	inner := `{"timestamp":"` + validTimestamp +
		`","requestId":"req-2","isSidechain":true,"costUSD":0.75,"message":{"id":"msg_2","model":"claude-sonnet-4-5","usage":{"input_tokens":7,"output_tokens":8,"cache_creation_input_tokens":9}}}`
	line := dailyWrapperLine(inner)

	entry, ok := ParseDailyLine(line)
	if !ok {
		t.Fatalf("ParseDailyLine rejected an AgentProgress wrapper")
	}
	if entry.MessageID != "msg_2" || entry.RequestID != "req-2" || entry.SessionID != "sess-1" {
		t.Fatalf("wrapper entry = %+v, want msg_2 / req-2 / sess-1", entry)
	}
	if entry.Model != "claude-sonnet-4-5" {
		t.Fatalf("wrapper Model = %q", entry.Model)
	}
	if !entry.Sidechain {
		t.Fatalf("wrapper did not read isSidechain from data.message")
	}
	if entry.Usage.Input != 7 || entry.Usage.Output != 8 || entry.Usage.CacheCreate5m != 9 {
		t.Fatalf("wrapper usage = %+v", entry.Usage)
	}
	if entry.Usage.ReportedCost == nil || *entry.Usage.ReportedCost != 0.75 {
		t.Fatalf("wrapper ReportedCost = %v, want 0.75", entry.Usage.ReportedCost)
	}

	// The wrapper path treats version as absent (daily.rs:196): a top-level
	// version that would fail the semver gate is ignored for this shape.
	withVersion := strings.Replace(line, `{"sessionId":"sess-1",`, `{"sessionId":"sess-1","version":"v1.2.3",`, 1)
	if _, ok := ParseDailyLine(withVersion); !ok {
		t.Fatalf("ParseDailyLine applied the direct-shape version gate to a wrapper line")
	}
	// The entry loader has no wrapper shape at all.
	if _, ok := ParseLine(line); ok {
		t.Fatalf("ParseLine accepted an AgentProgress wrapper")
	}
	// A wrapper whose session id is empty is dropped (daily.rs:403-442).
	emptySession := strings.Replace(line, `"sessionId":"sess-1"`, `"sessionId":""`, 1)
	if _, ok := ParseDailyLine(emptySession); ok {
		t.Fatalf("ParseDailyLine accepted an empty session id")
	}
	// The wrapper requires data.message.message with tokens.
	missingTokens := dailyWrapperLine(`{"timestamp":"` + validTimestamp + `","message":{"id":"msg_2","model":"m","usage":{"input_tokens":1}}}`)
	if _, ok := ParseDailyLine(missingTokens); ok {
		t.Fatalf("ParseDailyLine accepted a wrapper without output_tokens")
	}

	// Direct lines keep working through the daily entry point.
	entry, ok = ParseDailyLine(validLine())
	if !ok || entry.MessageID != "msg_1" {
		t.Fatalf("ParseDailyLine rejected the direct shape")
	}
}

func TestParseLineRejectsTrailingContent(t *testing.T) {
	line := validLine()
	for _, trailing := range []string{`{}`, `x`, `,`} {
		if _, ok := ParseLine(line + trailing); ok {
			t.Fatalf("ParseLine accepted trailing content %q", trailing)
		}
	}
	// JSON whitespace after the object is fine: byte_lines keeps the CR of a
	// CRLF transcript (fast.rs:82-99).
	if _, ok := ParseLine(line + "\r"); !ok {
		t.Fatalf("ParseLine rejected a trailing carriage return")
	}
	if _, ok := ParseLine("  " + line + " "); !ok {
		t.Fatalf("ParseLine rejected surrounding whitespace")
	}
}

func TestParseLineDeepNestingIsBounded(t *testing.T) {
	// serde_json caps recursion at 128 levels; a line deeper than the cap is
	// rejected instead of consuming unbounded parser stack.
	deep := strings.Repeat(`{"x":`, 200) + `1` + strings.Repeat(`}`, 200)
	line := lineWithMessage(`{"id":"msg_1","model":"m","usage":{"input_tokens":1,"output_tokens":2},"extra":` + deep + `}`)
	if _, ok := ParseLine(line); ok {
		t.Fatalf("ParseLine accepted a line nested past the depth cap")
	}
}

func TestParseLineUsageKeepsIntegerPrecision(t *testing.T) {
	for _, value := range []int64{0, 1, math.MaxInt32, 1 << 53, math.MaxInt64} {
		line := lineWithUsage(`{"input_tokens":` + itoa(value) + `,"output_tokens":0}`)
		entry, ok := ParseLine(line)
		if !ok {
			t.Fatalf("ParseLine rejected input_tokens=%d", value)
		}
		if entry.Usage.Input != value {
			t.Fatalf("Input = %d, want %d", entry.Usage.Input, value)
		}
	}
}

func itoa(value int64) string {
	if value == 0 {
		return "0"
	}
	var digits [20]byte
	i := len(digits)
	for value > 0 {
		i--
		digits[i] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[i:])
}
