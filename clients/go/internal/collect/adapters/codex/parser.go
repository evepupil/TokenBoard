package codex

// The line parser of ccusage's Codex adapter, ported from v20.0.33
// (commit 1308c416): visit_codex_session_file_with_compaction_history,
// visit_codex_session_entry, the headless exec path and the timestamp / model
// helpers in rust/adapters/codex/src/parser.rs; the lossy deserialization
// rules in rust/adapters/codex/src/types.rs:278-539; and the strict RFC 3339
// parsing in crates/ccusage-core/src/date_utils.rs:111-161.
//
// The decoder is explicit rather than struct-tag based because serde's
// behaviour is what the events depend on: field names are case sensitive,
// duplicate keys are a parse error, several nested values are "an object or
// absent", and numbers are accepted as integer strings. One deliberate
// difference: a string field carrying a number (e.g. "model": 3) drops the
// line in serde, while this decoder treats it as absent. Codex never writes
// such lines; see the ledger's Task 3 notes.

import (
	"encoding/json"
	"math"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// codexRewriteBurstPauseMillis is CODEX_REWRITTEN_BURST_PAUSE_MS
// (parser.rs:120-127): the longest pause tolerated inside a burst of replayed
// usage before the child's own events are assumed to start.
const codexRewriteBurstPauseMillis = 1_000

// codexAutoReviewModel is CODEX_AUTO_REVIEW_MODEL (parser.rs:45).
const codexAutoReviewModel = "codex-auto-review"

// value is a case-sensitively keyed JSON object plus the line's broken flag.
//
// serde_json validates every str it DECODES: the key of every member on an
// object the typed struct walks (de.rs MapKey::deserialize_any -> read.rs
// parse_str -> as_str -> str::from_utf8) and the value of every modeled string
// field. A single invalid byte in either position fails the whole line. Members
// the struct does not model are skipped without decoding (de.rs ignore_value ->
// read.rs ignore_str, which scans for the closing quote and never validates
// UTF-8), so invalid bytes there fail nothing - the committed fixture's
// 2026-05-24 line pins that: ccusage bills its 9 input tokens.
//
// encoding/json instead replaces invalid bytes with U+FFFD and never fails, so
// the port's only evidence of an invalid byte is that replacement character.
// Codex writes fixed ASCII keys and identifier-shaped modeled strings, so a
// literal U+FFFD in either is a false positive no real log contains. Every
// accessor that decodes a modeled position poisons the shared broken flag;
// decodeSessionEntry and decodeExecEntry turn that into the whole-line failure
// serde performs.
type value struct {
	fields map[string]json.RawMessage
	// broken is shared by every object decoded from the same line.
	broken *bool
}

// repaired reports whether decoding this str had to replace invalid bytes (or
// a lone surrogate escape) with U+FFFD.
func repaired(text string) bool {
	return strings.ContainsRune(text, utf8.RuneError)
}

// newValue starts the flag for one line's root object.
func newValue(fields map[string]json.RawMessage) value {
	root := value{fields: fields, broken: new(bool)}
	root.markRepairedKeys()
	return root
}

// child decodes one nested object on the same line.
func (v value) child(fields map[string]json.RawMessage) value {
	child := value{fields: fields, broken: v.broken}
	child.markRepairedKeys()
	return child
}

// markRepairedKeys is the MapKey half: serde decodes the key of every member of
// an object it walks, so a repaired key fails the line.
func (v value) markRepairedKeys() {
	for key := range v.fields {
		if repaired(key) {
			v.poison()
			return
		}
	}
}

func (v value) poison() {
	if v.broken != nil {
		*v.broken = true
	}
}

// failed reports whether anything decoded from this line would have failed it
// under serde_json.
func (v value) failed() bool {
	return v.broken != nil && *v.broken
}

func isJSONNull(raw json.RawMessage) bool {
	return string(bytesTrimSpace(raw)) == "null"
}

func bytesTrimSpace(raw []byte) []byte {
	start := 0
	for start < len(raw) && isJSONSpace(raw[start]) {
		start++
	}
	end := len(raw)
	for end > start && isJSONSpace(raw[end-1]) {
		end--
	}
	return raw[start:end]
}

func isJSONSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r'
}

// object extracts an optional nested object. Scalars and arrays are absent,
// not a parse error (deserialize_optional_object_lossy, types.rs:358-450).
func (v value) object(key string) value {
	if v.fields == nil {
		return value{}
	}
	raw, ok := v.fields[key]
	if !ok || isJSONNull(raw) {
		return value{}
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return value{}
	}
	return v.child(fields)
}

// stringField is Option<Cow<str>>: a JSON string or absent. A string serde
// would have rejected fails the line instead.
func (v value) stringField(key string) (string, bool) {
	if v.fields == nil {
		return "", false
	}
	raw, ok := v.fields[key]
	if !ok || isJSONNull(raw) {
		return "", false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", false
	}
	if repaired(text) {
		v.poison()
		return "", false
	}
	return text, true
}

// lossyU64 is deserialize_optional_u64_lossy (types.rs:452-539): a JSON
// unsigned integer or a trimmed string of digits; negative, floating point and
// boolean values are absent.
func (v value) lossyU64(key string) (uint64, bool) {
	if v.fields == nil {
		return 0, false
	}
	raw, present := v.fields[key]
	if !present || isJSONNull(raw) {
		return 0, false
	}
	var number uint64
	if err := json.Unmarshal(raw, &number); err == nil {
		return number, true
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return 0, false
	}
	// visit_str receives a decoded &str: serde validates it before the parse.
	if repaired(text) {
		v.poison()
		return 0, false
	}
	number, err := strconv.ParseUint(strings.TrimSpace(text), 10, 64)
	if err != nil {
		return 0, false
	}
	return number, true
}

// firstLossyU64 is Option::or over aliases: the first successfully parsed one
// wins, so an invalid alias does not hide a later valid one.
func (v value) firstLossyU64(keys ...string) (uint64, bool) {
	for _, key := range keys {
		if number, ok := v.lossyU64(key); ok {
			return number, true
		}
	}
	return 0, false
}

