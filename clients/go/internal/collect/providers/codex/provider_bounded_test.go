package codex

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Port of codex-bounded-retry.test.ts and codex-bounded-attribution-batches.
// test.ts: the bounded collection retries once when the canonical attribution
// races the frozen copy, and every bounded report runs in the configured
// batches.

// provReportDiagnostic is the suite's reportDiagnostic: the clone fallback
// notice is expected noise, everything else is a diagnostic.
func provReportDiagnostic(lines *[]string) func(string) {
	return func(line string) {
		if line != CodexSessionCopyFallbackMessage {
			*lines = append(*lines, line)
		}
	}
}

// provBoundedDailyResult is the bounded-retry suite's daily report.
const provBoundedDailyResult = `{"data":[{"date":"2026-05-21","models":{
	"gpt-5.6":{"inputTokens":10,"totalTokens":10}}}]}`

// provBoundedSessionRow builds the suite's session row fixture.
func provBoundedSessionRow(sessionFile, lastActivity, model string) string {
	return `{"sessions":[{"directory":"2026/05/20","sessionFile":"` + sessionFile + `",
		"lastActivity":"` + lastActivity + `",
		"models":{"` + model + `":{"inputTokens":10,"totalTokens":10}}}]}`
}

// A source session that changes between the frozen copy and the cache write
// keeps this run's bounded snapshot: the copy is what was measured, and the
// attribution is simply not persisted.
func TestCodexBoundedKeepsTheBoundedSnapshotWhenItsSourceChangesAfterTheFrozenCopy(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	stateDir := t.TempDir()
	sessionPath := filepath.Join(codexHome, "sessions", "2026", "05", "20", "stable-session.jsonl")
	provWriteJSONL(t, sessionPath, provTokenEvent("2026-05-21T04:24:07.234Z", 10, "gpt-5.6"))
	diagnostics := []string{}
	canonicalRuns := 0

	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("--since") && call.hasArg("session") {
			return provJSON(t, provBoundedSessionRow("stable-session", "2026-05-20T04:24:07.234Z", "gpt-5.4")), nil
		}
		if call.hasArg("daily") {
			return provJSON(t, provBoundedDailyResult), nil
		}
		canonicalRuns++
		if canonicalRuns == 1 {
			provWriteJSONL(t, sessionPath, provTokenEvent("2026-05-21T04:24:07.234Z", 20, "gpt-5.6"))
		}
		return provJSON(t, provBoundedSessionRow("stable-session", "2026-05-21T04:24:07.234Z", "gpt-5.6")), nil
	}}
	snapshots, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  stateDir,
		Timezone:  "Asia/Shanghai",
		Since:     "20260515",
		Stderr:    provReportDiagnostic(&diagnostics),
		Runner:    runner.run,
		Env:       provEnv(provForceEnv(nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if canonicalRuns != 1 {
		t.Errorf("canonical runs = %d", canonicalRuns)
	}
	want := []string{
		"Skipping stale Codex canonical attribution cache write for a session that changed after copy",
	}
	if len(diagnostics) != len(want) || diagnostics[0] != want[0] {
		t.Errorf("diagnostics = %v, want %v", diagnostics, want)
	}
	row := provSnapshotFor(t, snapshots, "2026-05-21", "gpt-5.6")
	if row.TotalTokens != 10 || row.SessionCount != 1 {
		t.Errorf("snapshot = %+v", row)
	}
}

// A full-history collection has the same rule: the stale write is reported and
// skipped, not written with the wrong identity.
func TestCodexBoundedReportsAStaleCanonicalAttributionCacheWriteDuringAFullHistoryCollection(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	stateDir := t.TempDir()
	sessionPath := filepath.Join(codexHome, "sessions", "2026", "05", "20", "stable-session.jsonl")
	provWriteJSONL(t, sessionPath, provTokenEvent("2026-05-21T04:24:07.234Z", 10, "gpt-5.6"))
	diagnostics := []string{}

	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("daily") {
			return provJSON(t, provBoundedDailyResult), nil
		}
		provAppendJSONL(t, sessionPath, provTokenEvent("2026-05-21T04:24:07.234Z", 20, "gpt-5.6"))
		return provJSON(t, provBoundedSessionRow("stable-session", "2026-05-21T04:24:07.234Z", "gpt-5.6")), nil
	}}
	if _, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  stateDir,
		Timezone:  "Asia/Shanghai",
		Since:     "all",
		Stderr:    provReportDiagnostic(&diagnostics),
		Runner:    runner.run,
		Env:       provEnv(provForceEnv(nil)),
	}); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"Skipping stale Codex canonical attribution cache write for a session that changed after copy",
	}
	if len(diagnostics) != len(want) || diagnostics[0] != want[0] {
		t.Errorf("diagnostics = %v, want %v", diagnostics, want)
	}
}

