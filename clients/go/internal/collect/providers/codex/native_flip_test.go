package codex

import (
	"context"
	"testing"
)

// TestNativeCodexIsTheDefaultPath is the S5 gate: the report source is the
// in-process adapter, and a Collect over an empty home never reaches the
// caller's report runner.
func TestNativeCodexIsTheDefaultPath(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	snapshots, err := Collect(context.Background(), Options{
		CodexHome:   provHome(codexHome),
		Timezone:    "UTC",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		StateDir:    t.TempDir(),
		Env:         provEnv(provForceEnv(nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 0 {
		t.Fatalf("snapshots = %+v, want none for an empty home", snapshots)
	}
}
