package claude

// The line parser is the second layer of ccusage's Claude adapter: after the
// discovery layer (paths.go) hands over a transcript, this file decides which
// lines count and what they carry. Every rule cites the upstream source it is
// ported from (ccusage v20.0.33, commit 1308c416):
//
//	rust/adapters/claude/src/lib.rs         entry loader, null blacklist, semver, advisor split
//	rust/adapters/claude/src/daily.rs       AgentProgress wrapper, daily loader
//	rust/crates/ccusage-core/src/types.rs   usage schema, cache_creation breakdown, speed enum
//	rust/crates/ccusage-core/src/date_utils.rs  timestamp length gate and offset validation
//
// The parser reads only token, model, timestamp and session identity fields.
// Prompt, completion and tool payload bytes are validated as JSON but never
// retained.

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
)

const (
	// usageMarker is the byte sequence a line must contain before it is parsed
	// at all (lib.rs:509-512, daily.rs:302-305). The trailing brace makes
	// `"usage": {` a miss, which is what upstream does.
	usageMarker = `"usage":{`
	// nullLiteral selects the strict deep scan (lib.rs:727-736).
	nullLiteral = "null"
	// advisorMarker gates the advisor split (lib.rs:635-638).
	advisorMarker = `"advisor_message"`
	// maxJSONDepth is serde_json's recursion limit. A line nested deeper than
	// this is rejected instead of exhausting the parser stack.
	maxJSONDepth = 128
	// secondMarker is the quoted key form used by the prefilter tests.
	speedStandard = "standard"
	speedFast     = "fast"
)

// blacklistedNullFields are the field names that may never be null at any
// depth (lib.rs:867-886), in the order of the upstream comment.
var blacklistedNullFields = [][]byte{
	[]byte("id"),
	[]byte("cwd"),
	[]byte("model"),
	[]byte("speed"),
	[]byte("costUSD"),
	[]byte("version"),
	[]byte("sessionId"),
	[]byte("requestId"),
	[]byte("isApiErrorMessage"),
	[]byte("cache_read_input_tokens"),
	[]byte("cache_creation_input_tokens"),
}

// Usage is one response's token accounting.
//
// Speed keeps the raw enum value: the empty string means the line carried no
// `speed` member at all, and the only non-empty values are "standard" and
// "fast" because anything else fails deserialization (types.rs:60-65). Task 3
// needs the absent/present distinction for its last replacement rung
// (lib.rs:211), and Task 4 needs Fast to scale the whole request (cost.rs).
//
// HasCacheCreate reports that the line carried a `cache_creation` breakdown
// object. When it is set, CacheCreate5m/CacheCreate1h come from the
// `ephemeral_*` pair and the flat `cache_creation_input_tokens` is ignored
// (types.rs:41-50).
type Usage struct {
	Input          int64
	Output         int64
	CacheCreate5m  int64
	CacheCreate1h  int64
	CacheRead      int64
	HasCacheCreate bool
	// ReportedCost is costUSD. Advisor entries never carry one (lib.rs:568).
	ReportedCost *float64
	Speed        string
	Fast         bool
}

// Entry is one billable line. MessageID, RequestID, SessionID and Model are
// empty when the line omitted them; empty strings are rejected outright
// (lib.rs:676-705), so "" always means "absent".
//
// ProjectPath is not parsed from the line: the caller (Task 5) knows the file
// path and fills it from PathSessionParts, exactly like
// LoadedEntry.project_path (lib.rs:498-500). It stays zero here.
type Entry struct {
	MessageID   string
	RequestID   string
	SessionID   string
	Model       string
	Timestamp   time.Time
	Sidechain   bool
	IsSynthetic bool
	ProjectPath string
	Usage       Usage
}

// ParseLineEntries parses one transcript line for the session/entry chain and
// returns the parent entry followed by one entry per advisor iteration
// (lib.rs:559-600). It returns nil when the line is dropped.
//
// Both collector chains must use a multi-entry form: ccusage's entry loader
// splits advisor iterations too (lib.rs:559-598, the loader behind
// `claude session`), so a parent-only view would silently under-count every
// advisor response in both the daily and the session reports.
func ParseLineEntries(line string) []Entry {
	entries, _ := parseLineEntries(line, false)
	return entries
}

// ParseDailyLineEntries is the daily-chain form of ParseLineEntries. It also
// accepts the AgentProgress wrapper `{"sessionId", "data": {"message": {...}}}`
// (daily.rs:182-227), where the wrapper's own timestamp/message move up one
// level and `version` is treated as absent.
func ParseDailyLineEntries(line string) []Entry {
	entries, _ := parseLineEntries(line, true)
	return entries
}

// ParseLine returns only the parent entry of a line.
//
// WARNING: it drops the advisor entries that ParseLineEntries returns, so a
// collector chain calling it under-counts advisor usage. Collector code must
// use ParseLineEntries; this wrapper exists for tests and for callers that only
// inspect the parent message.
func ParseLine(line string) (Entry, bool) {
	entries := ParseLineEntries(line)
	if len(entries) == 0 {
		return Entry{}, false
	}
	return entries[0], true
}

