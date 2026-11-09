package codex

// The line prefilter of ccusage's Codex adapter, ported from v20.0.33
// (commit 1308c416): codex_line_usage_kind and codex_line_type_flags in
// rust/adapters/codex/src/parser.rs:661-790. The two stages exist to reject
// most of a rollout with plain substring searches before any JSON parsing, so
// the finders below must stay byte-for-byte identical to the Rust ones.

import "bytes"

// LineKind is CodexLineKind (parser.rs:80-85) plus the outcome Rust models as
// None.
type LineKind int

const (
	// Skip is a line no parser needs: neither a session record nor a headless
	// exec entry.
	Skip LineKind = iota
	// Session is a rollout record the session state machine parses.
	Session
	// Headless is an exec-mode log entry carrying a usage object.
	Headless
)

func (k LineKind) String() string {
	switch k {
	case Session:
		return "Session"
	case Headless:
		return "Headless"
	default:
		return "Skip"
	}
}

// The compact finders (parser.rs:25-47). Each matches the exact byte sequence
// a compactly serialized record contains; their spaced counterparts are only
// searched in the second stage.
var (
	eventMsgTypeFinder              = []byte(`"type":"event_msg"`)
	turnContextTypeFinder           = []byte(`"type":"turn_context"`)
	tokenCountTypeFinder            = []byte(`"type":"token_count"`)
	threadSettingsAppliedTypeFinder = []byte(`"type":"thread_settings_applied"`)
	tokenUsageRecordTypeFinder      = []byte(`"type":"token_usage_record"`)
	compactedTypeFinder             = []byte(`"type":"compacted"`)
	threadSettingsAppliedFinder     = []byte("thread_settings_applied")
	compactTypeFieldFinder          = []byte(`"type":`)
	typeKeyFinder                   = []byte(`"type"`)
	usageFieldFinder                = []byte(`"usage":`)
	inputTokensFieldFinder          = []byte(`"input_tokens":`)
	promptTokensFieldFinder         = []byte(`"prompt_tokens":`)
	nestedTokenCountFinder          = []byte("token_count")
	nestedTokenUsageRecordFinder    = []byte("token_usage_record")
	nestedCompactedFinder           = []byte("compacted")
	nestedTurnContextFinder         = []byte("turn_context")
)

// nestedSearchLimit is the 64 KiB gate on the spaced second stage
// (parser.rs:683-690): a line that large is not scanned for nested types.
const nestedSearchLimit = 64 * 1024

// lineTypeFlags is the tuple codex_line_type_flags returns (parser.rs:714-790).
type lineTypeFlags struct {
	turnContext           bool
	eventMsg              bool
	tokenCount            bool
	threadSettingsApplied bool
	tokenUsageRecord      bool
	compacted             bool
}

// isSession is the caller's verdict from those flags (parser.rs:700-711).
func (f lineTypeFlags) isSession() bool {
	return f.turnContext || f.tokenUsageRecord || f.compacted ||
		(f.eventMsg && (f.tokenCount || f.threadSettingsApplied))
}

// ClassifyLine is codex_line_usage_kind (parser.rs:661-713). Session always
// wins over Headless: a record that looks like a session but also mentions a
// usage field is parsed as a session.
func ClassifyLine(line []byte) LineKind {
	hasEventMsg := bytes.Contains(line, eventMsgTypeFinder)
	hasTokenCount := hasEventMsg && bytes.Contains(line, tokenCountTypeFinder)
	hasThreadSettingsApplied := hasEventMsg && bytes.Contains(line, threadSettingsAppliedTypeFinder)
	if bytes.Contains(line, turnContextTypeFinder) ||
		hasTokenCount ||
		hasThreadSettingsApplied ||
		bytes.Contains(line, tokenUsageRecordTypeFinder) ||
		bytes.Contains(line, compactedTypeFinder) {
		return Session
	}

	hasCompactType := bytes.Contains(line, compactTypeFieldFinder)
	hasNestedTokenCount := !hasEventMsg && hasCompactType && len(line) < nestedSearchLimit &&
		bytes.Contains(line, nestedTokenCountFinder)
	hasNestedThreadSettingsApplied := !hasEventMsg && hasCompactType && len(line) < nestedSearchLimit &&
		bytes.Contains(line, threadSettingsAppliedFinder)
	hasCompactionType := bytes.Contains(line, nestedTokenUsageRecordFinder) ||
		bytes.Contains(line, nestedCompactedFinder)
	if hasEventMsg ||
		bytes.Contains(line, nestedTurnContextFinder) ||
		hasNestedTokenCount ||
		hasNestedThreadSettingsApplied ||
		hasCompactionType ||
		!hasCompactType {
		if codexLineTypeFlags(line).isSession() {
			return Session
		}
	}

	if bytes.Contains(line, usageFieldFinder) ||
		bytes.Contains(line, inputTokensFieldFinder) ||
		bytes.Contains(line, promptTokensFieldFinder) {
		return Headless
	}
	return Skip
}

// codexLineTypeFlags is codex_line_type_flags (parser.rs:714-790): walk every
// "type" key in the line, skipping JSON whitespace, and match its string value
// against the six record values exactly. It returns as soon as a value
// combination decides the line is a session record, which is why the caller
// re-checks the same condition on the returned flags.
func codexLineTypeFlags(line []byte) lineTypeFlags {
	flags := lineTypeFlags{}
	start := 0
	for {
		index := bytes.Index(line[start:], typeKeyFinder)
		if index < 0 {
			return flags
		}
		keyStart := start + index
		cursor := skipJSONWhitespace(line, keyStart+len(typeKeyFinder))
		if cursor >= len(line) || line[cursor] != ':' {
			start = keyStart + len(typeKeyFinder)
			continue
		}
		cursor = skipJSONWhitespace(line, cursor+1)
		if cursor >= len(line) || line[cursor] != '"' {
			// Rust resumes one byte past the offending position, which can run
			// past the end of a line cut short and panic; stopping returns the
			// same flags without crashing on a truncated line.
			start = cursor + 1
			if start >= len(line) {
				return flags
			}
			continue
		}
		cursor++
		flags.turnContext = flags.turnContext || jsonStringValueMatches(line, cursor, "turn_context")
		flags.eventMsg = flags.eventMsg || jsonStringValueMatches(line, cursor, "event_msg")
		flags.tokenCount = flags.tokenCount || jsonStringValueMatches(line, cursor, "token_count")
		flags.threadSettingsApplied = flags.threadSettingsApplied ||
			jsonStringValueMatches(line, cursor, "thread_settings_applied")
		flags.tokenUsageRecord = flags.tokenUsageRecord || jsonStringValueMatches(line, cursor, "token_usage_record")
		flags.compacted = flags.compacted || jsonStringValueMatches(line, cursor, "compacted")
		if flags.isSession() {
			return flags
		}
		start = cursor + 1
		if start > len(line) {
			return flags
		}
	}
}

// jsonStringValueMatches is json_string_value_matches (parser.rs:790-796): the
// value bytes followed by the closing quote, so "token_count_extra" does not
// match "token_count".
func jsonStringValueMatches(line []byte, start int, value string) bool {
	if start+len(value) > len(line) {
		return false
	}
	return string(line[start:start+len(value)]) == value && line[start+len(value)] == '"'
}

// skipJSONWhitespace is skip_json_whitespace (parser.rs:798-803).
func skipJSONWhitespace(line []byte, index int) int {
	for index < len(line) {
		switch line[index] {
		case ' ', '\n', '\r', '\t':
			index++
		default:
			return index
		}
	}
	return index
}
