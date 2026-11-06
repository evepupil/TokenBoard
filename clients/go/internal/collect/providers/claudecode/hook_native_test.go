package claudecode

// Tests for the native hook path (S2, Task 8).
//
// The hook path keeps sessioncursor.CollectHookIncremental exactly as the
// ccusage path runs it - same roots, same cursor, same changed keys - and then
// reconciles the incremental key set against a full in-process recompute of the
// window the scan reports. There is no second data source any more, so the two
// halves must be the same tree and the same implementation; a key the parser
// proved exists but the recompute misses is a hard error.
//
// Everything here runs through nativeCollect, which is what useNativeClaude ==
// true dispatches to and what the registry's native provider calls.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// runNativeHook drives nativeCollect with hook mode on and returns its result.
// Pricing never leaves the machine: the default fetcher fails the test, so any
// catalogue request identifies the run that made it.
func runNativeHook(t *testing.T, options Options, env map[string]string) ([]contract.Snapshot, error) {
	t.Helper()
	options.Env = testEnv(env)
	if options.PricingFetcher == nil {
		options.PricingFetcher = failingFetcher(t)
	}
	if options.Timezone == "" {
		options.Timezone = "UTC"
	}
	if options.CollectedAt == "" {
		options.CollectedAt = nativeCollectedAt
	}
	return nativeCollect(context.Background(), nativeInput{
		options:     options,
		env:         options.Env,
		timezone:    options.Timezone,
		collectedAt: options.CollectedAt,
	})
}

// hookNativeEnv is the environment a hook run sees.
func hookNativeEnv(values map[string]string) map[string]string {
	env := map[string]string{"TOKENBOARD_HOOK_MODE": "1"}
	for key, value := range values {
		env[key] = value
	}
	return env
}