// trimmedNonEmpty is non_empty_cow_string: trimmed, absent when empty.
func (v value) trimmedNonEmpty(key string) (string, bool) {
	text, ok := v.stringField(key)
	if !ok {
		return "", false
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", false
	}
	return text, true
}

// timestampValue is CodexTimestamp (types.rs:183-188): a string or an unsigned
// number.
type timestampValue struct {
	text     string
	number   uint64
	isString bool
}

type timestampState int

const (
	timestampAbsent timestampState = iota
	timestampValid
	// timestampInvalid is a present value that is neither a string nor an
	// unsigned integer. serde fails the whole line.
	timestampInvalid
)

func (v value) timestamp(key string) (timestampValue, timestampState) {
	if v.fields == nil {
		return timestampValue{}, timestampAbsent
	}
	raw, ok := v.fields[key]
	if !ok || isJSONNull(raw) {
		return timestampValue{}, timestampAbsent
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return timestampValue{text: text, isString: true}, timestampValid
	}
	var number uint64
	if err := json.Unmarshal(raw, &number); err == nil {
		return timestampValue{number: number}, timestampValid
	}
	return timestampValue{}, timestampInvalid
}

// rawUsageFrom is CodexRawUsage's Deserialize impl (types.rs:278-356).
func rawUsageFrom(v value) (RawUsage, bool) {
	if v.fields == nil {
		return RawUsage{}, false
	}
	input, _ := v.firstLossyU64("input_tokens", "prompt_tokens", "input")
	output, _ := v.firstLossyU64("output_tokens", "completion_tokens", "output")
	reasoning, _ := v.firstLossyU64("reasoning_output_tokens", "reasoning_tokens")
	cached, _ := v.firstLossyU64("cached_input_tokens", "cache_read_input_tokens", "cached_tokens")
	created, _ := v.firstLossyU64("cache_write_input_tokens", "cache_creation_input_tokens")
	total, _ := v.lossyU64("total_tokens")
	usage := RawUsage{
		Input:       input,
		Output:      output,
		Reasoning:   reasoning,
		CachedInput: min(cached, input),
	}
	// A recorded zero total is unusable rather than a free turn; reasoning is
	// part of output, so it is never added on top (types.rs:341-347).
	if total > 0 {
		usage.Total = total
	} else if sum, ok := addUint64(input, output); ok {
		usage.Total = sum
	} else {
		usage.Total = math.MaxUint64
	}
	usage.CacheCreation = min(created, input-usage.CachedInput)
	return usage, true
}

func addUint64(a, b uint64) (uint64, bool) {
	sum := a + b
	return sum, sum >= a
}

// modelFields is the model | model_name | metadata.model triple shared by the
// payload, info, result and top-level shapes (parser.rs:906-924).
type modelFields struct {
	model     string
	modelName string
	metadata  string
}

func decodeModelFields(v value) modelFields {
	var fields modelFields
	fields.model, _ = v.trimmedNonEmpty("model")
	fields.modelName, _ = v.trimmedNonEmpty("model_name")
	if metadata := v.object("metadata"); metadata.fields != nil {
		fields.metadata, _ = metadata.trimmedNonEmpty("model")
	}
	return fields
}

func (f modelFields) first() (string, bool) {
	if f.model != "" {
		return f.model, true
	}
	if f.modelName != "" {
		return f.modelName, true
	}
	if f.metadata != "" {
		return f.metadata, true
	}
	return "", false
}

// infoFields is CodexInfo (types.rs:234-256).
type infoFields struct {
	fields   modelFields
	last     RawUsage
	hasLast  bool
	total    RawUsage
	hasTotal bool
}

func decodeInfo(v value) infoFields {
	var info infoFields
	info.fields = decodeModelFields(v)
	if object := v.object("last_token_usage"); object.fields != nil {
		info.last, info.hasLast = rawUsageFrom(object)
	}
	if object := v.object("total_token_usage"); object.fields != nil {
		info.total, info.hasTotal = rawUsageFrom(object)
	}
	return info
}

// payloadFields is CodexPayload (types.rs:190-228).
type payloadFields struct {
	payloadType          string
	fields               modelFields
	responseID           string
	hasResponseID        bool
	compactionResponseID string
	hasCompactionID      bool
	info                 infoFields
	hasInfo              bool
	usage                RawUsage
	hasUsage             bool
	threadUsage          RawUsage
	hasThreadUsage       bool
	serviceTier          string
	hasServiceTier       bool
}

func decodePayload(v value) payloadFields {
	var payload payloadFields
	if v.fields == nil {
		return payload
	}
	payload.payloadType, _ = v.stringField("type")
	payload.fields = decodeModelFields(v)
	payload.responseID, payload.hasResponseID = v.stringField("response_id")
	payload.compactionResponseID, payload.hasCompactionID = v.stringField("compaction_response_id")
	if object := v.object("info"); object.fields != nil {
		payload.info = decodeInfo(object)
		payload.hasInfo = true
	}
	if object := v.object("usage"); object.fields != nil {
		payload.usage, payload.hasUsage = rawUsageFrom(object)
	}
	if object := v.object("thread_token_usage"); object.fields != nil {
		payload.threadUsage, payload.hasThreadUsage = rawUsageFrom(object)
	}
	if settings := v.object("thread_settings"); settings.fields != nil {
		payload.serviceTier, payload.hasServiceTier = settings.stringField("service_tier")
	}
	return payload
}

func (p payloadFields) model() (string, bool) {
	model, ok := p.fields.first()
	if !ok {
		return p.info.fields.first()
	}
	return model, true
}

// sessionEntry is CodexSessionLogEntry (types.rs:128-140).
type sessionEntry struct {
	entryType    string
	timestamp    timestampValue
	hasTimestamp bool
	payload      payloadFields
}

