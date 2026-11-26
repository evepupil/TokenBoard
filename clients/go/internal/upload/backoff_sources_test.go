package upload

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeBackoffFixture(t *testing.T, dir string, payload map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, backoffFileName), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}

func readBackoffFile(t *testing.T, dir string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, backoffFileName))
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

func TestBackoffPausesOnlyTheFailingSource(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 5, 9, 12, 0, 0, 0, time.UTC)
	for range uploadFailurePauseThreshold {
		if _, err := RecordFailure(dir, "codex", os.ErrPermission, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, paused := IsPaused(dir, "codex", now); !paused {
		t.Fatal("codex should be paused after the threshold")
	}
	if until, paused := IsPaused(dir, "claude-code", now); paused {
		t.Fatalf("claude-code paused until %s; one source's failures must not pause another", until)
	}
}

func TestBackoffSuccessClearsOnlyItsSource(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 5, 9, 12, 0, 0, 0, time.UTC)
	for range uploadFailurePauseThreshold {
		if _, err := RecordFailure(dir, "codex", os.ErrPermission, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := RecordFailure(dir, "claude-code", os.ErrPermission, now); err != nil {
		t.Fatal(err)
	}
	RecordSuccess(dir, "claude-code")
	if _, paused := IsPaused(dir, "codex", now); !paused {
		t.Fatal("codex must stay paused after another source succeeded")
	}
	payload := readBackoffFile(t, dir)
	sources, _ := payload["sources"].(map[string]any)
	if _, exists := sources["claude-code"]; exists {
		t.Errorf("claude-code entry survived its own success: %v", sources)
	}
}

// The v1 file has no source attribution. Its pause applies to every source
// (that is what it did before the split) and its failure count must not be
// added to whichever source writes first — it cannot be attributed.
func TestBackoffReadsLegacyV1AsAnUnattributedGlobalPause(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 5, 9, 12, 0, 0, 0, time.UTC)
	writeBackoffFixture(t, dir, map[string]any{
		"consecutiveFailures": 4,
		"lastErrorSummary":    "Upload failed with status 400",
		"pausedUntil":         now.Add(time.Hour).UTC().Format(time.RFC3339Nano),
	})
	for _, source := range []string{"codex", "claude-code"} {
		if _, paused := IsPaused(dir, source, now); !paused {
			t.Fatalf("%s: a legacy pause must still cover every source", source)
		}
	}
	state, err := RecordFailure(dir, "codex", os.ErrPermission, now)
	if err != nil {
		t.Fatal(err)
	}
	if state.ConsecutiveFailures != 1 {
		t.Errorf("codex consecutive failures = %d; the legacy count must not be inherited", state.ConsecutiveFailures)
	}
	payload := readBackoffFile(t, dir)
	if payload["consecutiveFailures"] == nil || payload["pausedUntil"] == nil {
		t.Errorf("legacy fields were dropped while the legacy pause is still active: %v", payload)
	}
}

// Once the legacy pause has expired nothing reads it any more, so the next
// success may clean the flat fields up.
func TestBackoffClearsLegacyFieldsAfterThePauseExpired(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 5, 9, 12, 0, 0, 0, time.UTC)
	writeBackoffFixture(t, dir, map[string]any{
		"consecutiveFailures": 5,
		"lastErrorSummary":    "Upload failed with status 400",
		"pausedUntil":         now.Add(-time.Hour).UTC().Format(time.RFC3339Nano),
	})
	RecordSuccess(dir, "codex")
	if _, err := os.Stat(filepath.Join(dir, backoffFileName)); os.IsNotExist(err) {
		return // nothing left to keep: the file itself is gone
	}
	payload := readBackoffFile(t, dir)
	if _, exists := payload["consecutiveFailures"]; exists {
		t.Errorf("expired legacy fields survived a success write: %v", payload)
	}
}

// The same v2 file is written by the TypeScript collector; this fixture pins
// the shape both sides must agree on.
func TestBackoffReadsTheCrossLanguageV2Shape(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 5, 9, 12, 0, 0, 0, time.UTC)
	writeBackoffFixture(t, dir, map[string]any{
		"version": 2,
		"sources": map[string]any{
			"claude-code": map[string]any{
				"consecutiveFailures": 2,
				"lastErrorSummary":    "status 400",
				"pausedUntil":         "2026-05-09T13:00:00.000Z",
			},
		},
	})
	if until, paused := IsPaused(dir, "claude-code", now); !paused || until != "2026-05-09T13:00:00.000Z" {
		t.Fatalf("paused=%v until=%q", paused, until)
	}
	if _, paused := IsPaused(dir, "codex", now); paused {
		t.Error("codex must not inherit claude-code's v2 pause")
	}
}
