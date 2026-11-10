package codex

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Port of codex-hook-race.test.ts and codex-hook-scoped-reconciliation.test.ts:
// the hook reconciliation reruns the whole narrow collection once when a child
// reader races, and the scoped reconciliation covers exactly the changed dates.

// provHookDailyResult is the hook-race suite's daily report.
const provHookDailyResult = `{"data":[{"date":"2026-05-22","model":"gpt-5",
	"inputTokens":10,"outputTokens":5,"totalTokens":15,"costUSD":0.03}]}`

// provHookSessionResult is the hook-race suite's session report.
const provHookSessionResult = `{"data":[{"sessionId":"session","lastActivity":"2026-05-22T01:00:00.000Z",
	"models":{"gpt-5":{"inputTokens":10,"outputTokens":5,"totalTokens":15}}}]}`

// provHookEvent is the suite's tokenCountEvent: input, output and cost.
func provHookEvent(timestamp string, inputTokens, outputTokens int, costUsd float64) map[string]any {
	return provTokenEventWithCost(timestamp, inputTokens, outputTokens, costUsd)
}

// provReadPendingUpload ports readPendingUpload: the cursor's pending flag for
// one relative session path.
func provReadPendingUpload(t *testing.T, stateDir, relativePath string) bool {
	t.Helper()
	state, err := sessioncursor.Read(filepath.Join(stateDir, sessionCursorFileNameForTest()), string(contract.SourceCodex))
	if err != nil {
		t.Fatalf("read cursor: %v", err)
	}
	entry, ok := state.Files[relativePath]
	if !ok || entry.PendingUpload == nil {
		return false
	}
	return *entry.PendingUpload
}

// sessionCursorFileNameForTest is the legacy single-home cursor name.
func sessionCursorFileNameForTest() string {
	return sessioncursor.FileName(contract.SourceCodex, "")
}

// One child reader race is retryable: the hook reconciliation reruns the whole
// narrow collection once and reports the retry line.
func TestCodexHookRerunsTheNarrowReconciliationOnceAfterAChildReaderRace(t *testing.T) {
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex")
	stateDir := filepath.Join(root, "state")
	sessionFile := filepath.Join(codexHome, "sessions", "2026", "05", "22", "session.jsonl")
	diagnostics := []string{}
	provWriteJSONL(t, sessionFile, provHookEvent("2026-05-22T01:00:00.000Z", 10, 5, 0.03))

	correctionCalls := 0
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("session") {
			return provJSON(t, provHookSessionResult), nil
		}
		return provJSON(t, provHookDailyResult), nil
	}}
	snapshots, err := Collect(context.Background(), Options{
		ccusagePath: true,
		CodexHome:   provHome(codexHome),
		StateDir:    stateDir,
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		Stderr:      provReportDiagnostic(&diagnostics),
		Runner:      runner.run,
		Env: provEnv(map[string]string{
			"TOKENBOARD_HOOK_MODE":            "1",
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
		}),
		CorrectSubagentUsage: func(input SubagentCorrectionInput) ([]contract.Snapshot, error) {
			correctionCalls++
			if correctionCalls == 1 {
				return nil, fmt.Errorf("Codex child session changed while reading; retry the sync")
			}
			return input.Snapshots, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	got := provSnapshotFor(t, snapshots, "2026-05-22", "gpt-5")
	if got.Source != contract.SourceCodex || got.TotalTokens != 15 || got.SessionCount != 1 {
		t.Errorf("snapshot = %+v", got)
	}
	if correctionCalls != 2 {
		t.Errorf("correction calls = %d", correctionCalls)
	}
	if len(runner.calls) != 4 {
		t.Errorf("runner calls = %d (%+v)", len(runner.calls), runner.calls)
	}
	want := []string{"Codex child session changed; retrying hook reconciliation once"}
	if len(diagnostics) != len(want) || diagnostics[0] != want[0] {
		t.Errorf("diagnostics = %v, want %v", diagnostics, want)
	}
	if !provReadPendingUpload(t, stateDir, "2026/05/22/session.jsonl") {
		t.Error("the session file must stay pending an upload")
	}
}

// A second race exhausts the retry budget; the error surfaces and the cursor
// stays pending so the next sync retries it.
func TestCodexHookLeavesTheParsedCursorPendingAfterASecondChildReaderRace(t *testing.T) {
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex")
	stateDir := filepath.Join(root, "state")
	sessionFile := filepath.Join(codexHome, "sessions", "2026", "05", "22", "session.jsonl")
	provWriteJSONL(t, sessionFile, provHookEvent("2026-05-22T01:00:00.000Z", 10, 5, 0.03))

	correctionCalls := 0
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("session") {
			return provJSON(t, provHookSessionResult), nil
		}
		return provJSON(t, provHookDailyResult), nil
	}}
	_, err := Collect(context.Background(), Options{
		ccusagePath: true,
		CodexHome:   provHome(codexHome),
		StateDir:    stateDir,
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		Runner:      runner.run,
		Env: provEnv(map[string]string{
			"TOKENBOARD_HOOK_MODE":            "1",
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
		}),
		CorrectSubagentUsage: func(SubagentCorrectionInput) ([]contract.Snapshot, error) {
			correctionCalls++
			return nil, fmt.Errorf("Codex child session changed while reading; retry the sync")
		},
	})
	if err == nil || err.Error() != "Codex child session changed while reading; retry the sync" {
		t.Fatalf("err = %v", err)
	}
	if correctionCalls != 2 {
		t.Errorf("correction calls = %d", correctionCalls)
	}
	if len(runner.calls) != 4 {
		t.Errorf("runner calls = %d (%+v)", len(runner.calls), runner.calls)
	}
	if !provReadPendingUpload(t, stateDir, "2026/05/22/session.jsonl") {
		t.Error("the session file must stay pending an upload")
	}
}