// writeHookSession writes one session transcript and returns its path.
func writeHookSession(t *testing.T, configDir, project, name string, rows ...string) string {
	t.Helper()
	path := filepath.Join(configDir, "projects", project, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	content := strings.Join(rows, "\n") + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// acknowledgeHookSnapshots clears the cursor's pending flag the way the CLI
// does after a successful upload.
func acknowledgeHookSnapshots(t *testing.T, stateDir string, snapshots []contract.Snapshot) {
	t.Helper()
	groups := map[string]bool{}
	for _, snapshot := range snapshots {
		groups[snapshot.AckGroupKey()] = true
	}
	if err := sessioncursor.AcknowledgePendingUploads(sessioncursor.AcknowledgeInput{
		StateDir:           stateDir,
		Source:             "claude-code",
		AcknowledgedGroups: groups,
	}); err != nil {
		t.Fatal(err)
	}
}

// TestHookNativeReconcilesIncrementalKeysAgainstWindowRecompute pins the core
// fail-closed rule: when the parser saw a (date, model) the recompute does not
// return, collection fails with the reconciliation error verbatim.
//
// The fixture makes the two halves disagree on purpose. The file is new to the
// cursor, so the incremental scan reads it, but its mtime sits in January,
// before the --since bound (2026-05-22) minus the one-day prune margin, so the
// window recompute's mtime prune drops the whole session group.
func TestHookNativeReconcilesIncrementalKeysAgainstWindowRecompute(t *testing.T) {
	claudeHome, stateDir, sessionFile := hookFixture(t,
		claudeUsageRow("2026-05-22T02:00:00.000Z", "claude-sonnet-4-5", 8, 13, nil))
	january := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	if err := os.Chtimes(sessionFile, january, january); err != nil {
		t.Fatal(err)
	}

	_, err := runNativeHook(t, Options{StateDir: stateDir}, hookNativeEnv(map[string]string{
		"CLAUDE_CONFIG_DIR": claudeHome,
	}))
	if err == nil {
		t.Fatal("a recompute that misses a parsed key must fail the collection")
	}
	want := "Claude hook reconciliation returned no snapshots for parsed usage keys: 2026-05-22/claude-sonnet-4-5"
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %v, want the reconciliation error %q verbatim", err, want)
	}

	// The failed run must leave the cursor pending: the usage the parser proved
	// exists is still unuploaded.
	cursor, readErr := sessioncursor.Read(filepath.Join(stateDir, CursorName), "claude-code")
	if readErr != nil {
		t.Fatal(readErr)
	}
	entry, ok := cursor.Files["project-a/session.jsonl"]
	if !ok || entry.PendingUpload == nil || !*entry.PendingUpload {
		t.Fatalf("pending upload must survive the failed reconciliation: %+v", entry)
	}
}

// TestHookNativeNoChangesReturnsEmpty pins the unchanged-tree result: after a
// successful run and its acknowledgement, a hook run with nothing new returns
// an empty slice instead of re-reporting the history.
func TestHookNativeNoChangesReturnsEmpty(t *testing.T) {
	claudeHome, stateDir, _ := hookFixture(t,
		claudeUsageRow("2026-05-22T02:00:00.000Z", "claude-sonnet-4-5", 8, 13, floatPtr(0.12)))
	env := hookNativeEnv(map[string]string{"CLAUDE_CONFIG_DIR": claudeHome})

	first, err := runNativeHook(t, Options{StateDir: stateDir}, env)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 1 {
		t.Fatalf("first run snapshots = %+v, want one row", first)
	}
	acknowledgeHookSnapshots(t, stateDir, first)

	second, err := runNativeHook(t, Options{
		StateDir:    stateDir,
		CollectedAt: "2026-11-06T01:00:00.000Z",
	}, env)
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 0 {
		t.Fatalf("second run snapshots = %+v, want none", second)
	}
}

// TestHookNativeNeverRunsCcusage pins that the native hook path has no
// subprocess at all: neither the ccusage runner nor the binary resolver may be
// touched, even though the change set is non-empty.
func TestHookNativeNeverRunsCcusage(t *testing.T) {
	claudeHome, stateDir, _ := hookFixture(t,
		claudeUsageRow("2026-05-22T02:00:00.000Z", "claude-sonnet-4-5", 8, 13, floatPtr(0.12)))
	options := Options{
		StateDir: stateDir,
		Runner: func(context.Context, string, []string, ccusage.CommandOptions) (any, error) {
			t.Error("the native hook path must not run ccusage")
			return nil, errors.New("ccusage must not run")
		},
		ResolveBinary: func(ccusage.AcquireOptions) (ccusage.Binary, error) {
			t.Error("the native hook path must not resolve a ccusage binary")
			return ccusage.Binary{}, errors.New("ccusage must not run")
		},
	}
	snapshots, err := runNativeHook(t, options, hookNativeEnv(map[string]string{
		"CLAUDE_CONFIG_DIR": claudeHome,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 || snapshots[0].UsageDate != "2026-05-22" {
		t.Fatalf("snapshots = %+v, want the in-process recompute's row", snapshots)
	}
}

// TestHookNativeOfflinePricing pins the hook rule for the catalogue: even with
// an endpoint configured, hook mode must price from the cache/static config and
// never fetch. The control run proves the counter can observe a request.
func TestHookNativeOfflinePricing(t *testing.T) {
	claudeHome, stateDir, _ := hookFixture(t,
		claudeUsageRow("2026-05-22T02:00:00.000Z", "claude-sonnet-4-5", 8, 13, floatPtr(0.12)))
	fetcher := &countingFetcher{}
	options := Options{StateDir: stateDir, PricingFetcher: fetcher.fetch}
	endpoint := "https://tokenboard.example/api/v1/ingest"

	_, err := runNativeHook(t, options, hookNativeEnv(map[string]string{
		"CLAUDE_CONFIG_DIR":   claudeHome,
		"TOKENBOARD_ENDPOINT": endpoint,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if fetcher.calls != 0 {
		t.Fatalf("hook mode made %d catalogue request(s), want none", fetcher.calls)
	}

	// Control: the same options outside hook mode do reach the configured
	// endpoint, so a zero counter above means "not fetched", not "not wired".
	if _, err := runNativeHook(t, Options{
		StateDir:       t.TempDir(),
		PricingFetcher: fetcher.fetch,
	}, map[string]string{
		"CLAUDE_CONFIG_DIR":   claudeHome,
		"TOKENBOARD_ENDPOINT": endpoint,
	}); err != nil {
		t.Fatal(err)
	}
	if fetcher.calls == 0 {
		t.Fatal("outside hook mode the configured endpoint must be used")
	}
}

// TestHookNativeMergesCachedSnapshots pins the no-recompute branch: a pending
// file that vanished while still unacknowledged is re-emitted from the cursor,
// stamped with the current run's collectedAt, and no report is built for it.
func TestHookNativeMergesCachedSnapshots(t *testing.T) {
	claudeHome, stateDir, sessionFile := hookFixture(t,
		claudeUsageRow("2026-05-22T02:00:00.000Z", "claude-sonnet-4-5", 8, 13, floatPtr(0.12)))
	env := hookNativeEnv(map[string]string{"CLAUDE_CONFIG_DIR": claudeHome})

	first, err := runNativeHook(t, Options{StateDir: stateDir}, env)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 1 {
		t.Fatalf("first run snapshots = %+v, want one row", first)
	}
	// Left pending on purpose: the file is then removed, which is exactly the
	// "uploaded usage whose file disappeared" case the cursor exists for.
	if err := os.Remove(sessionFile); err != nil {
		t.Fatal(err)
	}

	second, err := runNativeHook(t, Options{
		StateDir:    stateDir,
		CollectedAt: "2026-11-06T02:00:00.000Z",
	}, env)
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 1 {
		t.Fatalf("second run snapshots = %+v, want the cached row", second)
	}
	cached := second[0]
	if cached.UsageDate != "2026-05-22" || cached.Model != "claude-sonnet-4-5" ||
		cached.InputTokens != 8 || cached.OutputTokens != 13 {
		t.Fatalf("cached snapshot = %+v", cached)
	}
	if cached.CollectedAt != "2026-11-06T02:00:00.000Z" {
		t.Fatalf("cached snapshot collectedAt = %q, want the current run's", cached.CollectedAt)
	}
}

// TestHookNativeParsesTheRangeArgsWindow pins the strict parse of the fixed
// RangeArgs shape. Anything that is not [--since YYYYMMDD --until YYYYMMDD] must
// be an error: treating an unexpected shape as "no window" would turn a hook
// run into a full-history scan.
func TestHookNativeParsesTheRangeArgsWindow(t *testing.T) {
	since, until, err := parseHookRangeArgs([]string{"--since", "20260522", "--until", "20260525"})
	if err != nil {
		t.Fatal(err)
	}
	if since != "20260522" || until != "20260525" {
		t.Fatalf("since/until = %q/%q, want 20260522/20260525", since, until)
	}

	cases := map[string][]string{
		"empty":              {},
		"too short":          {"--since", "20260522"},
		"too long":           {"--since", "20260522", "--until", "20260525", "--timezone", "UTC"},
		"flags swapped":      {"--until", "20260522", "--since", "20260525"},
		"missing flag":       {"20260522", "20260522", "--until", "20260525"},
		"invalid calendar":   {"--since", "20261340", "--until", "20261341"},
		"reversed window":    {"--since", "20260525", "--until", "20260522"},
		"dashed spelling":    {"--since", "2026-05-22", "--until", "2026-05-25"},
		"open lower bound":   {"--since", "all", "--until", "20260525"},
		"empty date":         {"--since", "", "--until", "20260525"},
		"trailing garbage":   {"--since", "20260522x", "--until", "20260525"},
		"timezone suffix":    {"--since", "20260522", "--until", "20260525", "--json"},
		"duplicated --since": {"--since", "20260522", "--since", "20260525"},
	}
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			if _, _, err := parseHookRangeArgs(args); err == nil {
				t.Fatalf("parseHookRangeArgs(%v) = nil error, want a fail-closed rejection", args)
			}
		})
	}
}

// TestHookNativeWindowReachesTheRecompute is the integration half of the parse
// test: the dates the incremental scan reports must bound the recompute. Three
// files carry rows across a five-day span; only the two files that change are
// re-read, their new dates (2026-05-23 and 2026-05-27) become the window, and
// the surrounding rows must not be reported.
func TestHookNativeWindowReachesTheRecompute(t *testing.T) {
	root := t.TempDir()
	claudeHome := filepath.Join(root, "claude")
	stateDir := filepath.Join(root, "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeHookSession(t, claudeHome, "project-a", "a.jsonl", nativeRowAt(10, "2026-05-20T02:00:00.000Z"))
	fileB := writeHookSession(t, claudeHome, "project-b", "b.jsonl", nativeRowAt(11, "2026-05-22T02:00:00.000Z"))
	fileC := writeHookSession(t, claudeHome, "project-c", "c.jsonl", nativeRowAt(12, "2026-05-28T02:00:00.000Z"))
	env := hookNativeEnv(map[string]string{"CLAUDE_CONFIG_DIR": claudeHome})

	first, err := runNativeHook(t, Options{StateDir: stateDir}, env)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 3 {
		t.Fatalf("first run snapshots = %+v, want the three files' rows", first)
	}
	acknowledgeHookSnapshots(t, stateDir, first)

	// Append one row to two of the three files. The cursor's append-only fast
	// path reads only these lines, so the changed dates are 2026-05-23 and
	// 2026-05-27 - a window that excludes fileA's row and the outer rows of B
	// and C.
	for path, row := range map[string]string{
		fileB: nativeRowAt(21, "2026-05-23T02:00:00.000Z"),
		fileC: nativeRowAt(31, "2026-05-27T02:00:00.000Z"),
	} {
		handle, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := handle.WriteString(row + "\n"); err != nil {
			handle.Close()
			t.Fatal(err)
		}
		if err := handle.Close(); err != nil {
			t.Fatal(err)
		}
	}

	second, err := runNativeHook(t, Options{
		StateDir:    stateDir,
		CollectedAt: "2026-11-06T03:00:00.000Z",
	}, env)
	if err != nil {
		t.Fatal(err)
	}
	dates := map[string]int64{}
	for _, snapshot := range second {
		dates[snapshot.UsageDate] = snapshot.InputTokens
	}
	want := map[string]int64{"2026-05-23": 21, "2026-05-27": 31}
	if len(dates) != len(want) {
		t.Fatalf("second run dates = %v, want exactly %v (the recompute must be bounded by the changed-date window)", dates, want)
	}
	for date, inputTokens := range want {
		if dates[date] != inputTokens {
			t.Fatalf("second run dates = %v, want %v", dates, want)
		}
	}
}

// TestHookNativeScansEveryResolvedRoot pins the SessionDirs hand-off: the
// incremental scan must cover exactly the roots the recompute reads. A
// comma-separated CLAUDE_CONFIG_DIR used to leave the scan pointed at a single
// nonexistent path while the recompute read both roots.
func TestHookNativeScansEveryResolvedRoot(t *testing.T) {
	root := t.TempDir()
	rootA := filepath.Join(root, "root-a")
	rootB := filepath.Join(root, "root-b")
	writeHookSession(t, rootA, "project-a", "a.jsonl",
		nativeRowAt(11, "2026-05-22T02:00:00.000Z"))
	writeHookSession(t, rootB, "project-b", "b.jsonl", fmt.Sprintf(
		`{"type":"assistant","timestamp":"2026-05-22T02:00:00.000Z",`+
			`"message":{"model":"claude-haiku-4-5","usage":{"input_tokens":22,"output_tokens":1}}}`))
	stateDir := filepath.Join(root, "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}

	snapshots, err := runNativeHook(t, Options{StateDir: stateDir}, hookNativeEnv(map[string]string{
		"CLAUDE_CONFIG_DIR": rootA + "," + rootB,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 2 {
		t.Fatalf("snapshots = %+v, want one row from each root", snapshots)
	}
	byModel := map[string]int64{}
	for _, snapshot := range snapshots {
		byModel[snapshot.Model] = snapshot.InputTokens
	}
	if byModel["claude-sonnet-4-20250514"] != 11 || byModel["claude-haiku-4-5"] != 22 {
		t.Fatalf("snapshots = %+v, want both roots' rows", snapshots)
	}
}

// TestHookNativeUsesTheResolvedTimezone pins the timezone hand-off: the
// incremental scan and the recompute must attribute the same row to the same
// day, or the reconciliation would fail for every row near midnight.
func TestHookNativeUsesTheResolvedTimezone(t *testing.T) {
	// 20:00Z on 2026-05-20 is 04:00 on 2026-05-21 in Asia/Shanghai.
	claudeHome, stateDir, _ := hookFixture(t,
		claudeUsageRow("2026-05-20T20:00:00.000Z", "claude-sonnet-4-5", 8, 13, floatPtr(0.12)))
	snapshots, err := runNativeHook(t, Options{
		StateDir: stateDir,
		Timezone: "Asia/Shanghai",
	}, hookNativeEnv(map[string]string{"CLAUDE_CONFIG_DIR": claudeHome}))
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 || snapshots[0].UsageDate != "2026-05-21" {
		t.Fatalf("snapshots = %+v, want the row on 2026-05-21 (Asia/Shanghai)", snapshots)
	}
}

// TestHookNativeRejectsUnloadableTimezone applies the non-hook rule to the hook
// branch: an unloadable zone is an error, not a silent UTC re-attribution.
func TestHookNativeRejectsUnloadableTimezone(t *testing.T) {
	claudeHome, stateDir, _ := hookFixture(t,
		claudeUsageRow("2026-05-22T02:00:00.000Z", "claude-sonnet-4-5", 8, 13, floatPtr(0.12)))
	_, err := runNativeHook(t, Options{
		StateDir: stateDir,
		Timezone: "Mars/Olympus_Mons",
	}, hookNativeEnv(map[string]string{"CLAUDE_CONFIG_DIR": claudeHome}))
	if err == nil || !strings.Contains(err.Error(), "native timezone") {
		t.Fatalf("err = %v, want the unloadable-timezone error", err)
	}
}