// ParseDailyLine returns only the parent entry of a daily-chain line, accepting
// the AgentProgress wrapper.
//
// WARNING: like ParseLine it drops advisor entries; the daily collector chain
// must use ParseDailyLineEntries.
func ParseDailyLine(line string) (Entry, bool) {
	entries := ParseDailyLineEntries(line)
	if len(entries) == 0 {
		return Entry{}, false
	}
	return entries[0], true
}

// parseLineEntries is the shared implementation behind the two exported
// wrappers. daily selects whether the AgentProgress wrapper shape is accepted.
func parseLineEntries(line string, daily bool) ([]Entry, bool) {
	if !strings.Contains(line, usageMarker) {
		return nil, false
	}
	scan := &scanner{
		data:     []byte(line),
		nullScan: strings.Contains(line, nullLiteral),
		keys:     make([]keySpan, 0, 8),
	}
	var captured lineCapture
	if !scan.parseObject(kindRoot, target{line: &captured}, false) {
		return nil, false
	}
	if !scan.atEnd() {
		return nil, false
	}

	shape, ok := captured.resolve(daily)
	if !ok {
		return nil, false
	}
	timestamp, ok := ParseTimestamp(shape.timestamp)
	if !ok {
		return nil, false
	}
	if shape.version.present && !validSemverPrefix(shape.version.value) {
		return nil, false
	}
	if emptyButPresent(captured.sessionID) || emptyButPresent(shape.requestID) {
		return nil, false
	}
	if emptyButPresent(shape.message.id) || emptyButPresent(shape.message.model) {
		return nil, false
	}

	parent := Entry{
		MessageID:   shape.message.id.value,
		RequestID:   shape.requestID.value,
		SessionID:   captured.sessionID.value,
		Model:       shape.message.model.value,
		Timestamp:   timestamp,
		Sidechain:   shape.isSidechain.present && shape.isSidechain.value,
		IsSynthetic: shape.message.model.value == "<synthetic>",
		Usage:       shape.message.usage.buildUsage(shape.costUSD),
	}
	entries := []Entry{parent}
	entries = append(entries, advisorEntries(line, parent)...)
	return entries, true
}

// emptyButPresent reports the empty-string skip conditions (lib.rs:676-705).
func emptyButPresent(field strField) bool {
	return field.present && field.value == ""
}

// advisorEntries splits `message.usage.iterations[]` into standalone entries.
//
// Upstream appends every `advisor_message` iteration with a non-empty model as
// its own row, numbered by advisor order rather than by array index
// (lib.rs:559-598, daily.rs:368-398), inheriting the parent's request id,
// session, sidechain flag and timestamp but never its reported cost. The
// parent entry itself is unaffected.
func advisorEntries(line string, parent Entry) []Entry {
	advisors := advisorUsagesFromLine(line)
	if len(advisors) == 0 {
		return nil
	}
	entries := make([]Entry, 0, len(advisors))
	for index, advisor := range advisors {
		entry := parent
		// A parent without a message id cannot name its advisors; upstream
		// leaves the id absent in that case (lib.rs:562-565).
		if parent.MessageID != "" {
			entry.MessageID = parent.MessageID + ":advisor:" + strconv.Itoa(index)
		}
		entry.Model = advisor.model
		entry.Usage = advisor.usage
		// The parent's synthetic marker must not propagate, so IsSynthetic is
		// recomputed from the advisor's own model. Upstream assigns the model
		// directly without re-running the `<synthetic>` check (lib.rs:566),
		// which differs only for an advisor iteration literally named
		// "<synthetic>" - a value no transcript writes. Normalizing here keeps
		// the invariant `IsSynthetic == (Model == "<synthetic>")` true for
		// every Entry, which is what Task 4's breakdown filter relies on.
		entry.IsSynthetic = advisor.model == "<synthetic>"
		entries = append(entries, entry)
	}
	return entries
}

// advisorUsage is one split-off iteration.
type advisorUsage struct {
	model string
	usage Usage
}

// advisorUsagesFromLine mirrors lib.rs:635-658: the raw line must mention
// advisor_message, the top-level message.usage.iterations array must
// deserialize as a whole (a single malformed iteration discards every advisor
// row), and only iterations typed advisor_message with a non-empty model are
// kept. AgentProgress wrappers have no top-level message, so they yield none -
// the same asymmetry upstream has (daily.rs:368 parses the raw line).
func advisorUsagesFromLine(line string) []advisorUsage {
	if !strings.Contains(line, advisorMarker) {
		return nil
	}
	var envelope advisorEnvelope
	if err := json.Unmarshal([]byte(line), &envelope); err != nil {
		// A shape mismatch anywhere in the envelope discards every advisor row.
		return nil
	}
	if envelope.Message == nil || envelope.Message.Usage == nil {
		return nil
	}
	iterations := envelope.Message.Usage.Iterations
	advisors := make([]advisorUsage, 0, len(iterations))
	for _, iteration := range iterations {
		// `type` is a required String in the envelope schema, so a missing or
		// null value fails the whole parse rather than skipping one row
		// (lib.rs:621-628).
		if iteration.Type == nil {
			return nil
		}
		if *iteration.Type != "advisor_message" {
			continue
		}
		if iteration.Model == nil || *iteration.Model == "" {
			continue
		}
		usage, ok := advisorUsageFromIteration(iteration)
		if !ok {
			return nil
		}
		advisors = append(advisors, advisorUsage{model: *iteration.Model, usage: usage})
	}
	return advisors
}

