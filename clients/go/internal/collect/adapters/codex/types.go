package codex

import "github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"

// The value types of ccusage's Codex adapter, ported from v20.0.33
// (commit 1308c416): the CodexRawUsage / CodexTokenUsageEvent / service-tier
// types in rust/adapters/codex/src/types.rs:5-80, with their field semantics
// kept exactly: the six counters are a snapshot of one record, not a diff.

// RawUsage is CodexRawUsage (types.rs:5-13): the six counters a Codex record
// reports. Input includes cached and cache-creation tokens; reasoning is a
// subset of output.
type RawUsage struct {
	Input         uint64
	CachedInput   uint64
	CacheCreation uint64
	Output        uint64
	Reasoning     uint64
	Total         uint64
}

// Tier is CodexServiceTier (types.rs:15-20).
type Tier int

const (
	TierStandard Tier = iota
	TierFast
	TierFlex
)

func (t Tier) String() string {
	switch t {
	case TierStandard:
		return "standard"
	case TierFast:
		return "fast"
	case TierFlex:
		return "flex"
	default:
		return "unknown"
	}
}

// Event is CodexTokenUsageEvent (types.rs:47-65).
type Event struct {
	SessionID string
	// ResponseID is set only on token_usage_record events (types.rs:49).
	ResponseID string
	// Timestamp is the record's own string, trimmed as codex_session_timestamp
	// leaves it (parser.rs:805-812), or the normalized RFC 3339 form of a
	// numeric timestamp.
	Timestamp       string
	Model           string
	IsFallbackModel bool
	ServiceTier     *Tier
	RawUsage
}

// normalize is normalize_codex_raw_usage (parser.rs:1318-1325): cached input
// cannot exceed input and cache creation cannot exceed the uncached part.
func (u RawUsage) normalize() RawUsage {
	u.CachedInput = min(u.CachedInput, u.Input)
	u.CacheCreation = min(u.CacheCreation, u.Input-u.CachedInput)
	return u
}

// subtract is subtract_codex_raw_usage (parser.rs:1285-1315): per-field
// saturating difference, re-normalized after the subtraction. A counter that
// went backwards floors at zero rather than wrapping.
func (u RawUsage) subtract(previous *RawUsage) RawUsage {
	var before RawUsage
	if previous != nil {
		before = *previous
	}
	return RawUsage{
		Input:         saturatingSub(u.Input, before.Input),
		CachedInput:   saturatingSub(u.CachedInput, before.CachedInput),
		CacheCreation: saturatingSub(u.CacheCreation, before.CacheCreation),
		Output:        saturatingSub(u.Output, before.Output),
		Reasoning:     saturatingSub(u.Reasoning, before.Reasoning),
		Total:         saturatingSub(u.Total, before.Total),
	}.normalize()
}

func saturatingSub(a, b uint64) uint64 {
	if b > a {
		return 0
	}
	return a - b
}

// isZeroWithoutTotal is the token_count gate (parser.rs:521-527): five fields,
// deliberately excluding Total, so an advancing cumulative total alone is not
// an event.
func (u RawUsage) isZeroWithoutTotal() bool {
	return u.Input == 0 && u.CachedInput == 0 && u.CacheCreation == 0 && u.Output == 0 && u.Reasoning == 0
}

// isZero is the headless and token_usage_record gate (parser.rs:404-411,
// 1253-1260): all six fields, including Total.
func (u RawUsage) isZero() bool {
	return u.isZeroWithoutTotal() && u.Total == 0
}

// Bucket is CodexUsageBucket (types.rs:72-81): the four billed counters plus
// the part of each that came from a long-context request, which bills at its
// own rate and cannot be recovered from the sums afterwards.
type Bucket struct {
	Input         uint64
	CachedInput   uint64
	CacheCreation uint64
	Output        uint64

	LongContextInput         uint64
	LongContextCachedInput   uint64
	LongContextCacheCreation uint64
	LongContextOutput        uint64
}

// TimestampedUsage is CodexTimestampedUsage (types.rs:84-89): one time bucket
// of a time-dependent model, with the tier-recorded split.
type TimestampedUsage struct {
	Usage            Bucket
	RecordedStandard Bucket
	RecordedFast     Bucket
	RecordedFlex     Bucket
}

// BucketFor returns the recorded bucket for a tier (BucketFor(nil) is nil).
func (t *TimestampedUsage) BucketFor(tier *Tier) *Bucket {
	if tier == nil {
		return nil
	}
	switch *tier {
	case TierStandard:
		return &t.RecordedStandard
	case TierFast:
		return &t.RecordedFast
	case TierFlex:
		return &t.RecordedFlex
	}
	return nil
}

// ModelUsage is CodexModelUsage (types.rs:92-127) without the fields the
// report layer derives later.
type ModelUsage struct {
	Input         uint64
	CachedInput   uint64
	CacheCreation uint64
	Output        uint64
	Reasoning     uint64
	Total         uint64

	LongContextInput         uint64
	LongContextCachedInput   uint64
	LongContextCacheCreation uint64
	LongContextOutput        uint64

	RecordedStandard Bucket
	RecordedFast     Bucket
	RecordedFlex     Bucket

	// Timestamped holds time-dependent pricing buckets, keyed by event
	// millisecond (types.rs:126).
	Timestamped map[int64]*TimestampedUsage
	IsFallback  bool
}

// TierBucket returns the recorded bucket for a tier (TierBucket(nil) is nil).
func (m *ModelUsage) TierBucket(tier *Tier) *Bucket {
	if tier == nil {
		return nil
	}
	switch *tier {
	case TierStandard:
		return &m.RecordedStandard
	case TierFast:
		return &m.RecordedFast
	case TierFlex:
		return &m.RecordedFlex
	}
	return nil
}

// timestampedAt returns the bucket for one instant, creating it on first use.
func (m *ModelUsage) timestampedAt(millis int64) *TimestampedUsage {
	if m.Timestamped == nil {
		m.Timestamped = map[int64]*TimestampedUsage{}
	}
	bucket, ok := m.Timestamped[millis]
	if !ok {
		bucket = &TimestampedUsage{}
		m.Timestamped[millis] = bucket
	}
	return bucket
}

// Group is CodexGroup (types.rs:113-127): one report period.
type Group struct {
	Input         uint64
	CachedInput   uint64
	CacheCreation uint64
	Output        uint64
	Reasoning     uint64
	Total         uint64
	Models        map[string]*ModelUsage
	LastActivity  string
}

func newGroup() *Group {
	return &Group{Models: map[string]*ModelUsage{}}
}

// resolveModelName is ccusage's resolve_model_name, shared with the pricing
// layer so both names agree (model_aliases.rs:14-26).
func resolveModelName(model string) string {
	return nativepricing.ResolveModelName(model)
}
