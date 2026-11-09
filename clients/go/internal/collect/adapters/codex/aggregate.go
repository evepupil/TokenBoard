package codex

// The aggregation layer of ccusage's Codex adapter, ported from v20.0.33
// (commit 1308c416): rust/adapters/codex/src/aggregate.rs and the group types
// in rust/adapters/codex/src/types.rs:104-127. Events are deduplicated into one
// table, the survivors are summed into per-period groups, and a second pass
// attributes service tiers - a duplicated event can carry a tier its first copy
// lacked, so a tier cannot be booked while the event is first seen.
//
// The Rust version parallelizes files across threads with sharded dedupe maps.
// This port walks the files in order on one goroutine: the grouping result is
// the same (the first copy of a key wins either way and compaction copies are
// resolved by file index), and the concurrency can be added where a profile
// asks for it.

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// ReportKind is ccusage's AgentReportKind (cli, the `--kind` of a Codex
// report): the period a group is keyed by.
type ReportKind int

const (
	ReportDaily ReportKind = iota
	ReportWeekly
	ReportMonthly
	ReportSession
)

// reportTimezone is the location ccusage's parse_tz falls back to when the
// requested zone is unknown: the system zone (paths.rs:146-147 does the same).
func reportTimezone(name string) *time.Location {
	if name != "" {
		if location, err := time.LoadLocation(name); err == nil {
			return location
		}
	}
	return time.Local
}

// formatDateTZ is format_date_tz (date_utils.rs:313-324): the calendar date of
// an instant in the report's zone.
func formatDateTZ(millis int64, location *time.Location) string {
	return time.UnixMilli(millis).In(location).Format("2006-01-02")
}

// weekStart is week_start with WeekDay::Monday (summary.rs:317-331): the
// Monday on or before date, as YYYY-MM-DD.
func weekStart(date string) (string, bool) {
	parsed, err := time.ParseInLocation("2006-01-02", date, time.UTC)
	if err != nil {
		return "", false
	}
	weekday := int(parsed.Weekday()) // Sunday is 0, like weekday_from_sunday.
	shift := ((weekday-1)%7 + 7) % 7
	return parsed.AddDate(0, 0, -shift).Format("2006-01-02"), true
}

// reportPeriod is codex_period_for (aggregate.rs:408-430): the group key for
// one event, or ok=false when the date falls outside the --since/--until
// window. Both bounds are inclusive and compared as compact YYYYMMDD text.
func reportPeriod(millis int64, sessionID string, kind ReportKind, location *time.Location, since, until string) (string, bool) {
	date := formatDateTZ(millis, location)
	if since != "" || until != "" {
		compact := compactDate(date)
		if since != "" && compact < compactDate(since) {
			return "", false
		}
		if until != "" && compact > compactDate(until) {
			return "", false
		}
	}
	switch kind {
	case ReportWeekly:
		if start, ok := weekStart(date); ok {
			return start, true
		}
		return date, true
	case ReportMonthly:
		return date[:7], true
	case ReportSession:
		if sessionID == "" {
			return "", false
		}
		return sessionID, true
	default:
		return date, true
	}
}

func compactDate(date string) string {
	compact := make([]byte, 0, len(date))
	for i := 0; i < len(date); i++ {
		if date[i] != '-' {
			compact = append(compact, date[i])
		}
	}
	return string(compact)
}

// eventKey is CodexEventKey (aggregate.rs:23-41): a compaction request is
// identified by its response id alone, a normal event by what it recorded.
type eventKey struct {
	responseID string
	isResponse bool
	usage      usageKey
}

// usageKey is CodexUsageKey (aggregate.rs:30-41). The session fields stay zero
// for every kind except session, so a daily key ignores the session - the same
// event replayed into a second session counts once (aggregate.rs:753-771).
type usageKey struct {
	sessionID string
	timestamp int64
	model     string
	raw       RawUsage
}