// A race retry re-discovers the changed dates from the cursor, so a session
// that crossed a usage date reports both days rather than the first one only.
func TestCodexHookRescansAllPendingRowsWhenARetryCrossesAUsageDate(t *testing.T) {
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex")
	stateDir := filepath.Join(root, "state")
	sessionFile := filepath.Join(codexHome, "sessions", "2026", "05", "22", "session.jsonl")
	provWriteJSONL(t, sessionFile, provHookEvent("2026-05-22T01:00:00.000Z", 10, 5, 0.03))

	correctionCalls := 0
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("session") {
			return provJSON(t, `{"data":[{"sessionId":"session","lastActivity":"2026-05-23T01:00:00.000Z",
				"models":{"gpt-5":{"inputTokens":30,"outputTokens":15,"totalTokens":45}}}]}`), nil
		}
		return provJSON(t, `{"data":[
			{"date":"2026-05-22","model":"gpt-5","inputTokens":10,"outputTokens":5,"totalTokens":15,"costUSD":0.03},
			{"date":"2026-05-23","model":"gpt-5","inputTokens":20,"outputTokens":10,"totalTokens":30,"costUSD":0.06}]}`), nil
	}}
	snapshots, err := Collect(context.Background(), Options{
		ccusagePath: true,
		CodexHome:   provHome(codexHome),
		StateDir:    stateDir,
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-23T10:00:00.000Z",
		Runner:      runner.run,
		Env: provEnv(map[string]string{
			"TOKENBOARD_HOOK_MODE":            "1",
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
		}),
		CorrectSubagentUsage: func(input SubagentCorrectionInput) ([]contract.Snapshot, error) {
			correctionCalls++
			if correctionCalls == 1 {
				provAppendJSONL(t, sessionFile, provHookEvent("2026-05-23T01:00:00.000Z", 20, 10, 0.06))
				return nil, fmt.Errorf("Codex child session changed while reading; retry the sync")
			}
			return input.Snapshots, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if correctionCalls != 2 {
		t.Errorf("correction calls = %d", correctionCalls)
	}
	if len(snapshots) != 2 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	first := provSnapshotFor(t, snapshots, "2026-05-22", "gpt-5")
	second := provSnapshotFor(t, snapshots, "2026-05-23", "gpt-5")
	if first.TotalTokens != 15 || second.TotalTokens != 30 {
		t.Errorf("snapshots = %+v", snapshots)
	}
}

// A failure that is not a race is not retried: the source reports it once.
func TestCodexHookDoesNotRetryANonRaceCorrectionFailure(t *testing.T) {
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex")
	stateDir := filepath.Join(root, "state")
	sessionFile := filepath.Join(codexHome, "sessions", "2026", "05", "22", "session.jsonl")
	provWriteJSONL(t, sessionFile, provHookEvent("2026-05-22T01:00:00.000Z", 10, 5, 0.03))

	correctionCalls := 0
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("session") {
			return provJSON(t, provHookSessionResult), nil
		}
		return provJSON(t, provHookDailyResult), nil
	}}
	_, err := Collect(context.Background(), Options{
		ccusagePath: true,
		CodexHome:   provHome(codexHome),
		StateDir:    stateDir,
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		Runner:      runner.run,
		Env: provEnv(map[string]string{
			"TOKENBOARD_HOOK_MODE":            "1",
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
		}),
		CorrectSubagentUsage: func(SubagentCorrectionInput) ([]contract.Snapshot, error) {
			correctionCalls++
			return nil, fmt.Errorf("Codex child session contains invalid UTF-8")
		},
	})
	if err == nil || err.Error() != "Codex child session contains invalid UTF-8" {
		t.Fatalf("err = %v", err)
	}
	if correctionCalls != 1 {
		t.Errorf("correction calls = %d", correctionCalls)
	}
	if len(runner.calls) != 2 {
		t.Errorf("runner calls = %d (%+v)", len(runner.calls), runner.calls)
	}
	if !provReadPendingUpload(t, stateDir, "2026/05/22/session.jsonl") {
		t.Error("the session file must stay pending an upload")
	}
}

