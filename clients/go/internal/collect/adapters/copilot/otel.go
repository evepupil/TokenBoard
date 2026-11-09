package copilot

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/adapters/tools"
)

// This file ports the OpenTelemetry half of rust/adapters/copilot/src/parser.rs
// (:16-163, 375-839): typed records, the four call classes, the timestamp and
// attribute rules, and the per-record candidate conversion of one exporter file.
// The suppression matrix over all candidates in a file lives in dedupe.go.

// otelRecord is CopilotRecord (parser.rs:22-53). serde refuses a line whose
// declared field has the wrong JSON kind (`type` must be a string, `spanId` a
// string, `attributes` an object, and so on); the remaining fields stay as raw
// values because timestamps arrive as scalars, arrays or strings.
type otelRecord struct {
	raw     map[string]any
	Type    any
	Name    any
	SpanID  any
	TraceID any
	SpanCtx any
	Start   any
	End     any
	Dur     any
	Kind    any
	HRTime  any
	UHRTime any
	Time    any
	TS      any
	ObsTS   any
	UnixNs  any
	Body    any
	UBody   any
	Attrs   map[string]any
}

// decodeOtelRecord is CopilotRecord's Deserialize.
func decodeOtelRecord(value any) (otelRecord, bool) {
	raw, ok := value.(map[string]any)
	if !ok {
		return otelRecord{}, false
	}
	record := otelRecord{raw: raw}
	// Every declared member is read. Type, name, the ids, the body fields and
	// spanContext are Option<Value>, which serde reads whatever the value is,
	// null included (parser.rs:22-53); attributes is Option<Map>, whose typed
	// read refuses any non-object, null included. Rejecting a line serde would
	// keep hides real usage; keeping one serde would drop lets a rejected row
	// name a trace that suppresses another row.
	declared := []struct {
		name string
		dest *any
	}{
		{"type", &record.Type},
		{"name", &record.Name},
		{"spanId", &record.SpanID},
		{"traceId", &record.TraceID},
		{"duration", &record.Dur},
		{"kind", &record.Kind},
		{"body", &record.Body},
		{"_body", &record.UBody},
		{"spanContext", &record.SpanCtx},
		{"startTime", &record.Start},
		{"endTime", &record.End},
		{"hrTime", &record.HRTime},
		{"_hrTime", &record.UHRTime},
		{"time", &record.Time},
		{"timestamp", &record.TS},
		{"observedTimestamp", &record.ObsTS},
		{"timeUnixNano", &record.UnixNs},
	}
	for _, entry := range declared {
		value, present := raw[entry.name]
		if !present {
			continue
		}
		*entry.dest = value
	}
	if attributes, present := raw["attributes"]; present && attributes != nil {
		object, ok := attributes.(map[string]any)
		if !ok {
			return otelRecord{}, false
		}
		record.Attrs = object
	}
	return record, true
}

// otelUsageSource is CopilotUsageSource (parser.rs:95-101). The numeric order
// is the class ladder of to_candidate (parser.rs:407-416).
type otelUsageSource int

const (
	chatSpan otelUsageSource = iota
	inferenceLog
	agentTurnLog
	agentSummarySpan
)

// candidate is CopilotUsageCandidate (parser.rs:110-124).
type candidate struct {
	source       otelUsageSource
	traceID      string
	hasTrace     bool
	responseID   string
	hasResponse  bool
	model        string
	sessionID    string
	timestamp    int64
	input        uint64
	output       uint64
	cacheCreate  uint64
	cacheRead    uint64
	reasoning    uint64
	extra        uint64
	dedupKey     string
	spanID       string
	hasSpan      bool
	turnIndex    string
	hasTurnIndex bool
}

// traceContext is TraceContext (parser.rs:103-108).
type traceContext struct {
	model          string
	hasModel       bool
	sessionID      string
	hasSession     bool
	sessionPhysics uint8
}