func decodeSessionEntry(line []byte) (sessionEntry, bool) {
	root, ok := deserializeObject(line)
	if !ok {
		return sessionEntry{}, false
	}
	entry := sessionEntry{}
	entry.entryType, _ = root.stringField("type")
	switch timestamp, state := root.timestamp("timestamp"); state {
	case timestampInvalid:
		return sessionEntry{}, false
	case timestampValid:
		entry.timestamp, entry.hasTimestamp = timestamp, true
	}
	entry.payload = decodePayload(root.object("payload"))
	if root.failed() {
		// One modeled string or key serde would have decoded was not valid
		// UTF-8: serde fails the whole line, and so does the port.
		return sessionEntry{}, false
	}
	return entry, true
}

// resultFields is CodexResultFields (types.rs:258-276).
type resultFields struct {
	fields       modelFields
	timestamp    timestampValue
	hasTimestamp bool
	createdAt    timestampValue
	hasCreatedAt bool
	createdCamel timestampValue
	hasCreated   bool
	usage        RawUsage
	hasUsage     bool
}

func decodeResultFields(v value) (resultFields, bool) {
	var fields resultFields
	fields.fields = decodeModelFields(v)
	switch timestamp, state := v.timestamp("timestamp"); state {
	case timestampInvalid:
		return resultFields{}, false
	case timestampValid:
		fields.timestamp, fields.hasTimestamp = timestamp, true
	}
	switch timestamp, state := v.timestamp("created_at"); state {
	case timestampInvalid:
		return resultFields{}, false
	case timestampValid:
		fields.createdAt, fields.hasCreatedAt = timestamp, true
	}
	switch timestamp, state := v.timestamp("createdAt"); state {
	case timestampInvalid:
		return resultFields{}, false
	case timestampValid:
		fields.createdCamel, fields.hasCreated = timestamp, true
	}
	if object := v.object("usage"); object.fields != nil {
		fields.usage, fields.hasUsage = rawUsageFrom(object)
	}
	return fields, true
}

// execEntry is CodexLogEntry (types.rs:142-165).
type execEntry struct {
	fields       modelFields
	timestamp    timestampValue
	hasTimestamp bool
	createdAt    timestampValue
	hasCreatedAt bool
	createdCamel timestampValue
	hasCreated   bool
	data         resultFields
	hasData      bool
	result       resultFields
	hasResult    bool
	response     resultFields
	hasResponse  bool
	usage        RawUsage
	hasUsage     bool
}

func decodeExecEntry(line []byte) (execEntry, bool) {
	root, ok := deserializeObject(line)
	if !ok {
		return execEntry{}, false
	}
	entry := execEntry{}
	entry.fields = decodeModelFields(root)
	switch timestamp, state := root.timestamp("timestamp"); state {
	case timestampInvalid:
		return execEntry{}, false
	case timestampValid:
		entry.timestamp, entry.hasTimestamp = timestamp, true
	}
	switch timestamp, state := root.timestamp("created_at"); state {
	case timestampInvalid:
		return execEntry{}, false
	case timestampValid:
		entry.createdAt, entry.hasCreatedAt = timestamp, true
	}
	switch timestamp, state := root.timestamp("createdAt"); state {
	case timestampInvalid:
		return execEntry{}, false
	case timestampValid:
		entry.createdCamel, entry.hasCreated = timestamp, true
	}
	if object := root.object("data"); object.fields != nil {
		entry.data, entry.hasData = decodeResultFields(object)
		if !entry.hasData {
			return execEntry{}, false
		}
	}
	if object := root.object("result"); object.fields != nil {
		entry.result, entry.hasResult = decodeResultFields(object)
		if !entry.hasResult {
			return execEntry{}, false
		}
	}
	if object := root.object("response"); object.fields != nil {
		entry.response, entry.hasResponse = decodeResultFields(object)
		if !entry.hasResponse {
			return execEntry{}, false
		}
	}
	if object := root.object("usage"); object.fields != nil {
		entry.usage, entry.hasUsage = rawUsageFrom(object)
	}
	if root.failed() {
		return execEntry{}, false
	}
	return entry, true
}

// deserializeObject decodes one JSON object from a line. Invalid UTF-8 is NOT
// rejected up front: serde only validates the strings it decodes, so bytes in
// skipped members (de.rs ignore_value -> read.rs ignore_str) are legal and the
// committed fixture pins a line that relies on it. The accessors mark
// the ones serde would decode on the line's shared broken flag instead; a
// caller that fails the line calls failed(). Duplicate keys take the last
// value — a documented deviation from serde's "duplicate field" error.
func deserializeObject(line []byte) (value, bool) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(line, &fields); err != nil || fields == nil {
		return value{}, false
	}
	return newValue(fields), true
}

// pendingUsage is CodexPendingUsage (parser.rs:97-100).
type pendingUsage struct {
	event       Event
	threadUsage RawUsage
	hasThread   bool
}

// sessionState is CodexSessionUsageState + CodexCompactionUsageState
// (parser.rs:74-95). compactionHistory is the optional
// recorded_usage_timestamps map (parser.rs:81): filled when a caller wants the
// response ids of usage records that a later compacted marker claimed, which is
// how the replay plan recognizes copied compactions.
type sessionState struct {
	previousTotals         *RawUsage
	currentModel           *string
	currentModelIsFallback bool
	currentServiceTier     *Tier

	compactedIDs      map[string]struct{}
	pending           map[string]pendingUsage
	emittedIDs        map[string]struct{}
	latestUsageID     string
	hasLatestUsage    bool
	compactionHistory map[string]compactionStamp
}

func newSessionState(compactionHistory map[string]compactionStamp) *sessionState {
	return &sessionState{
		compactedIDs:      map[string]struct{}{},
		pending:           map[string]pendingUsage{},
		emittedIDs:        map[string]struct{}{},
		compactionHistory: compactionHistory,
	}
}

