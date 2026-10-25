// Package sessionusage ports session-usage-aggregate.ts: folding usage
// events into one snapshot per (local date, model), plus the shared
// per-provider readers (token counts, timestamps, JSONL parsing, the
// --since window).
package sessionusage

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/collate"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// UnknownModel is the label for usage whose model cannot be determined.
const UnknownModel = "unknown"

const maxModelNameLength = 160

// Event is one model call's usage, already normalized to TokenBoard's
// disjoint counts.
type Event struct {
	OccurredAt          time.Time
	Model               string
	InputTokens         int64
	OutputTokens        int64
	CacheCreationTokens int64
	CacheReadTokens     int64
	CostUSD             float64
	SessionID           string
}

type aggregateRow struct {
	usageDate           string
	model               string
	inputTokens         int64
	outputTokens        int64
	cacheCreationTokens int64
	cacheReadTokens     int64
	costUSD             float64
	sessions            map[string]bool
}

// Aggregate folds usage events into one snapshot per (local date, model).
//
// Sources that cannot report a cost set CostAvailable false, which pins
// costUsd to 0 so the schema's cost-unavailable rule holds and no reporting
// surface presents a guessed figure as real.
type Aggregate struct {
	source        contract.Source
	timezone      *time.Location
	timezoneName  string
	collectedAt   string
	costAvailable bool
	rows          map[string]*aggregateRow
}

// NewAggregate builds an aggregate for one source. The timezone must already
// be validated by the caller.
func NewAggregate(source contract.Source, timezone string, collectedAt string, costAvailable bool) (*Aggregate, error) {
	location, err := contract.LoadLocation(timezone)
	if err != nil {
		return nil, err
	}
	return &Aggregate{
		source:        source,
		timezone:      location,
		timezoneName:  timezone,
		collectedAt:   collectedAt,
		costAvailable: costAvailable,
		rows:          map[string]*aggregateRow{},
	}, nil
}

// Add folds one event. An event with no billable tokens is dropped, matching
// the TS aggregate's own billable test.
func (a *Aggregate) Add(event Event) {
	billable := event.InputTokens + event.OutputTokens + event.CacheCreationTokens + event.CacheReadTokens
	if billable == 0 {
		return
	}
	usageDate := event.OccurredAt.In(a.timezone).Format("2006-01-02")
	model := BoundedModel(event.Model)
	key := usageDate + "\x00" + model
	current, ok := a.rows[key]
	if !ok {
		row := &aggregateRow{
			usageDate:           usageDate,
			model:               model,
			inputTokens:         event.InputTokens,
			outputTokens:        event.OutputTokens,
			cacheCreationTokens: event.CacheCreationTokens,
			cacheReadTokens:     event.CacheReadTokens,
			sessions:            map[string]bool{},
		}
		if a.costAvailable {
			row.costUSD = event.CostUSD
		}
		if event.SessionID != "" {
			row.sessions[event.SessionID] = true
		}
		a.rows[key] = row
		return
	}
	current.inputTokens += event.InputTokens
	current.outputTokens += event.OutputTokens
	current.cacheCreationTokens += event.CacheCreationTokens
	current.cacheReadTokens += event.CacheReadTokens
	if a.costAvailable {
		current.costUSD += event.CostUSD
	}
	if event.SessionID != "" {
		current.sessions[event.SessionID] = true
	}
}

// Snapshots returns the folded rows sorted by (date, model), in the same
// collation the TS aggregate uses — localeCompare, not byte order.
//
// Every folded row is checked against the snapshot contract before it is
// returned. TS gets this from `usageSnapshotSchema.parse` inside its aggregate;
// without it here, one corrupted row (a huge count, a sum past int64, a
// negative cost) leaves the collector intact, the server rejects the whole
// upload batch, and the upload failure is non-transient — pausing uploads for
// every source on the machine, not just the one with the bad row.
func (a *Aggregate) Snapshots() ([]contract.Snapshot, error) {
	rows := make([]*aggregateRow, 0, len(a.rows))
	for _, row := range a.rows {
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].usageDate != rows[j].usageDate {
			return collate.Less(rows[i].usageDate, rows[j].usageDate)
		}
		return collate.Less(rows[i].model, rows[j].model)
	})
	snapshots := make([]contract.Snapshot, 0, len(rows))
	for _, row := range rows {
		costUSD := 0.0
		if a.costAvailable {
			costUSD = row.costUSD
		}
		snapshot := contract.Snapshot{
			Source:        a.source,
			UsageDate:     row.usageDate,
			Timezone:      a.timezoneName,
			Model:         row.model,
			InputTokens:   row.inputTokens,
			OutputTokens:  row.outputTokens,
			CacheCreation: row.cacheCreationTokens,
			CacheRead:     row.cacheReadTokens,
			TotalTokens:   row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens,
			CostUSD:       costUSD,
			SessionCount:  int64(len(row.sessions)),
			CollectedAt:   a.collectedAt,
		}
		if err := snapshot.Validate(); err != nil {
			return nil, fmt.Errorf("%s %s %s: %w", a.source, row.usageDate, row.model, err)
		}
		snapshots = append(snapshots, snapshot)
	}
	return snapshots, nil
}

