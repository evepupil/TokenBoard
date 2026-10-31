package sessionfile

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// ParseInput describes one session file parse.
type ParseInput struct {
	Source      contract.Source
	Timezone    string
	CollectedAt string
	SessionID   string
}

// ParseResult is what a hook sync records from one file.
type ParseResult struct {
	Snapshots                  []contract.Snapshot
	IgnoredUploadSafeRows      int
	SkippedOversizedRows       int
	LargestSkippedOversizedRow int64
	MalformedRows              int
	MissingCost                bool
	UnparsedTokenLikeRows      int
}

type metricRow struct {
	usageDate           string
	model               string
	inputTokens         float64
	outputTokens        float64
	cacheCreationTokens float64
	cacheReadTokens     float64
	totalTokens         float64
	costUSD             float64
	hasCost             bool
}

type aggregateRow struct {
	metricRow
	sessions map[string]bool
}

type parseState struct {
	rows                  map[string]*aggregateRow
	ignoredUploadSafeRows int
	skippedOversizedRows  int
	largestSkippedBytes   int64
	malformedRows         int
	missingCost           bool
	unparsedTokenLikeRows int
}

// Parse consumes the lines of one session file. The timezone must already be
// valid; an unloadable zone fails with the TS message so a caller sees the
// same diagnostic either side of the migration.
func Parse(input ParseInput, lines []Line) (ParseResult, error) {
	location, err := contract.LoadLocation(input.Timezone)
	if err != nil {
		return ParseResult{}, &timezoneError{timezone: input.Timezone}
	}
	state := &parseState{rows: map[string]*aggregateRow{}}
	for _, line := range lines {
		if line.Skipped {
			state.skippedOversizedRows++
			if line.ByteLength > state.largestSkippedBytes {
				state.largestSkippedBytes = line.ByteLength
			}
			continue
		}
		if err := consumeLine(state, input, location, line.Text); err != nil {
			return ParseResult{}, err
		}
	}
	return finish(state, input)
}

// ParseLines consumes the lines of one session file as they are read, the way
// the TS `parseSessionJsonlLines` consumes its async iterable: the caller
// streams from disk and nothing holds the whole file in memory. `Parse`
// remains for callers that already hold the lines (tests, golden fixtures).
func ParseLines(input ParseInput, lines func(yield func(Line) error) error) (ParseResult, error) {
	location, err := contract.LoadLocation(input.Timezone)
	if err != nil {
		return ParseResult{}, &timezoneError{timezone: input.Timezone}
	}
	state := &parseState{rows: map[string]*aggregateRow{}}
	err = lines(func(line Line) error {
		if line.Skipped {
			state.skippedOversizedRows++
			if line.ByteLength > state.largestSkippedBytes {
				state.largestSkippedBytes = line.ByteLength
			}
			return nil
		}
		return consumeLine(state, input, location, line.Text)
	})
	if err != nil {
		return ParseResult{}, err
	}
	return finish(state, input)
}

type timezoneError struct{ timezone string }

func (e *timezoneError) Error() string {
	return "Invalid timezone for session JSONL formatDate: " + e.timezone
}

func consumeLine(state *parseState, input ParseInput, location *time.Location, line string) error {
	record, malformed := readLineRecord(line)
	if malformed {
		state.malformedRows++
		return nil
	}
	if record == nil {
		return nil
	}

	var metric *metricRow
	if input.Source == contract.SourceCodex {
		metric = readCodexMetric(record, location)
	} else {
		metric = readClaudeMetric(record, location)
	}
	if metric == nil {
		if isKnownCodexTokenMetadata(input.Source, record) {
			return nil
		}
		if isKnownClaudeSyntheticZeroUsage(input.Source, record) {
			state.ignoredUploadSafeRows++
			return nil
		}
		if hasUnparsedTokenMetricField(input.Source, record) {
			state.unparsedTokenLikeRows++
		}
		return nil
	}

	if !metric.hasCost {
		state.missingCost = true
	}
	mergeMetric(state.rows, *metric, input.SessionID)
	return nil
}