// advisorEnvelope is the `UsageIterationsEnvelope` shape (lib.rs:605-628).
// Message and Usage are pointers so a missing one fails the whole parse, like
// the non-Option fields upstream. model is a pointer because
// `UsageIteration.model` is nullable and exempt from the blacklist.
type advisorEnvelope struct {
	Message *struct {
		Usage *struct {
			Iterations []advisorIteration `json:"iterations"`
		} `json:"usage"`
	} `json:"message"`
}

// advisorIteration flattens TokenUsageRaw next to type/model exactly like
// `#[serde(flatten)] usage: TokenUsageRaw` (lib.rs:621-628). Token pointers
// keep the required input_tokens/output_tokens members distinguishable from an
// absent one.
type advisorIteration struct {
	Type                   *string `json:"type"`
	Model                  *string `json:"model"`
	InputTokens            *int64  `json:"input_tokens"`
	OutputTokens           *int64  `json:"output_tokens"`
	CacheCreateInputTokens *int64  `json:"cache_creation_input_tokens"`
	CacheReadInputTokens   *int64  `json:"cache_read_input_tokens"`
	Speed                  *string `json:"speed"`
	CacheCreation          *struct {
		FiveMinutes *int64 `json:"ephemeral_5m_input_tokens"`
		OneHour     *int64 `json:"ephemeral_1h_input_tokens"`
	} `json:"cache_creation"`
}

// advisorUsageFromIteration applies the same schema rules as a top-level usage
// object. A violation discards every advisor row, matching serde's
// all-or-nothing envelope deserialization.
func advisorUsageFromIteration(iteration advisorIteration) (Usage, bool) {
	if iteration.InputTokens == nil || iteration.OutputTokens == nil {
		return Usage{}, false
	}
	if !validTokenCount(*iteration.InputTokens) || !validTokenCount(*iteration.OutputTokens) {
		return Usage{}, false
	}
	usage := Usage{Input: *iteration.InputTokens, Output: *iteration.OutputTokens}
	if iteration.CacheCreateInputTokens != nil {
		if !validTokenCount(*iteration.CacheCreateInputTokens) {
			return Usage{}, false
		}
		usage.CacheCreate5m = *iteration.CacheCreateInputTokens
	}
	if iteration.CacheReadInputTokens != nil {
		if !validTokenCount(*iteration.CacheReadInputTokens) {
			return Usage{}, false
		}
		usage.CacheRead = *iteration.CacheReadInputTokens
	}
	if iteration.Speed != nil {
		if *iteration.Speed != speedStandard && *iteration.Speed != speedFast {
			return Usage{}, false
		}
		usage.Speed = *iteration.Speed
		usage.Fast = *iteration.Speed == speedFast
	}
	if iteration.CacheCreation != nil {
		usage.HasCacheCreate = true
		if iteration.CacheCreation.FiveMinutes != nil {
			if !validTokenCount(*iteration.CacheCreation.FiveMinutes) {
				return Usage{}, false
			}
			usage.CacheCreate5m = *iteration.CacheCreation.FiveMinutes
		}
		if iteration.CacheCreation.OneHour != nil {
			if !validTokenCount(*iteration.CacheCreation.OneHour) {
				return Usage{}, false
			}
			usage.CacheCreate1h = *iteration.CacheCreation.OneHour
		}
	}
	return usage, true
}

// validTokenCount rejects what serde's u64 field would reject as well as the
// values past int64 (see the overflow note in parseTokenCount).
func validTokenCount(value int64) bool {
	return value >= 0
}

// buildUsage assembles the token accounting (types.rs:41-50).
func (u *usageCapture) buildUsage(cost numField) Usage {
	usage := Usage{
		Input:     u.input.value,
		Output:    u.output.value,
		CacheRead: u.cacheReadIn.value,
		Speed:     u.speed.value,
		Fast:      u.speed.value == speedFast,
	}
	if u.hasCacheCreation {
		usage.HasCacheCreate = true
		usage.CacheCreate5m = u.cacheCreation.fiveMinutes.value
		usage.CacheCreate1h = u.cacheCreation.oneHour.value
	} else {
		usage.CacheCreate5m = u.cacheCreateIn.value
	}
	if cost.present {
		value := cost.value
		usage.ReportedCost = &value
	}
	return usage
}