// parseOtelFile is parse_otel_file (parser.rs:126-163). ceiling is the instant
// a record without any usable timestamp falls back to when the file's
// modification time cannot be read.
func parseOtelFile(path string, ceiling int64) ([]Entry, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	records := make([]otelRecord, 0)
	forEachJSONLine(content, func(line []byte) bool {
		return containsBytes(line, []byte(`"attributes"`))
	}, DecodeJSONLineStrict, func(value any) {
		if record, ok := decodeOtelRecord(value); ok {
			records = append(records, record)
		}
	})
	contexts := collectTraceContexts(records)
	fallback := fileModifiedTimestamp(path, ceiling)
	candidates := make([]candidate, 0, len(records))
	for index, record := range records {
		if converted, ok := toCandidate(record, index, fallback, contexts); ok {
			candidates = append(candidates, converted)
		}
	}
	// One set of suppression indexes per file (parser.rs:141-146): rebuilding it
	// per candidate is the same answer at candidates×candidates work.
	sets := newCandidateSets(candidates)
	entries := make([]Entry, 0, len(candidates))
	for index, cand := range candidates {
		if !shouldEmitCandidate(index, cand, sets) {
			continue
		}
		entries = append(entries, Entry{
			Timestamp:     cand.timestamp,
			TimestampText: formatRFC3339Millis(cand.timestamp),
			SessionID:     cand.sessionID,
			Model:         cand.model,
			Input:         cand.input,
			Output:        cand.output,
			CacheCreation: cand.cacheCreate,
			CacheRead:     cand.cacheRead,
			Reasoning:     cand.reasoning,
			Extra:         cand.extra,
			RequestCount:  1,
			NanoAiu:       0,
			DedupKey:      cand.dedupKey,
		})
	}
	return entries, nil
}

func formatRFC3339Millis(millis int64) string {
	return time.UnixMilli(millis).UTC().Format("2006-01-02T15:04:05.000Z")
}

// collectTraceContexts is collect_trace_contexts (parser.rs:375-398): per trace,
// the first non-empty model and the best-priority session any record names.
func collectTraceContexts(records []otelRecord) map[string]*traceContext {
	contexts := map[string]*traceContext{}
	for _, record := range records {
		traceID, ok := traceIDFromRecord(record)
		if !ok || record.Attrs == nil {
			continue
		}
		context, present := contexts[traceID]
		if !present {
			context = &traceContext{}
			contexts[traceID] = context
		}
		if !context.hasModel {
			context.model, context.hasModel = firstNonEmptyModelAttr(record.Attrs)
		}
		if sessionID, priority, ok := bestSessionAttr(record.Attrs); ok && priority > context.sessionPhysics {
			context.sessionID, context.hasSession, context.sessionPhysics = sessionID, true, priority
		}
	}
	return contexts
}

// toCandidate is to_candidate (parser.rs:400-492).
func toCandidate(record otelRecord, index int, fallback int64, contexts map[string]*traceContext) (candidate, bool) {
	attributes := record.Attrs
	if attributes == nil {
		return candidate{}, false
	}
	var source otelUsageSource
	switch {
	case isChatSpanRecord(record, attributes):
		source = chatSpan
	case isInferenceLogRecord(record, attributes):
		source = inferenceLog
	case isAgentTurnLogRecord(record, attributes):
		source = agentTurnLog
	case isAgentSummarySpanRecord(record, attributes):
		source = agentSummarySpan
	default:
		return candidate{}, false
	}
	input := attrNumber(attributes, "gen_ai.usage.input_tokens")
	output := attrNumber(attributes, "gen_ai.usage.output_tokens")
	cacheRead := attrNumber(attributes, "gen_ai.usage.cache_read.input_tokens")
	cacheCreation := attrNumberFirst(attributes,
		"gen_ai.usage.cache_write.input_tokens", "gen_ai.usage.cache_creation.input_tokens")
	reasoning := attrNumberFirst(attributes,
		"gen_ai.usage.reasoning.output_tokens", "gen_ai.usage.reasoning_tokens")
	total := attrNumberFirst(attributes,
		"gen_ai.usage.total_tokens", "gen_ai.usage.total.token_count")
	// Copilot counts cache reads and writes in the input tokens, as it does in
	// session-state inputTokens.
	uncachedInput := saturatingSub(input, saturatingAdd(cacheRead, cacheCreation))
	known := saturatingAdd(uncachedInput, output)
	known = saturatingAdd(known, cacheCreation)
	known = saturatingAdd(known, cacheRead)
	missing := saturatingSub(total, known)
	extra := uint64(0)
	if missing > 0 {
		if output == 0 {
			output = missing
		} else {
			extra = missing
		}
	}
	if saturatingAdd(known, missing) == 0 {
		return candidate{}, false
	}
	traceID, hasTrace := traceIDFromRecord(record)
	var context *traceContext
	if hasTrace {
		context = contexts[traceID]
	}
	responseID, hasResponse := attrString(attributes, "gen_ai.response.id")
	model, ok := firstNonEmptyModelAttr(attributes)
	if !ok && context != nil && context.hasModel {
		model, ok = context.model, true
	}
	if !ok {
		model = "unknown"
	}
	sessionID, hasSessionID := bestSessionID(attributes)
	if !hasSessionID && context != nil && context.hasSession {
		sessionID, hasSessionID = context.sessionID, true
	}
	if !hasSessionID && hasTrace {
		sessionID, hasSessionID = traceID, true
	}
	if !hasSessionID {
		sessionID = "unknown-session"
	}
	timestamp, ok := timestampFromRecord(record)
	if !ok {
		timestamp = fallback
	}
	spanID, hasSpan := spanIDFromRecord(record)
	converted := candidate{
		source:      source,
		traceID:     traceID,
		hasTrace:    hasTrace,
		responseID:  responseID,
		hasResponse: hasResponse,
		model:       model,
		sessionID:   sessionID,
		timestamp:   timestamp,
		input:       uncachedInput,
		output:      output,
		cacheCreate: cacheCreation,
		cacheRead:   cacheRead,
		reasoning:   reasoning,
		extra:       extra,
		spanID:      spanID,
		hasSpan:     hasSpan,
	}
	converted.hasTurnIndex = false
	if value, ok := numberValue(attributes["turn.index"]); ok {
		converted.turnIndex, converted.hasTurnIndex = strconv.FormatUint(value, 10), true
	} else if value, ok := numberValue(attributes["copilot_chat.turn.index"]); ok {
		converted.turnIndex, converted.hasTurnIndex = strconv.FormatUint(value, 10), true
	}
	converted.dedupKey = dedupKeyForRecord(source, converted, sessionID, index)
	return converted, true
}

