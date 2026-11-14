package codex

import (
	"context"
	"errors"
	"runtime"
	"sync"
	"time"
)

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
// which worker finishes first, and keeps memory bounded: a file parsed ahead of
// its turn waits with a read slot, and the pass holds at most 2*workers files.

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
	if workers < 1 {
		workers = 1
	}
	aggregation := newPerKindAggregation()
	if err := parseFiles(ctx, pruned, plan, workers, func(fileIndex int, events []Event) error {
		for _, event := range events {
			if err := aggregation.addEvent(event, fileIndex, location, since, until); err != nil {
				return err
			}
		}
		return nil
	}, nil); err != nil {
		return nil, nil, err
	}
	aggregation.applyRecordedUsage(location, since, until)
	return aggregation.daily.groups, aggregation.sessions.groups, nil
}

// parsedFile is one file's events, in the order the parser produced them.
type parsedFile struct {
	events []Event
}

// parseFiles reads every eligible file, at most `workers` at a time, and hands
// each file's events to consume in file order. A cancelled context stops the
// workers and returns its error; the first parse error wins, and one from
// consume ends the pass the same way.
//
// Memory is bounded by a read budget of 2*workers slots. A worker takes one slot
// before claiming a file and keeps it until the aggregation has booked that
// file; a completed file that finished ahead of its turn waits with its slot.
// A worker takes the slot before the job, so when the budget is full the next
// job cannot be the earliest unbooked file: that file is already being parsed
// or waiting in its ready channel, either of which lets the consumption side
// release a slot. There is no interleaving in which every worker waits for a
// slot while the aggregation waits for a file no worker has claimed.
//
// onParsed, when supplied, runs after each successful parse. It lets a test
// measure how far the readers ran ahead of the aggregation.
func parseFiles(
	ctx context.Context,
	pruned []FileGroup,
	plan *ReplayPlan,
	workers int,
	consume func(fileIndex int, events []Event) error,
	onParsed func(),
) error {
	if onParsed == nil {
		onParsed = func() {}
	}
	type job struct {
		index       int
		sessionsDir string
		file        string
	}
	jobs := make(chan job)
	// The file order is fixed before the workers start, so the consumption
	// below never depends on which worker finished first.
	order := []job{}
	for _, group := range pruned {
		for _, file := range group.Files {
			order = append(order, job{index: len(order), sessionsDir: group.Dir, file: file})
		}
	}
	ready := make([]chan parsedFile, len(order))
	for i := range ready {
		ready[i] = make(chan parsedFile, 1)
	}
	budget := make(chan struct{}, 2*workers)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	// takeSlot makes a worker wait for a read slot or a cancellation, whichever
	// comes first. It reports false when the slot was not taken. A slot is
	// released only after the aggregation has booked that file.
	takeSlot := func() bool {
		select {
		case budget <- struct{}{}:
			return true
		case <-ctx.Done():
			return false
		}
	}

	var firstErr error
	var errMu sync.Mutex
	fail := func(err error) {
		errMu.Lock()
		if firstErr == nil {
			firstErr = err
		}
		errMu.Unlock()
		cancel()
	}

	var pending sync.WaitGroup
	pending.Add(workers)
	for worker := 0; worker < workers; worker++ {
		go func() {
			defer pending.Done()
			for {
				// The slot is taken before the file is claimed, so the worker
				// holding the earliest file due is never the one waiting for
				// budget while later files (from other workers) fill it.
				if !takeSlot() {
					return
				}
				item, ok := <-jobs
				if !ok {
					return
				}
				events := make([]Event, 0, 16)
				err := ParseFile(item.sessionsDir, item.file, plan.Prefix(item.file), func(event Event) error {
					// aggregateFile drops the compaction records a fork copied from
					// its parent (aggregate.go); the filter is kind-independent, so
					// it runs here, before the event reaches either grouping.
					if plan.IsReplayedCompaction(item.file, event.ResponseID) {
						return nil
					}
					events = append(events, event)
					return nil
				})
				if err != nil {
					fail(err)
					return
				}
				onParsed()
				// A failed parse returns without releasing its slot; fail cancels
				// the pass, so no worker waits on that slot again. On the success
				// path every slot is released after the file is booked or is still
				// held when the pass is cancelled.
				select {
				case ready[item.index] <- parsedFile{events: events}:
				case <-ctx.Done():
					return
				}
			}
		}()
	}

	// The feed runs alongside the consumption: the workers stop taking slots
	// once every one belongs to a completed file, and the consumption frees the
	// earliest one. Feeding from this goroutine instead would let it block on
	// the jobs channel while nobody reads, which is the same deadlock one level
	// down.
	go func() {
		defer close(jobs)
		for _, item := range order {
			select {
			case jobs <- item:
			case <-ctx.Done():
				return
			}
		}
	}()

	for i := range order {
		select {
		case file := <-ready[i]:
			err := consume(i, file.events)
			<-budget
			if err != nil {
				fail(err)
			}
		case <-ctx.Done():
		}
		if ctx.Err() != nil {
			break
		}
	}
	pending.Wait()
	if firstErr != nil {
		return firstErr
	}
	// No parse failed, so a cancelled context is the caller's: report it.
	if err := ctx.Err(); err != nil && (errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)) {
		return err
	}
	return nil
}

// addEvent books one event into both kinds, in file order, after parseFiles has
// dropped the compaction records a fork copied from its parent.
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
