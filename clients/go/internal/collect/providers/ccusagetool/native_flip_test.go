package ccusagetool

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// TestNativeToolsAreTheDefaultPath is the S5 gate: every tool source's native
// switch is true, and Collect over a home with no tool install never spawns
// ccusage.
func TestNativeToolsAreTheDefaultPath(t *testing.T) {
	if !useNativeTools {
		t.Fatal("useNativeTools must be true after the native path passed the parity gate")
	}
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
	calls := 0
	runner := func(context.Context, string, []string, ccusage.CommandOptions) (any, error) {
		calls++
		return nil, nil
	}
	snapshots, err := Collect(context.Background(), contract.Source("amp"), Options{
		Runner: runner,
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
	if calls != 0 {
		t.Fatalf("the ccusage runner was called %d times; the native path must never spawn ccusage", calls)
	}
	if len(snapshots) != 0 {
		t.Fatalf("snapshots = %+v, want none for a tool-less home", snapshots)
	}
}
