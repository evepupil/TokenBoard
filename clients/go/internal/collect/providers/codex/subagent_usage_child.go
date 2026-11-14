package codex

// Port of codex-subagent-usage-child.ts: the per-request child-session usage
// the Codex subagent correction subtracts from the parent's aggregate.
//
// A Codex child session file reports two counters per request: the cumulative
// `total_token_usage` (which starts from the parent's copied history) and the
// per-request `last_token_usage` (what the provider actually charged). Only
// the per-request counter may be subtracted; a cumulative-only row is the
// inherited baseline and carries no charge of its own. A row that reports a
// cumulative counter but no per-request counter is not silently treated as
// zero usage — it is counted and reported, because skipping it quietly would
// leave the parent's inflated total in place.
//
// Events are keyed by the session's identity inside its Codex home (not the
// absolute path), so the same child copied into two profile homes deduplicates
// while two genuinely different sessions with identical counters stay
// distinct.

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/collate"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

const (
	// MaxCodexChildSessionBytes bounds one child session file.
	MaxCodexChildSessionBytes = 4 * 1024 * 1024 * 1024
	// MaxCodexChildSessionLineBytes bounds one line of a child session.
	MaxCodexChildSessionLineBytes = 1024 * 1024
	// MaxDiscardedCodexChildSessionLineBytes bounds an oversized row that is
	// discarded as irrelevant.
	MaxDiscardedCodexChildSessionLineBytes = 64 * 1024 * 1024
	// MaxCodexChildUsageEvents bounds the unique events one child file yields.
	MaxCodexChildUsageEvents = 65_536
	// MaxMergedCodexChildUsageEvents bounds the unique events across profiles.
	MaxMergedCodexChildUsageEvents = 65_536

	// maxSubagentFormattedUsageDateCacheEntries mirrors the TS cache bound.
	maxSubagentFormattedUsageDateCacheEntries = 4_096
)

// codexChildSessionReadLimits mirrors codexChildSessionReadLimits. The pointer
// limits are rebuilt per call so a caller cannot mutate a shared limit.
func codexChildSessionReadLimits() JSONLReadLimits {
	maxBytes := int64(MaxCodexChildSessionBytes)
	maxLineBytes := int64(MaxCodexChildSessionLineBytes)
	maxDiscarded := int64(MaxDiscardedCodexChildSessionLineBytes)
	return JSONLReadLimits{
		MaxBytes:              &maxBytes,
		MaxLineBytes:          &maxLineBytes,
		MaxDiscardedLineBytes: &maxDiscarded,
		RelevantMetadataKeys:  []string{"total_token_usage", "last_token_usage", "subagent"},
		CodexUsageOnly:        true,
		DiscardableLineTypes:  []string{"compacted", "event_msg", "response_item", "turn_context"},
		Label:                 "Codex child session",
	}
}

// TotalUsage is one request's token counters.
type TotalUsage struct {
	InputTokens         float64
	OutputTokens        float64
	CacheCreationTokens float64
	CacheReadTokens     float64
	TotalTokens         float64
}

// DatedUsage is a TotalUsage attributed to a usage date.
type DatedUsage struct {
	UsageDate           string
	InputTokens         float64
	OutputTokens        float64
	CacheCreationTokens float64
	CacheReadTokens     float64
	TotalTokens         float64
}

// datedUsageOf attaches a usage date to a counter set.
func datedUsageOf(usageDate string, usage TotalUsage) DatedUsage {
	return DatedUsage{
		UsageDate:           usageDate,
		InputTokens:         usage.InputTokens,
		OutputTokens:        usage.OutputTokens,
		CacheCreationTokens: usage.CacheCreationTokens,
		CacheReadTokens:     usage.CacheReadTokens,
		TotalTokens:         usage.TotalTokens,
	}
}

// ChildUsageEvent is one deduplicated per-request child usage event.
type ChildUsageEvent struct {
	EventKey string
	DatedUsage
}

// ReadChildLastUsageByDate reads a child session's per-request usage and sums
// it per usage date. Events are deduplicated within the file by event key.
func ReadChildLastUsageByDate(
	filePath string,
	timestamp string,
	timezone string,
	stderr func(string),
) ([]DatedUsage, error) {
	merger := NewChildUsageEventMergerWithLimit(MaxCodexChildUsageEvents)
	err := readChildUsageEventsFromFile(filePath, timestamp, timezone, stderr, func(event ChildUsageEvent) error {
		return merger.AddOne(event)
	})
	if err != nil {
		return nil, err
	}
	return merger.ToUsageByDate(), nil
}

