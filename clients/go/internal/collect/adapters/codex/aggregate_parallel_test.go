package codex

// The parallel parse must produce exactly the groupings a sequential pass
// produces. Ordering matters because the dedupe tables keep insertion order and
// a duplicate's service tier and earliest copy are resolved by arrival order,
// so the workers only parse; the aggregated events are replayed in file order.

import (
	"context"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func writeManyFiles(t *testing.T, root string, count int) []string {
	t.Helper()
	files := make([]string, 0, count)
	for index := 0; index < count; index++ {
		day := fmt.Sprintf("2026/01/%02d", index%28+1)
		name := filepath.Join(day, fmt.Sprintf("f%03d.jsonl", index))
		// Every file carries its own session id so the daily and session
		// groupings both have something to dedupe, and a couple of them share a
		// token count so the duplicate path is exercised.
		lines := []string{
			sessionMeta("2026-01-01T00:00:00.000Z", fmt.Sprintf("s%03d", index), ""),
			headlessLine("2026-01-05T12:00:00Z", "gpt-5.4", uint64(index%3+1)*100, 20),
			headlessLine("2026-01-06T12:00:00Z", "gpt-5.4", uint64(index%3+1)*100, 20),
		}
		files = append(files, writeSourceFile(t, root, name, lines...))
	}
	return files
}

func TestParallelParseMatchesSequential(t *testing.T) {
	root := t.TempDir()
	files := writeManyFiles(t, root, 40)
	sources := []FileGroup{{Dir: root, Files: files}}

	wantDaily, wantSessions, err := LoadGroupsPerKind(sources, "UTC", "", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, workers := range []int{1, 2, 4, 16} {
		gotDaily, gotSessions, err := loadGroupsPerKindWorkers(context.Background(), sources, "UTC", "", "", workers)
		if err != nil {
			t.Fatalf("workers=%d: %v", workers, err)
		}
		if !reflect.DeepEqual(gotDaily, wantDaily) {
			t.Fatalf("workers=%d: daily grouping differs from the sequential pass", workers)
		}
		if !reflect.DeepEqual(gotSessions, wantSessions) {
			t.Fatalf("workers=%d: session grouping differs from the sequential pass", workers)
		}
	}
}

// A windowed parse also runs through the replay plan, whose pruning depends on
// the same file order; the parallel path must not change which files survive.
func TestParallelParseMatchesSequentialWithAWindow(t *testing.T) {
	root := t.TempDir()
	files := writeManyFiles(t, root, 24)
	sources := []FileGroup{{Dir: root, Files: files}}

	wantDaily, wantSessions, err := LoadGroupsPerKind(sources, "UTC", "2026-01-05", "2026-01-06")
	if err != nil {
		t.Fatal(err)
	}
	gotDaily, gotSessions, err := loadGroupsPerKindWorkers(context.Background(), sources, "UTC", "2026-01-05", "2026-01-06", 8)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotDaily, wantDaily) {
		t.Fatalf("daily grouping differs from the sequential windowed pass")
	}
	if !reflect.DeepEqual(gotSessions, wantSessions) {
		t.Fatalf("session grouping differs from the sequential windowed pass")
	}
}

// An error while booking one file must end the pass with that file's message,
// whichever worker produced the file.
func TestParallelParseReportsABookingError(t *testing.T) {
	root := t.TempDir()
	good := writeSourceFile(t, root, "2026/01/05/good.jsonl", headlessLine("2026-01-05T12:00:00Z", "gpt-5.4", 10, 1))
	broken := writeSourceFile(t, root, "2026/01/06/bad.jsonl",
		tokenCountLine("not-a-timestamp", `{"last_token_usage":{"input_tokens":10}}`))
	_, _, err := loadGroupsPerKindWorkers(context.Background(), []FileGroup{{Dir: root, Files: []string{good, broken}}}, "UTC", "", "", 4)
	if err == nil {
		t.Fatal("want the invalid timestamp to fail the parse")
	}
	if !strings.Contains(err.Error(), "Invalid Codex timestamp: not-a-timestamp") {
		t.Fatalf("error = %q, want the invalid-timestamp message", err)
	}
}

// Cancellation must stop the parallel parse rather than run it to completion.
func TestParallelParseHonoursCancellation(t *testing.T) {
	root := t.TempDir()
	files := writeManyFiles(t, root, 20)
	sources := []FileGroup{{Dir: root, Files: files}}

	// Already-cancelled: nothing is parsed.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := loadGroupsPerKindWorkers(ctx, sources, "UTC", "", "", 4); err == nil {
		t.Fatal("want a cancelled parse to return the context error")
	}

	// Cancelled mid-pass: the pass must return once the first file is booked
	// rather than read the remaining files first.
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	booked := 0
	err := parseFiles(ctx, sources, NewReplayPlan(sources), 4, func(int, []Event) error {
		booked++
		cancel()
		return nil
	}, nil)
	if err == nil {
		t.Fatal("want the cancelled pass to report the context error")
	}
	if booked != 1 {
		t.Fatalf("booked %d files after cancellation, want 1", booked)
	}
}

