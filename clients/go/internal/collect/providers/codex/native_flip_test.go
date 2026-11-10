package codex

import (
	"context"
	"testing"

	ccexec "github.com/MisonL/TokenBoard/clients/go/internal/ccusage/exec"
)

// TestNativeCodexIsTheDefaultPath is the S5 gate: the compile-time switch points
// at the in-process report source, and a Collect over an empty home never
// reaches the caller's ccusage runner.
func TestNativeCodexIsTheDefaultPath(t *testing.T) {
	if !useNativeCodex {
		t.Fatal("useNativeCodex must be true after the native path passed the parity gate")
	}
	codexHome := provEmptyCodexHome(t)
	calls := 0
	runner := func(context.Context, string, []string, ccexec.CommandOptions) (any, error) {
		calls++
		return nil, nil
	}
	snapshots, err := Collect(context.Background(), Options{
		CodexHome:   provHome(codexHome),
		Timezone:    "UTC",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		Runner:      runner,
		StateDir:    t.TempDir(),
		Env:         provEnv(provForceEnv(nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatalf("the ccusage runner was called %d times; the native path must never spawn ccusage", calls)
	}
	if len(snapshots) != 0 {
		t.Fatalf("snapshots = %+v, want none for an empty home", snapshots)
	}
}
