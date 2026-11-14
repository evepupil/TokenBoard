package ccusage

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Port of normalize-ccusage.ts: ccusage's daily JSON becomes TokenBoard
// snapshots, with session counts joined in from `ccusage claude session`.
// The row-shape tolerance (breakdown/modelBreakdowns/models/...) mirrors the
// TS parser exactly, because ccusage has emitted all of those shapes and the
// shadow comparison runs both implementations over the same files.
//
// Objects are decoded into orderedRecord, not maps: the TS normalizer iterates
// breakdown objects in insertion order, and the session-count attribution
// keeps the first model on a token tie. A Go map would silently pick a
// different model there.

// NormalizeOptions configures one normalization.
type NormalizeOptions struct {
	Source                      contract.Source
	Timezone                    string
	CollectedAt                 string
	Sessions                    any
	HasSessions                 bool
	IncludeSessionOnlySnapshots bool
}

// modelRow is one model's metrics within a daily row.
type modelRow struct {
	model    string
	metrics  *orderedRecord
	parent   *orderedRecord
	isParent bool
}

type sessionCountState struct {
	provided     bool
	counts       map[string]float64
	attributions map[string]SessionAttribution
}

// SessionAttribution is what ccusage's session report says one session file
// belongs to: the usage date it counts toward and the model it was attributed
// to. The Codex provider keys its canonical attribution cache by it, so it is
// exported even though the Claude path only uses it internally.
type SessionAttribution struct {
	UsageDate string
	Model     string
}

var (
	inputTokenKeys         = []string{"inputTokens", "input_tokens"}
	outputTokenKeys        = []string{"outputTokens", "output_tokens"}
	cacheCreationTokenKeys = []string{
		"cacheCreationTokens", "cacheCreationInputTokens", "inputCacheCreationTokens",
		"cache_creation_tokens", "cache_creation_input_tokens", "input_cache_creation_tokens",
		"cache_write_input_tokens",
	}
	cacheReadTokenKeys = []string{
		"cacheReadTokens", "cacheReadInputTokens", "cachedInputTokens",
		"cache_read_tokens", "cache_read_input_tokens", "cached_input_tokens",
	}
)

// DecodeJSON decodes ccusage output preserving object key order and JSON
// numbers. The provider hands the result to NormalizeCcusageDailyJSON.
func DecodeJSON(data []byte) (any, error) {
	return decodeOrdered(data)
}

// DecodeJSONValue decodes one already-decoded value (a runner stub's return)
// into the ordered representation.
func DecodeJSONValue(value any) (any, error) {
	return normalizeDecodedValue(value), nil
}

// normalizeDecodedValue converts encoding/json maps and slices into ordered
// records, preserving the map's key order only as Go provides it (sorted for
// map[string]any). Stub callers that need document order must hand over raw
// JSON bytes instead.
func normalizeDecodedValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		record := newOrderedRecord()
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sortByteOrder(keys)
		for _, key := range keys {
			record.set(key, normalizeDecodedValue(typed[key]))
		}
		return record
	case []any:
		out := make([]any, 0, len(typed))
		for _, entry := range typed {
			out = append(out, normalizeDecodedValue(entry))
		}
		return out
	case *orderedRecord:
		return typed
	}
	return value
}