// A source change detected by the scope's own stability check fails the whole
// bounded collection once; the retry re-freezes and succeeds.
func TestCodexBoundedRetriesTheCompleteCollectionOnceWhenTheScopeCopySeesASourceChange(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	stateDir := t.TempDir()
	sessionPath := filepath.Join(codexHome, "sessions", "2026", "05", "20", "scope-race-session.jsonl")
	provWriteJSONL(t, sessionPath, provTokenEvent("2026-05-21T04:24:07.234Z", 10, "gpt-5.6"))
	diagnostics := []string{}
	canonicalRuns := 0

	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("--since") && call.hasArg("session") {
			return provJSON(t, provBoundedSessionRow("scope-race-session", "2026-05-20T04:24:07.234Z", "gpt-5.4")), nil
		}
		if call.hasArg("daily") {
			return provJSON(t, provBoundedDailyResult), nil
		}
		canonicalRuns++
		if canonicalRuns == 1 {
			return nil, fmt.Errorf("Codex session changed during scoped collection; retry the sync")
		}
		return provJSON(t, provBoundedSessionRow("scope-race-session", "2026-05-21T04:24:07.234Z", "gpt-5.6")), nil
	}}
	snapshots, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  stateDir,
		Timezone:  "Asia/Shanghai",
		Since:     "20260515",
		Stderr:    provReportDiagnostic(&diagnostics),
		Runner:    runner.run,
		Env:       provEnv(provForceEnv(nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if canonicalRuns != 2 {
		t.Errorf("canonical runs = %d", canonicalRuns)
	}
	want := []string{"Codex canonical attribution changed; retrying the bounded collection once"}
	if len(diagnostics) != len(want) || diagnostics[0] != want[0] {
		t.Errorf("diagnostics = %v, want %v", diagnostics, want)
	}
	row := provSnapshotFor(t, snapshots, "2026-05-21", "gpt-5.6")
	if row.TotalTokens != 10 || row.SessionCount != 1 {
		t.Errorf("snapshot = %+v", row)
	}
}

// A canonical report that briefly reports no session at all is the same race
// seen from the other side: the bounded row has no attribution, which is
// retryable.
func TestCodexBoundedRetriesTheCompleteCollectionOnceWhenAttributionIsBrieflyMissing(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	stateDir := t.TempDir()
	sessionPath := filepath.Join(codexHome, "sessions", "2026", "05", "20", "scope-race-session.jsonl")
	provWriteJSONL(t, sessionPath, provTokenEvent("2026-05-21T04:24:07.234Z", 10, "gpt-5.6"))
	diagnostics := []string{}
	canonicalRuns := 0

	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("--since") && call.hasArg("session") {
			return provJSON(t, provBoundedSessionRow("scope-race-session", "2026-05-20T04:24:07.234Z", "gpt-5.4")), nil
		}
		if call.hasArg("daily") {
			return provJSON(t, provBoundedDailyResult), nil
		}
		canonicalRuns++
		if canonicalRuns == 1 {
			return provJSON(t, `{"sessions":[]}`), nil
		}
		return provJSON(t, provBoundedSessionRow("scope-race-session", "2026-05-21T04:24:07.234Z", "gpt-5.6")), nil
	}}
	snapshots, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  stateDir,
		Timezone:  "Asia/Shanghai",
		Since:     "20260515",
		Stderr:    provReportDiagnostic(&diagnostics),
		Runner:    runner.run,
		Env:       provEnv(provForceEnv(nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if canonicalRuns != 2 {
		t.Errorf("canonical runs = %d", canonicalRuns)
	}
	want := []string{"Codex canonical attribution changed; retrying the bounded collection once"}
	if len(diagnostics) != len(want) || diagnostics[0] != want[0] {
		t.Errorf("diagnostics = %v, want %v", diagnostics, want)
	}
	row := provSnapshotFor(t, snapshots, "2026-05-21", "gpt-5.6")
	if row.TotalTokens != 10 || row.SessionCount != 1 {
		t.Errorf("snapshot = %+v", row)
	}
}

// The retry budget is one: a child session that is still unstable on the
// second attempt surfaces the error instead of looping.
func TestCodexBoundedRetriesOnceWhenAChildSessionRemainsUnstableDuringFrozenCorrection(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	stateDir := t.TempDir()
	sessionPath := filepath.Join(codexHome, "sessions", "2026", "05", "20", "unstable-session.jsonl")
	provWriteJSONL(t, sessionPath, provTokenEvent("2026-05-21T04:24:07.234Z", 10, "gpt-5.6"))
	diagnostics := []string{}
	canonicalRuns := 0

	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("--since") && call.hasArg("session") {
			return provJSON(t, provBoundedSessionRow("unstable-session", "2026-05-20T04:24:07.234Z", "gpt-5.4")), nil
		}
		if call.hasArg("daily") {
			return provJSON(t, provBoundedDailyResult), nil
		}
		canonicalRuns++
		if canonicalRuns <= 2 {
			return nil, fmt.Errorf("Codex child session changed while correcting; retry the sync")
		}
		return provJSON(t, provBoundedSessionRow("unstable-session", "2026-05-21T04:24:07.234Z", "gpt-5.6")), nil
	}}
	_, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  stateDir,
		Timezone:  "Asia/Shanghai",
		Since:     "20260515",
		Stderr:    provReportDiagnostic(&diagnostics),
		Runner:    runner.run,
		Env:       provEnv(provForceEnv(nil)),
	})
	if err == nil || err.Error() != "Codex child session changed while correcting; retry the sync" {
		t.Fatalf("err = %v", err)
	}
	if canonicalRuns != 2 {
		t.Errorf("canonical runs = %d", canonicalRuns)
	}
	want := []string{"Codex canonical attribution changed; retrying the bounded collection once"}
	if len(diagnostics) != len(want) || diagnostics[0] != want[0] {
		t.Errorf("diagnostics = %v, want %v", diagnostics, want)
	}
}

