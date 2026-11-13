package codex

// One parse, two report kinds, parsed concurrently.
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
//
// Parsing is per-file and independent, so files are parsed concurrently; the
// aggregation is a single ordered stream and is fed one file at a time, in file
// order, as soon as each file's turn comes. That keeps the result independent of
// which worker finishes first, and keeps memory flat: a file parsed ahead of its
// turn waits in a window of `workers+1` entries, not in a buffer holding the
// whole corpus.

import (
	"context"
	"runtime"
	"sync"
	"time"
)

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

// loadGroupsPerKindWorkers is the implementation behind both entry points. The
// worker count is a parameter so the tests can pin that every count produces the
// same groupings.
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
	aggregation := newPerKindAggregation()
	fileOffset := 0
	err := streamFilesInOrder(ctx, pruned, plan, workers,
		func(events []Event) error {
			for _, event := range events {
				if err := aggregation.addEvent(event, fileOffset, location, since, until); err != nil {
					return err
				}
			}
			fileOffset++
			return nil
		},
		func() {},
	)
	if err != nil {
		return nil, nil, err
	}
	aggregation.applyRecordedUsage(location, since, until)
	return aggregation.daily.groups, aggregation.sessions.groups, nil
}

// addEvent books one event into both kinds in a fixed order. The replayed-
// compaction filter is kind-independent, so moving it from the per-file visitor
// to this point does not change which events are booked.
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

// fileJob is one eligible file and its position in the scan.
type fileJob struct {
	index       int
	sessionsDir string
	file        string
}

// parsedEvents is one parsed file waiting for its turn in the aggregation.
type parsedEvents struct {
	index  int
	events []Event
}

// streamFilesInOrder parses every eligible file with up to `workers` concurrent
// readers and hands each file's events to `consume` in file order, as soon as
// that file is the next one due. A file that finishes ahead of its turn waits in
// a window of workers+1 entries, so a slow file at the front cannot let the
// whole corpus pile up in memory.
//
// The order is fixed before the workers start, so which worker finishes first
// never affects what `consume` sees. `onParsed` runs after each successful parse,
// which lets a test observe how far ahead the readers ran.
func streamFilesInOrder(
	ctx context.Context,
	pruned []FileGroup,
	plan *ReplayPlan,
	workers int,
	consume func(events []Event) error,
	onParsed func(),
) error {
	if workers < 1 {
		workers = 1
	}
	if onParsed == nil {
		onParsed = func() {}
	}
	order := []fileJob{}
	for _, group := range pruned {
		for _, file := range group.Files {
			order = append(order, fileJob{index: len(order), sessionsDir: group.Dir, file: file})
		}
	}
	if len(order) == 0 {
		return nil
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var firstErr error
	var errMu sync.Mutex
	var pending sync.WaitGroup

	// ready carries one parsed file per send. Its capacity is the window: a
	// worker blocks once it is more than workers+1 files ahead of the
	// aggregation, which bounds the memory the readers can hold.
	// slots is the read-ahead window: a worker holds one slot from the start of
	// a file's parse until the aggregation has taken that file. At most
	// workers+1 files (one in flight per worker plus the one being booked) are
	// ever parsed ahead of the aggregation.
	slots := make(chan struct{}, workers+1)
	ready := make(chan parsedEvents)
	// jobs is unbuffered so each worker picks up the next file only after it
	// finished the previous one; the sender below is the only writer and always
	// closes it.
	jobs := make(chan fileJob)

	pending.Add(workers)
	for worker := 0; worker < workers; worker++ {
		go func() {
			defer pending.Done()
			for item := range jobs {
				if ctx.Err() != nil {
					return
				}
				// Claim a slot before parsing. Without this a worker that finds the
				// window full still parses its next file and holds the events on
				// its own stack, so the read-ahead grows to workers extra files
				// beyond the window.
				select {
				case slots <- struct{}{}:
				case <-ctx.Done():
					return
				}
				events := make([]Event, 0, 16)
				err := ParseFile(item.sessionsDir, item.file, plan.Prefix(item.file), func(event Event) error {
					events = append(events, event)
					return nil
				})
				if err != nil {
					<-slots
					errMu.Lock()
					if firstErr == nil {
						firstErr = err
						cancel()
					}
					errMu.Unlock()
					return
				}
				onParsed()
				select {
				case ready <- parsedEvents{index: item.index, events: events}:
				case <-ctx.Done():
					<-slots
					return
				}
			}
		}()
	}

	// The aggregation runs on its own goroutine so the readers keep going while
	// it books events; it only ever sees files in index order.
	consumeErr := make(chan error, 1)
	go func() {
		waiting := map[int][]Event{}
		for next := 0; next < len(order); next++ {
			events, ok := waiting[next]
			if ok {
				delete(waiting, next)
			} else {
				for {
					select {
					case got := <-ready:
						if got.index == next {
							events, ok = got.events, true
						} else {
							waiting[got.index] = got.events
						}
					case <-ctx.Done():
						consumeErr <- ctx.Err()
						return
					}
					if ok {
						break
					}
				}
			}
			<-slots
			if err := consume(events); err != nil {
				cancel()
				consumeErr <- err
				return
			}
		}
		consumeErr <- nil
	}()

	for _, item := range order {
		select {
		case jobs <- item:
		case <-ctx.Done():
		}
	}
	close(jobs)
	pending.Wait()
	consumeDone := <-consumeErr
	// A parse error is the real failure; the context error it triggered is only
	// its consequence.
	if firstErr != nil {
		return firstErr
	}
	return consumeDone
}

// codexParseWorkers is the number of rollout files parsed concurrently. The
// parse is CPU-bound (JSON decoding of the decompressed text), so it scales
// with cores. The cap is 8, the same ceiling the subagent worker pool uses to
// keep a very large machine from opening hundreds of zstd decoders and file
// handles at once; the floor is 2 so even a single-core machine overlaps one
// file's parse with the next file's read.
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