// NormalizeCcusageDailyJSON ports normalizeCcusageDailyJson.
func NormalizeCcusageDailyJSON(input any, options NormalizeOptions) ([]contract.Snapshot, error) {
	collectedAt := options.CollectedAt
	if collectedAt == "" {
		collectedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	// Accept already-decoded Go values as well as the ordered records the
	// command runner produces, so a caller that hands over JSON.parse-shaped
	// data gets the same rows the TypeScript normalizer would see.
	input = normalizeDecodedValue(input)
	if options.Sessions != nil {
		options.Sessions = normalizeDecodedValue(options.Sessions)
	}
	// The session report, not the daily report, supplies session counts; the
	// TS normalizer passes options.sessions here and the daily input only to
	// the row extraction below.
	sessionCounts, err := getSessionCounts(options.Sessions, options.HasSessions, options.Timezone, options.Source)
	if err != nil {
		return nil, err
	}
	snapshots := []contract.Snapshot{}
	for _, row := range extractDailyRows(input) {
		usageDate, err := readDate(row)
		if err != nil {
			return nil, err
		}
		for _, model := range extractModelRows(row) {
			totalTokens := readTotalTokens(model.metrics, options.Source)
			costUsd := readCostUsd(model.metrics, model.parent, model.isParent, options.Source)
			inputTokens := readNumber(model.metrics, inputTokenKeys)
			outputTokens := readNumber(model.metrics, outputTokenKeys)
			cacheCreation := readNumber(model.metrics, cacheCreationTokenKeys)
			cacheRead := readNumber(model.metrics, cacheReadTokenKeys)
			sessionCount := readSessionCount(sessionCounts, usageDate, model.model, model.metrics)
			if err := assertIntegral(inputTokens, outputTokens, cacheCreation, cacheRead, totalTokens, sessionCount); err != nil {
				return nil, err
			}
			snapshot := contract.Snapshot{
				Source:        options.Source,
				UsageDate:     usageDate,
				Timezone:      options.Timezone,
				Model:         model.model,
				InputTokens:   int64(inputTokens),
				OutputTokens:  int64(outputTokens),
				CacheCreation: int64(cacheCreation),
				CacheRead:     int64(cacheRead),
				TotalTokens:   int64(totalTokens),
				CostUSD:       costUsd,
				SessionCount:  int64(sessionCount),
				CollectedAt:   collectedAt,
			}
			if err := snapshot.Validate(); err != nil {
				return nil, fmt.Errorf("ccusage snapshot %s/%s: %w", usageDate, model.model, err)
			}
			snapshots = append(snapshots, snapshot)
		}
	}
	return appendSessionOnlySnapshots(snapshots, sessionCounts, options, collectedAt)
}

// assertIntegral rejects fractional counts: the TS schema's z.number().int()
// fails them, and truncating here would upload a different number than the TS
// collector.
func assertIntegral(values ...float64) error {
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) || math.Trunc(value) != value {
			return fmt.Errorf("ccusage token counts must be integers, got %v", value)
		}
	}
	return nil
}

func getSessionCounts(input any, provided bool, timezone string, source contract.Source) (sessionCountState, error) {
	state := sessionCountState{provided: provided, counts: map[string]float64{}, attributions: map[string]SessionAttribution{}}
	for _, row := range extractDailyRows(input) {
		attribution, ok, err := readCcusageSessionAttribution(row, timezone, source)
		if err != nil {
			return state, err
		}
		if !ok {
			continue
		}
		key := sessionCountKey(attribution.UsageDate, attribution.Model)
		state.counts[key]++
		state.attributions[key] = attribution
	}
	return state, nil
}

func appendSessionOnlySnapshots(
	snapshots []contract.Snapshot,
	sessionCounts sessionCountState,
	options NormalizeOptions,
	collectedAt string,
) ([]contract.Snapshot, error) {
	if !options.IncludeSessionOnlySnapshots || !sessionCounts.provided || len(sessionCounts.counts) == 0 {
		return snapshots, nil
	}
	existing := map[string]bool{}
	for _, snapshot := range snapshots {
		existing[sessionCountKey(snapshot.UsageDate, snapshot.Model)] = true
	}
	keys := make([]string, 0, len(sessionCounts.counts))
	for key := range sessionCounts.counts {
		keys = append(keys, key)
	}
	sortByteOrder(keys)
	sessionOnly := []contract.Snapshot{}
	for _, key := range keys {
		sessionCount := sessionCounts.counts[key]
		if existing[key] || sessionCount <= 0 {
			continue
		}
		attribution, ok := sessionCounts.attributions[key]
		if !ok {
			continue
		}
		snapshot := contract.Snapshot{
			Source:       options.Source,
			UsageDate:    attribution.UsageDate,
			Timezone:     options.Timezone,
			Model:        attribution.Model,
			SessionCount: int64(sessionCount),
			CollectedAt:  collectedAt,
		}
		if err := snapshot.Validate(); err != nil {
			return nil, fmt.Errorf("ccusage session-only snapshot: %w", err)
		}
		sessionOnly = append(sessionOnly, snapshot)
	}
	return append(snapshots, sessionOnly...), nil
}

func readSessionCount(state sessionCountState, usageDate, model string, metrics *orderedRecord) float64 {
	if state.provided {
		return state.counts[sessionCountKey(usageDate, model)]
	}
	return readNumber(metrics, []string{"sessionCount", "sessions"})
}

// ReadCcusageSessionAttribution ports readCcusageSessionAttribution.
func ReadCcusageSessionAttribution(row any, timezone string, source contract.Source) (SessionAttribution, bool, error) {
	return readCcusageSessionAttribution(row, timezone, source)
}