// The unbounded collection has its own retry: one change during the scan
// reruns it once.
func TestCodexHookRetriesAnUnboundedCollectionAfterOneChildReaderRace(t *testing.T) {
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex")
	sessionFile := filepath.Join(codexHome, "sessions", "2026", "05", "22", "session.jsonl")
	diagnostics := []string{}
	provWriteJSONL(t, sessionFile, provHookEvent("2026-05-22T01:00:00.000Z", 10, 5, 0.03))

	correctionCalls := 0
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("session") {
			return provJSON(t, provHookSessionResult), nil
		}
		return provJSON(t, provHookDailyResult), nil
	}}
	snapshots, err := Collect(context.Background(), Options{
		ccusagePath: true,
		CodexHome:   provHome(codexHome),
		StateDir:    t.TempDir(),
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		Stderr:      provReportDiagnostic(&diagnostics),
		Runner:      runner.run,
		Env: provEnv(provForceEnv(map[string]string{
			"TOKENBOARD_SINCE":         "",
			"TOKENBOARD_DEFAULT_SINCE": "",
			"TOKENBOARD_UNTIL":         "",
		})),
		CorrectSubagentUsage: func(input SubagentCorrectionInput) ([]contract.Snapshot, error) {
			correctionCalls++
			if correctionCalls == 1 {
				return nil, fmt.Errorf("Codex child session changed while reading; retry the sync")
			}
			return input.Snapshots, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	got := provSnapshotFor(t, snapshots, "2026-05-22", "gpt-5")
	if got.Source != contract.SourceCodex || got.TotalTokens != 15 || got.SessionCount != 1 {
		t.Errorf("snapshot = %+v", got)
	}
	if correctionCalls != 2 {
		t.Errorf("correction calls = %d", correctionCalls)
	}
	if len(runner.calls) != 4 {
		t.Errorf("runner calls = %d (%+v)", len(runner.calls), runner.calls)
	}
	want := []string{"Codex session files changed during unbounded collection; retrying once"}
	if len(diagnostics) != len(want) || diagnostics[0] != want[0] {
		t.Errorf("diagnostics = %v, want %v", diagnostics, want)
	}
}

// changedDateDailyResult / changedDateSessionResult are the scoped
// reconciliation fixtures.
func provChangedDateDailyResult(activeTokens int) string {
	return `{"data":[` + provChangedDateDailyRow(activeTokens) + `]}`
}

func provInitialDailyResult(activeTokens int) string {
	return `{"data":[{"date":"2025-01-01","model":"gpt-5","inputTokens":1,"outputTokens":0,
		"totalTokens":1,"costUSD":0.01},` + provChangedDateDailyRow(activeTokens) + `]}`
}

func provChangedDateDailyRow(activeTokens int) string {
	return `{"date":"2026-05-22","model":"gpt-5","inputTokens":` + strconv.Itoa(10+activeTokens) +
		`,"outputTokens":0,"totalTokens":` + strconv.Itoa(10+activeTokens) + `,"costUSD":0.01}`
}

func provScopedSessionRow(sessionFile, directory, lastActivity string, totalTokens int) string {
	return `{"sessionId":"` + sessionFile + `","directory":"` + directory + `","sessionFile":"` + sessionFile + `",
		"lastActivity":"` + lastActivity + `",
		"models":{"gpt-5":{"inputTokens":` + strconv.Itoa(totalTokens) + `,"outputTokens":0,"totalTokens":` +
		strconv.Itoa(totalTokens) + `}}}`
}

func provChangedDateSessionResult(activeTokens int) string {
	return `{"data":[` +
		provScopedSessionRow("stable", "2026/05/22", "2026-05-22T01:00:00.000Z", 10) + `,` +
		provScopedSessionRow("active-old", "2026/04/02", "2026-05-22T02:00:00.000Z", activeTokens) + `]}`
}

func provInitialSessionResult(activeTokens int) string {
	return `{"data":[` +
		provScopedSessionRow("stable", "2026/05/22", "2026-05-22T01:00:00.000Z", 10) + `,` +
		provScopedSessionRow("active-old", "2026/04/02", "2026-05-22T02:00:00.000Z", activeTokens) + `,` +
		provScopedSessionRow("history", "2025/01/01", "2025-01-01T01:00:00.000Z", 1) + `]}`
}

// provSetMtime ports the suite's setFileMtime.
func provSetMtime(t *testing.T, path, value string) {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatalf("parse mtime: %v", err)
	}
	if err := os.Chtimes(path, parsed, parsed); err != nil {
		t.Fatalf("set mtime: %v", err)
	}
}

// provClearPendingUploads ports clearPendingUploadCursors: every pending flag
// in the source's cursor is cleared before the next sync.
func provClearPendingUploads(t *testing.T, stateDir string) {
	t.Helper()
	cursorPath := filepath.Join(stateDir, sessionCursorFileNameForTest())
	state, err := sessioncursor.Read(cursorPath, string(contract.SourceCodex))
	if err != nil {
		t.Fatalf("read cursor: %v", err)
	}
	for relativePath, entry := range state.Files {
		entry.PendingUpload = nil
		state.Files[relativePath] = entry
	}
	if err := sessioncursor.Write(cursorPath, state); err != nil {
		t.Fatalf("write cursor: %v", err)
	}
}

// The hook reconciliation covers exactly the changed dates: unrelated history
// stays out of the frozen scope, and the changed day's aggregation is complete.
func TestCodexHookKeepsCompleteChangedDateAggregationWhileExcludingUnrelatedHistory(t *testing.T) {
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex")
	stateDir := filepath.Join(root, "state")
	stableSession := filepath.Join(codexHome, "sessions", "2026", "05", "22", "stable.jsonl")
	activeOldSession := filepath.Join(codexHome, "sessions", "2026", "04", "02", "active-old.jsonl")
	unrelatedHistory := filepath.Join(codexHome, "sessions", "2025", "01", "01", "history.jsonl")
	scopedHomes := []string{}
	commandArgs := [][]string{}
	activeTokens := 15
	verifyFrozenScope := false

	provWriteJSONL(t, stableSession, provTokenEvent("2026-05-22T01:00:00.000Z", 10, "gpt-5"))
	provWriteJSONL(t, activeOldSession, provTokenEvent("2026-05-22T01:00:00.000Z", activeTokens, "gpt-5"))
	provWriteJSONL(t, unrelatedHistory, provTokenEvent("2025-01-01T01:00:00.000Z", 1, "gpt-5"))
	provSetMtime(t, stableSession, "2026-05-22T01:00:00.000Z")
	provSetMtime(t, activeOldSession, "2026-05-22T01:00:00.000Z")
	provSetMtime(t, unrelatedHistory, "2025-01-01T01:00:00.000Z")

	var checkErr error
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		scopedHome := call.envValue("CODEX_HOME")
		scopedHomes = append(scopedHomes, scopedHome)
		commandArgs = append(commandArgs, call.args)
		if !verifyFrozenScope {
			if call.hasArg("session") {
				return provJSON(t, provInitialSessionResult(activeTokens)), nil
			}
			return provJSON(t, provInitialDailyResult(activeTokens)), nil
		}
		if scopedHome == codexHome {
			checkErr = fmt.Errorf("the live home was used")
		}
		if !provFileExists(filepath.Join(scopedHome, "sessions", "2026", "05", "22", "stable.jsonl")) {
			checkErr = fmt.Errorf("the frozen scope lost the stable session")
		}
		if !provFileExists(filepath.Join(scopedHome, "sessions", "2026", "04", "02", "active-old.jsonl")) {
			checkErr = fmt.Errorf("the frozen scope lost the changed session")
		}
		if provFileExists(filepath.Join(scopedHome, "sessions", "2025", "01", "01", "history.jsonl")) {
			checkErr = fmt.Errorf("the frozen scope included unrelated history")
		}
		if call.hasArg("session") {
			return provJSON(t, provChangedDateSessionResult(activeTokens)), nil
		}
		return provJSON(t, provChangedDateDailyResult(activeTokens)), nil
	}}
	options := Options{
		ccusagePath: true,
		CodexHome:   provHome(codexHome),
		StateDir:    stateDir,
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		Runner:      runner.run,
		Env: provEnv(map[string]string{
			"TOKENBOARD_HOOK_MODE":            "1",
			"TOKENBOARD_STATE_DIR":            stateDir,
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
		}),
	}
	if _, err := Collect(context.Background(), options); err != nil {
		t.Fatalf("first collect: %v", err)
	}
	provClearPendingUploads(t, stateDir)

	verifyFrozenScope = true
	activeTokens = 20
	provAppendJSONL(t, activeOldSession, provTokenEvent("2026-05-22T02:00:00.000Z", activeTokens, "gpt-5"))
	provSetMtime(t, activeOldSession, "2026-05-22T02:00:00.000Z")
	scopedHomes = nil
	commandArgs = nil

	options.CollectedAt = "2026-05-22T10:01:00.000Z"
	snapshots, err := Collect(context.Background(), options)
	if err != nil {
		t.Fatalf("second collect: %v", err)
	}
	if checkErr != nil {
		t.Fatalf("scoped check: %v", checkErr)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	got := provSnapshotFor(t, snapshots, "2026-05-22", "gpt-5")
	if got.Source != contract.SourceCodex || got.TotalTokens != 30 || got.SessionCount != 2 {
		t.Errorf("snapshot = %+v", got)
	}
	if len(scopedHomes) != 2 {
		t.Fatalf("scoped homes = %v", scopedHomes)
	}
	unique := map[string]bool{}
	for _, home := range scopedHomes {
		unique[home] = true
	}
	if len(unique) != 1 {
		t.Errorf("scoped homes = %v", scopedHomes)
	}
	for _, args := range commandArgs {
		if !containsArg(args, "--single-thread") {
			t.Errorf("missing --single-thread in %v", args)
		}
	}
	if len(commandArgs) != 2 {
		t.Fatalf("calls = %d (%v)", len(commandArgs), commandArgs)
	}
	provAssertArgsContain(t, commandArgs[0], []string{
		"codex", "daily", "--since", "20260522", "--until", "20260522"})
	provAssertArgsContain(t, commandArgs[1], []string{
		"codex", "session", "--since", "20260522", "--until", "20260522"})
}