// ParseTimestamp is the strict length-gated parser of date_utils.rs:111-161.
//
// Only four byte lengths are accepted - 20 and 25 (whole seconds plus "Z" or
// an offset) and 24 and 29 (exactly three fractional digits plus "Z" or an
// offset). Anything else, including one or six fractional digits and a
// missing timezone, is rejected. The returned time is the UTC instant.
func ParseTimestamp(value string) (time.Time, bool) {
	data := []byte(value)
	var milliseconds int64
	tzStart := 0
	switch len(data) {
	case 20, 25:
		switch data[19] {
		case 'Z', '+', '-':
		default:
			return time.Time{}, false
		}
		tzStart = 19
	case 24, 29:
		if data[19] != '.' {
			return time.Time{}, false
		}
		if !allDigits(data[20:23]) {
			return time.Time{}, false
		}
		milliseconds = int64(data[20]-'0')*100 + int64(data[21]-'0')*10 + int64(data[22]-'0')
		tzStart = 23
	default:
		return time.Time{}, false
	}
	if data[4] != '-' || data[7] != '-' || data[10] != 'T' ||
		data[13] != ':' || data[16] != ':' {
		return time.Time{}, false
	}
	if !allDigits(data[0:4]) || !allDigits(data[5:7]) || !allDigits(data[8:10]) ||
		!allDigits(data[11:13]) || !allDigits(data[14:16]) || !allDigits(data[17:19]) {
		return time.Time{}, false
	}
	year := int(data[0]-'0')*1000 + int(data[1]-'0')*100 + int(data[2]-'0')*10 + int(data[3]-'0')
	month := int(data[5]-'0')*10 + int(data[6]-'0')
	day := int(data[8]-'0')*10 + int(data[9]-'0')
	hour := int(data[11]-'0')*10 + int(data[12]-'0')
	minute := int(data[14]-'0')*10 + int(data[15]-'0')
	second := int(data[17]-'0')*10 + int(data[18]-'0')
	if hour > 23 || minute > 59 || second > 59 {
		return time.Time{}, false
	}
	offsetMinutes, ok := parseTimezoneOffset(data[tzStart:])
	if !ok {
		return time.Time{}, false
	}
	if month < 1 || month > 12 || day < 1 || day > daysInMonth(year, time.Month(month)) {
		return time.Time{}, false
	}
	instant := time.Date(year, time.Month(month), day, hour, minute, second, int(milliseconds)*int(time.Millisecond), time.UTC)
	return instant.Add(-time.Duration(offsetMinutes) * time.Minute), true
}

// parseTimezoneOffset mirrors date_utils.rs:147-161: "Z" or ±HH:MM with an
// hour at most 23 and a minute at most 59.
func parseTimezoneOffset(data []byte) (int64, bool) {
	if len(data) == 1 && data[0] == 'Z' {
		return 0, true
	}
	if len(data) != 6 || (data[0] != '+' && data[0] != '-') || data[3] != ':' {
		return 0, false
	}
	if !allDigits(data[1:3]) || !allDigits(data[4:6]) {
		return 0, false
	}
	hours := int64(data[1]-'0')*10 + int64(data[2]-'0')
	minutes := int64(data[4]-'0')*10 + int64(data[5]-'0')
	if hours > 23 || minutes > 59 {
		return 0, false
	}
	offset := hours*60 + minutes
	if data[0] == '-' {
		return -offset, true
	}
	return offset, true
}

// validSemverPrefix mirrors lib.rs:888-908: one or more digits, a dot, one or
// more digits, a dot, then at least one digit. Bytes after the prefix are not
// examined, so "2.0.30-beta" and "2.0.30.1" pass while "v2.0.3" does not.
func validSemverPrefix(value string) bool {
	index := 0
	for index < len(value) && isDigit(value[index]) {
		index++
	}
	if index == 0 || index >= len(value) || value[index] != '.' {
		return false
	}
	index++
	start := index
	for index < len(value) && isDigit(value[index]) {
		index++
	}
	if index == start || index >= len(value) || value[index] != '.' {
		return false
	}
	index++
	return index < len(value) && isDigit(value[index])
}

// ---------------------------------------------------------------------------
// Capture structures
// ---------------------------------------------------------------------------

// strField, intField, numField and boolField record a captured member with the
// three outcomes serde distinguishes: absent, valid, or a type error. A type
// error anywhere in a shape's declared members fails that shape, which is why
// the loader can still prefer the direct shape over AgentProgress.
type strField struct {
	value   string
	present bool
	bad     bool
}

type intField struct {
	value   int64
	present bool
	bad     bool
}

type numField struct {
	value   float64
	present bool
	bad     bool
}

type boolField struct {
	value   bool
	present bool
	bad     bool
}

type cacheCreationCapture struct {
	fiveMinutes intField
	oneHour     intField
	bad         bool
}

type usageCapture struct {
	input            intField
	output           intField
	cacheCreateIn    intField
	cacheReadIn      intField
	speed            strField
	hasCacheCreation bool
	cacheCreation    cacheCreationCapture
}