func readCcusageSessionAttribution(row any, timezone string, source contract.Source) (SessionAttribution, bool, error) {
	record, ok := row.(*orderedRecord)
	if !ok || record == nil {
		return SessionAttribution{}, false, nil
	}
	usageDate, ok, err := readSessionDate(record, timezone)
	if err != nil || !ok {
		return SessionAttribution{}, false, err
	}
	return SessionAttribution{UsageDate: usageDate, Model: readSessionCountModel(record, source)}, true, nil
}

func readSessionDate(row *orderedRecord, timezone string) (string, bool, error) {
	var value any
	for _, key := range []string{"lastActivity", "date", "usageDate"} {
		if candidate, ok := row.Get(key); ok && candidate != nil {
			value = candidate
			break
		}
	}
	text, ok := value.(string)
	if !ok {
		return "", false, nil
	}
	formatted, err := formatDate(text, timezone)
	if err != nil {
		return "", false, err
	}
	return formatted, true, nil
}

func readSessionCountModel(row *orderedRecord, source contract.Source) string {
	rows := extractModelRows(row)
	first := modelRow{model: readModel(row), metrics: row, parent: row, isParent: true}
	if len(rows) > 0 {
		first = rows[0]
	}
	selected := first
	for _, candidate := range rows[1:] {
		if readTotalTokens(candidate.metrics, source) > readTotalTokens(selected.metrics, source) {
			selected = candidate
		}
	}
	return selected.model
}

func sessionCountKey(date, model string) string {
	return date + "\x00" + model
}

func extractDailyRows(input any) []*orderedRecord {
	switch typed := input.(type) {
	case []any:
		return filterRecords(typed)
	case *orderedRecord:
		if typed == nil {
			return nil
		}
		for _, key := range []string{"data", "daily", "rows", "items", "sessions"} {
			if value, ok := typed.Get(key); ok {
				if values, ok := value.([]any); ok {
					return filterRecords(values)
				}
			}
		}
		if hasTokenMetrics(typed) {
			return []*orderedRecord{typed}
		}
		return nil
	}
	return nil
}

func filterRecords(values []any) []*orderedRecord {
	out := []*orderedRecord{}
	for _, value := range values {
		if record, ok := value.(*orderedRecord); ok && record != nil {
			out = append(out, record)
		}
	}
	return out
}

func extractModelRows(row *orderedRecord) []modelRow {
	if breakdown, ok := orderedValue(row, "breakdown"); ok {
		if rows := objectModelRows(breakdown, row); len(rows) > 0 {
			return rows
		}
	}
	if value, ok := row.Get("modelBreakdowns"); ok {
		switch typed := value.(type) {
		case []any:
			rows := []modelRow{}
			for _, entry := range typed {
				if metrics, ok := entry.(*orderedRecord); ok && metrics != nil {
					rows = append(rows, modelRow{model: readModel(metrics), metrics: metrics, parent: row})
				}
			}
			if len(rows) > 0 {
				return rows
			}
		case *orderedRecord:
			if rows := objectModelRows(typed, row); len(rows) > 0 {
				return rows
			}
		}
	}
	if models, ok := orderedValue(row, "models"); ok {
		if rows := objectModelRows(models, row); len(rows) > 0 {
			return rows
		}
	}
	return []modelRow{{model: readModel(row), metrics: row, parent: row, isParent: true}}
}

func orderedValue(row *orderedRecord, key string) (*orderedRecord, bool) {
	value, ok := row.Get(key)
	if !ok {
		return nil, false
	}
	record, ok := value.(*orderedRecord)
	if !ok || record == nil {
		return nil, false
	}
	return record, true
}

// objectModelRows iterates an object breakdown in document order, matching
// Object.entries.
func objectModelRows(values *orderedRecord, parent *orderedRecord) []modelRow {
	rows := []modelRow{}
	for _, model := range values.Keys() {
		value, _ := values.Get(model)
		metrics, ok := value.(*orderedRecord)
		if !ok || metrics == nil {
			continue
		}
		rows = append(rows, modelRow{model: model, metrics: metrics, parent: parent})
	}
	return rows
}

func readDate(row *orderedRecord) (string, error) {
	var value any
	for _, key := range []string{"date", "usageDate", "period"} {
		if candidate, ok := row.Get(key); ok && candidate != nil {
			value = candidate
			break
		}
	}
	text, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("ccusage row is missing date")
	}
	return normalizeDate(text)
}