// turnIndex is the AgentTurnLog key input (parser.rs:717-719): turn.index, then
// copilot_chat.turn.index, rendered the way Rust prints a u64.
func turnIndex(attributes map[string]any) (string, bool) {
	if value, ok := numberValue(attributes["turn.index"]); ok {
		return strconv.FormatUint(value, 10), true
	}
	if value, ok := numberValue(attributes["copilot_chat.turn.index"]); ok {
		return strconv.FormatUint(value, 10), true
	}
	return "", false
}

// dedupKeyForRecord is dedup_key_for_record (parser.rs:693-726).
func dedupKeyForRecord(source otelUsageSource, cand candidate, sessionID string, index int) string {
	timestamp := strconv.FormatInt(cand.timestamp, 10)
	switch source {
	case chatSpan, agentSummarySpan:
		if cand.hasTrace && cand.hasSpan {
			return cand.traceID + ":" + cand.spanID
		}
		return "span:" + sessionID + ":" + timestamp + ":" + strconv.Itoa(index)
	case inferenceLog:
		if cand.hasTrace && cand.hasSpan {
			return "log:" + cand.traceID + ":" + cand.spanID
		}
		return "log:" + sessionID + ":" + timestamp + ":" + strconv.Itoa(index)
	default:
		turn := "idx-" + strconv.Itoa(index)
		if cand.hasTurnIndex {
			turn = cand.turnIndex
		}
		if cand.hasTrace {
			return "agent-turn:" + cand.traceID + ":" + turn
		}
		return "agent-turn:" + sessionID + ":" + turn + ":" + strconv.Itoa(index)
	}
}

// sessionAttrs is SESSION_ATTRS (parser.rs:624-631), in tie-break order: among
// equal priorities the last listed attribute wins (max_by_key keeps the later
// maximum).
var sessionAttrs = []struct {
	key      string
	priority uint8
}{
	{"gen_ai.conversation.id", 3},
	{"copilot_chat.session_id", 3},
	{"copilot_chat.chat_session_id", 3},
	{"session.id", 3},
	{"github.copilot.interaction_id", 2},
	{"gen_ai.response.id", 1},
}

// bestSessionAttr is best_session_attr (parser.rs:787-792).
func bestSessionAttr(attributes map[string]any) (string, uint8, bool) {
	var (
		best     string
		priority uint8
		found    bool
	)
	for _, entry := range sessionAttrs {
		value, ok := attrString(attributes, entry.key)
		if !ok {
			continue
		}
		if !found || entry.priority >= priority {
			best, priority, found = value, entry.priority, true
		}
	}
	return best, priority, found
}

func bestSessionID(attributes map[string]any) (string, bool) {
	value, _, ok := bestSessionAttr(attributes)
	return value, ok
}

// modelAttrs is MODEL_ATTRS (parser.rs:623).
var modelAttrs = []string{"gen_ai.response.model", "gen_ai.request.model"}