// Every bounded report — daily, session and canonical — runs inside a frozen
// batch of at most the configured size, and the canonical run sees only one
// selected session at a time.
func TestCodexBoundedRunsEveryReportInConfiguredBatches(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	stateDir := t.TempDir()
	first := filepath.Join(codexHome, "sessions", "2026", "05", "20", "first.jsonl")
	second := filepath.Join(codexHome, "sessions", "2026", "05", "20", "second.jsonl")
	provWriteJSONL(t, first, provTokenEvent("2026-05-21T04:24:07.234Z", 10, "gpt-5.6"))
	provWriteJSONL(t, second, provTokenEvent("2026-05-21T04:25:07.234Z", 10, "gpt-5.6"))
	canonicalBatches := []string{}
	commandArgs := [][]string{}

	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		commandArgs = append(commandArgs, call.args)
		scopedHome := call.envValue("CODEX_HOME")
		if scopedHome == codexHome {
			return nil, fmt.Errorf("Bounded collection must not run ccusage against the live Codex home")
		}
		hasFirst := provFileExists(filepath.Join(scopedHome, "sessions", "2026", "05", "20", "first.jsonl"))
		hasSecond := provFileExists(filepath.Join(scopedHome, "sessions", "2026", "05", "20", "second.jsonl"))
		selected := "second"
		if hasFirst {
			selected = "first"
		}
		if call.hasArg("--since") && call.hasArg("session") {
			if hasFirst == hasSecond {
				return nil, fmt.Errorf("Frozen bounded batch must contain exactly one selected session")
			}
			return provJSON(t, `{"sessions":[{"directory":"2026/05/20","sessionFile":"`+selected+`",
				"lastActivity":"2026-05-20T04:24:07.234Z","models":{"gpt-5.4":{"inputTokens":10,"totalTokens":10}}}]}`), nil
		}
		if call.hasArg("daily") {
			if hasFirst == hasSecond {
				return nil, fmt.Errorf("Frozen bounded batch must contain exactly one selected session")
			}
			return provJSON(t, `{"data":[{"date":"2026-05-21","models":{"gpt-5.6":{"inputTokens":10,"totalTokens":10}}}]}`), nil
		}
		canonicalBatches = append(canonicalBatches, selected)
		if hasFirst == hasSecond {
			return nil, fmt.Errorf("Canonical attribution batch must contain exactly one bounded session")
		}
		return provJSON(t, `{"sessions":[{"directory":"2026/05/20","sessionFile":"`+selected+`",
			"lastActivity":"2026-05-21T04:24:07.234Z","models":{"gpt-5.6":{"inputTokens":10,"totalTokens":10}}}]}`), nil
	}}
	snapshots, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  stateDir,
		Timezone:  "Asia/Shanghai",
		Since:     "20260515",
		Runner:    runner.run,
		Env: provEnv(provForceEnv(map[string]string{
			"TOKENBOARD_CODEX_BATCH_SIZE": "1",
		})),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(canonicalBatches) != 2 {
		t.Fatalf("canonical batches = %v", canonicalBatches)
	}
	if len(commandArgs) != 6 {
		t.Fatalf("calls = %d (%v)", len(commandArgs), commandArgs)
	}
	for _, args := range commandArgs {
		if !containsArg(args, "--single-thread") {
			t.Errorf("missing --single-thread in %v", args)
		}
	}
	sawFirst, sawSecond := false, false
	for _, selected := range canonicalBatches {
		if selected == "first" {
			sawFirst = true
		}
		if selected == "second" {
			sawSecond = true
		}
	}
	if !sawFirst || !sawSecond {
		t.Errorf("canonical batches = %v", canonicalBatches)
	}
	row := provSnapshotFor(t, snapshots, "2026-05-21", "gpt-5.6")
	if row.TotalTokens != 20 || row.SessionCount != 2 {
		t.Errorf("snapshot = %+v", row)
	}
}