// ParseFile visits every usage event in one Codex session log. It is
// visit_codex_session_file (parser.rs:181-190), the form without the compaction
// history output.
//
// replayPrefix is the usage a forked session replayed from its parent:
// nil for sessions that are not forks, and an empty (non-nil) slice for forks
// whose parent log is unavailable, which falls back to the rewritten-burst
// heuristic. Events whose ResponseID is set bypass replay filtering; the
// caller deduplicates copied compactions by response id.
func ParseFile(sessionsDir, path string, replayPrefix []RawUsage, visit func(Event) error) error {
	return parseFile(sessionsDir, path, replayPrefix, nil, visit)
}

// parseFile is visit_codex_session_file_with_compaction_history
// (parser.rs:202-334). A non-nil history collects every usage record's
// response id and parsed timestamp, narrowed at the end of the file to the ids
// a compacted marker claimed (parser.rs:310-322).
func parseFile(sessionsDir, path string, replayPrefix []RawUsage, history map[string]compactionStamp, visit func(Event) error) error {
	reader, openedPath, err := OpenRollout(path)
	if err != nil {
		// An unreadable rollout contributes nothing (parser.rs:204-206).
		return nil
	}
	defer reader.Close()

	sessionID := SessionID(sessionsDir, path)
	fallbackTimestamp := fileModifiedTimestamp(openedPath)
	replay := replayState{kind: replayDone}
	if replayPrefix != nil {
		replay = replayState{kind: replayMatchingParent, prefix: replayPrefix}
	}
	state := newSessionState(history)

	filtered := func(event Event) error {
		if event.ResponseID != "" {
			return visit(event)
		}
		for {
			switch replay.kind {
			case replayMatchingParent:
				if replay.index < len(replay.prefix) && replay.prefix[replay.index] == event.RawUsage {
					replay.index++
					return nil
				}
				replay.kind = replayDone
				if replay.index == 0 {
					if start, ok := detectRewriteBurst(path); ok {
						replay = replayState{kind: replaySkippingBurst, previous: start}
					}
				}
			case replaySkippingBurst:
				if millis, ok := ParseTimestamp(event.Timestamp); ok &&
					millis >= replay.previous && millis-replay.previous <= codexRewriteBurstPauseMillis {
					replay.previous = millis
					return nil
				}
				replay.kind = replayDone
			default:
				return visit(event)
			}
		}
	}

	err = ReadLines(reader, func(line []byte) error {
		switch ClassifyLine(line) {
		case Session:
			entry, ok := decodeSessionEntry(line)
			if !ok {
				return nil
			}
			return state.visitEntry(sessionID, entry, filtered)
		case Headless:
			if entry, ok := decodeExecEntry(line); ok {
				return state.visitExecEntry(sessionID, entry, fallbackTimestamp, filtered)
			}
			return state.visitExecLine(sessionID, line, fallbackTimestamp, filtered)
		default:
			return nil
		}
	})
	if history != nil {
		// Parent identity survives accounting suppression: a copied child can
		// keep a compaction pair while its cumulative snapshot is missing, so
		// only ids a marker claimed are kept (parser.rs:310-322).
		for id := range history {
			if _, compacted := state.compactedIDs[id]; !compacted {
				delete(history, id)
			}
		}
	}
	return err
}

type replayKind int

const (
	replayDone replayKind = iota
	replayMatchingParent
	replaySkippingBurst
)

type replayState struct {
	kind     replayKind
	prefix   []RawUsage
	index    int
	previous int64
}

// visitEntry is visit_codex_session_entry (parser.rs:336-556).
func (state *sessionState) visitEntry(sessionID string, entry sessionEntry, visit func(Event) error) error {
	payload := entry.payload
	if entry.entryType == "compacted" {
		responseID := strings.TrimSpace(payload.compactionResponseID)
		if !payload.hasCompactionID || responseID == "" {
			return nil
		}
		state.compactedIDs[responseID] = struct{}{}
		if pending, ok := state.pending[responseID]; ok {
			delete(state.pending, responseID)
			if _, emitted := state.emittedIDs[responseID]; !emitted {
				state.emittedIDs[responseID] = struct{}{}
				return visit(pending.event)
			}
		}
		return nil
	}
	if entry.entryType == "token_usage_record" {
		return state.visitUsageRecord(sessionID, entry, visit)
	}
	if entry.entryType == "turn_context" {
		if model, ok := payload.fields.first(); ok {
			state.currentModel = &model
			state.currentModelIsFallback = false
		}
		return nil
	}
	if entry.entryType != "event_msg" {
		return nil
	}
	timestamp, ok := sessionTimestamp(entry.timestamp, entry.hasTimestamp)
	if !ok {
		return nil
	}
	if payload.payloadType == "thread_settings_applied" {
		// A settings event that carries no service_tier at all says nothing
		// about the tier (parser.rs:485-497); an unrecognized tier clears it.
		if payload.hasServiceTier {
			state.currentServiceTier = serviceTier(payload.serviceTier)
		}
		return nil
	}
	if payload.payloadType != "token_count" {
		return nil
	}

	var totalUsage *RawUsage
	var total *RawUsage
	if payload.hasInfo && payload.info.hasTotal {
		value := payload.info.total
		total = &value
	}
	if total != nil {
		totalUsage = total
	}
	cumulativeAdvanced := totalUsage == nil || state.previousTotals == nil || *state.previousTotals != *totalUsage
	var rawUsage RawUsage
	var hasRawUsage bool
	if payload.hasInfo && payload.info.hasLast && cumulativeAdvanced {
		rawUsage, hasRawUsage = payload.info.last, true
	} else if totalUsage != nil {
		rawUsage, hasRawUsage = totalUsage.subtract(state.previousTotals), true
	}
	if totalUsage != nil {
		value := *totalUsage
		state.previousTotals = &value
	}
	if !hasRawUsage {
		return nil
	}
	rawUsage = rawUsage.normalize()
	if rawUsage.isZeroWithoutTotal() {
		return nil
	}

	// A local compaction advances the cumulative total between the record and
	// its marker; a remote one does not, so the latest pending request is
	// matched here and its usage counted through this token_count instead
	// (parser.rs:529-548).
	if cumulativeAdvanced && state.hasLatestUsage {
		if pending, ok := state.pending[state.latestUsageID]; ok {
			matches := pending.event.RawUsage == rawUsage
			if !matches && pending.hasThread && totalUsage != nil {
				matches = pending.threadUsage == totalUsage.normalize()
			}
			if matches {
				delete(state.pending, state.latestUsageID)
				state.emittedIDs[state.latestUsageID] = struct{}{}
			}
		}
	}

	parsedModel, hasParsedModel := payload.model()
	model, isFallback := resolveUsageModel(parsedModel, hasParsedModel, timestamp, &state.currentModel, &state.currentModelIsFallback)
	return visit(Event{
		SessionID:       sessionID,
		Timestamp:       timestamp,
		Model:           model,
		IsFallbackModel: isFallback,
		ServiceTier:     state.currentServiceTier,
		RawUsage:        rawUsage,
	})
}