func (u *usageCapture) valid() bool {
	if !u.input.present || !u.output.present {
		return false
	}
	if u.input.bad || u.output.bad || u.cacheCreateIn.bad || u.cacheReadIn.bad || u.speed.bad {
		return false
	}
	// The ephemeral breakdown fields are u64 too (types.rs:52-58): a negative,
	// fractional or overflowing value fails the whole line rather than being
	// zeroed, so their bad flags have to surface here as well.
	return !u.cacheCreation.bad && !u.cacheCreation.fiveMinutes.bad && !u.cacheCreation.oneHour.bad
}

type messageCapture struct {
	usage    usageCapture
	hasUsage bool
	model    strField
	id       strField
}

func (m *messageCapture) valid() bool {
	return m.hasUsage && m.usage.valid() && !m.model.bad && !m.id.bad
}

type directCapture struct {
	timestamp   strField
	message     messageCapture
	hasMessage  bool
	version     strField
	requestID   strField
	costUSD     numField
	isSidechain boolField
	isAPIError  boolField
}

type wrapperCapture struct {
	timestamp   strField
	message     messageCapture
	hasMessage  bool
	requestID   strField
	costUSD     numField
	isSidechain boolField
}

type lineCapture struct {
	sessionID strField
	direct    directCapture
	wrapper   wrapperCapture
	hasData   bool
}

// resolvedLine is the shape that won, flattened for the shared validity gates.
type resolvedLine struct {
	timestamp   string
	message     *messageCapture
	requestID   strField
	costUSD     numField
	isSidechain boolField
	version     strField
}

// resolve picks the shape the way serde's untagged enum does: the direct shape
// first, then AgentProgress when the caller allows it (daily.rs:182-187).
func (c *lineCapture) resolve(daily bool) (resolvedLine, bool) {
	if c.direct.valid(c) {
		return resolvedLine{
			timestamp:   c.direct.timestamp.value,
			message:     &c.direct.message,
			requestID:   c.direct.requestID,
			costUSD:     c.direct.costUSD,
			isSidechain: c.direct.isSidechain,
			version:     c.direct.version,
		}, true
	}
	if daily && c.hasData && c.wrapper.valid(c) {
		return resolvedLine{
			timestamp:   c.wrapper.timestamp.value,
			message:     &c.wrapper.message,
			requestID:   c.wrapper.requestID,
			costUSD:     c.wrapper.costUSD,
			isSidechain: c.wrapper.isSidechain,
			// The wrapper path treats version as absent (daily.rs:196).
		}, true
	}
	return resolvedLine{}, false
}

func (d *directCapture) valid(c *lineCapture) bool {
	if c.sessionID.bad || d.timestamp.bad || !d.timestamp.present {
		return false
	}
	if !d.hasMessage || !d.message.valid() {
		return false
	}
	return !d.version.bad && !d.requestID.bad && !d.costUSD.bad &&
		!d.isSidechain.bad && !d.isAPIError.bad
}

func (w *wrapperCapture) valid(c *lineCapture) bool {
	if c.sessionID.bad || w.timestamp.bad || !w.timestamp.present {
		return false
	}
	if !w.hasMessage || !w.message.valid() {
		return false
	}
	return !w.requestID.bad && !w.costUSD.bad && !w.isSidechain.bad
}

// ---------------------------------------------------------------------------
// Validating scanner
// ---------------------------------------------------------------------------

// scanner walks one JSON value while enforcing both structural rules ccusage
// applies before typed deserialization: no duplicate object members
// (lib.rs:738-830) and no null on a blacklisted field name at any depth
// (lib.rs:832-886), with the iterations[].model exemption.
//
// Upstream only runs the strict walk when the line contains a null literal
// (lib.rs:727-736); the duplicate-member rule is enforced unconditionally
// here, which is the plan's stated rule and a superset of serde's typed
// duplicate-field rejection. The null check cannot fire without a null
// literal, so gating it explicitly would not change any outcome.
type scanner struct {
	data     []byte
	pos      int
	nullScan bool
	keys     []keySpan
	depth    int
}

type keySpan struct{ start, end int }

// objectKind selects which members of an object are captured. kindGeneric and
// kindIteration capture nothing but still validate structure, nulls and
// duplicates - iteration contents are unknown fields to serde, so only the
// structural rules apply there.
type objectKind uint8

const (
	kindGeneric objectKind = iota
	kindRoot
	kindMessage
	kindUsage
	kindCacheCreation
	kindIteration
	kindWrapperData
	kindAgentMessage
)

// target points the shared member dispatch at the capture it should fill.
type target struct {
	line    *lineCapture
	message *messageCapture
	usage   *usageCapture
	cache   *cacheCreationCapture
}

func (s *scanner) parseObject(kind objectKind, into target, iterationElement bool) bool {
	if s.depth >= maxJSONDepth {
		return false
	}
	s.depth++
	ok := s.parseObjectMembers(kind, into, iterationElement)
	s.depth--
	return ok
}