// A reusable pending snapshot is dropped once ccusage reports its day, so it is
// not summed on top of a figure that already contains it. Real Codex writes
// `token_count` events with no `info.model`, so the parser labels the turn
// `all`; ccusage reports the day under concrete model ids, and an exact
// group-key match would never fire for `all`. The pending copy would then be
// added to a day that already includes it, over-counting every hook sync.
func TestCodexHookDoesNotAddAReusedPendingSnapshotLabelledAllOnTopOfTheSameDay(t *testing.T) {
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex")
	stateDir := filepath.Join(root, "state")
	fileA := filepath.Join(codexHome, "sessions", "2026", "05", "22", "a.jsonl")
	fileB := filepath.Join(codexHome, "sessions", "2026", "05", "22", "b.jsonl")

	// The first sync finds usage in A but ccusage reports nothing for the day,
	// so the run fails closed and the cursor keeps A pending.
	emptyDaily := provJSON(t, `{"data":[]}`)
	daily := emptyDaily
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("session") {
			return provJSON(t, `{"data":[]}`), nil
		}
		return daily, nil
	}}
	options := Options{
		ccusagePath: true,
		CodexHome:   provHome(codexHome),
		StateDir:    stateDir,
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		Runner:      runner.run,
		Env: provEnv(map[string]string{
			"TOKENBOARD_HOOK_MODE":            "1",
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
		}),
	}

	provWriteJSONL(t, fileA, provHookEventWithoutModel("2026-05-22T01:00:00.000Z", 10, 5, 0.03))
	if _, err := Collect(context.Background(), options); err == nil ||
		!strings.Contains(err.Error(), "Codex hook reconciliation returned no snapshots for parsed usage keys") {
		t.Fatalf("first collect err = %v", err)
	}
	if !provReadPendingUpload(t, stateDir, "2026/05/22/a.jsonl") {
		t.Fatal("file A must stay pending after the failed reconciliation")
	}

	// A second file lands for the same day and ccusage now reports the whole day
	// under the concrete model id: A's 15 plus B's 15.
	provWriteJSONL(t, fileB, provHookEventWithoutModel("2026-05-22T02:00:00.000Z", 10, 5, 0.03))
	daily = provJSON(t, `{"data":[{"date":"2026-05-22","model":"gpt-5",
		"inputTokens":20,"outputTokens":10,"totalTokens":30,"costUSD":0.06}]}`)
	options.CollectedAt = "2026-05-22T11:00:00.000Z"

	snapshots, err := Collect(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	// Only ccusage's figure, not the cached `all` copy summed on top of it.
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	got := provSnapshotFor(t, snapshots, "2026-05-22", "gpt-5")
	if got.TotalTokens != 30 {
		t.Errorf("total = %d, want 30 (the cached all copy must not be added)", got.TotalTokens)
	}
	if provHasSnapshot(snapshots, "2026-05-22", "all") {
		t.Errorf("the reused pending all snapshot must not also upload: %+v", snapshots)
	}
}