// visitUsageRecord is the token_usage_record arm (parser.rs:363-447).
func (state *sessionState) visitUsageRecord(sessionID string, entry sessionEntry, visit func(Event) error) error {
	payload := entry.payload
	responseID := strings.TrimSpace(payload.responseID)
	if !payload.hasResponseID || responseID == "" {
		return nil
	}
	if _, emitted := state.emittedIDs[responseID]; emitted {
		return nil
	}
	timestamp, ok := sessionTimestamp(entry.timestamp, entry.hasTimestamp)
	if !ok || !payload.hasUsage {
		return nil
	}
	rawUsage := payload.usage.normalize()
	if rawUsage.isZero() {
		return nil
	}
	if state.compactionHistory != nil {
		if _, recorded := state.compactionHistory[responseID]; !recorded {
			millis, parsed := ParseTimestamp(timestamp)
			state.compactionHistory[responseID] = compactionStamp{millis: millis, ok: parsed}
		}
	}
	parsedModel, hasParsedModel := payload.fields.first()
	requestModel := state.currentModel
	requestFallback := state.currentModelIsFallback
	model, isFallback := resolveUsageModel(parsedModel, hasParsedModel, timestamp, &requestModel, &requestFallback)
	event := Event{
		SessionID:       sessionID,
		ResponseID:      responseID,
		Timestamp:       timestamp,
		Model:           model,
		IsFallbackModel: isFallback || !hasParsedModel,
		ServiceTier:     state.currentServiceTier,
		RawUsage:        rawUsage,
	}
	state.latestUsageID, state.hasLatestUsage = responseID, true
	if _, compacted := state.compactedIDs[responseID]; compacted {
		if _, emitted := state.emittedIDs[responseID]; !emitted {
			state.emittedIDs[responseID] = struct{}{}
			return visit(event)
		}
		return nil
	}
	if _, pending := state.pending[responseID]; !pending {
		state.pending[responseID] = pendingUsage{
			event:       event,
			threadUsage: payload.threadUsage.normalize(),
			hasThread:   payload.hasThreadUsage,
		}
	}
	return nil
}

// visitExecEntry is add_codex_exec_event (parser.rs:558-590).
func (state *sessionState) visitExecEntry(sessionID string, entry execEntry, fallbackTimestamp string, visit func(Event) error) error {
	rawUsage, ok := headlessUsage(entry)
	if !ok {
		return nil
	}
	parsedModel, hasParsedModel := execModel(entry)
	eventTimestamp := execTimestamp(entry)
	if eventTimestamp == "" {
		eventTimestamp = fallbackTimestamp
	}
	modelTimestamp := execModelTimestamp(entry)
	if modelTimestamp == "" {
		modelTimestamp = fallbackTimestamp
	}
	return state.visitExecUsage(sessionID, rawUsage, parsedModel, hasParsedModel, eventTimestamp, modelTimestamp, visit)
}