// ReadChildLastUsageEvents reads a child session's distinct per-request usage
// events. The event keys are local to this read and are never persisted: the
// cache stores date-level usage only, because a cross-profile merge must not
// inherit identities resolved against another profile's file.
func ReadChildLastUsageEvents(
	filePath string,
	timestamp string,
	timezone string,
	stderr func(string),
) ([]ChildUsageEvent, error) {
	events := []ChildUsageEvent{}
	seenEventKeys := map[string]bool{}
	err := readChildUsageEventsFromFile(filePath, timestamp, timezone, stderr, func(event ChildUsageEvent) error {
		if seenEventKeys[event.EventKey] {
			return nil
		}
		if len(seenEventKeys) >= MaxCodexChildUsageEvents {
			return fmt.Errorf("Codex child session exceeds the %d unique usage-event limit", MaxCodexChildUsageEvents)
		}
		seenEventKeys[event.EventKey] = true
		events = append(events, event)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return events, nil
}

// readChildUsageEventsFromFile drives the TS async generator. The
// missing-per-request summary is emitted from a defer, exactly like the TS
// generator's finally block: it is reported for a completed read, an early
// stop and a failure alike.
func readChildUsageEventsFromFile(
	filePath string,
	timestamp string,
	timezone string,
	stderr func(string),
	yield func(ChildUsageEvent) error,
) error {
	missingLastUsageRecords := 0
	defer func() {
		if missingLastUsageRecords > 0 {
			emitStderr(stderr, fmt.Sprintf(
				"Skipped %d Codex child usage record%s with total_token_usage but missing last_token_usage",
				missingLastUsageRecords, jsonlPlural(missingLastUsageRecords)))
		}
	}()

	readErr := ReadJSONLRecords(filePath, stderr, codexChildSessionReadLimits(), func(record UnknownRecord) error {
		result, err := readChildUsageEvent(record, timestamp, timezone, filePath)
		if err != nil {
			return err
		}
		if result.missingLastUsage {
			missingLastUsageRecords++
		}
		if result.event == nil {
			return nil
		}
		return yield(*result.event)
	})
	if readErr != nil && !errors.Is(readErr, ErrStopJSONL) {
		return readErr
	}
	return nil
}

type childUsageEventRead struct {
	event            *ChildUsageEvent
	missingLastUsage bool
}

// readChildUsageEvent ports readChildUsageEvent. A record before the child's
// start timestamp is not this session's usage; a record with a cumulative
// counter but no per-request counter is reported, not zeroed.
func readChildUsageEvent(
	record UnknownRecord,
	timestamp string,
	timezone string,
	filePath string,
) (childUsageEventRead, error) {
	recordTimestamp := ReadString(record, []string{"timestamp"})
	if recordTimestamp == "" || recordTimestamp < timestamp {
		return childUsageEventRead{}, nil
	}
	cumulative := readChildTotalUsage(record, "total_token_usage")
	usage := readChildTotalUsage(record, "last_token_usage")
	if cumulative == nil {
		return childUsageEventRead{}, nil
	}
	if usage == nil {
		return childUsageEventRead{missingLastUsage: true}, nil
	}
	usageDate, err := FormatCodexUsageDate(recordTimestamp, timezone)
	if err != nil {
		return childUsageEventRead{}, err
	}
	event := ChildUsageEvent{
		EventKey:   childUsageEventKey(filePath, recordTimestamp, *cumulative),
		DatedUsage: datedUsageOf(usageDate, *usage),
	}
	return childUsageEventRead{event: &event}, nil
}

// MergeChildUsageEventsByDate merges several profiles' event lists, dropping
// the same child copied into more than one profile.
func MergeChildUsageEventsByDate(eventLists [][]ChildUsageEvent) ([]DatedUsage, error) {
	merger := NewChildUsageEventMerger()
	for _, events := range eventLists {
		if err := merger.Add(events); err != nil {
			return nil, err
		}
	}
	return merger.ToUsageByDate(), nil
}

// ChildUsageEventMerger accumulates distinct child events per usage date.
type ChildUsageEventMerger struct {
	byDate        map[string]DatedUsage
	seenEventKeys map[string]bool
	maxUnique     int
}

// NewChildUsageEventMerger uses the merged-profile event limit.
func NewChildUsageEventMerger() *ChildUsageEventMerger {
	return NewChildUsageEventMergerWithLimit(MaxMergedCodexChildUsageEvents)
}

// NewChildUsageEventMergerWithLimit uses an explicit unique-event limit.
func NewChildUsageEventMergerWithLimit(maxUniqueEvents int) *ChildUsageEventMerger {
	return &ChildUsageEventMerger{
		byDate:        map[string]DatedUsage{},
		seenEventKeys: map[string]bool{},
		maxUnique:     maxUniqueEvents,
	}
}

// Add accumulates every event in the list.
func (m *ChildUsageEventMerger) Add(events []ChildUsageEvent) error {
	for _, event := range events {
		if err := m.AddOne(event); err != nil {
			return err
		}
	}
	return nil
}

// AddOne accumulates one event unless its key was already seen. Exceeding the
// unique-event limit fails closed rather than growing without bound.
func (m *ChildUsageEventMerger) AddOne(event ChildUsageEvent) error {
	if m.seenEventKeys[event.EventKey] {
		return nil
	}
	if len(m.seenEventKeys) >= m.maxUnique {
		return fmt.Errorf("Codex child usage correction exceeds the %d unique usage-event limit", m.maxUnique)
	}
	m.seenEventKeys[event.EventKey] = true
	addDatedUsage(m.byDate, event.UsageDate, event.DatedUsage)
	return nil
}

// ToUsageByDate returns the accumulated usages ordered by usage date.
func (m *ChildUsageEventMerger) ToUsageByDate() []DatedUsage {
	out := make([]DatedUsage, 0, len(m.byDate))
	for _, usage := range m.byDate {
		out = append(out, usage)
	}
	sortDatedUsages(out)
	return out
}

func sortDatedUsages(usages []DatedUsage) {
	// The TS sorts with usageDate.localeCompare; dates are ASCII, but the
	// shared collation keeps this consistent with every other JS sort in the
	// package.
	sort.SliceStable(usages, func(left, right int) bool {
		return collate.Less(usages[left].UsageDate, usages[right].UsageDate)
	})
}

// SumDatedUsage totals a list of dated usages.
func SumDatedUsage(usages []DatedUsage) TotalUsage {
	total := TotalUsage{}
	for _, usage := range usages {
		total.InputTokens += usage.InputTokens
		total.OutputTokens += usage.OutputTokens
		total.CacheCreationTokens += usage.CacheCreationTokens
		total.CacheReadTokens += usage.CacheReadTokens
		total.TotalTokens += usage.TotalTokens
	}
	return total
}

func addDatedUsage(byDate map[string]DatedUsage, usageDate string, usage DatedUsage) {
	current, ok := byDate[usageDate]
	if !ok {
		current = DatedUsage{UsageDate: usageDate}
	}
	current.InputTokens += usage.InputTokens
	current.OutputTokens += usage.OutputTokens
	current.CacheCreationTokens += usage.CacheCreationTokens
	current.CacheReadTokens += usage.CacheReadTokens
	current.TotalTokens += usage.TotalTokens
	byDate[usageDate] = current
}

func readChildTotalUsage(record UnknownRecord, key string) *TotalUsage {
	payload := ReadRecord(record["payload"])
	info := ReadRecord(payload["info"])
	usage := ReadRecord(info[key])
	if usage == nil {
		return nil
	}
	return &TotalUsage{
		InputTokens:         ReadNumber(usage, []string{"input_tokens", "inputTokens"}),
		OutputTokens:        ReadNumber(usage, []string{"output_tokens", "outputTokens"}),
		CacheCreationTokens: ReadCacheCreationTokens(usage),
		CacheReadTokens:     ReadCacheReadTokens(usage),
		TotalTokens:         ReadTotalTokens(usage),
	}
}

func childUsageEventKey(filePath string, timestamp string, usage TotalUsage) string {
	return stableChildSessionIdentity(filePath) + "|" + timestamp + "|" + totalUsageKey(usage)
}

var stableChildSessionIdentityPattern = regexp.MustCompile(`/(sessions|archived_sessions)/(.+)$`)

// stableChildSessionIdentity keeps only the part of the path that identifies
// the session within a Codex home, so the same child copied into a second
// profile home deduplicates.
func stableChildSessionIdentity(filePath string) string {
	normalized := replaceAllBackslashes(filePath)
	if match := stableChildSessionIdentityPattern.FindStringSubmatch(normalized); match != nil {
		return match[1] + "/" + match[2]
	}
	separator := lastSlashIndex(normalized)
	return normalized[separator+1:]
}

func replaceAllBackslashes(value string) string {
	out := make([]byte, 0, len(value))
	for index := 0; index < len(value); index++ {
		if value[index] == '\\' {
			out = append(out, '/')
			continue
		}
		out = append(out, value[index])
	}
	return string(out)
}

func lastSlashIndex(value string) int {
	for index := len(value) - 1; index >= 0; index-- {
		if value[index] == '/' {
			return index
		}
	}
	return -1
}

func totalUsageKey(usage TotalUsage) string {
	return formatJSNumber(usage.InputTokens) + "/" +
		formatJSNumber(usage.CacheCreationTokens) + "/" +
		formatJSNumber(usage.CacheReadTokens) + "/" +
		formatJSNumber(usage.OutputTokens) + "/" +
		formatJSNumber(usage.TotalTokens)
}

// subagentUsageDateCache is the TS module's two-level cache: one loaded
// location per timezone and one formatted date per (timezone, value). The TS
// runs on one thread; the Go correction reads child files from a bounded pool,
// so both levels are mutex-guarded. The formatted map is a FIFO bounded at
// 4096 entries, matching the TS Map eviction.
var subagentUsageDateCache = struct {
	sync.Mutex
	locations map[string]*time.Location
	formatted map[string]string
	order     []string
}{
	locations: map[string]*time.Location{},
	formatted: map[string]string{},
}

// FormatCodexUsageDate ports formatCodexUsageDate: validate the calendar
// date, parse the timestamp the way Date.parse does, and render the calendar
// day in the report timezone.
func FormatCodexUsageDate(value string, timezone string) (string, error) {
	if err := jsonlAssertValidCalendarDate(value, "Invalid Codex date"); err != nil {
		return "", err
	}
	cacheKey := timezone + "\x00" + value
	if cached, ok := subagentCachedUsageDate(cacheKey); ok {
		return cached, nil
	}

	parsed, ok := jsonlParseJSDate(value)
	if !ok {
		normalized, err := NormalizeDate(value)
		if err != nil {
			return "", err
		}
		return subagentCacheUsageDate(cacheKey, normalized), nil
	}
	location, err := subagentTimezoneLocation(timezone)
	if err != nil {
		// The TS catches only RangeError from Intl and rewrites it; every
		// other failure propagates. A timezone Go cannot load is the same
		// class of failure.
		return "", fmt.Errorf("Invalid timezone for Codex subagent usage date: %s", timezone)
	}
	return subagentCacheUsageDate(cacheKey, parsed.In(location).Format("2006-01-02")), nil
}

func subagentTimezoneLocation(timezone string) (*time.Location, error) {
	// Go's LoadLocation treats "" as UTC; Intl rejects an empty timeZone.
	if timezone == "" {
		return nil, errors.New("empty timezone")
	}
	subagentUsageDateCache.Lock()
	cached, ok := subagentUsageDateCache.locations[timezone]
	subagentUsageDateCache.Unlock()
	if ok {
		return cached, nil
	}
	location, err := contract.LoadLocation(timezone)
	if err != nil {
		return nil, err
	}
	subagentUsageDateCache.Lock()
	subagentUsageDateCache.locations[timezone] = location
	subagentUsageDateCache.Unlock()
	return location, nil
}

func subagentCachedUsageDate(cacheKey string) (string, bool) {
	subagentUsageDateCache.Lock()
	defer subagentUsageDateCache.Unlock()
	value, ok := subagentUsageDateCache.formatted[cacheKey]
	return value, ok && value != ""
}

func subagentCacheUsageDate(cacheKey string, usageDate string) string {
	subagentUsageDateCache.Lock()
	defer subagentUsageDateCache.Unlock()
	if _, exists := subagentUsageDateCache.formatted[cacheKey]; !exists {
		if len(subagentUsageDateCache.order) >= maxSubagentFormattedUsageDateCacheEntries {
			oldest := subagentUsageDateCache.order[0]
			subagentUsageDateCache.order = subagentUsageDateCache.order[1:]
			delete(subagentUsageDateCache.formatted, oldest)
		}
		subagentUsageDateCache.order = append(subagentUsageDateCache.order, cacheKey)
	}
	subagentUsageDateCache.formatted[cacheKey] = usageDate
	return usageDate
}
