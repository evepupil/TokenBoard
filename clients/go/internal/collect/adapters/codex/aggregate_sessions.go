package codex

import (
	"context"
	"time"
)

// One parse, two report kinds.
//
// The native report source answers `codex daily` and `codex session` as two
// separate calls, and each used to parse every rollout file from scratch. On
// this machine that is most of what the full scan costs, so the two reports now
// share a single pass: every file is read once and every event is booked into
// both the daily and the session grouping.
//
// The two groupings are not independent: which period an event belongs to, and
// whether a later copy of it may take it over, depend on the report kind
// (aggregate.rs:60-63, 711-751). A shared pass therefore keeps one dedupe table
// per kind and re-derives the daily/session decision from the event itself
// rather than from the kind parameter, which is what LoadGroups' single-kind
// path still does. The result must be identical to running both kinds
// separately, field for field, and aggregate_sessions_test.go pins that.

// perKindAggregation holds one aggregation per report kind, all fed from the
// same event stream.
type perKindAggregation struct {
	daily    *aggregation
	sessions *aggregation
}

func newPerKindAggregation() *perKindAggregation {
	return &perKindAggregation{daily: newAggregation(), sessions: newAggregation()}
}

// LoadGroupsPerKind is LoadGroups for the daily and session reports together:
// one pass over the eligible files, two groupings. A caller that needs both
// reports should use this instead of two LoadGroups calls, which parse the same
// bytes twice.
func LoadGroupsPerKind(sources []FileGroup, timezone, since, until string) (daily, sessions map[string]*Group, err error) {
	return LoadGroupsPerKindContext(context.Background(), sources, timezone, since, until)
}

// LoadGroupsPerKindContext is LoadGroupsPerKind with the same cancellation seam
// LoadGroupsContext provides.
func LoadGroupsPerKindContext(ctx context.Context, sources []FileGroup, timezone, since, until string) (map[string]*Group, map[string]*Group, error) {
	pruned := make([]FileGroup, len(sources))
	for i, group := range sources {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		pruned[i] = FileGroup{Dir: group.Dir, Files: FilterByEligibility(group.Dir, group.Files, since, until, timezone)}
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	var plan *ReplayPlan
	if since != "" || until != "" {
		plan = NewBoundedReplayPlan(pruned, sources)
	} else {
		plan = NewReplayPlan(sources)
	}
	location := reportTimezone(timezone)
	aggregation := newPerKindAggregation()
	fileOffset := 0
	for i, group := range sources {
		for _, file := range pruned[i].Files {
			if err := ctx.Err(); err != nil {
				return nil, nil, err
			}
			if err := aggregation.aggregateFile(group.Dir, file, fileOffset, location, since, until, plan); err != nil {
				return nil, nil, err
			}
			fileOffset++
		}
	}
	aggregation.applyRecordedUsage(location, since, until)
	return aggregation.daily.groups, aggregation.sessions.groups, nil
}

// aggregateFile reads one file once and hands every event to both kinds.
func (a *perKindAggregation) aggregateFile(
	sessionsDir, file string,
	fileIndex int,
	location *time.Location,
	since, until string,
	plan *ReplayPlan,
) error {
	return ParseFile(sessionsDir, file, plan.Prefix(file), func(event Event) error {
		if plan.IsReplayedCompaction(file, event.ResponseID) {
			return nil
		}
		if err := a.daily.addEvent(event, ReportDaily, location, since, until, fileIndex); err != nil {
			return err
		}
		return a.sessions.addEvent(event, ReportSession, location, since, until, fileIndex)
	})
}

// applyRecordedUsage is applyRecordedUsage for both kinds.
func (a *perKindAggregation) applyRecordedUsage(location *time.Location, since, until string) {
	a.daily.applyRecordedUsage(ReportDaily, location, since, until)
	a.sessions.applyRecordedUsage(ReportSession, location, since, until)
}
