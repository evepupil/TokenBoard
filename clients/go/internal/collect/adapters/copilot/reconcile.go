package copilot

import (
	"sort"
	"strconv"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/adapters/tools"
	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// This file ports the reconciliation half of loader.rs (:127-432): turning the
// cumulative per-model snapshots of one session into interval usage, deciding
// where OpenTelemetry replaces those intervals, and reporting the credits no
// model breakdown accounts for. Everything here is a pure function of its
// input so each rule can be tested on its own.

// unattributedModel is UNATTRIBUTED_MODEL (loader.rs:271): the label for
// credits Copilot billed without saying which model used them.
const unattributedModel = "unknown"

// ReconcileInput is everything reconcile_session_state_entries and
// credit_gap_entries read.
type ReconcileInput struct {
	// Timezone is the report --timezone, which date_range_bounds_ms resolves the
	// since/until bounds in.
	Timezone string
	// Entries are the session-state model snapshots of every file, in discovery
	// order.
	Entries []Entry
	// Snapshots are the shutdown/checkpoint credit totals of every file.
	Snapshots []CreditSnapshot
	// OTelEntries are the OTel calls; only their timestamps matter here.
	OTelEntries []Entry
	// Since and Until are the raw --since/--until bounds as the date-range
	// helpers take them ("" is absent).
	Since string
	Until string
	// SinceMs and UntilMs are the --since/--until window as epoch
	// milliseconds, UntilMs exclusive (date_range_bounds_ms). nil is
	// unbounded.
	SinceMs *int64
	UntilMs *int64
	// SkippedSession reports sessions whose credit gaps OTel owns (the sessions
	// any OTel row names).
	SkippedSession func(sessionID string) bool
}

// Reconciliation is SessionStateReconciliation (loader.rs:127-136) plus the
// credit gaps.
type Reconciliation struct {
	// Intervals are the per-interval session-state entries, sorted by
	// (timestamp, dedup key).
	Intervals []Entry
	// OTelAfter is, per (session, model), the time after which OTel rows are
	// reported: the latest shutdown through --until, or the shutdown before the
	// intervals OTel replaces. Without an entry every OTel row counts.
	OTelAfter map[string]int64
	// AttributedNano is, per (session, shutdown timestamp), the credits the
	// model breakdowns reported at that shutdown, every shutdown included.
	AttributedNano map[string]uint64
	// Gaps are the cost-only entries for credits no model breakdown accounts
	// for.
	Gaps []Entry
}

// attributedKey is the AttributedNano key: session and shutdown timestamp.
func attributedKey(sessionID string, timestamp int64) string {
	return sessionID + "\x00" + strconv.FormatInt(timestamp, 10)
}

// otelKey is the OTelAfter key: session and model.
func otelKey(sessionID, model string) string {
	return sessionID + "\x00" + model
}

// Reconcile is load_entries_inner's reconciliation stage (loader.rs:81-114)
// minus pricing and the OTel row filter, which the loader applies.
func Reconcile(input ReconcileInput) Reconciliation {
	attributed := map[string]uint64{}
	// load_entries_inner hands date_range_bounds_ms the RAW Option<&str>
	// bounds (loader.rs:81-85), so a partial spelling such as "202601" narrows
	// nothing here, unlike the lexicographic report filter.
	sinceMs, untilMs := tools.DateRangeBoundsMs(input.Since, input.Until, input.Timezone)
	if input.SinceMs != nil {
		sinceMs = input.SinceMs
	}
	if input.UntilMs != nil {
		untilMs = input.UntilMs
	}
	intervals, otelAfter := reconcileSessionStateEntries(sessionStateEntries(input.Entries),
		otelCallTimestamps(input.OTelEntries), sinceMs, untilMs, attributed)
	skipped := input.SkippedSession
	if skipped == nil {
		skipped = func(string) bool { return false }
	}
	gaps := creditGapEntries(input.Snapshots, attributed, skipped, sinceMs, untilMs)
	return Reconciliation{Intervals: intervals, OTelAfter: otelAfter, AttributedNano: attributed, Gaps: gaps}
}

// sessionStateEntries drops the credit-gap entries from a mix of pipelines'
// entries: OTel calls and session-state snapshots are the only inputs the
// interval differencing reads, and a credit gap (a session-wide total, no
// tokens) would otherwise become a zero-valued baseline for its model.
func sessionStateEntries(entries []Entry) []Entry {
	out := make([]Entry, 0, len(entries))
	for _, entry := range entries {
		if entry.CostUSD != nil {
			continue
		}
		out = append(out, entry)
	}
	return out
}

// OtelCallTimestamps is otel_call_timestamps (loader.rs:140-154): OTel call
// timestamps per (session, model), sorted.
func otelCallTimestamps(entries []Entry) map[string][]int64 {
	calls := map[string][]int64{}
	for _, entry := range entries {
		key := otelKey(entry.SessionID, entry.Model)
		calls[key] = append(calls[key], entry.Timestamp)
	}
	for _, timestamps := range calls {
		sort.Slice(timestamps, func(i, j int) bool { return timestamps[i] < timestamps[j] })
	}
	return calls
}

// otelReplacementStart is otel_replacement_start (loader.rs:164-195). sorted
// are the indices of entries for one (session, model) in order; calls are the
// OTel call timestamps of the same key. It returns the position of the first
// interval OTel replaces - the first interval with OTel rows after which OTel
// holds more calls than the intervals report - or -1 when OTel does not
// replace anything.
func otelReplacementStart(entries []Entry, sorted []int, calls []int64) int {
	for _, index := range sorted {
		if entries[index].RequestCount == 0 {
			return -1
		}
	}
	start := -1
	var countedCalls, otelCalls, reportedCalls, previousRequests uint64
	for position, index := range sorted {
		entry := entries[index]
		through := sort.Search(len(calls), func(i int) bool { return calls[i] > entry.Timestamp })

		callsThrough := uint64(through)
		intervalCalls := callsThrough - countedCalls
		countedCalls = callsThrough
		if start < 0 && intervalCalls > 0 {
			start = position
		}
		if start >= 0 {
			otelCalls = tools.SaturatingAddU64(otelCalls, intervalCalls)
			reportedCalls = tools.SaturatingAddU64(reportedCalls,
				tools.SaturatingSubU64(entry.RequestCount, previousRequests))
		}
		previousRequests = entry.RequestCount
	}
	if start < 0 || otelCalls <= reportedCalls {
		return -1
	}
	return start
}

// reconcileSessionStateEntries is reconcile_session_state_entries
// (loader.rs:199-268).
func reconcileSessionStateEntries(entries []Entry, otelCalls map[string][]int64,
	sinceMs, untilMs *int64, attributed map[string]uint64) ([]Entry, map[string]int64) {
	entries = deduplicateSessionEntries(entries)
	grouped := map[string][]int{}
	keys := []string{}
	for index, entry := range entries {
		key := otelKey(entry.SessionID, entry.Model)
		if _, present := grouped[key]; !present {
			keys = append(keys, key)
		}
		grouped[key] = append(grouped[key], index)
	}
	sort.Strings(keys)
	intervalIndices := []Entry{}
	otelAfter := map[string]int64{}
	for _, key := range keys {
		sorted := grouped[key]
		sort.SliceStable(sorted, func(i, j int) bool {
			left, right := entries[sorted[i]], entries[sorted[j]]
			if left.Timestamp != right.Timestamp {
				return left.Timestamp < right.Timestamp
			}
			return sorted[i] < sorted[j]
		})
		latestVisible := -1
		for position := len(sorted) - 1; position >= 0; position-- {
			if untilMs == nil || entries[sorted[position]].Timestamp < *untilMs {
				latestVisible = position
				break
			}
		}
		otelStart := -1
		if calls, ok := otelCalls[key]; ok {
			otelStart = otelReplacementStart(entries, sorted, calls)
		}
		// otelStart - 1 is the interval before the replaced one; with
		// otelStart == 0 it is None, so nothing is suppressed. When OTel
		// replaces nothing, every snapshot visible through --until counts.
		otelAfterPosition := otelStart - 1
		if otelStart < 0 {
			otelAfterPosition = latestVisible
		}
		if otelAfterPosition >= 0 {
			otelAfter[key] = entries[sorted[otelAfterPosition]].Timestamp
		}
		havePrevious := false
		var previous Entry
		for position, index := range sorted {
			current := entries[index]
			var reconciled Entry
			if havePrevious {
				reconciled = subtractUsage(current, previous)
			} else {
				reconciled = cloneEntry(current)
			}
			previous, havePrevious = current, true
			attributed[attributedKey(current.SessionID, current.Timestamp)] =
				tools.SaturatingAddU64(attributed[attributedKey(current.SessionID, current.Timestamp)], reconciled.NanoAiu)
			// The visibility cut is a drop even when nothing is suppressed:
			// latest_visible is .unwrap_or(i64::MAX), so a key with no
			// snapshot before --until keeps no interval at all.
			if (latestVisible < 0 || position > latestVisible) ||
				(otelStart >= 0 && position >= otelStart) ||
				(sinceMs != nil && current.Timestamp < *sinceMs) {
				continue
			}
			if hasUsage(reconciled) {
				intervalIndices = append(intervalIndices, reconciled)
			}
		}
	}
	sort.SliceStable(intervalIndices, func(i, j int) bool {
		if intervalIndices[i].Timestamp != intervalIndices[j].Timestamp {
			return intervalIndices[i].Timestamp < intervalIndices[j].Timestamp
		}
		return intervalIndices[i].DedupKey < intervalIndices[j].DedupKey
	})
	return intervalIndices, otelAfter
}

// creditGapEntries is credit_gap_entries (loader.rs:289-357): the session-wide
// totalNanoAiu no modelMetrics entry accounts for, as cost-only entries.
//
// modelMetrics only covers the running Copilot process: a resumed or restarted
// session reports an empty or partial breakdown while totalNanoAiu keeps the
// whole session. At every shutdown, and at the checkpoints after the last one,
// the unexplained amount is the session total minus the per-model credits
// reported so far. A later shutdown can catch up on a breakdown, so only what
// stays unexplained at every later snapshot is reported, dated at the first
// snapshot from which it stays. Checkpoints before a shutdown are already part
// of that shutdown's total.
func creditGapEntries(snapshots []CreditSnapshot, attributed map[string]uint64,
	skippedSessions func(string) bool, sinceMs, untilMs *int64) []Entry {
	seen := map[string]bool{}
	sessions := map[string][]CreditSnapshot{}
	sessionIDs := []string{}
	for _, snapshot := range snapshots {
		if seen[snapshot.DedupKey] {
			continue
		}
		seen[snapshot.DedupKey] = true
		if _, present := sessions[snapshot.SessionID]; !present {
			sessionIDs = append(sessionIDs, snapshot.SessionID)
		}
		sessions[snapshot.SessionID] = append(sessions[snapshot.SessionID], snapshot)
	}
	sort.Strings(sessionIDs)
	gaps := []Entry{}
	for _, sessionID := range sessionIDs {
		group := sessions[sessionID]
		allShutdown := true
		unknownTotal := false
		for _, snapshot := range group {
			if !snapshot.IsShutdown {
				allShutdown = false
				continue
			}
			if snapshot.TotalNanoAiu == nil {
				unknownTotal = true
			}
		}
		// Sessions without checkpoints come from Copilot versions that restart
		// their totals; without a total on every shutdown, the tokens already
		// reported cannot be told apart from what is missing.
		if skippedSessions(sessionID) || allShutdown || unknownTotal {
			continue
		}
		// (timestamp, is_shutdown): checkpoints sort before a shutdown at the
		// same instant.
		sort.SliceStable(group, func(i, j int) bool {
			if group[i].Timestamp != group[j].Timestamp {
				return group[i].Timestamp < group[j].Timestamp
			}
			return !group[i].IsShutdown && group[j].IsShutdown
		})
		lastShutdown := -1
		for position := len(group) - 1; position >= 0; position-- {
			if group[position].IsShutdown {
				lastShutdown = position
				break
			}
		}
		var sessionTotal, attributedTotal uint64
		type point struct {
			snapshot    CreditSnapshot
			unexplained uint64
		}
		points := []point{}
		for position, snapshot := range group {
			if !snapshot.IsShutdown && lastShutdown >= 0 && position < lastShutdown {
				continue
			}
			total := uint64(0)
			if snapshot.TotalNanoAiu != nil {
				total = *snapshot.TotalNanoAiu
			}
			if total > sessionTotal {
				sessionTotal = total
			}
			if snapshot.IsShutdown {
				attributedTotal = tools.SaturatingAddU64(attributedTotal,
					attributed[attributedKey(sessionID, snapshot.Timestamp)])
			}
			points = append(points, point{snapshot, tools.SaturatingSubU64(sessionTotal, attributedTotal)})
		}
		// Suffix minimum: an amount is only reported if no later snapshot
		// explains it away.
		lasting := ^uint64(0)
		for index := len(points) - 1; index >= 0; index-- {
			if points[index].unexplained < lasting {
				lasting = points[index].unexplained
			}
			points[index].unexplained = lasting
		}
		var reported uint64
		for _, current := range points {
			gap := tools.SaturatingSubU64(current.unexplained, reported)
			if current.unexplained > reported {
				reported = current.unexplained
			}
			millis := current.snapshot.Timestamp
			if gap == 0 ||
				(sinceMs != nil && millis < *sinceMs) ||
				(untilMs != nil && millis >= *untilMs) {
				continue
			}
			gaps = append(gaps, creditGapEntry(current.snapshot, gap))
		}
	}
	return gaps
}

// creditGapEntry is credit_gap_entry (loader.rs:359-377). One AIU is one
// GitHub AI credit, billed at $0.01, so nano / 1e11 is dollars.
func creditGapEntry(snapshot CreditSnapshot, nanoAiu uint64) Entry {
	cost := nativepricing.Product(float64(nanoAiu), 1e-11)
	return Entry{
		Timestamp:     snapshot.Timestamp,
		TimestampText: tools.FormatRFC3339Millis(snapshot.Timestamp),
		SessionID:     snapshot.SessionID,
		Model:         unattributedModel,
		NanoAiu:       nanoAiu,
		CostUSD:       &cost,
		DedupKey:      snapshot.DedupKey,
	}
}

// deduplicateSessionEntries is deduplicate_session_entries (loader.rs:379-395):
// per dedup key the entry with the latest timestamp is kept; on a tie the
// later occurrence replaces the earlier one. Survivors keep their discovery
// order.
func deduplicateSessionEntries(entries []Entry) []Entry {
	indexes := map[string]int{}
	for index, entry := range entries {
		previous, present := indexes[entry.DedupKey]
		if !present || entries[previous].Timestamp <= entry.Timestamp {
			indexes[entry.DedupKey] = index
		}
	}
	kept := make([]int, 0, len(indexes))
	for _, index := range indexes {
		kept = append(kept, index)
	}
	sort.Ints(kept)
	out := make([]Entry, 0, len(kept))
	for _, index := range kept {
		out = append(out, entries[index])
	}
	return out
}

// subtractUsage is subtract_usage (loader.rs:397-422): the interval between two
// cumulative snapshots, saturating, with no cost.
func subtractUsage(current, baseline Entry) Entry {
	return Entry{
		Timestamp:     current.Timestamp,
		TimestampText: current.TimestampText,
		SessionID:     current.SessionID,
		Model:         current.Model,
		Input:         tools.SaturatingSubU64(current.Input, baseline.Input),
		Output:        tools.SaturatingSubU64(current.Output, baseline.Output),
		CacheCreation: tools.SaturatingSubU64(current.CacheCreation, baseline.CacheCreation),
		CacheRead:     tools.SaturatingSubU64(current.CacheRead, baseline.CacheRead),
		Reasoning:     tools.SaturatingSubU64(current.Reasoning, baseline.Reasoning),
		Extra:         tools.SaturatingSubU64(current.Extra, baseline.Extra),
		RequestCount:  tools.SaturatingSubU64(current.RequestCount, baseline.RequestCount),
		NanoAiu:       tools.SaturatingSubU64(current.NanoAiu, baseline.NanoAiu),
		DedupKey:      current.DedupKey,
	}
}

// hasUsage is has_usage (loader.rs:424-432).
func hasUsage(entry Entry) bool {
	return entry.Input > 0 || entry.Output > 0 || entry.CacheCreation > 0 ||
		entry.CacheRead > 0 || entry.Reasoning > 0 || entry.Extra > 0 || entry.RequestCount > 0
}

func cloneEntry(entry Entry) Entry {
	return entry
}