func readModel(row *orderedRecord) string {
	for _, key := range []string{"model", "modelName", "name"} {
		if value, ok := row.Get(key); ok {
			if text, ok := value.(string); ok && text != "" {
				return text
			}
		}
	}
	for _, key := range []string{"models", "modelsUsed"} {
		if value, ok := row.Get(key); ok {
			if values, ok := value.([]any); ok && len(values) == 1 {
				if text, ok := values[0].(string); ok {
					return text
				}
			}
		}
	}
	return "all"
}

func readTotalTokens(row *orderedRecord, source contract.Source) float64 {
	inputTokens := readNumber(row, inputTokenKeys)
	outputTokens := readNumber(row, outputTokenKeys)
	cacheCreationTokens := readNumber(row, cacheCreationTokenKeys)
	cacheReadTokens := readNumber(row, cacheReadTokenKeys)
	explicitTotal := readNumber(row, []string{"totalTokens", "total_tokens"})
	if source == contract.SourceCodex {
		var explicit *float64
		if explicitTotal > 0 {
			explicit = &explicitTotal
		}
		return normalizeCodexTotalTokens(codexTokenTotals{
			inputTokens:         inputTokens,
			outputTokens:        outputTokens,
			cacheCreationTokens: cacheCreationTokens,
			cacheReadTokens:     cacheReadTokens,
			explicitTotalTokens: explicit,
		})
	}
	if explicitTotal > 0 {
		return explicitTotal
	}
	return inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens
}

func readNumber(row *orderedRecord, keys []string) float64 {
	for _, key := range keys {
		if value, ok := row.Get(key); ok {
			if number, ok := jsonNumber(value); ok {
				return number
			}
		}
	}
	return 0
}

func readCostUsd(row, parent *orderedRecord, isParent bool, source contract.Source) float64 {
	directCost := readNumber(row, []string{"costUsd", "costUSD", "totalCost", "cost"})
	if directCost > 0 {
		return directCost
	}
	if isParent {
		return directCost
	}
	parentCost := readNumber(parent, []string{"costUsd", "costUSD", "totalCost", "cost"})
	parentTokens := readTotalTokens(parent, source)
	rowTokens := readTotalTokens(row, source)
	if parentCost <= 0 || parentTokens <= 0 || rowTokens <= 0 {
		return 0
	}
	return parentCost * (rowTokens / parentTokens)
}

func normalizeDate(value string) (string, error) {
	if err := assertValidIsoCalendarDate(value, "Invalid ccusage date"); err != nil {
		return "", err
	}
	if pureDatePattern.MatchString(value) {
		return value, nil
	}
	if dateTimePrefixPattern.MatchString(value) {
		if parsed, ok := parseJSDate(value); ok {
			return parsed.UTC().Format("2006-01-02"), nil
		}
	}
	if parsed, ok := parseJSDate(value + " UTC"); ok {
		return parsed.UTC().Format("2006-01-02"), nil
	}
	return value, nil
}

func formatDate(value, timezone string) (string, error) {
	if err := assertValidIsoCalendarDate(value, "Invalid ccusage date"); err != nil {
		return "", err
	}
	if pureDatePattern.MatchString(value) {
		return value, nil
	}
	if !dateTimePrefixPattern.MatchString(value) {
		return normalizeDate(value)
	}
	parsed, ok := parseJSDate(value)
	if !ok {
		return normalizeDate(value)
	}
	location, err := contract.LoadLocation(timezone)
	if err != nil {
		return "", fmt.Errorf("Invalid timezone for ccusage session date: %s", timezone)
	}
	return parsed.In(location).Format("2006-01-02"), nil
}

func hasTokenMetrics(row *orderedRecord) bool {
	for _, key := range []string{"inputTokens", "outputTokens", "totalTokens"} {
		if value, ok := row.Get(key); ok {
			if _, ok := jsonNumber(value); ok {
				return true
			}
		}
	}
	return false
}

// jsonNumber accepts exactly the JSON number types the decoder can produce.
// A numeric string stays a string: the TS parser's typeof check rejects it,
// and accepting one would invent usage the other implementation never saw.
func jsonNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return 0, false
		}
		return parsed, true
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	}
	return 0, false
}

var (
	pureDatePattern       = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	dateTimePrefixPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T`)
	isoDatePrefixPattern  = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})`)
)