// visitExecLine is add_codex_exec_event_from_value (parser.rs:592-624): the
// shape-lenient fallback used when the typed decode rejects the line.
func (state *sessionState) visitExecLine(sessionID string, line []byte, fallbackTimestamp string, visit func(Event) error) error {
	if !utf8.Valid(line) {
		return nil
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(line, &raw); err != nil || raw == nil {
		return nil
	}
	object := newValue(raw)
	if object.failed() {
		// serde's Value fallback decodes every string and key in the line,
		// so a repaired one fails it even here.
		return nil
	}
	usage, ok := usageFromValue(object)
	if !ok {
		return nil
	}
	rawUsage := usage.normalize()
	if rawUsage.isZero() {
		return nil
	}
	parsedModel, hasParsedModel := modelFromValue(object)
	eventTimestamp := normalizedValueTimestamp(object)
	if eventTimestamp == "" {
		eventTimestamp = fallbackTimestamp
	}
	modelTimestamp := rawOrNormalizedValueTimestamp(object)
	if modelTimestamp == "" {
		modelTimestamp = fallbackTimestamp
	}
	return state.visitExecUsage(sessionID, rawUsage, parsedModel, hasParsedModel, eventTimestamp, modelTimestamp, visit)
}

// visitExecUsage is visit_codex_exec_usage_event (parser.rs:626-658).
func (state *sessionState) visitExecUsage(sessionID string, rawUsage RawUsage, parsedModel string, hasParsedModel bool, eventTimestamp, modelTimestamp string, visit func(Event) error) error {
	model, isFallback := resolveUsageModel(parsedModel, hasParsedModel, modelTimestamp, &state.currentModel, &state.currentModelIsFallback)
	return visit(Event{
		SessionID:       sessionID,
		Timestamp:       eventTimestamp,
		Model:           model,
		IsFallbackModel: isFallback,
		RawUsage:        rawUsage.normalize(),
	})
}

func headlessUsage(entry execEntry) (RawUsage, bool) {
	var usage RawUsage
	ok := false
	if entry.hasUsage {
		usage, ok = entry.usage, true
	} else if entry.hasData && entry.data.hasUsage {
		usage, ok = entry.data.usage, true
	} else if entry.hasResult && entry.result.hasUsage {
		usage, ok = entry.result.usage, true
	} else if entry.hasResponse && entry.response.hasUsage {
		usage, ok = entry.response.usage, true
	}
	usage = usage.normalize()
	if !ok || usage.isZero() {
		return RawUsage{}, false
	}
	return usage, true
}

func execModel(entry execEntry) (string, bool) {
	if model, ok := entry.fields.first(); ok {
		return model, true
	}
	for _, fields := range []resultFields{entry.data, entry.result, entry.response} {
		if model, ok := fields.fields.first(); ok {
			return model, true
		}
	}
	return "", false
}

func execTimestamp(entry execEntry) string {
	for _, candidate := range []struct {
		value   timestampValue
		present bool
	}{
		{entry.timestamp, entry.hasTimestamp},
		{entry.createdAt, entry.hasCreatedAt},
		{entry.createdCamel, entry.hasCreated},
	} {
		if candidate.present {
			if normalized, ok := normalizeTimestampValue(candidate.value); ok {
				return normalized
			}
		}
	}
	for _, fields := range []resultFields{entry.data, entry.result, entry.response} {
		for _, candidate := range []struct {
			value   timestampValue
			present bool
		}{
			{fields.timestamp, fields.hasTimestamp},
			{fields.createdAt, fields.hasCreatedAt},
			{fields.createdCamel, fields.hasCreated},
		} {
			if candidate.present {
				if normalized, ok := normalizeTimestampValue(candidate.value); ok {
					return normalized
				}
			}
		}
	}
	return ""
}

func execModelTimestamp(entry execEntry) string {
	for _, candidate := range []struct {
		value   timestampValue
		present bool
	}{
		{entry.timestamp, entry.hasTimestamp},
		{entry.createdAt, entry.hasCreatedAt},
		{entry.createdCamel, entry.hasCreated},
	} {
		if candidate.present {
			if normalized, ok := rawOrNormalizedTimestampValue(candidate.value); ok {
				return normalized
			}
		}
	}
	for _, fields := range []resultFields{entry.data, entry.result, entry.response} {
		for _, candidate := range []struct {
			value   timestampValue
			present bool
		}{
			{fields.timestamp, fields.hasTimestamp},
			{fields.createdAt, fields.hasCreatedAt},
			{fields.createdCamel, fields.hasCreated},
		} {
			if candidate.present {
				if normalized, ok := rawOrNormalizedTimestampValue(candidate.value); ok {
					return normalized
				}
			}
		}
	}
	return ""
}

// usageFromValue is usage_from_result_value (parser.rs:1002-1022).
func usageFromValue(object value) (RawUsage, bool) {
	if usage, ok := rawUsageFrom(object.object("usage")); ok {
		return usage, true
	}
	for _, key := range []string{"data", "result", "response"} {
		if nested := object.object(key); nested.fields != nil {
			if usage, ok := rawUsageFrom(nested.object("usage")); ok {
				return usage, true
			}
		}
	}
	return RawUsage{}, false
}

// modelFromValue is codex_model_from_result_value (parser.rs:950-983).
func modelFromValue(object value) (string, bool) {
	if model, ok := decodeModelFields(object).first(); ok {
		return model, true
	}
	for _, key := range []string{"data", "result", "response"} {
		if nested := object.object(key); nested.fields != nil {
			if model, ok := decodeModelFields(nested).first(); ok {
				return model, true
			}
		}
	}
	return "", false
}

// normalizedValueTimestamp is codex_timestamp_from_result_value
// (parser.rs:1069-1080).
func normalizedValueTimestamp(object value) string {
	for _, candidate := range append([]value{object}, nestedObjects(object)...) {
		for _, key := range []string{"timestamp", "created_at", "createdAt"} {
			if raw, ok := candidate.fields[key]; ok && !isJSONNull(raw) {
				var item struct {
					value   timestampValue
					present bool
				}
				item.value, item.present = timestampFromRaw(raw)
				if item.present {
					if normalized, ok := normalizeTimestampValue(item.value); ok {
						return normalized
					}
				}
			}
		}
	}
	return ""
}

// rawOrNormalizedValueTimestamp is
// codex_model_timestamp_from_result_value (parser.rs:1082-1097).
func rawOrNormalizedValueTimestamp(object value) string {
	for _, candidate := range append([]value{object}, nestedObjects(object)...) {
		for _, key := range []string{"timestamp", "created_at", "createdAt"} {
			if raw, ok := candidate.fields[key]; ok && !isJSONNull(raw) {
				item, present := timestampFromRaw(raw)
				if present {
					if normalized, ok := rawOrNormalizedTimestampValue(item); ok {
						return normalized
					}
				}
			}
		}
	}
	return ""
}

func nestedObjects(object value) []value {
	nested := make([]value, 0, 3)
	for _, key := range []string{"data", "result", "response"} {
		if child := object.object(key); child.fields != nil {
			nested = append(nested, child)
		}
	}
	return nested
}

func timestampFromRaw(raw json.RawMessage) (timestampValue, bool) {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return timestampValue{text: text, isString: true}, true
	}
	var number uint64
	if err := json.Unmarshal(raw, &number); err == nil {
		return timestampValue{number: number}, true
	}
	return timestampValue{}, false
}

// sessionTimestamp is codex_session_timestamp (parser.rs:805-812): a string is
// trimmed and kept as written - validity is the aggregator's concern - and a
// number is normalized.
func sessionTimestamp(value timestampValue, present bool) (string, bool) {
	if !present {
		return "", false
	}
	if value.isString {
		trimmed := strings.TrimSpace(value.text)
		if trimmed == "" {
			return "", false
		}
		return trimmed, true
	}
	return normalizeTimestampValue(value)
}

// normalizeTimestampValue is normalize_codex_timestamp (parser.rs:1181-1198).
func normalizeTimestampValue(value timestampValue) (string, bool) {
	millis, ok := timestampMillis(value)
	if !ok {
		return "", false
	}
	return FormatTimestamp(millis), true
}