func (s *scanner) parseObjectMembers(kind objectKind, into target, iterationElement bool) bool {
	s.skipSpace()
	if !s.consume('{') {
		return false
	}
	s.skipSpace()
	if s.consume('}') {
		return true
	}
	base := len(s.keys)
	defer func() { s.keys = s.keys[:base] }()
	for {
		s.skipSpace()
		start, end, ok := s.parseString()
		if !ok {
			return false
		}
		key := s.data[start:end]
		// Keys are compared as raw bytes. A key written with a JSON unicode
		// escape (for example "id" for "id") therefore does not match the
		// blacklist or the duplicate check, while serde unescapes keys before
		// comparing them. Real Claude Code transcripts never escape object key
		// names, so this is a known, deliberate gap rather than a defect to fix
		// here; closing it would require decoding every key on the hot path.
		for _, span := range s.keys[base:] {
			if bytes.Equal(s.data[span.start:span.end], key) {
				return false
			}
		}
		s.keys = append(s.keys, keySpan{start: start, end: end})
		s.skipSpace()
		if !s.consume(':') {
			return false
		}
		s.skipSpace()
		if s.nullScan && s.atNull() && isBlacklistedNullField(key) &&
			!(iterationElement && bytes.Equal(key, []byte("model"))) {
			return false
		}
		if !s.parseMember(kind, key, into) {
			return false
		}
		s.skipSpace()
		if s.consume(',') {
			continue
		}
		if s.consume('}') {
			return true
		}
		return false
	}
}

func (s *scanner) parseMember(kind objectKind, key []byte, into target) bool {
	switch kind {
	case kindRoot:
		switch {
		case keyIs(key, "timestamp"):
			return s.parseStr(&into.line.direct.timestamp)
		case keyIs(key, "message"):
			return s.parseObjectField(kindMessage, target{message: &into.line.direct.message},
				&into.line.direct.hasMessage)
		case keyIs(key, "sessionId"):
			return s.parseStr(&into.line.sessionID)
		case keyIs(key, "version"):
			return s.parseStr(&into.line.direct.version)
		case keyIs(key, "requestId"):
			return s.parseStr(&into.line.direct.requestID)
		case keyIs(key, "costUSD"):
			return s.parseNumberField(&into.line.direct.costUSD)
		case keyIs(key, "isSidechain"):
			return s.parseBoolField(&into.line.direct.isSidechain)
		case keyIs(key, "isApiErrorMessage"):
			return s.parseBoolField(&into.line.direct.isAPIError)
		case keyIs(key, "data"):
			return s.parseObjectField(kindWrapperData, target{line: into.line}, &into.line.hasData)
		}
	case kindWrapperData:
		if keyIs(key, "message") {
			return s.parseObjectField(kindAgentMessage, target{line: into.line},
				&into.line.wrapper.hasMessage)
		}
	case kindAgentMessage:
		switch {
		case keyIs(key, "timestamp"):
			return s.parseStr(&into.line.wrapper.timestamp)
		case keyIs(key, "message"):
			return s.parseObjectField(kindMessage, target{message: &into.line.wrapper.message},
				&into.line.wrapper.hasMessage)
		case keyIs(key, "requestId"):
			return s.parseStr(&into.line.wrapper.requestID)
		case keyIs(key, "costUSD"):
			return s.parseNumberField(&into.line.wrapper.costUSD)
		case keyIs(key, "isSidechain"):
			return s.parseBoolField(&into.line.wrapper.isSidechain)
		}
	case kindMessage:
		switch {
		case keyIs(key, "usage"):
			return s.parseObjectField(kindUsage, target{usage: &into.message.usage},
				&into.message.hasUsage)
		case keyIs(key, "model"):
			return s.parseStr(&into.message.model)
		case keyIs(key, "id"):
			return s.parseStr(&into.message.id)
		}
	case kindUsage:
		switch {
		case keyIs(key, "input_tokens"):
			return s.parseTokenField(&into.usage.input)
		case keyIs(key, "output_tokens"):
			return s.parseTokenField(&into.usage.output)
		case keyIs(key, "cache_creation_input_tokens"):
			return s.parseTokenField(&into.usage.cacheCreateIn)
		case keyIs(key, "cache_read_input_tokens"):
			return s.parseTokenField(&into.usage.cacheReadIn)
		case keyIs(key, "speed"):
			return s.parseSpeedField(&into.usage.speed)
		case keyIs(key, "cache_creation"):
			if s.peek() == '{' {
				into.usage.hasCacheCreation = true
				return s.parseObject(kindCacheCreation,
					target{cache: &into.usage.cacheCreation}, false)
			}
			if !s.atNull() {
				into.usage.cacheCreation.bad = true
			}
			return s.skipValue()
		case keyIs(key, "iterations"):
			if s.peek() == '[' {
				return s.parseArray(kindIteration, target{}, true)
			}
		}
	case kindCacheCreation:
		switch {
		case keyIs(key, "ephemeral_5m_input_tokens"):
			return s.parseTokenField(&into.cache.fiveMinutes)
		case keyIs(key, "ephemeral_1h_input_tokens"):
			return s.parseTokenField(&into.cache.oneHour)
		}
	}
	return s.skipValue()
}