// ReadTokenCount is a non-negative integer count, tolerating string-encoded
// numbers. TS keeps an oversized count as a float (`Math.trunc`) and lets the
// schema reject the row at validation; Go cannot keep it — `int64(x)` for x past
// int64 range is undefined and wraps on amd64, usually to a negative that folds
// cleanly and poisons the whole upload batch. So a finite count beyond the
// contract's bound is clamped one past it: the folded row then fails the
// snapshot's own Validate — which fails that one source, the same blast radius
// TS has — instead of uploading a wrapped number.
func ReadTokenCount(value any) int64 {
	parsed, ok := ReadFiniteNumber(value)
	if !ok || parsed <= 0 {
		return 0
	}
	if parsed > float64(contract.MaxSnapshotTokens) {
		return contract.MaxSnapshotTokens + 1
	}
	return int64(parsed)
}

// ReadFiniteNumber reads a finite number from a number or a numeric string.
func ReadFiniteNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case json.Number:
		if parsed, err := typed.Float64(); err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0) {
			return parsed, true
		}
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0, false
		}
		if parsed, err := strconv.ParseFloat(trimmed, 64); err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0) {
			return parsed, true
		}
	}
	return 0, false
}

// secondsThreshold splits epoch seconds from milliseconds: a millisecond
// timestamp for any plausible date is far larger, so the two cannot be
// confused.
const secondsThreshold = 100_000_000_000

// ReadEventTimestamp reads epoch seconds, epoch milliseconds, or a timestamp
// string as a time.Time. The string forms follow the JS Date parser for the
// shapes real session logs use: an explicit zone is honored, a zone-less
// date-time is local time, and a bare date is UTC midnight — which is what
// `new Date(...)` does with each.
func ReadEventTimestamp(value any) (time.Time, bool) {
	if numeric, ok := ReadFiniteNumber(value); ok {
		if numeric <= 0 {
			return time.Time{}, false
		}
		milliseconds := numeric
		if numeric < secondsThreshold {
			milliseconds = numeric * 1000
		}
		return time.UnixMilli(int64(milliseconds)), true
	}
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" {
		return time.Time{}, false
	}
	trimmed := strings.TrimSpace(text)
	if parsed, err := time.Parse(time.RFC3339Nano, trimmed); err == nil {
		return parsed, true
	}
	if parsed, err := time.ParseInLocation("2006-01-02T15:04:05", trimmed, time.Local); err == nil {
		return parsed, true
	}
	if parsed, err := time.Parse("2006-01-02", trimmed); err == nil {
		return parsed, true
	}
	return time.Time{}, false
}

// FormatDate renders a timestamp's local calendar date in the given zone,
// matching the TS formatDate.
func FormatDate(at time.Time, timezone string) string {
	location, err := contract.LoadLocation(timezone)
	if err != nil {
		location = time.UTC
	}
	return at.In(location).Format("2006-01-02")
}

// LocalTimezone mirrors the collector's default: the system IANA zone, else
// UTC. It shares the CLI's resolution (TZ, then time.Local, then the
// conventional zone files).
func LocalTimezone() string {
	if name := strings.TrimSpace(os.Getenv("TZ")); name != "" {
		return name
	}
	if name := time.Local.String(); name != "" && name != "Local" && contract.IsValidTimezone(name) {
		return name
	}
	if data, err := os.ReadFile("/etc/timezone"); err == nil {
		if name := strings.TrimSpace(string(data)); contract.IsValidTimezone(name) {
			return name
		}
	}
	if target, err := os.Readlink("/etc/localtime"); err == nil {
		if index := strings.LastIndex(target, "zoneinfo/"); index >= 0 {
			if name := target[index+len("zoneinfo/"):]; contract.IsValidTimezone(name) {
				return name
			}
		}
	}
	return "UTC"
}

// BoundedModel bounds a model id from provider responses before upload.
func BoundedModel(value any) string {
	text, ok := value.(string)
	if !ok {
		return UnknownModel
	}
	model := strings.TrimSpace(text)
	if model == "" {
		return UnknownModel
	}
	return truncateUTF16(model, maxModelNameLength)
}