// timestampMillis is the conversion behind normalize_codex_timestamp: a string
// parses strictly, and a number above 10_000_000_000 is already milliseconds
// while anything smaller is seconds.
func timestampMillis(value timestampValue) (int64, bool) {
	if value.isString {
		trimmed := strings.TrimSpace(value.text)
		if trimmed == "" {
			return 0, false
		}
		return ParseTimestamp(trimmed)
	}
	var millis uint64
	if value.number > 10_000_000_000 {
		millis = value.number
	} else {
		millis = value.number * 1_000
	}
	if millis > math.MaxInt64 {
		millis = math.MaxInt64
	}
	return int64(millis), true
}

// rawOrNormalizedTimestampValue is raw_or_normalized_codex_timestamp
// (parser.rs:1156-1179): a string that already starts with a valid date is
// kept verbatim; anything else is normalized so the caller's chain can move on
// to the next candidate field.
func rawOrNormalizedTimestampValue(value timestampValue) (string, bool) {
	if value.isString {
		trimmed := strings.TrimSpace(value.text)
		if trimmed == "" {
			return "", false
		}
		if timestampDate(trimmed) != "" {
			return trimmed, true
		}
		return normalizeTimestampValue(value)
	}
	return normalizeTimestampValue(value)
}

// resolveUsageModel is resolve_codex_usage_model (parser.rs:814-846).
func resolveUsageModel(parsedModel string, hasParsedModel bool, timestamp string, currentModel **string, currentModelIsFallback *bool) (string, bool) {
	if hasParsedModel {
		model := parsedModel
		*currentModel = &model
		*currentModelIsFallback = false
	}
	isFallback := false
	model := parsedModel
	if !hasParsedModel {
		if *currentModel != nil {
			model = **currentModel
		} else {
			isFallback = true
			*currentModelIsFallback = true
			sentinel := "gpt-5"
			*currentModel = &sentinel
			model = sentinel
		}
	}
	// parsed_model_is_missing: while the sentinel stands, every event without
	// its own model is marked as fallback (parser.rs:827-829).
	if *currentModel != nil && *currentModelIsFallback {
		isFallback = true
	}
	if fallback, ok := logModelFallback(model, timestamp); ok {
		isFallback = true
		model = fallback
	}
	return model, isFallback
}

// autoReviewFallback is one entry of codex-auto-review-fallbacks.json, which
// ccusage embeds and reads newest first (parser.rs:45, 833-846).
type autoReviewFallback struct {
	releasedOn string
	model      string
}

var autoReviewFallbacks = []autoReviewFallback{
	{"2026-07-30", "gpt-5.6-luna"},
	{"2026-03-05", "gpt-5.4"},
	{"2026-02-05", "gpt-5.3-codex"},
	{"2025-12-11", "gpt-5.2-codex"},
	{"2025-11-13", "gpt-5.1-codex"},
	{"2025-09-15", "gpt-5-codex"},
	{"2025-08-07", "gpt-5"},
}

// logModelFallback is codex_log_model_fallback (parser.rs:833-846).
func logModelFallback(model, timestamp string) (string, bool) {
	if model != codexAutoReviewModel {
		return "", false
	}
	date := timestampDate(timestamp)
	if date == "" {
		return "gpt-5", true
	}
	for _, fallback := range autoReviewFallbacks {
		if date >= fallback.releasedOn {
			return fallback.model, true
		}
	}
	return "gpt-5", true
}

// timestampDate is codex_timestamp_date (parser.rs:850-868): the leading
// YYYY-MM-DD, validated as a real calendar date.
func timestampDate(timestamp string) string {
	if len(timestamp) < 10 {
		return ""
	}
	date := timestamp[:10]
	if !allASCIIDigits(date[0:4]) || date[4] != '-' ||
		!allASCIIDigits(date[5:7]) || date[7] != '-' ||
		!allASCIIDigits(date[8:10]) {
		return ""
	}
	year := dateNumber(date[0:4])
	month := dateNumber(date[5:7])
	day := dateNumber(date[8:10])
	maxDay := calendarMonthDays(year, month)
	if maxDay == 0 || day < 1 || day > maxDay {
		return ""
	}
	return date
}

func allASCIIDigits(text string) bool {
	for i := 0; i < len(text); i++ {
		if text[i] < '0' || text[i] > '9' {
			return false
		}
	}
	return true
}

func dateNumber(text string) int {
	value := 0
	for i := 0; i < len(text); i++ {
		value = value*10 + int(text[i]-'0')
	}
	return value
}

// calendarMonthDays is codex_days_in_month (parser.rs:878-887); 0 for an invalid
// month.
func calendarMonthDays(year, month int) int {
	switch month {
	case 1, 3, 5, 7, 8, 10, 12:
		return 31
	case 4, 6, 9, 11:
		return 30
	case 2:
		if year%4 == 0 && year%100 != 0 || year%400 == 0 {
			return 29
		}
		return 28
	}
	return 0
}

// serviceTier is codex_service_tier (parser.rs:660-674).
func serviceTier(recorded string) *Tier {
	switch recorded {
	case "default", "standard":
		tier := TierStandard
		return &tier
	case "fast", "priority":
		tier := TierFast
		return &tier
	case "flex":
		tier := TierFlex
		return &tier
	}
	return nil
}