// dedupeRecord is CodexDedupeRecord (aggregate.rs:46-51).
type dedupeRecord struct {
	serviceTier  *Tier
	model        string
	sessionID    string
	hasSessionID bool
	compaction   *compactionEvent
}

// compactionEvent is CodexCompactionEvent (aggregate.rs:53-57).
type compactionEvent struct {
	fileIndex int
	timestamp int64
	event     Event
}

// eventKeyFor is codex_event_key (aggregate.rs:753-780).
func eventKeyFor(event Event, timestamp int64, model string, kind ReportKind) eventKey {
	if event.ResponseID != "" {
		return eventKey{responseID: event.ResponseID, isResponse: true}
	}
	key := usageKey{timestamp: timestamp, model: model, raw: event.RawUsage}
	if kind == ReportSession {
		key.sessionID = event.SessionID
	}
	return eventKey{usage: key}
}

// aggregation is CodexAggregation (aggregate.rs:60-63): the grouping and the
// dedupe table it was built from. seen keeps insertion order so the second pass
// visits records the way the single-threaded Rust map iteration effectively
// does for a given key set - the result is order-independent either way.
type aggregation struct {
	groups map[string]*Group
	seen   map[eventKey]*dedupeRecord
	order  []eventKey
}

func newAggregation() *aggregation {
	return &aggregation{
		groups: map[string]*Group{},
		seen:   map[eventKey]*dedupeRecord{},
	}
}

// LoadGroups is load_groups_from_sources with the file discovery already done
// (aggregate.rs:97-132): every source group's files are aggregated into one
// shared dedupe table, then the recorded service tiers are applied to the
// groups they belong to.
//
// sources must carry the unpruned discovery output (CollectDedupedSources), not
// a caller-pruned list: the eligibility filter runs here, and the bounded replay
// plan receives the same discovery set as its "available" side, exactly like
// for_bounded_files - a forked child pruned by the window still finds its
// parent. Re-walking the directories here instead would lose the cross-source
// dedupe and could see files the aggregation was never given.
func LoadGroups(sources []FileGroup, kind ReportKind, timezone, since, until string) (map[string]*Group, error) {
	return LoadGroupsContext(context.Background(), sources, kind, timezone, since, until)
}