func finish(state *parseState, input ParseInput) (ParseResult, error) {
	result := ParseResult{
		IgnoredUploadSafeRows: state.ignoredUploadSafeRows,
		MalformedRows:         state.malformedRows,
		MissingCost:           state.missingCost,
		UnparsedTokenLikeRows: state.unparsedTokenLikeRows,
	}
	if state.skippedOversizedRows > 0 {
		result.SkippedOversizedRows = state.skippedOversizedRows
		result.LargestSkippedOversizedRow = state.largestSkippedBytes
	}
	rows := make([]*aggregateRow, 0, len(state.rows))
	for _, row := range state.rows {
		rows = append(rows, row)
	}
	snapshots := make([]contract.Snapshot, 0, len(rows))
	for _, row := range rows {
		// The TS parser builds each snapshot through usageSnapshotSchema.parse,
		// so one row the contract rejects fails the whole source there. Checking
		// the same way here keeps a poisoned snapshot out of the hook cursor,
		// which would otherwise replay it into an upload batch the server
		// rejects as a whole.
		if err := requireIntegerTokenCounts(row); err != nil {
			return ParseResult{}, fmt.Errorf("%s %s %s: %w", input.Source, row.usageDate, row.model, err)
		}
		snapshot := contract.Snapshot{
			Source:        input.Source,
			UsageDate:     row.usageDate,
			Timezone:      input.Timezone,
			Model:         row.model,
			InputTokens:   int64(row.inputTokens),
			OutputTokens:  int64(row.outputTokens),
			CacheCreation: int64(row.cacheCreationTokens),
			CacheRead:     int64(row.cacheReadTokens),
			TotalTokens:   int64(row.totalTokens),
			CostUSD:       row.costUSD,
			SessionCount:  int64(len(row.sessions)),
			CollectedAt:   input.CollectedAt,
		}
		if err := snapshot.Validate(); err != nil {
			return ParseResult{}, fmt.Errorf("%s %s %s: %w", input.Source, row.usageDate, row.model, err)
		}
		snapshots = append(snapshots, snapshot)
	}
	result.Snapshots = snapshots
	return result, nil
}

// requireIntegerTokenCounts mirrors the schema's integer range check on the
// float the parser summed. Converting an out-of-range float to int64 is
// implementation-defined in Go, so the range is enforced before the cast.
func requireIntegerTokenCounts(row *aggregateRow) error {
	for _, check := range []struct {
		name  string
		value float64
	}{
		{"inputTokens", row.inputTokens},
		{"outputTokens", row.outputTokens},
		{"cacheCreationTokens", row.cacheCreationTokens},
		{"cacheReadTokens", row.cacheReadTokens},
		{"totalTokens", row.totalTokens},
	} {
		if check.value < 0 || check.value > contract.MaxSnapshotTokens || check.value != math.Trunc(check.value) {
			return fmt.Errorf("%s: must be an integer in 0..%d", check.name, contract.MaxSnapshotTokens)
		}
	}
	return nil
}

func readLineRecord(line string) (map[string]any, bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return nil, false
	}
	// Ports `JSON.parse`: trailing non-whitespace after the first value is a syntax error,
	// matching the codex port's jsonlDecodeJSON — a line like `{"a":1}garbage` decodes fine
	// with a bare first Decode and would otherwise be silently accepted and counted.
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	decoder.UseNumber()
	var parsed any
	if err := decoder.Decode(&parsed); err != nil {
		return nil, true
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, true
	}
	record, ok := parsed.(map[string]any)
	if !ok {
		return nil, false
	}
	return record, false
}

func readCodexMetric(record map[string]any, location *time.Location) *metricRow {
	if stringValue(record["type"]) != "event_msg" {
		return nil
	}
	payload := recordValue(record["payload"])
	if payload == nil || stringValue(payload["type"]) != "token_count" {
		return nil
	}
	info := recordValue(payload["info"])
	var usage map[string]any
	if info != nil && info["last_token_usage"] != nil {
		usage = recordValue(info["last_token_usage"])
	} else {
		usage = recordValue(payload["usage"])
	}
	timestamp, ok := readTimestamp(record)
	if usage == nil || !ok {
		return nil
	}
	model := firstString(info, "model")
	if model == "" {
		model = firstString(usage, "model")
	}
	if model == "" {
		model = "all"
	}
	return buildMetric(contract.SourceCodex, record, usage, model, timestamp, location)
}