// detectRewriteBurst is detect_rewritten_burst (parser.rs:131-178): the start
// of a rewritten broadcast of replayed usage at the head of the log, if the
// first two usable token_count events come back to back.
func detectRewriteBurst(path string) (int64, bool) {
	reader, _, err := OpenRollout(path)
	if err != nil {
		return 0, false
	}
	defer reader.Close()
	var first int64
	haveFirst := false
	found := false
	var millis int64
	err = ReadLines(reader, func(line []byte) error {
		if ClassifyLine(line) != Session {
			return nil
		}
		entry, ok := decodeSessionEntry(line)
		if !ok {
			return nil
		}
		if entry.entryType != "event_msg" || entry.payload.payloadType != "token_count" {
			return nil
		}
		if !entry.payload.hasInfo || (!entry.payload.info.hasLast && !entry.payload.info.hasTotal) {
			return nil
		}
		timestamp, ok := sessionTimestamp(entry.timestamp, entry.hasTimestamp)
		if !ok {
			return nil
		}
		parsed, ok := ParseTimestamp(timestamp)
		if !ok {
			return nil
		}
		if !haveFirst {
			first, haveFirst, millis = parsed, true, parsed
			return nil
		}
		if parsed >= first && parsed-first <= codexRewriteBurstPauseMillis {
			found, millis = true, first
		}
		return errStopRead
	})
	if err != nil && err != errStopRead {
		return 0, false
	}
	return millis, found
}

// errStopRead ends detect_rewritten_burst's scan at the second usable event.
var errStopRead = errStopReadError{}

type errStopReadError struct{}

func (errStopReadError) Error() string { return "stop" }

// fileModifiedTimestamp is file_modified_timestamp (parser.rs:1268-1283): the
// mtime as RFC 3339 millis, or the epoch when it cannot be read.
func fileModifiedTimestamp(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return FormatTimestamp(0)
	}
	modified := info.ModTime()
	if modified.UnixMilli() < 0 && modified.Before(time.Unix(0, 0)) {
		return FormatTimestamp(0)
	}
	return FormatTimestamp(modified.UnixMilli())
}

// ParseTimestamp is parse_ts_timestamp (date_utils.rs:111-144): the strict
// length-gated RFC 3339 parser, returning milliseconds since the epoch.
//
// Only byte lengths 20 and 25 (whole seconds plus "Z" or an offset) and 24 and
// 29 (exactly three fractional digits plus "Z" or an offset) are accepted, so
// one or six fractional digits, a missing zone and leap seconds are rejected.
func ParseTimestamp(value string) (int64, bool) {
	data := []byte(value)
	var milliseconds int64
	timezoneStart := 0
	switch len(data) {
	case 20, 25:
		switch data[19] {
		case 'Z', '+', '-':
		default:
			return 0, false
		}
		timezoneStart = 19
	case 24, 29:
		if data[19] != '.' || !allASCIIDigits(value[20:23]) {
			return 0, false
		}
		milliseconds = int64(data[20]-'0')*100 + int64(data[21]-'0')*10 + int64(data[22]-'0')
		timezoneStart = 23
	default:
		return 0, false
	}
	if data[4] != '-' || data[7] != '-' || data[10] != 'T' ||
		data[13] != ':' || data[16] != ':' {
		return 0, false
	}
	if !allASCIIDigits(value[0:4]) || !allASCIIDigits(value[5:7]) || !allASCIIDigits(value[8:10]) ||
		!allASCIIDigits(value[11:13]) || !allASCIIDigits(value[14:16]) || !allASCIIDigits(value[17:19]) {
		return 0, false
	}
	year := dateNumber(value[0:4])
	month := dateNumber(value[5:7])
	day := dateNumber(value[8:10])
	hour := dateNumber(value[11:13])
	minute := dateNumber(value[14:16])
	second := dateNumber(value[17:19])
	if hour > 23 || minute > 59 || second > 59 {
		return 0, false
	}
	offsetMinutes, ok := parseTimezoneOffset(value[timezoneStart:])
	if !ok {
		return 0, false
	}
	if month < 1 || month > 12 || day < 1 || day > calendarMonthDays(year, month) {
		return 0, false
	}
	days := daysFromCivil(year, month, day)
	millis := days*86_400_000 +
		int64(hour)*3_600_000 +
		int64(minute)*60_000 +
		int64(second)*1_000 +
		milliseconds
	return millis - offsetMinutes*60_000, true
}

func parseTimezoneOffset(data string) (int64, bool) {
	if data == "Z" {
		return 0, true
	}
	if len(data) != 6 || (data[0] != '+' && data[0] != '-') || data[3] != ':' {
		return 0, false
	}
	if !allASCIIDigits(data[1:3]) || !allASCIIDigits(data[4:6]) {
		return 0, false
	}
	hours := int64(dateNumber(data[1:3]))
	minutes := int64(dateNumber(data[4:6]))
	if hours > 23 || minutes > 59 {
		return 0, false
	}
	offset := hours*60 + minutes
	if data[0] == '-' {
		return -offset, true
	}
	return offset, true
}

// daysFromCivil is date_utils.rs:268-275 (Howard Hinnant's algorithm), kept
// identical so years outside time.Time's comfort zone parse the same way.
func daysFromCivil(year, month, day int) int64 {
	y := int64(year) - b2i64(month <= 2)
	era := floorDiv(y, 400)
	yearOfEra := y - era*400
	monthPrime := int64(month)
	if month > 2 {
		monthPrime -= 3
	} else {
		monthPrime += 9
	}
	dayOfYear := (153*monthPrime+2)/5 + int64(day) - 1
	dayOfEra := yearOfEra*365 + yearOfEra/4 - yearOfEra/100 + dayOfYear
	return era*146_097 + dayOfEra - 719_468
}

func b2i64(condition bool) int64 {
	if condition {
		return 1
	}
	return 0
}

func floorDiv(value, divisor int64) int64 {
	quotient := value / divisor
	if value%divisor != 0 && (value < 0) != (divisor < 0) {
		quotient--
	}
	return quotient
}

// FormatTimestamp is format_rfc3339_millis (date_utils.rs:356-368).
func FormatTimestamp(millis int64) string {
	return time.UnixMilli(millis).UTC().Format("2006-01-02T15:04:05.000Z")
}

// NormalizeTimestamp renders value in the canonical RFC 3339 millisecond form
// (normalize_codex_timestamp's string half, parser.rs:1181-1198), or "" when
// the value is not a parseable timestamp.
func NormalizeTimestamp(value string) string {
	millis, ok := ParseTimestamp(strings.TrimSpace(value))
	if !ok {
		return ""
	}
	return FormatTimestamp(millis)
}