// truncateUTF16 mirrors JS String#slice(0, limit), which counts UTF-16 code
// units. Counting runes instead would leave up to 320 units on an astral-plane
// id, and contract validation — which counts units — would then reject the
// snapshot.
//
// A cut inside a surrogate pair drops the half rather than keeping it. JS's
// slice keeps the lone surrogate, but a Go string cannot hold one, and the
// alternative — keeping the whole pair — would exceed the bound this function
// exists to enforce. Only an id over 160 units with a pair straddling the cut
// reaches this branch.
func truncateUTF16(value string, limit int) string {
	units := 0
	for index, character := range value {
		width := 1
		if character > 0xFFFF {
			width = 2
		}
		if units+width > limit {
			return value[:index]
		}
		units += width
	}
	return value
}

// ParseJSONLine parses one JSONL line into an object; anything else
// (blank, malformed, array, scalar) is not an object.
func ParseJSONLine(line string) map[string]any {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return nil
	}
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	decoder.UseNumber()
	var parsed any
	if err := decoder.Decode(&parsed); err != nil {
		return nil
	}
	record, ok := parsed.(map[string]any)
	if !ok {
		return nil
	}
	return record
}

// ReadRecordAt returns the value as an object, or nil.
func ReadRecordAt(value any) map[string]any {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return record
}

// ReadSinceDate resolves --since to a local date string, or "" for full
// history. Invalid values fail with the TS message shape.
func ReadSinceDate(since string, label string) (string, error) {
	// The window is already resolved by the caller: the CLI applies the TS
	// `flags.since ?? (env.TOKENBOARD_SINCE || env.TOKENBOARD_DEFAULT_SINCE ||
	// '')` chain, so the providers (which TS gives `options.since ?? …`) and
	// the CLI agree on one value. A set-but-empty TOKENBOARD_SINCE therefore
	// arrives here as the empty window and means full history, not a second
	// fallback to the default.
	value := since
	if value == "" {
		return "", nil
	}
	normalized, err := AssertValidDateFilter(value, label+" since value", true)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(normalized) == "all" {
		return "", nil
	}
	compact := strings.ReplaceAll(normalized, "-", "")
	return compact[:4] + "-" + compact[4:6] + "-" + compact[6:8], nil
}

// AssertValidDateFilter mirrors iso-calendar-date.ts assertValidDateFilter:
// YYYYMMDD or YYYY-MM-DD, a real calendar date, optionally the literal
// "all".
func AssertValidDateFilter(value, field string, allowAll bool) (string, error) {
	trimmed := strings.TrimSpace(value)
	invalid := func() error {
		return &DateFilterError{Field: field, Value: value}
	}
	if allowAll && trimmed == "all" {
		return trimmed, nil
	}
	compact := strings.ReplaceAll(trimmed, "-", "")
	if len(compact) != 8 {
		return "", invalid()
	}
	for _, digit := range compact {
		if digit < '0' || digit > '9' {
			return "", invalid()
		}
	}
	if !contract.IsValidIsoDate(compact[:4] + "-" + compact[4:6] + "-" + compact[6:8]) {
		return "", invalid()
	}
	return trimmed, nil
}

// DateFilterError carries the TS error message shape.
type DateFilterError struct {
	Field string
	Value string
}

func (e *DateFilterError) Error() string {
	return "Invalid " + e.Field + ": " + e.Value + ". Expected YYYYMMDD or YYYY-MM-DD."
}

// AssertValidDateFilterRange ports iso-calendar-date.ts
// assertValidDateFilterRange: validate a --since/--until pair and reject a
// reversed window. An empty bound or an explicit "all" means "no bound" and
// is never forwarded to ccusage.
func AssertValidDateFilterRange(since, until, sinceField, untilField string) (string, string, error) {
	normalizedSince := ""
	trimmedSince := strings.TrimSpace(since)
	if since != "" && trimmedSince != "all" {
		value, err := AssertValidDateFilter(since, sinceField, true)
		if err != nil {
			return "", "", err
		}
		normalizedSince = value
	}
	normalizedUntil := ""
	if until != "" {
		value, err := AssertValidDateFilter(until, untilField, false)
		if err != nil {
			return "", "", err
		}
		normalizedUntil = value
	}
	if normalizedSince != "" && normalizedUntil != "" &&
		strings.ReplaceAll(normalizedSince, "-", "") > strings.ReplaceAll(normalizedUntil, "-", "") {
		return "", "", fmt.Errorf(
			"Invalid %s/%s: since date must not be after until date.", sinceField, untilField)
	}
	return normalizedSince, normalizedUntil, nil
}