func isKnownCodexTokenMetadata(source contract.Source, record map[string]any) bool {
	if source != contract.SourceCodex {
		return false
	}
	recordType := stringValue(record["type"])
	if recordType == "token_usage_record" || recordType == "compacted" {
		// Codex writes this request-level record alongside event_msg/token_count.
		// Its usage fields are cumulative/duplicate metadata, not another
		// billable event, so it stays out of the snapshot and the guard.
		payload := recordValue(record["payload"])
		var latest map[string]any
		if payload != nil {
			latest = recordValue(payload["latest_token_usage_record"])
		}
		return recordValue(record["usage"]) != nil ||
			recordValue(record["turn_token_usage"]) != nil ||
			recordValue(record["thread_token_usage"]) != nil ||
			(payload != nil && (recordValue(payload["usage"]) != nil ||
				recordValue(payload["turn_token_usage"]) != nil ||
				recordValue(payload["thread_token_usage"]) != nil)) ||
			(latest != nil && (recordValue(latest["usage"]) != nil ||
				recordValue(latest["turn_token_usage"]) != nil ||
				recordValue(latest["thread_token_usage"]) != nil))
	}
	if recordType != "event_msg" {
		return false
	}
	payload := recordValue(record["payload"])
	if payload == nil || stringValue(payload["type"]) != "token_count" {
		return false
	}
	info := recordValue(payload["info"])
	var usage map[string]any
	if info != nil && info["last_token_usage"] != nil {
		usage = recordValue(info["last_token_usage"])
	} else {
		usage = recordValue(payload["usage"])
	}
	if usage != nil {
		return false
	}
	if info != nil && recordValue(info["total_token_usage"]) != nil {
		return true
	}
	return recordValue(payload["total_token_usage"]) != nil
}

func readClaudeMetric(record map[string]any, location *time.Location) *metricRow {
	message := recordValue(record["message"])
	if message == nil {
		message = record
	}
	var usage map[string]any
	if message["usage"] != nil {
		usage = recordValue(message["usage"])
	} else {
		usage = recordValue(record["usage"])
	}
	timestamp, ok := readTimestamp(record)
	if usage == nil || !ok {
		return nil
	}
	model := firstString(message, "model", "modelName")
	if model == "" {
		model = firstString(record, "model")
	}
	if model == "" {
		model = "all"
	}
	if isSyntheticZeroUsage(model, usage) {
		return nil
	}
	return buildMetric(contract.SourceClaudeCode, record, usage, model, timestamp, location)
}

func isKnownClaudeSyntheticZeroUsage(source contract.Source, record map[string]any) bool {
	if source != contract.SourceClaudeCode {
		return false
	}
	message := recordValue(record["message"])
	if message == nil {
		message = record
	}
	var usage map[string]any
	if message["usage"] != nil {
		usage = recordValue(message["usage"])
	} else {
		usage = recordValue(record["usage"])
	}
	if usage == nil {
		return false
	}
	model := firstString(message, "model", "modelName")
	if model == "" {
		model = firstString(record, "model")
	}
	if model == "" {
		model = "all"
	}
	return isSyntheticZeroUsage(model, usage)
}

func isSyntheticZeroUsage(model string, usage map[string]any) bool {
	if model != "<synthetic>" {
		return false
	}
	for _, key := range []string{
		"input_tokens", "inputTokens", "output_tokens", "outputTokens",
		"cache_creation_input_tokens", "cache_write_input_tokens",
		"cacheCreationInputTokens", "cacheCreationTokens",
		"cache_read_input_tokens", "cached_input_tokens",
		"cacheReadInputTokens", "cachedInputTokens", "cacheReadTokens",
		"total_tokens", "totalTokens",
	} {
		if value, ok := optionalNumber(usage, key); ok && value != 0 {
			return false
		}
	}
	return true
}

func buildMetric(
	source contract.Source,
	record map[string]any,
	usage map[string]any,
	model string,
	timestamp time.Time,
	location *time.Location,
) *metricRow {
	inputTokens := readNumber(usage, "input_tokens", "inputTokens")
	outputTokens := readNumber(usage, "output_tokens", "outputTokens")
	cacheCreationTokens := readNumber(usage,
		"cache_creation_input_tokens", "cache_write_input_tokens",
		"cacheCreationInputTokens", "cacheCreationTokens")
	cacheReadTokens := readNumber(usage,
		"cache_read_input_tokens", "cached_input_tokens",
		"cacheReadInputTokens", "cachedInputTokens", "cacheReadTokens")
	costUSD, hasCost := readCostUSD(usage, record)

	totalTokens := 0.0
	if source == contract.SourceCodex {
		totalTokens = resolveCodexRawUsage(codexRawUsageInput{
			inputTokens:         inputTokens,
			outputTokens:        outputTokens,
			cacheCreationTokens: cacheCreationTokens,
			cacheReadTokens:     cacheReadTokens,
			explicitTotalTokens: usableExplicitTotal(usage),
		}).totalTokens
	} else {
		totalTokens = readTotalTokens(usage, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens)
	}

	return &metricRow{
		usageDate:           timestamp.In(location).Format("2006-01-02"),
		model:               model,
		inputTokens:         inputTokens,
		outputTokens:        outputTokens,
		cacheCreationTokens: cacheCreationTokens,
		cacheReadTokens:     cacheReadTokens,
		totalTokens:         totalTokens,
		costUSD:             costUSD,
		hasCost:             hasCost,
	}
}

