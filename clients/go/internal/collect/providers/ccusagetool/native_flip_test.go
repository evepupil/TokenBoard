package ccusagetool

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// TestNativeToolsAreTheDefaultPath is the S5 gate: every tool source has a
// native adapter behind the registry, and a default Collect over a home with
// no tool install never reaches the caller's report runner.
func TestNativeToolsAreTheDefaultPath(t *testing.T) {
	for _, source := range contract.CcusageToolSources() {
		if _, ok := collect.LookupNative(source); !ok {
			t.Fatalf("no native provider registered for %s", source)
		}
	}
	// A scratch home: the tester's own amp history must not leak in.
	home := t.TempDir()
	for _, dir := range []string{"threads"} {
		if err := os.MkdirAll(filepath.Join(home, "amp", dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	// No Runner is injected: the default path builds its own in-process
	// runner, and a regression that wanted a report would have to fail here
	// rather than answer from a stub.
	snapshots, err := Collect(context.Background(), contract.Source("amp"), Options{
		Env: func(key string) string {
			if key == "AMP_DATA_DIR" {
				return filepath.Join(home, "amp")
			}
			return ""
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 0 {
		t.Fatalf("snapshots = %+v, want none for a tool-less home", snapshots)
	}
}
