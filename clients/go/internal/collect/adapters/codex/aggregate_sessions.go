package codex

import (
	"context"
	"errors"
	"runtime"
	"sync"
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
	return loadGroupsPerKindWorkers(ctx, sources, timezone, since, until, codexParseWorkers())
}

// loadGroupsPerKindWorkers is the implementation behind both entry points.
// Parsing is per-file and independent, so the workers read files concurrently;
// aggregation is order-sensitive (the dedupe tables keep insertion order and a
// duplicate's earliest copy is decided by arrival), so the events a worker
// collected are replayed to the aggregation in file order. The result is the
// same as a sequential pass whatever the worker count, which
// aggregate_parallel_test.go pins.
func loadGroupsPerKindWorkers(ctx context.Context, sources []FileGroup, timezone, since, until string, workers int) (map[string]*Group, map[string]*Group, error) {
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
	if workers < 1 {
		workers = 1
	}
	parsed, err := parseFiles(ctx, pruned, plan, workers)
	if err != nil {
		return nil, nil, err
	}
	aggregation := newPerKindAggregation()
	for fileOffset, file := range parsed {
		for _, event := range file.events {
			if err := aggregation.addEvent(event, fileOffset, location, since, until); err != nil {
				return nil, nil, err
			}
		}
	}
	aggregation.applyRecordedUsage(location, since, until)
	return aggregation.daily.groups, aggregation.sessions.groups, nil
}

// parsedFile is one file's events, in the order the parser produced them.
type parsedFile struct {
	events []Event
}

// parseFiles reads every eligible file, at most `workers` at a time, and
// returns one entry per file in file order. A cancelled context stops the
// workers and returns its error; the first parse error wins.
func parseFiles(ctx context.Context, pruned []FileGroup, plan *ReplayPlan, workers int) ([]parsedFile, error) {
	type job struct {
		index       int
		sessionsDir string
		file        string
	}
	jobs := make(chan job)
	// The file order is fixed before the workers start, so the replay below
	// never depends on which worker finished first.
	order := []job{}
	for _, group := range pruned {
		for _, file := range group.Files {
			order = append(order, job{index: len(order), sessionsDir: group.Dir, file: file})
		}
	}
	results := make([]parsedFile, len(order))

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var firstErr error
	var errMu sync.Mutex
	var pending sync.WaitGroup
	pending.Add(workers)
	for worker := 0; worker < workers; worker++ {
		go func() {
			defer pending.Done()
			for item := range jobs {
				if ctx.Err() != nil {
					return
				}
				events := make([]Event, 0, 16)
				err := ParseFile(item.sessionsDir, item.file, plan.Prefix(item.file), func(event Event) error {
					events = append(events, event)
					return nil
				})
				if err != nil {
					errMu.Lock()
					if firstErr == nil {
						firstErr = err
						cancel()
					}
					errMu.Unlock()
					return
				}
				results[item.index] = parsedFile{events: events}
			}
		}()
	}
	for _, item := range order {
		select {
		case jobs <- item:
		case <-ctx.Done():
		}
	}
	close(jobs)
	pending.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	// No parse failed, so a cancelled context is the caller's: report it.
	if err := ctx.Err(); err != nil && (errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)) {
		return nil, err
	}
	return results, nil
}

// addEvent books one event into both kinds. The plan's replayed-compaction
// filter is applied here, in file order, so it sees the same sequence a
// sequential parse would.
func (a *perKindAggregation) addEvent(event Event, fileIndex int, location *time.Location, since, until string) error {
	if err := a.daily.addEvent(event, ReportDaily, location, since, until, fileIndex); err != nil {
		return err
	}
	return a.sessions.addEvent(event, ReportSession, location, since, until, fileIndex)
}

// applyRecordedUsage is applyRecordedUsage for both kinds.
func (a *perKindAggregation) applyRecordedUsage(location *time.Location, since, until string) {
	a.daily.applyRecordedUsage(ReportDaily, location, since, until)
	a.sessions.applyRecordedUsage(ReportSession, location, since, until)
}

// codexParseWorkers is the number of rollout files parsed concurrently. The
// parse is CPU-bound (JSON decoding of the decompressed text), so it scales
// with cores; the cap keeps a very large machine from opening hundreds of zstd
// decoders and file handles at once. It mirrors the bound the subagent pool
// already uses for the same reason.
func codexParseWorkers() int {
	workers := runtime.NumCPU()
	if workers > 8 {
		workers = 8
	}
	if workers < 2 {
		workers = 2
	}
	return workers
}