func mergeMetric(rows map[string]*aggregateRow, metric metricRow, sessionID string) {
	key := metric.usageDate + "\x00" + metric.model
	current, ok := rows[key]
	if !ok {
		rows[key] = &aggregateRow{metricRow: metric, sessions: map[string]bool{sessionID: true}}
		return
	}
	current.inputTokens += metric.inputTokens
	current.outputTokens += metric.outputTokens
	current.cacheCreationTokens += metric.cacheCreationTokens
	current.cacheReadTokens += metric.cacheReadTokens
	current.totalTokens += metric.totalTokens
	current.costUSD += metric.costUSD
	current.sessions[sessionID] = true
}

func readTotalTokens(
	usage map[string]any,
	inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens float64,
) float64 {
	total := readNumber(usage, "total_tokens", "totalTokens")
	if total > 0 {
		return total
	}
	return inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens
}

func usableExplicitTotal(usage map[string]any) *float64 {
	total, ok := optionalNumber(usage, "total_tokens")
	if !ok {
		total, ok = optionalNumber(usage, "totalTokens")
	}
	if !ok || total <= 0 {
		return nil
	}
	return &total
}

func readCostUSD(usage, record map[string]any) (float64, bool) {
	for _, source := range []map[string]any{usage, record} {
		for _, key := range []string{"cost_usd", "costUsd", "costUSD", "total_cost", "totalCost"} {
			if value, ok := optionalNumber(source, key); ok {
				return value, true
			}
		}
	}
	return 0, false
}

// readTimestamp mirrors `new Date(value)`: an RFC3339 string, or one of the
// shapes session logs emit without an explicit zone.
func readTimestamp(record map[string]any) (time.Time, bool) {
	value := firstString(record, "timestamp", "createdAt", "created_at")
	if value == "" {
		return time.Time{}, false
	}
	trimmed := strings.TrimSpace(value)
	if parsed, err := time.Parse(time.RFC3339Nano, trimmed); err == nil {
		return parsed, true
	}
	if parsed, err := time.ParseInLocation("2006-01-02T15:04:05", trimmed, time.Local); err == nil {
		return parsed, true
	}
	return time.Time{}, false
}

func readNumber(record map[string]any, keys ...string) float64 {
	for _, key := range keys {
		if value, ok := optionalNumber(record, key); ok {
			return value
		}
	}
	return 0
}

// optionalNumber reads a JSON number. A numeric string is not a number: the TS
// parser's typeof check rejects it, and accepting one here would invent usage
// the other implementation never saw.
func optionalNumber(record map[string]any, key string) (float64, bool) {
	value, ok := record[key]
	if !ok {
		return 0, false
	}
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	parsed, err := number.Float64()
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return parsed, true
}

func firstString(record map[string]any, keys ...string) string {
	if record == nil {
		return ""
	}
	for _, key := range keys {
		if value, ok := record[key].(string); ok && value != "" {
			return value
		}
	}
	return ""
}

func recordValue(value any) map[string]any {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return record
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

func hasUnparsedTokenMetricField(source contract.Source, record map[string]any) bool {
	if source == contract.SourceClaudeCode {
		message := recordValue(record["message"])
		if message == nil {
			message = record
		}
		var usage map[string]any
		if message["usage"] != nil {
			usage = recordValue(message["usage"])
		} else {
			usage = recordValue(record["usage"])
		}
		return usage != nil && hasTokenMetricField(usage, 0)
	}
	return hasTokenMetricField(record, 0)
}

func hasTokenMetricField(value any, depth int) bool {
	if depth > 5 || value == nil {
		return false
	}
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			if hasTokenMetricField(item, depth+1) {
				return true
			}
		}
		return false
	case map[string]any:
		for key, child := range typed {
			if isTokenMetricKey(key) || hasTokenMetricField(child, depth+1) {
				return true
			}
		}
	}
	return false
}

func isTokenMetricKey(key string) bool {
	switch key {
	case "input_tokens", "output_tokens", "total_tokens",
		"cache_creation_input_tokens", "cache_read_input_tokens",
		"inputTokens", "outputTokens", "totalTokens",
		"cacheCreationTokens", "cacheReadTokens":
		return true
	}
	return false
}