// parseObjectField captures a nested object member. A non-object value marks
// the shape unsatisfied and is skipped, which is what serde's untagged enum
// does when one variant fails to deserialize.
func (s *scanner) parseObjectField(kind objectKind, into target, present *bool) bool {
	if s.peek() != '{' {
		*present = false
		return s.skipValue()
	}
	*present = true
	return s.parseObject(kind, into, false)
}

func (s *scanner) parseArray(kind objectKind, into target, iterationElement bool) bool {
	if s.depth >= maxJSONDepth {
		return false
	}
	s.depth++
	ok := s.parseArrayElements(kind, into, iterationElement)
	s.depth--
	return ok
}

func (s *scanner) parseArrayElements(kind objectKind, into target, iterationElement bool) bool {
	s.skipSpace()
	if !s.consume('[') {
		return false
	}
	s.skipSpace()
	if s.consume(']') {
		return true
	}
	for {
		s.skipSpace()
		if !s.parseValueAs(kind, into, iterationElement) {
			return false
		}
		s.skipSpace()
		if s.consume(',') {
			continue
		}
		if s.consume(']') {
			return true
		}
		return false
	}
}

// parseValueAs consumes one value. Nested arrays are always generic: only the
// array reached from a usage object's `iterations` member exempts its element
// models (lib.rs:855-862).
func (s *scanner) parseValueAs(kind objectKind, into target, iterationElement bool) bool {
	switch s.peek() {
	case '{':
		return s.parseObject(kind, into, iterationElement)
	case '[':
		return s.parseArray(kindGeneric, target{}, false)
	case '"':
		_, _, ok := s.parseString()
		return ok
	case 't', 'f', 'n':
		return s.parseLiteral()
	default:
		_, _, ok := s.parseNumberToken()
		return ok
	}
}

func (s *scanner) skipValue() bool {
	return s.parseValueAs(kindGeneric, target{}, false)
}

// parseStr captures a string member. `null` leaves it absent, which is what
// Option<String> does; a non-string is a type error (unless the null blacklist
// already rejected the line).
func (s *scanner) parseStr(field *strField) bool {
	if s.peek() != '"' {
		if s.atNull() {
			field.present = false
			return s.skipValue()
		}
		field.bad = true
		return s.skipValue()
	}
	start, end, ok := s.parseString()
	if !ok {
		return false
	}
	field.value = decodeJSONString(s.data, start, end)
	field.present = true
	return true
}

// parseSpeedField also enforces the two-value speed enum (types.rs:60-65).
func (s *scanner) parseSpeedField(field *strField) bool {
	if !s.parseStr(field) {
		return false
	}
	if field.present && field.value != speedStandard && field.value != speedFast {
		field.bad = true
	}
	return true
}

func (s *scanner) parseNumberField(field *numField) bool {
	if s.atNull() {
		field.present = false
		return s.skipValue()
	}
	start, end, ok := s.parseNumberToken()
	if !ok {
		field.bad = true
		return false
	}
	value, err := strconv.ParseFloat(string(s.data[start:end]), 64)
	if err != nil {
		field.bad = true
		return true
	}
	field.value = value
	field.present = true
	return true
}

func (s *scanner) parseBoolField(field *boolField) bool {
	value, ok, null := s.parseBoolToken()
	if null {
		field.present = false
		return true
	}
	if !ok {
		field.bad = true
		return s.skipValue()
	}
	field.value = value
	field.present = true
	return true
}

// parseTokenField captures a token member. serde's u64 rejects negatives,
// fractions, exponents and null, so all of those fail the line.
func (s *scanner) parseTokenField(field *intField) bool {
	if s.atNull() {
		field.bad = true
		return s.skipValue()
	}
	start, end, ok := s.parseNumberToken()
	if !ok {
		field.bad = true
		return false
	}
	value, ok := parseTokenCount(s.data[start:end])
	if !ok {
		field.bad = true
		return true
	}
	field.value = value
	field.present = true
	return true
}

// parseTokenCount accepts only a plain non-negative decimal integer that fits
// in int64.
//
// ccusage stores tokens as u64, so the representable upper bound is a
// deliberately narrowed one: values above math.MaxInt64 are rejected here
// rather than wrapped or clamped, keeping the fail-closed direction.
func parseTokenCount(raw []byte) (int64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var value int64
	for _, digit := range raw {
		if digit < '0' || digit > '9' {
			// Rejects signs, fractions and exponents: a float is not a u64.
			return 0, false
		}
		if value > (math.MaxInt64-int64(digit-'0'))/10 {
			return 0, false
		}
		value = value*10 + int64(digit-'0')
	}
	return value, true
}

// ---------------------------------------------------------------------------
// Lexical helpers
// ---------------------------------------------------------------------------

func (s *scanner) peek() byte {
	if s.pos >= len(s.data) {
		return 0
	}
	return s.data[s.pos]
}

func (s *scanner) consume(want byte) bool {
	if s.peek() != want {
		return false
	}
	s.pos++
	return true
}

func (s *scanner) skipSpace() {
	for s.pos < len(s.data) {
		switch s.data[s.pos] {
		case ' ', '\t', '\n', '\r':
			s.pos++
		default:
			return
		}
	}
}

