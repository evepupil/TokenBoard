package copilot

import (
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/adapters/tools"
)

// TestRegisterInstallsTheWindowedCopilotLoader pins init(): the adapter is
// reachable through the shared registry under its CLI command name, over an
// empty home it answers an empty report rather than an error, and the window
// reaches Load.
func TestRegisterInstallsTheWindowedCopilotLoader(t *testing.T) {
	if !tools.HasNativeAdapter("copilot") {
		t.Fatal("copilot is not registered")
	}
	since := int64(1767225600000) // 2026-01-01T00:00Z
	entries, err := tools.LoadCommandInWindow(t.Context(), "copilot", tools.Options{
		HomeDir: func() (string, error) { return t.TempDir(), nil },
		Env:     func(string) (string, bool) { return "", false },
	}, &tools.Window{Since: "20260101", SinceMs: &since})
	if err != nil || len(entries) != 0 {
		t.Fatalf("LoadCommandInWindow(copilot) = (%v, %v), want no entries and no error", entries, err)
	}
}