// The second run narrows canonical attribution to the files the cache does not
// cover, and the narrowed scope carries the live bytes rather than the stale
// frozen copy.
func TestCodexBoundedNarrowsCanonicalAttributionToCacheMissFilesWithinASharedScope(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	stateDir := t.TempDir()
	first := filepath.Join(codexHome, "sessions", "2026", "05", "20", "first.jsonl")
	second := filepath.Join(codexHome, "sessions", "2026", "05", "20", "second.jsonl")
	provWriteJSONL(t, first, provTokenEvent("2026-05-21T04:24:07.234Z", 10, "gpt-5.6"))
	provWriteJSONL(t, second, provTokenEvent("2026-05-21T04:25:07.234Z", 10, "gpt-5.6"))
	canonicalScopes := [][2]bool{}
	canonicalTokens := [][2]int64{}
	dailyCalls := 0

	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		scopedHome := call.envValue("CODEX_HOME")
		selected := [2]bool{
			provFileExists(filepath.Join(scopedHome, "sessions", "2026", "05", "20", "first.jsonl")),
			provFileExists(filepath.Join(scopedHome, "sessions", "2026", "05", "20", "second.jsonl")),
		}
		if call.hasArg("session") {
			if !call.hasArg("--since") {
				canonicalScopes = append(canonicalScopes, selected)
				canonicalTokens = append(canonicalTokens, [2]int64{
					provScopedToken(t, scopedHome, "first", selected[0]),
					provScopedToken(t, scopedHome, "second", selected[1]),
				})
			}
			rows := ""
			if selected[0] {
				rows += `{"directory":"2026/05/20","sessionFile":"first","lastActivity":"2026-05-20T04:24:07.234Z",
					"models":{"gpt-5.6":{"inputTokens":10,"totalTokens":10}}}`
			}
			if selected[1] {
				if rows != "" {
					rows += ","
				}
				rows += `{"directory":"2026/05/20","sessionFile":"second","lastActivity":"2026-05-20T04:25:07.234Z",
					"models":{"gpt-5.6":{"inputTokens":10,"totalTokens":10}}}`
			}
			return provJSON(t, `{"sessions":[`+rows+`]}`), nil
		}
		dailyCalls++
		if dailyCalls == 2 {
			provAppendJSONL(t, second, provTokenEvent("2026-05-21T04:26:07.234Z", 20, "gpt-5.6"))
		}
		return provJSON(t, `{"data":[{"date":"2026-05-21","models":{"gpt-5.6":{"inputTokens":20,"totalTokens":20}}}]}`), nil
	}}
	options := Options{
		CodexHome: provHome(codexHome),
		StateDir:  stateDir,
		Timezone:  "Asia/Shanghai",
		Since:     "20260515",
		Runner:    runner.run,
		Env: provEnv(provForceEnv(map[string]string{
			"TOKENBOARD_CODEX_BATCH_SIZE": "200",
		})),
	}
	if _, err := Collect(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	provAppendJSONL(t, second, provTokenEvent("2026-05-21T04:25:30.234Z", 15, "gpt-5.6"))
	if _, err := Collect(context.Background(), options); err != nil {
		t.Fatal(err)
	}

	wantScopes := [][2]bool{{true, true}, {false, true}}
	if len(canonicalScopes) != len(wantScopes) {
		t.Fatalf("canonical scopes = %v", canonicalScopes)
	}
	for index := range wantScopes {
		if canonicalScopes[index] != wantScopes[index] {
			t.Errorf("canonical scope %d = %v, want %v", index, canonicalScopes[index], wantScopes[index])
		}
	}
	wantTokens := [][2]int64{{10, 10}, {-1, 15}}
	if len(canonicalTokens) != len(wantTokens) {
		t.Fatalf("canonical tokens = %v", canonicalTokens)
	}
	for index := range wantTokens {
		if canonicalTokens[index] != wantTokens[index] {
			t.Errorf("canonical tokens %d = %v, want %v", index, canonicalTokens[index], wantTokens[index])
		}
	}
}

// provFileExists is the TS `exists` helper.
func provFileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// containsArg reports whether args holds value.
func containsArg(args []string, value string) bool {
	for _, arg := range args {
		if arg == value {
			return true
		}
	}
	return false
}

// provScopedToken reads the last token event of a frozen session file; a file
// that was not selected yields -1.
func provScopedToken(t *testing.T, scopedHome, sessionFile string, selected bool) int64 {
	t.Helper()
	if !selected {
		return -1
	}
	content, err := os.ReadFile(filepath.Join(scopedHome, "sessions", "2026", "05", "20", sessionFile+".jsonl"))
	if err != nil {
		t.Fatalf("read scoped token: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(content)), "\n")
	var event struct {
		Payload struct {
			Info struct {
				LastTokenUsage struct {
					TotalTokens float64 `json:"total_tokens"`
				} `json:"last_token_usage"`
			} `json:"info"`
		} `json:"payload"`
	}
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &event); err != nil {
		t.Fatalf("parse scoped token: %v", err)
	}
	return int64(event.Payload.Info.LastTokenUsage.TotalTokens)
}