// firstNonEmptyModelAttr is first_non_empty_model_attr (parser.rs:642-644).
func firstNonEmptyModelAttr(attributes map[string]any) (string, bool) {
	for _, key := range modelAttrs {
		if value, ok := attrString(attributes, key); ok {
			return normalizeCopilotModel(value), true
		}
	}
	return "", false
}

// isSpanRecord is is_span_record (parser.rs:654-665). The record holds no raw
// `type` when the line omitted it or wrote null; both fall through to the shape
// check, which `Option<Value>::as_str` also does.
func isSpanRecord(record otelRecord) bool {
	if text, ok := record.Type.(string); ok {
		return text == "span"
	}
	if _, hasName := stringValue(record.Name); !hasName {
		return false
	}
	_, hasSpanID := stringValue(record.SpanID)
	_, hasTraceID := stringValue(record.TraceID)
	return hasSpanID || hasTraceID || record.Start != nil || record.End != nil ||
		record.Dur != nil || record.Kind != nil
}

func isChatSpanRecord(record otelRecord, attributes map[string]any) bool {
	if !isSpanRecord(record) {
		return false
	}
	if operation, ok := attrString(attributes, "gen_ai.operation.name"); ok && operation == "chat" {
		return true
	}
	name, ok := stringValue(record.Name)
	return ok && strings.HasPrefix(name, "chat ")
}

func isAgentSummarySpanRecord(record otelRecord, attributes map[string]any) bool {
	if !isSpanRecord(record) {
		return false
	}
	if operation, ok := attrString(attributes, "gen_ai.operation.name"); ok && operation == "invoke_agent" {
		return true
	}
	name, ok := stringValue(record.Name)
	return ok && strings.HasPrefix(name, "invoke_agent ")
}

func isInferenceLogRecord(record otelRecord, attributes map[string]any) bool {
	if isSpanRecord(record) {
		return false
	}
	if event, ok := attrString(attributes, "event.name"); ok && event == "gen_ai.client.inference.operation.details" {
		return true
	}
	body, ok := recordBody(record)
	return ok && strings.HasPrefix(body, "GenAI inference:")
}

func isAgentTurnLogRecord(record otelRecord, attributes map[string]any) bool {
	if isSpanRecord(record) {
		return false
	}
	if event, ok := attrString(attributes, "event.name"); ok && event == "copilot_chat.agent.turn" {
		return true
	}
	body, ok := recordBody(record)
	return ok && strings.HasPrefix(body, "copilot_chat.agent.turn")
}

// traceIDFromRecord is trace_id_from_record (parser.rs:728-732).
func traceIDFromRecord(record otelRecord) (string, bool) {
	if value, ok := stringValue(record.TraceID); ok {
		return value, true
	}
	return nestedString(record.SpanCtx, "traceId")
}

// spanIDFromRecord is span_id_from_record (parser.rs:734-738).
func spanIDFromRecord(record otelRecord) (string, bool) {
	if value, ok := stringValue(record.SpanID); ok {
		return value, true
	}
	return nestedString(record.SpanCtx, "spanId")
}

// nestedString is nested_string (parser.rs:740-745).
func nestedString(object any, key string) (string, bool) {
	fields, ok := object.(map[string]any)
	if !ok {
		return "", false
	}
	return stringValue(fields[key])
}

// recordBody is record_body (parser.rs:747-749).
func recordBody(record otelRecord) (string, bool) {
	if value, ok := stringValue(record.Body); ok {
		return value, true
	}
	return stringValue(record.UBody)
}

// stringValue is string_value (parser.rs:751-754): a trimmed non-empty string.
func stringValue(value any) (string, bool) {
	text, ok := value.(string)
	if !ok {
		return "", false
	}
	trimmed := trimRustSpace(text)
	return trimmed, trimmed != ""
}

// numberValue is number_value (parser.rs:756-766): an unsigned JSON integer, a
// negative integer only when it is not (so never), or a decimal string.
func numberValue(value any) (uint64, bool) {
	switch typed := value.(type) {
	case json.Number:
		// serde_json::Number::as_u64: an integer literal that is not negative.
		if strings.ContainsAny(string(typed), ".eE") {
			return 0, false
		}
		if parsed, err := strconv.ParseUint(string(typed), 10, 64); err == nil {
			return parsed, true
		}
		return 0, false
	case string:
		if parsed, err := strconv.ParseUint(trimRustSpace(typed), 10, 64); err == nil {
			return parsed, true
		}
	}
	return 0, false
}