// assertValidIsoCalendarDate mirrors the TS helper: the value's leading
// YYYY-MM-DD must be a real calendar date; the rest is not examined.
func assertValidIsoCalendarDate(value, message string) error {
	match := isoDatePrefixPattern.FindStringSubmatch(value)
	if match == nil {
		return nil
	}
	year, _ := strconv.Atoi(match[1])
	month, _ := strconv.Atoi(match[2])
	day, _ := strconv.Atoi(match[3])
	if month < 1 || month > 12 || day < 1 {
		return fmt.Errorf("%s", message)
	}
	candidate := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	if candidate.Year() != year || int(candidate.Month()) != month || candidate.Day() != day {
		return fmt.Errorf("%s", message)
	}
	return nil
}

// parseJSDate covers the shapes ccusage emits: RFC3339 with a zone, a zone-less
// date-time (JS treats it as local time), "YYYY-MM-DD HH:MM:SS UTC", a bare
// date (UTC midnight), and the display dates (`Apr 28, 2026`, optionally with
// an explicit UTC suffix) codex daily rows carry — Date.parse accepts those,
// so the normalizer must too.
func parseJSDate(value string) (time.Time, bool) {
	trimmed := strings.TrimSpace(value)
	if parsed, err := time.Parse(time.RFC3339Nano, trimmed); err == nil {
		return parsed, true
	}
	if parsed, err := time.ParseInLocation("2006-01-02T15:04:05", trimmed, time.Local); err == nil {
		return parsed, true
	}
	if parsed, err := time.ParseInLocation("2006-01-02 15:04:05 UTC", trimmed, time.UTC); err == nil {
		return parsed, true
	}
	if parsed, err := time.ParseInLocation("2006-01-02", trimmed, time.UTC); err == nil {
		return parsed, true
	}
	for _, layout := range []string{
		"Jan 2, 2006 MST",
		"Jan 2, 2006 15:04:05 MST",
		"Jan 2, 2006",
		"January 2, 2006 MST",
		"January 2, 2006",
	} {
		if parsed, err := time.ParseInLocation(layout, trimmed, time.UTC); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

// sortByteOrder sorts ASCII keys the way Array.prototype.sort compares UTF-16
// code units, which for these date/model keys is byte order.
func sortByteOrder(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

// SessionRows ports the Codex provider's readSessionRows: the session report's
// rows under whichever envelope key the report used. A non-object input yields
// no rows, matching the TS filter that silently drops non-object entries.
//
// The value is normalized first: a provider that re-projects ccusage's own
// report (the per-home row tagging) hands over a plain Go map, and the TS
// reader accepts any object shape.
func SessionRows(input any) []any {
	records := extractDailyRows(normalizeDecodedValue(input))
	out := make([]any, 0, len(records))
	for _, record := range records {
		out = append(out, record)
	}
	return out
}

// RecordGet reads one field of a session row. The provider resolves a row's
// session file from directory/sessionFile/sessionId, which requires field
// access the normalize package keeps private.
func RecordGet(row any, key string) (any, bool) {
	record, ok := row.(*orderedRecord)
	if !ok || record == nil {
		return nil, false
	}
	return record.Get(key)
}

// ReadSessionFileRow reads the fields the Codex provider needs to resolve a
// session row's file path: directory, sessionFile and sessionId, each only
// when it is a string.
func ReadSessionFileRow(row any) (directory, sessionFile, sessionID string, ok bool) {
	record, ok := row.(*orderedRecord)
	if !ok || record == nil {
		return "", "", "", false
	}
	readString := func(key string) string {
		value, present := record.Get(key)
		if !present {
			return ""
		}
		text, isString := value.(string)
		if !isString {
			return ""
		}
		return text
	}
	return readString("directory"), readString("sessionFile"), readString("sessionId"), true
}

// HasDailyRows ports the TS hasDailyRows: true only when the report is an
// object with a non-empty `daily` array. It is deliberately stricter than
// extractDailyRows. The ccusage tool family exits 0 with `{"daily":[]}` for a
// tool that is not installed, and that empty report is what lets a provider
// skip the second (session) spawn on machines with no such tool. Accepting the
// normalizer's wider row shapes here would turn "not installed" into an extra
// ccusage run, so the two checks are kept apart on purpose.
func HasDailyRows(input any) bool {
	record, ok := normalizeDecodedValue(input).(*orderedRecord)
	if !ok || record == nil {
		return false
	}
	value, ok := record.Get("daily")
	if !ok {
		return false
	}
	rows, ok := value.([]any)
	return ok && len(rows) > 0
}