// The readers must not run arbitrarily far ahead of the aggregation. Holding
// the whole corpus would turn a flat per-file memory profile into a peak
// proportional to the whole scan, which on this machine's Codex history is
// several gigabytes. The probe stalls the first booking until the readers have
// had time to run ahead, then records how many files were parsed.
func TestParallelParseKeepsTheReadAheadWindowBounded(t *testing.T) {
	root := t.TempDir()
	files := writeManyFiles(t, root, 64)
	sources := []FileGroup{{Dir: root, Files: files}}
	const workers = 4
	limit := int64(2 * workers)

	parsed := int64(0)
	parsedAtFirstConsume := int64(-1)
	err := parseFiles(context.Background(), sources, NewReplayPlan(sources), workers, func(int, []Event) error {
		if atomic.LoadInt64(&parsedAtFirstConsume) < 0 {
			// Give the readers a generous moment to run ahead, then look.
			time.Sleep(150 * time.Millisecond)
			atomic.StoreInt64(&parsedAtFirstConsume, atomic.LoadInt64(&parsed))
		}
		return nil
	}, func() { atomic.AddInt64(&parsed, 1) })
	if err != nil {
		t.Fatal(err)
	}
	readAhead := atomic.LoadInt64(&parsedAtFirstConsume)
	// The bound is the read budget itself: every parsed file holds a slot until
	// the aggregation books it, and the first booking has not released one yet.
	if readAhead > limit {
		t.Fatalf("readers were %d files ahead before the first file was booked, want at most %d", readAhead, limit)
	}
	if readAhead >= int64(len(files))/2 {
		t.Fatalf("readers were %d files ahead of %d, want a bounded window", readAhead, len(files))
	}
}

// A completed file is stored by its own index, so however the workers
// interleave, every file is replayed exactly once and no worker writes another
// worker's slot. The two groupings must be identical under repeated runs with
// many workers over more files than there are workers.
func TestParallelParseIsStableAcrossInterleavings(t *testing.T) {
	root := t.TempDir()
	files := writeManyFiles(t, root, 40)
	sources := []FileGroup{{Dir: root, Files: files}}
	wantDaily, wantSessions, err := LoadGroupsPerKind(sources, "UTC", "", "")
	if err != nil {
		t.Fatal(err)
	}
	for round := 0; round < 20; round++ {
		gotDaily, gotSessions, err := loadGroupsPerKindWorkers(context.Background(), sources, "UTC", "", "", 8)
		if err != nil {
			t.Fatalf("round %d: %v", round, err)
		}
		if !reflect.DeepEqual(gotDaily, wantDaily) || !reflect.DeepEqual(gotSessions, wantSessions) {
			t.Fatalf("round %d: groupings differ; a worker interleaved another file's slot", round)
		}
	}
}