// LoadGroupsContext is LoadGroups with a cancellation seam: the caller's
// deadline is polled between files (and before the replay plan reads its
// prefix), so a cancelled or timed-out collection stops reading instead of
// finishing the scan. The native report runner derives that deadline from
// CommandOptions.TimeoutMs, which the ccusage subprocess path enforced by
// killing the child.
func LoadGroupsContext(ctx context.Context, sources []FileGroup, kind ReportKind, timezone, since, until string) (map[string]*Group, error) {
	pruned := make([]FileGroup, len(sources))
	for i, group := range sources {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		pruned[i] = FileGroup{Dir: group.Dir, Files: FilterByEligibility(group.Dir, group.Files, since, until, timezone)}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var plan *ReplayPlan
	if since != "" || until != "" {
		plan = NewBoundedReplayPlan(pruned, sources)
	} else {
		plan = NewReplayPlan(sources)
	}
	location := reportTimezone(timezone)
	aggregation := newAggregation()
	fileOffset := 0
	for i, group := range sources {
		for _, file := range pruned[i].Files {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if err := aggregation.aggregateFile(group.Dir, file, fileOffset, kind, location, since, until, plan); err != nil {
				return nil, err
			}
			fileOffset++
		}
	}
	aggregation.applyRecordedUsage(kind, location, since, until)
	return aggregation.groups, nil
}

// aggregateFile is aggregate_file_local (aggregate.rs:273-322).
func (a *aggregation) aggregateFile(sessionsDir, file string, fileIndex int, kind ReportKind, location *time.Location, since, until string, plan *ReplayPlan) error {
	return ParseFile(sessionsDir, file, plan.Prefix(file), func(event Event) error {
		if plan.IsReplayedCompaction(file, event.ResponseID) {
			return nil
		}
		return a.addEvent(event, kind, location, since, until, fileIndex)
	})
}

// addEvent is add_event_to_groups_local (aggregate.rs:344-374).
func (a *aggregation) addEvent(event Event, kind ReportKind, location *time.Location, since, until string, fileIndex int) error {
	if event.Model == "" {
		return nil
	}
	model := resolveModelName(event.Model)
	millis, ok := ParseTimestamp(event.Timestamp)
	if !ok {
		return fmt.Errorf("Invalid Codex timestamp: %s", event.Timestamp)
	}
	key := eventKeyFor(event, millis, model, kind)
	if !a.insert(key, event, model, kind, millis, fileIndex) {
		return nil
	}
	period, ok := reportPeriod(millis, event.SessionID, kind, location, since, until)
	if !ok {
		return nil
	}
	group := a.group(period)
	accumulateEvent(group, &event, model, millis, false)
	return nil
}

func (a *aggregation) group(period string) *Group {
	group, ok := a.groups[period]
	if !ok {
		group = newGroup()
		a.groups[period] = group
	}
	return group
}

// insert is insert_dedupe_record (aggregate.rs:711-751). It reports whether
// the event is booked immediately: a first-seen normal event is, a compaction
// request never is (its tier may still arrive from a copy), and a duplicate
// only merges what it knows.
func (a *aggregation) insert(key eventKey, event Event, model string, kind ReportKind, millis int64, fileIndex int) bool {
	if record, seen := a.seen[key]; seen {
		record.serviceTier = mergeTiers(record.serviceTier, event.ServiceTier)
		if record.compaction != nil && fileIndex < record.compaction.fileIndex {
			record.compaction = &compactionEvent{fileIndex: fileIndex, timestamp: millis, event: event}
			record.model = model
			record.sessionID, record.hasSessionID = event.SessionID, kind == ReportSession
		}
		return false
	}
	record := &dedupeRecord{
		serviceTier: event.ServiceTier,
		model:       model,
	}
	if kind == ReportSession {
		record.sessionID, record.hasSessionID = event.SessionID, true
	}
	if event.ResponseID != "" {
		record.compaction = &compactionEvent{fileIndex: fileIndex, timestamp: millis, event: event}
	}
	a.seen[key] = record
	a.order = append(a.order, key)
	return event.ResponseID == ""
}

// mergeTiers is merge_codex_service_tiers (types.rs:22-38): an explicit
// metadata tier beats an unclassified copy, and a conflict resolves to the more
// conservative tier independently of order.
func mergeTiers(current, incoming *Tier) *Tier {
	if current != nil && *current == TierStandard || incoming != nil && *incoming == TierStandard {
		tier := TierStandard
		return &tier
	}
	if current != nil && *current == TierFast || incoming != nil && *incoming == TierFast {
		tier := TierFast
		return &tier
	}
	if current != nil && *current == TierFlex || incoming != nil && *incoming == TierFlex {
		tier := TierFlex
		return &tier
	}
	return nil
}

// applyRecordedUsage is apply_recorded_usage_entries (aggregate.rs:594-677):
// compaction requests are booked now that every copy has been seen, and a
// normal event whose duplicate carried a tier is credited to that tier's
// recorded bucket.
func (a *aggregation) applyRecordedUsage(kind ReportKind, location *time.Location, since, until string) {
	for _, key := range a.order {
		record := a.seen[key]
		if record.compaction != nil {
			event := record.compaction.event
			event.ServiceTier = record.serviceTier
			period, ok := reportPeriod(record.compaction.timestamp, event.SessionID, kind, location, since, until)
			if !ok {
				continue
			}
			group := a.group(period)
			accumulateEvent(group, &event, record.model, record.compaction.timestamp, true)
			continue
		}
		if key.isResponse || record.serviceTier == nil {
			continue
		}
		period, ok := reportPeriod(key.usage.timestamp, record.sessionID, kind, location, since, until)
		if !ok {
			continue
		}
		group, ok := a.groups[period]
		if !ok {
			continue
		}
		usage, ok := group.Models[record.model]
		if !ok {
			continue
		}
		isLongContext := key.usage.raw.Input > uint64LongContextThreshold(record.model)
		bucket := usageBucketFromKey(key.usage, isLongContext)
		mergeRecordedUsage(usage, record.model, key.usage.timestamp, *record.serviceTier, bucket)
	}
}

// uint64LongContextThreshold is nativepricing's long_context_split_threshold
// (pricing.rs:2753-2775) on the counter type the events use.
func uint64LongContextThreshold(model string) uint64 {
	threshold := int64(200_000)
	if cachedCorpus != nil {
		threshold = cachedCorpus.LongContextSplitThreshold(model)
	}
	return uint64(threshold)
}

// hasTimeDependentPricing is nativepricing.HasTimeDependentPricing.
func hasTimeDependentPricing(model string) bool {
	return nativepricing.HasTimeDependentPricing(model)
}

// cachedCorpus is the embedded pricing corpus, loaded once. LongContextSplitThreshold
// needs nothing beyond the frozen models.dev snapshot, and a load failure is
// already fail-closed at the provider's cost layer; the threshold only falls
// back to the 200K default when the snapshot cannot be read.
var cachedCorpus = func() *nativepricing.Corpus {
	corpus, err := nativepricing.LoadEmbeddedCorpus()
	if err != nil {
		return nil
	}
	return &corpus
}()

// accumulateEvent is accumulate_codex_event_into_group (aggregate.rs:432-461)
// plus the per-model half (aggregate.rs:463-524).
func accumulateEvent(group *Group, event *Event, model string, millis int64, recordServiceTier bool) {
	group.Input = saturatingAddU64(group.Input, event.Input)
	group.CachedInput = saturatingAddU64(group.CachedInput, event.CachedInput)
	group.CacheCreation = saturatingAddU64(group.CacheCreation, event.CacheCreation)
	group.Output = saturatingAddU64(group.Output, event.Output)
	group.Reasoning = saturatingAddU64(group.Reasoning, event.Reasoning)
	group.Total = saturatingAddU64(group.Total, event.Total)
	if group.LastActivity == "" || event.Timestamp > group.LastActivity {
		group.LastActivity = event.Timestamp
	}
	usage, ok := group.Models[model]
	if !ok {
		usage = &ModelUsage{}
		group.Models[model] = usage
	}
	accumulateModelUsage(usage, event, model, millis, recordServiceTier)
}

// accumulateModelUsage is accumulate_codex_event_into_model_usage
// (aggregate.rs:463-524). Each event is one request, so its own input size
// decides the pricing tier; the summed totals cannot recover it.
func accumulateModelUsage(usage *ModelUsage, event *Event, model string, millis int64, recordServiceTier bool) {
	usage.Input = saturatingAddU64(usage.Input, event.Input)
	usage.CachedInput = saturatingAddU64(usage.CachedInput, event.CachedInput)
	usage.CacheCreation = saturatingAddU64(usage.CacheCreation, event.CacheCreation)
	usage.Output = saturatingAddU64(usage.Output, event.Output)
	usage.Reasoning = saturatingAddU64(usage.Reasoning, event.Reasoning)
	usage.Total = saturatingAddU64(usage.Total, event.Total)
	isLongContext := event.Input > uint64LongContextThreshold(model)
	if isLongContext {
		usage.LongContextInput = saturatingAddU64(usage.LongContextInput, event.Input)
		usage.LongContextCachedInput = saturatingAddU64(usage.LongContextCachedInput, event.CachedInput)
		usage.LongContextCacheCreation = saturatingAddU64(usage.LongContextCacheCreation, event.CacheCreation)
		usage.LongContextOutput = saturatingAddU64(usage.LongContextOutput, event.Output)
	}
	if hasTimeDependentPricing(model) {
		timestamped := usage.timestampedAt(millis)
		accumulateBucket(&timestamped.Usage, event, isLongContext)
		if recordServiceTier {
			if bucket := timestamped.BucketFor(event.ServiceTier); bucket != nil {
				accumulateBucket(bucket, event, isLongContext)
			}
		}
	}
	if recordServiceTier {
		if bucket := usage.TierBucket(event.ServiceTier); bucket != nil {
			accumulateBucket(bucket, event, isLongContext)
		}
	}
	usage.IsFallback = usage.IsFallback || event.IsFallbackModel
}

// accumulateBucket is accumulate_codex_event_into_usage_bucket
// (aggregate.rs:526-544).
func accumulateBucket(bucket *Bucket, event *Event, isLongContext bool) {
	bucket.Input = saturatingAddU64(bucket.Input, event.Input)
	bucket.CachedInput = saturatingAddU64(bucket.CachedInput, event.CachedInput)
	bucket.CacheCreation = saturatingAddU64(bucket.CacheCreation, event.CacheCreation)
	bucket.Output = saturatingAddU64(bucket.Output, event.Output)
	if isLongContext {
		bucket.LongContextInput = saturatingAddU64(bucket.LongContextInput, event.Input)
		bucket.LongContextCachedInput = saturatingAddU64(bucket.LongContextCachedInput, event.CachedInput)
		bucket.LongContextCacheCreation = saturatingAddU64(bucket.LongContextCacheCreation, event.CacheCreation)
		bucket.LongContextOutput = saturatingAddU64(bucket.LongContextOutput, event.Output)
	}
}

// usageBucketFromKey rebuilds the four billed counters of a dedupe key
// (aggregate.rs:640-663).
func usageBucketFromKey(key usageKey, isLongContext bool) Bucket {
	bucket := Bucket{Input: key.raw.Input, CachedInput: key.raw.CachedInput, CacheCreation: key.raw.CacheCreation, Output: key.raw.Output}
	if isLongContext {
		bucket.LongContextInput = key.raw.Input
		bucket.LongContextCachedInput = key.raw.CachedInput
		bucket.LongContextCacheCreation = key.raw.CacheCreation
		bucket.LongContextOutput = key.raw.Output
	}
	return bucket
}

// mergeRecordedUsage is merge_recorded_codex_usage (aggregate.rs:557-581).
func mergeRecordedUsage(usage *ModelUsage, model string, millis int64, tier Tier, bucket Bucket) {
	if target := usage.TierBucket(&tier); target != nil {
		mergeBucket(target, bucket)
	}
	if hasTimeDependentPricing(model) {
		timestamped := usage.timestampedAt(millis)
		if target := timestamped.BucketFor(&tier); target != nil {
			mergeBucket(target, bucket)
		}
	}
}

// mergeBucket is merge_codex_usage_bucket (aggregate.rs:546-556).
func mergeBucket(target *Bucket, source Bucket) {
	target.Input = saturatingAddU64(target.Input, source.Input)
	target.CachedInput = saturatingAddU64(target.CachedInput, source.CachedInput)
	target.CacheCreation = saturatingAddU64(target.CacheCreation, source.CacheCreation)
	target.Output = saturatingAddU64(target.Output, source.Output)
	target.LongContextInput = saturatingAddU64(target.LongContextInput, source.LongContextInput)
	target.LongContextCachedInput = saturatingAddU64(target.LongContextCachedInput, source.LongContextCachedInput)
	target.LongContextCacheCreation = saturatingAddU64(target.LongContextCacheCreation, source.LongContextCacheCreation)
	target.LongContextOutput = saturatingAddU64(target.LongContextOutput, source.LongContextOutput)
}

func saturatingAddU64(left, right uint64) uint64 {
	sum := left + right
	if sum < left {
		return ^uint64(0)
	}
	return sum
}

// SortedPeriods returns the group keys in order, so a report is deterministic.
func SortedPeriods(groups map[string]*Group) []string {
	periods := make([]string, 0, len(groups))
	for period := range groups {
		periods = append(periods, period)
	}
	sort.Strings(periods)
	return periods
}
