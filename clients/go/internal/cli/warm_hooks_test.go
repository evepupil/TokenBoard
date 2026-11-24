package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
)

// The warm-hooks contract, mirroring the TS cli tests: a full scan may claim
// its high-water mark, a bounded one may not, and hook mode never warms.

func TestWarmHookCursorsSkipsHookMode(t *testing.T) {
	stateDir := t.TempDir()
	env := func(string) string { return "" }
	if err := warmHookCursors([]string{"claude-code"}, stateDir, time.Now(),
		Options{HookMode: true}, env, "all", "", &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "claude-code-cursor.json")); !os.IsNotExist(err) {
		t.Errorf("hook mode must not write a cursor: %v", err)
	}
}

func TestWarmHookCursorsRequiresAnUnboundedWindow(t *testing.T) {
	stateDir := t.TempDir()
	cases := []struct{ since, until string }{
		{"20260522", ""},
		{"all", "20260523"},
	}
	for _, tc := range cases {
		env := func(string) string { return "" }
		if err := warmHookCursors([]string{"claude-code"}, stateDir, time.Now(), Options{}, env, tc.since, tc.until, &bytes.Buffer{}); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(stateDir, "claude-code-cursor.json")); !os.IsNotExist(err) {
			t.Errorf("since=%q until=%q must not warm: %v", tc.since, tc.until, err)
		}
	}
}

func TestWarmHookCursorsAdvancesTheClaudeCodeHighWater(t *testing.T) {
	stateDir := t.TempDir()
	startedAt := time.Date(2026, 5, 22, 1, 0, 0, 0, time.UTC)
	env := func(string) string { return "" }
	if err := warmHookCursors([]string{"claude-code"}, stateDir, startedAt, Options{}, env, "all", "", &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	cursor, err := sessioncursor.Read(filepath.Join(stateDir, "claude-code-cursor.json"), "claude-code")
	if err != nil {
		t.Fatal(err)
	}
	raw, ok := cursor.ExtraValue("lastScanHighWaterMs")
	if !ok {
		t.Fatal("high-water mark not written")
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	if value != float64(startedAt.UnixMilli()) {
		t.Errorf("high-water = %v, want %v", value, startedAt.UnixMilli())
	}
}

// The mark only grows and is clamped to the clock, so a caller-supplied time
// ahead of now cannot hide files a later scan has not read.
func TestWarmHookCursorsClampsToTheClock(t *testing.T) {
	stateDir := t.TempDir()
	future := time.Now().Add(48 * time.Hour)
	env := func(string) string { return "" }
	if err := warmHookCursors([]string{"claude-code"}, stateDir, future, Options{}, env, "all", "", &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	cursor, err := sessioncursor.Read(filepath.Join(stateDir, "claude-code-cursor.json"), "claude-code")
	if err != nil {
		t.Fatal(err)
	}
	raw, ok := cursor.ExtraValue("lastScanHighWaterMs")
	if !ok {
		t.Fatal("high-water mark not written")
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	if value > float64(time.Now().UnixMilli())+1000 {
		t.Errorf("high-water %v must be clamped to now", value)
	}
}

// Codex warms the cursor the hook runs actually read. With one home and no
// history that is the legacy cursor; the profile cursors appear only once the
// plan turns multi-profile.
func TestWarmHookCursorsWarmTheCodexLegacyCursorForOneHome(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")
	home := filepath.Join(root, "codex")
	startedAt := time.Date(2026, 5, 22, 1, 0, 0, 0, time.UTC)
	env := func(key string) string {
		if key == "CODEX_HOME" {
			return home
		}
		return ""
	}
	if err := warmHookCursors([]string{"codex"}, stateDir, startedAt, Options{}, env, "all", "", &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	cursor, err := sessioncursor.Read(filepath.Join(stateDir, "codex-cursor.json"), "codex")
	if err != nil {
		t.Fatal(err)
	}
	raw, ok := cursor.ExtraValue("lastScanHighWaterMs")
	if !ok {
		t.Fatal("high-water mark not written to the legacy Codex cursor")
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	if value != float64(startedAt.UnixMilli()) {
		t.Errorf("high-water = %v, want %v", value, startedAt.UnixMilli())
	}
}

// Two homes force profile cursors, and the warm must land on those, not on the
// legacy cursor no hook run reads any more.
func TestWarmHookCursorsWarmEachCodexProfileCursor(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	startedAt := time.Date(2026, 5, 22, 1, 0, 0, 0, time.UTC)
	env := func(key string) string {
		if key == "TOKENBOARD_CODEX_HOMES_JSON" {
			return encodeJSONHomes(firstHome, secondHome)
		}
		return ""
	}
	if err := warmHookCursors([]string{"codex"}, stateDir, startedAt, Options{}, env, "all", "", &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	for _, home := range []string{firstHome, secondHome} {
		path := filepath.Join(stateDir, codexHookProfileCursorName(home))
		cursor, err := sessioncursor.Read(path, "codex")
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		if _, ok := cursor.ExtraValue("lastScanHighWaterMs"); !ok {
			t.Errorf("%s was not warmed", home)
		}
	}
	if _, err := os.Stat(filepath.Join(stateDir, "codex-cursor.json")); !os.IsNotExist(err) {
		t.Errorf("the legacy cursor must stay untouched: %v", err)
	}
}
