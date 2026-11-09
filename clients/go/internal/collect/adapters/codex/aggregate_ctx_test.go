package codex

// LoadGroupsContext exists so a caller-deadline can stop a scan between files:
// the Codex tree can hold hundreds of megabytes, and a cancelled collection
// must not keep reading it to the end. The timeout path in the native report
// runner depends on exactly this.

import (
	"context"
	"errors"
	"testing"
)

// cancelAfterCalls is a context whose Err reports cancellation once the caller
// has polled it callsLeft+1 times. It turns the checkpoints into a deterministic
// seam: a real cancel arrives mid-scan, and this reproduces that without timing.
type cancelAfterCalls struct {
	context.Context
	callsLeft int
}

func (c *cancelAfterCalls) Err() error {
	if c.callsLeft <= 0 {
		return context.Canceled
	}
	c.callsLeft--
	return nil
}

// TestLoadGroupsContextStopsAtTheNextCheckpoint pins the cancellation contract:
// a scan cancelled part-way returns context.Canceled and no groups. The call
// calibration lands the cancel inside the per-file loop - the two fixed
// pre-scan checkpoints (prune, replay plan) consume the first calls - so an
// implementation that only checked the context at entry would miss it.
func TestLoadGroupsContextStopsAtTheNextCheckpoint(t *testing.T) {
	root := t.TempDir()
	files := []string{}
	for _, name := range []string{"a.jsonl", "b.jsonl", "c.jsonl", "d.jsonl"} {
		files = append(files, writeSourceFile(t, root, name,
			headlessLine("2026-01-05T12:00:00Z", "gpt-5.4", 100, 20)))
	}
	sources := []FileGroup{{Dir: root, Files: files}}

	ctx := &cancelAfterCalls{Context: context.Background(), callsLeft: 3}
	groups, err := LoadGroupsContext(ctx, sources, ReportDaily, "UTC", "", "")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if groups != nil {
		t.Fatalf("groups = %+v, want none after cancellation", groups)
	}

	// An already-cancelled context is refused before any file is read, and the
	// background path stays byte-identical to LoadGroups.
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := LoadGroupsContext(cancelled, sources, ReportDaily, "UTC", "", ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled err = %v, want context.Canceled", err)
	}
	if _, err := LoadGroupsContext(context.Background(), sources, ReportDaily, "UTC", "", ""); err != nil {
		t.Fatalf("background err = %v, want a completed scan", err)
	}
}
