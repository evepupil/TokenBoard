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

// A parse error in one file must surface with that file's message, whichever
// worker found it.
func TestParallelParseReportsAFileError(t *testing.T) {
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
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err := loadGroupsPerKindWorkers(ctx, []FileGroup{{Dir: root, Files: files}}, "UTC", "", "", 4)
	if err == nil {
		t.Fatal("want a cancelled parse to return the context error")
	}
}

// The readers must not run arbitrarily far ahead of the aggregation. Holding the
// whole corpus would turn a flat per-file memory profile into a peak
// proportional to the whole scan, which on this machine's Codex history is
// several gigabytes. The probe stalls the first consume call until the readers
// have had time to run ahead, then records how many files were parsed: it must
// stay within the window the channel capacity allows, not grow to every file.
func TestParallelParseKeepsTheReadAheadWindowBounded(t *testing.T) {
	root := t.TempDir()
	files := writeManyFiles(t, root, 48)
	pruned := []FileGroup{{Dir: root, Files: files}}
	plan := NewReplayPlan(pruned)
	const workers = 4

	parsed := int64(0)
	parsedAtFirstConsume := int64(-1)
	err := streamFilesInOrder(context.Background(), pruned, plan, workers,
		func(events []Event) error {
			if atomic.LoadInt64(&parsedAtFirstConsume) < 0 {
				// Give the readers a generous moment to run ahead, then look.
				time.Sleep(150 * time.Millisecond)
				atomic.StoreInt64(&parsedAtFirstConsume, atomic.LoadInt64(&parsed))
			}
			return nil
		},
		func() { atomic.AddInt64(&parsed, 1) },
	)
	if err != nil {
		t.Fatal(err)
	}
	readAhead := atomic.LoadInt64(&parsedAtFirstConsume)
	// The bound is a constant of the worker count: at most workers files in
	// flight, the entry being booked, and the one already queued behind it.
	limit := int64(workers + 2)
	if readAhead > limit {
		t.Fatalf("readers were %d files ahead before the aggregation booked the first file, want at most %d", readAhead, limit)
	}
	// Well under the corpus: 48 files would mean the whole corpus was parsed.
	if readAhead >= int64(len(files))/2 {
		t.Fatalf("readers were %d files ahead of %d, want a bounded window", readAhead, len(files))
	}
}
