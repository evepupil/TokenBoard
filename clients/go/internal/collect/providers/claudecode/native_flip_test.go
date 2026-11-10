package claudecode

// The default-path gate for the S5 flip (2026-11-10): Collect now runs the
// in-process adapter, and nothing on that path may spawn or acquire ccusage.
// claudecode_test.go drives the subprocess implementation through
// Options.ccusagePath; this file owns what a user actually gets.

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	ccacq "github.com/MisonL/TokenBoard/clients/go/internal/ccusage/acquire"
	ccexec "github.com/MisonL/TokenBoard/clients/go/internal/ccusage/exec"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

func TestNativeClaudeIsTheDefaultPath(t *testing.T) {
	configDir := t.TempDir()
	writeNativeSession(t, configDir,
		`{"type":"assistant","timestamp":"2026-05-22T02:00:00.000Z",`+
			`"message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":5,"output_tokens":1}}}`)
	snapshots, err := Collect(context.Background(), Options{
		Timezone:       "UTC",
		CollectedAt:    nativeCollectedAt,
		StateDir:       t.TempDir(),
		Env:            testEnv(map[string]string{"CLAUDE_CONFIG_DIR": configDir}),
		PricingFetcher: failingFetcher(t),
		Runner: func(context.Context, string, []string, ccexec.CommandOptions) (any, error) {
			t.Error("the default path must not run ccusage")
			return nil, errors.New("ccusage must not run")
		},
		ResolveBinary: func(ccacq.AcquireOptions) (ccacq.Binary, error) {
			t.Error("the default path must not acquire a ccusage binary")
			return ccacq.Binary{}, errors.New("ccusage must not be acquired")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v, want the adapter's one row", snapshots)
	}
	snapshot := snapshots[0]
	if snapshot.UsageDate != "2026-05-22" || snapshot.Model != "claude-sonnet-4-20250514" ||
		snapshot.InputTokens != 5 || snapshot.TotalTokens != 6 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}

// TestRegistryCollectReachesTheNativePath pins the registry entry point, not
// just the package function: every production caller (CLI, daemon, preview)
// reaches Claude Code through collect.Lookup, and a nil ccusage seam there
// means a lookup that fell back to the subprocess would try to download one.
func TestRegistryCollectReachesTheNativePath(t *testing.T) {
	configDir := filepath.Join(t.TempDir(), "missing")
	provider, ok := collect.Lookup(contract.SourceClaudeCode)
	if !ok || provider == nil {
		t.Fatal("claude-code has no registry provider")
	}
	_, err := provider.Collect(context.Background(), collect.Options{
		Timezone: "UTC",
		StateDir: t.TempDir(),
		Env:      testEnv(map[string]string{"CLAUDE_CONFIG_DIR": configDir}),
	})
	if err == nil {
		t.Fatal("a CLAUDE_CONFIG_DIR that names no directory must fail")
	}
	// The native adapter's own error names the directories; the subprocess
	// path would have failed resolving or downloading ccusage first.
	if !strings.Contains(err.Error(), "No valid Claude data directories found in CLAUDE_CONFIG_DIR") {
		t.Fatalf("err = %v, want the native adapter's root-resolution error", err)
	}
}