// attrString is attr_string (parser.rs:768-770).
func attrString(attributes map[string]any, key string) (string, bool) {
	return stringValue(attributes[key])
}

// attrNumber is attr_number (parser.rs:772-774).
func attrNumber(attributes map[string]any, key string) uint64 {
	value, _ := numberValue(attributes[key])
	return value
}

// attrNumberFirst is attr_number_first (parser.rs:776-781): the first key whose
// value is positive.
func attrNumberFirst(attributes map[string]any, keys ...string) uint64 {
	for _, key := range keys {
		if value := attrNumber(attributes, key); value > 0 {
			return value
		}
	}
	return 0
}

// timestampFromRecord is timestamp_from_record (parser.rs:794-803).
func timestampFromRecord(record otelRecord) (int64, bool) {
	for _, parts := range []any{record.End, record.Start, record.HRTime, record.UHRTime, record.Time} {
		if value, ok := timestampFromParts(parts); ok {
			return value, true
		}
	}
	for _, scalar := range []any{record.TS, record.ObsTS} {
		if value, ok := timestampFromScalar(scalar); ok {
			return value, true
		}
	}
	return timestampFromUnixNanos(record.UnixNs)
}

// timestampFromParts is timestamp_from_parts (parser.rs:805-811): `[seconds,
// nanos]`, both unsigned integers, millis = seconds * 1000 + nanos / 1e6.
func timestampFromParts(value any) (int64, bool) {
	values, ok := value.([]any)
	if !ok || len(values) < 2 {
		return 0, false
	}
	seconds, ok := numberValue(values[0])
	if !ok {
		return 0, false
	}
	nanos, ok := numberValue(values[1])
	if !ok {
		return 0, false
	}
	// checked_mul / checked_add (parser.rs:809): either step leaving u64
	// answers None instead of wrapping to a tiny millis.
	if seconds > (1<<64-1)/1000 {
		return 0, false
	}
	scaled := seconds * 1000
	if scaled > 1<<64-1-nanos/1_000_000 {
		return 0, false
	}
	return clampMillis(scaled + nanos/1_000_000), true
}

// timestampFromScalar is timestamp_from_scalar (parser.rs:813-825): the unit is
// guessed from the magnitude.
func timestampFromScalar(value any) (int64, bool) {
	raw, ok := numberValue(value)
	if !ok {
		return 0, false
	}
	var millis uint64
	switch {
	case raw >= 100_000_000_000_000_000:
		millis = raw / 1_000_000
	case raw >= 100_000_000_000_000:
		millis = raw / 1_000
	case raw >= 100_000_000_000:
		millis = raw
	default:
		millis = raw * 1_000
	}
	return clampMillis(millis), true
}

// timestampFromUnixNanos is timestamp_from_unix_nanos (parser.rs:827-830): a
// positive value only.
func timestampFromUnixNanos(value any) (int64, bool) {
	raw, ok := numberValue(value)
	if !ok || raw == 0 {
		return 0, false
	}
	return clampMillis(raw / 1_000_000), true
}

// clampMillis is `.min(i64::MAX as u64) as i64`.
func clampMillis(millis uint64) int64 {
	if millis > 1<<63-1 {
		return 1<<63 - 1
	}
	return int64(millis)
}

// fileModifiedTimestamp is file_modified_timestamp (parser.rs:832-839): the
// file's modification time, or ceiling when it cannot be read.
func fileModifiedTimestamp(path string, ceiling int64) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return ceiling
	}
	modified := info.ModTime()
	if modified.Before(time.Unix(0, 0)) {
		return ceiling
	}
	return clampMillis(uint64(modified.UnixMilli()))
}

// forEachJSONLine splits content into lines the way jsonl::records does and
// hands each prefiltered line that decodes to visit.
func forEachJSONLine(content []byte, prefilter func([]byte) bool, decode func([]byte) (any, bool),
	visit func(value any)) {
	for _, line := range strings.Split(string(content), "\n") {
		raw := []byte(strings.TrimSuffix(line, "\r"))
		if len(raw) == 0 || !prefilter(raw) {
			continue
		}
		if value, ok := decode(raw); ok {
			visit(value)
		}
	}
}

func saturatingAdd(left, right uint64) uint64 {
	return tools.SaturatingAddU64(left, right)
}

func saturatingSub(left, right uint64) uint64 {
	return tools.SaturatingSubU64(left, right)
}