func (s *scanner) atEnd() bool {
	s.skipSpace()
	return s.pos == len(s.data)
}

func (s *scanner) atNull() bool {
	return bytes.HasPrefix(s.data[s.pos:], []byte("null"))
}

// parseString consumes a JSON string and returns its content bounds (without
// the quotes), validating escapes on the way.
func (s *scanner) parseString() (start, end int, ok bool) {
	if s.peek() != '"' {
		return 0, 0, false
	}
	s.pos++
	start = s.pos
	for s.pos < len(s.data) {
		switch s.data[s.pos] {
		case '"':
			end = s.pos
			s.pos++
			return start, end, true
		case '\\':
			s.pos++
			if s.pos >= len(s.data) {
				return 0, 0, false
			}
			switch s.data[s.pos] {
			case '"', '\\', '/', 'b', 'f', 'n', 'r', 't':
				s.pos++
			case 'u':
				if s.pos+4 >= len(s.data) {
					return 0, 0, false
				}
				for offset := 1; offset <= 4; offset++ {
					if !isHexDigit(s.data[s.pos+offset]) {
						return 0, 0, false
					}
				}
				s.pos += 5
			default:
				return 0, 0, false
			}
		default:
			if s.data[s.pos] < 0x20 {
				return 0, 0, false
			}
			s.pos++
		}
	}
	return 0, 0, false
}

// parseNumberToken validates the JSON number grammar and returns its bounds.
func (s *scanner) parseNumberToken() (start, end int, ok bool) {
	start = s.pos
	if s.peek() == '-' {
		s.pos++
	}
	digits := 0
	for s.pos < len(s.data) && isDigit(s.data[s.pos]) {
		s.pos++
		digits++
	}
	if digits == 0 {
		return 0, 0, false
	}
	if digits > 1 && s.data[start] == '0' {
		return 0, 0, false
	}
	if digits > 1 && s.data[start] == '-' && s.data[start+1] == '0' {
		return 0, 0, false
	}
	if s.peek() == '.' {
		s.pos++
		fraction := 0
		for s.pos < len(s.data) && isDigit(s.data[s.pos]) {
			s.pos++
			fraction++
		}
		if fraction == 0 {
			return 0, 0, false
		}
	}
	if s.peek() == 'e' || s.peek() == 'E' {
		s.pos++
		if s.peek() == '+' || s.peek() == '-' {
			s.pos++
		}
		exponent := 0
		for s.pos < len(s.data) && isDigit(s.data[s.pos]) {
			s.pos++
			exponent++
		}
		if exponent == 0 {
			return 0, 0, false
		}
	}
	return start, s.pos, true
}

func (s *scanner) parseLiteral() bool {
	switch {
	case bytes.HasPrefix(s.data[s.pos:], []byte("true")):
		s.pos += 4
	case bytes.HasPrefix(s.data[s.pos:], []byte("false")):
		s.pos += 5
	case bytes.HasPrefix(s.data[s.pos:], []byte("null")):
		s.pos += 4
	default:
		return false
	}
	return s.atValueEnd()
}

func (s *scanner) parseBoolToken() (value, ok, null bool) {
	switch {
	case bytes.HasPrefix(s.data[s.pos:], []byte("true")):
		s.pos += 4
		return true, s.atValueEnd(), false
	case bytes.HasPrefix(s.data[s.pos:], []byte("false")):
		s.pos += 5
		return false, s.atValueEnd(), false
	case bytes.HasPrefix(s.data[s.pos:], []byte("null")):
		s.pos += 4
		return false, s.atValueEnd(), true
	default:
		return false, false, false
	}
}

func (s *scanner) atValueEnd() bool {
	if s.pos >= len(s.data) {
		return true
	}
	switch s.data[s.pos] {
	case ',', '}', ']', ' ', '\t', '\n', '\r':
		return true
	}
	return false
}

// decodeJSONString returns the unescaped string. Transcript keys and values are
// overwhelmingly escape-free, so the fast path avoids the decoder.
func decodeJSONString(data []byte, start, end int) string {
	content := data[start:end]
	if bytes.IndexByte(content, '\\') < 0 {
		return string(content)
	}
	var decoded string
	if err := json.Unmarshal(data[start-1:end+1], &decoded); err != nil {
		// parseString already validated the escapes, so this cannot fail; an
		// empty value keeps the adapter fail-closed rather than guessing.
		return ""
	}
	return decoded
}

func keyIs(key []byte, literal string) bool {
	return len(key) == len(literal) && string(key) == literal
}

func isBlacklistedNullField(key []byte) bool {
	for _, field := range blacklistedNullFields {
		if bytes.Equal(key, field) {
			return true
		}
	}
	return false
}

func isDigit(value byte) bool { return value >= '0' && value <= '9' }

func isHexDigit(value byte) bool {
	return isDigit(value) || (value >= 'a' && value <= 'f') || (value >= 'A' && value <= 'F')
}

func allDigits(data []byte) bool {
	for _, value := range data {
		if !isDigit(value) {
			return false
		}
	}
	return len(data) > 0
}
