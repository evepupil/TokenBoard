package codex

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Port of codex-scoped-scan.test.ts: the frozen-copy scan (full history and
// bounded windows), the attribution-cache warm-up, and the scoped cleanup.

// provSessionResult builds the suite's session row.
func provSessionResult(sessionID string, identifier string) string {
	key := "sessionFile"
	if identifier != "" {
		key = identifier
	}
	return `{"sessions":[{"directory":"2026/05/09","` + key + `":"` + sessionID + `",
		"lastActivity":"2026-05-09T04:24:07.234Z",
		"models":{"gpt-5":{"inputTokens":10,"outputTokens":0}}}]}`
}

// provDailyResult is the suite's daily envelope (`daily`, model map).
const provDailyResult = `{"daily":[{"date":"2026-05-09","models":{"gpt-5":{
	"inputTokens":10,"outputTokens":0,"totalTokens":10}},"totalTokens":10,"costUSD":0.01}]}`

// A full scan attributes the session's context-priced turn and leaves the
// canonical model with only what it really ran.
func TestCodexScopeSplitsContextPricedUsageFromANonContextCanonicalModelInFullScans(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	sessionPath := filepath.Join(codexHome, "sessions", "2026", "05", "09", "mixed.jsonl")
	provWriteJSONL(t, sessionPath,
		provTurnContext("deepseek-v4-flash"),
		provTokenEvent("2026-05-09T04:24:07.234Z", 20, "gpt-5.6-sol"))

	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("session") {
			return provJSON(t, `{"sessions":[{"directory":"2026/05/09","sessionFile":"mixed",
				"lastActivity":"2026-05-09T04:24:07.234Z",
				"models":{"deepseek-v4-flash":{"inputTokens":20,"outputTokens":0,"totalTokens":20}}}]}`), nil
		}
		return provJSON(t, `{"daily":[{"date":"2026-05-09","models":{
			"deepseek-v4-flash":{"inputTokens":20,"outputTokens":0,"totalTokens":20}},
			"totalTokens":20,"costUSD":0.00008}]}`), nil
	}}
	snapshots, err := provCollect(t, Options{
		CodexHome:   provHome(codexHome),
		Timezone:    "UTC",
		CollectedAt: "2026-05-09T10:00:00.000Z",
		Runner:      runner.run,
	}, map[string]string{"TOKENBOARD_SINCE": "all"})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 2 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	canonical := provSnapshotFor(t, snapshots, "2026-05-09", "deepseek-v4-flash")
	if canonical.TotalTokens != 0 {
		t.Errorf("canonical = %+v", canonical)
	}
	assertCloseTo(t, canonical.CostUSD, 0, 12)
	context := provSnapshotFor(t, snapshots, "2026-05-09", "gpt-5.6-sol")
	if context.TotalTokens != 20 {
		t.Errorf("context = %+v", context)
	}
	assertCloseTo(t, context.CostUSD, 20*4.0/1_000_000, 14)
}

// A full scan runs in batches, and every batch carries the frozen CODEX_HOME.
func TestCodexScopeAllowsExplicitFullScanInBatches(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	stateDir := t.TempDir()
	for index, date := range [][2]string{{"2026", "03"}, {"2026", "04"}, {"2026", "05"}} {
		day := "20"
		if index == 2 {
			day = "09"
		}
		provWriteJSONL(t,
			filepath.Join(codexHome, "sessions", date[0], date[1], day, fmt.Sprintf("session-%d.jsonl", index)),
			provTokenEvent("2026-"+date[1]+"-"+day+"T04:24:07.234Z", 10, "gpt-5"))
	}
	scopedHomes := map[string]bool{}
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		scopedHomes[call.envValue("CODEX_HOME")] = true
		if call.hasArg("session") {
			return provJSON(t, provSessionResult(fmt.Sprintf("%d", len(scopedHomes)), "")), nil
		}
		return provJSON(t, provDailyResult), nil
	}}
	snapshots, err := Collect(context.Background(), Options{
		CodexHome:   provHome(codexHome),
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-09T10:00:00.000Z",
		StateDir:    stateDir,
		Runner:      runner.run,
		Env: provEnv(map[string]string{
			"TOKENBOARD_PACKAGE_MANAGER":      "",
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
			"TOKENBOARD_SINCE":                "all",
			"TOKENBOARD_DEFAULT_SINCE":        "20260501",
			"TOKENBOARD_CODEX_BATCH_SIZE":     "2",
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	configArgs := provConfigArgs(stateDir)
	call := func(report string) []string {
		return append([]string{
			"ccusage@20.0.33", "codex", report, "--json", "--offline", "--single-thread",
			"--timezone", "Asia/Shanghai",
		}, configArgs...)
	}
	if len(runner.calls) != 4 {
		t.Fatalf("calls = %+v", runner.calls)
	}
	provAssertArgs(t, runner.calls[0].args, call("daily"))
	provAssertArgs(t, runner.calls[1].args, call("session"))
	provAssertArgs(t, runner.calls[2].args, call("daily"))
	provAssertArgs(t, runner.calls[3].args, call("session"))
	if len(scopedHomes) != 2 {
		t.Fatalf("scoped homes = %v", scopedHomes)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	got := provSnapshotFor(t, snapshots, "2026-05-09", "gpt-5")
	if got.InputTokens != 20 || got.OutputTokens != 0 || got.TotalTokens != 20 ||
		got.CostUSD != 0.02 || got.SessionCount != 2 {
		t.Errorf("snapshot = %+v", got)
	}
}

// A home whose path contains a comma can only be supplied through the JSON
// list; it must reach ccusage intact, never split on the comma.
func TestCodexScopeCollectsACommaContainingHomeFromTheJSONEnvironmentValue(t *testing.T) {
	root := t.TempDir()
	codexHome := filepath.Join(root, "profile,primary")
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "09", "session.jsonl"),
		provTokenEvent("2026-05-09T04:24:07.234Z", 10, "gpt-5"))
	scopedHomes := map[string]bool{}
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		scopedHomes[call.envValue("CODEX_HOME")] = true
		if call.hasArg("session") {
			return provJSON(t, provSessionResult("session", "")), nil
		}
		return provJSON(t, provDailyResult), nil
	}}
	encodedHomes, err := json.Marshal([]string{codexHome})
	if err != nil {
		t.Fatal(err)
	}
	snapshots, err := Collect(context.Background(), Options{
		Since:    "20260509",
		Timezone: "Asia/Shanghai",
		StateDir: t.TempDir(),
		Runner:   runner.run,
		Env: provEnv(provForceEnv(map[string]string{
			"CODEX_HOME":                  codexHome,
			"TOKENBOARD_CODEX_HOMES_JSON": string(encodedHomes),
		})),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(scopedHomes) != 1 {
		t.Fatalf("scoped homes = %v", scopedHomes)
	}
	for home := range scopedHomes {
		if strings.Contains(home, "profile,primary") {
			t.Errorf("scoped home kept the comma path: %q", home)
		}
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	got := snapshots[0]
	if got.TotalTokens != 10 || got.SessionCount != 1 {
		t.Errorf("snapshot = %+v", got)
	}
}

// The subagent cache is keyed by the source session, not by the temporary
// frozen copy the scan read.
func TestCodexScopePersistsFrozenChildUsageUnderTheOriginalSourceIdentity(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	stateDir := t.TempDir()
	sessionPath := filepath.Join(codexHome, "sessions", "2026", "05", "09", "session.jsonl")
	provWriteJSONL(t, sessionPath,
		subagentChildSessionMeta("session", "parent", "2026-05-09T04:20:00.000Z"),
		provTotalUsageEvent("2026-05-09T04:24:07.234Z", 1, 0, 0))
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("session") {
			return provJSON(t, provSessionResult("session", "")), nil
		}
		return provJSON(t, provDailyResult), nil
	}}
	if _, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  stateDir,
		Runner:    runner.run,
		Env: provEnv(provForceEnv(map[string]string{
			"TOKENBOARD_PACKAGE_MANAGER": "",
			"TOKENBOARD_SINCE":           "all",
		})),
	}); err != nil {
		t.Fatal(err)
	}

	content, err := os.ReadFile(filepath.Join(stateDir, codexSubagentUsageCacheFileName))
	if err != nil {
		t.Fatal(err)
	}
	var cache struct {
		Entries map[string]json.RawMessage `json:"entries"`
	}
	if err := json.Unmarshal(content, &cache); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(sessionPath))
	sourceKey := hex.EncodeToString(sum[:])
	if len(cache.Entries) != 1 {
		t.Fatalf("entries = %v", cache.Entries)
	}
	if _, ok := cache.Entries[sourceKey]; !ok {
		t.Fatalf("entries = %v, want the source-file hash %q", cache.Entries, sourceKey)
	}
}

// subagentTokensEvent is the suite's totalUsageEvent: a cumulative usage row
// with the same per-request counters.
func provTotalUsageEvent(timestamp string, inputTokens, cacheReadTokens, outputTokens int) map[string]any {
	usage := map[string]any{
		"input_tokens":        inputTokens,
		"cached_input_tokens": cacheReadTokens,
		"output_tokens":       outputTokens,
		"total_tokens":        inputTokens + outputTokens,
	}
	return map[string]any{
		"type":      "event_msg",
		"timestamp": timestamp,
		"payload": map[string]any{
			"type": "token_count",
			"info": map[string]any{
				"model":             "gpt-5",
				"total_token_usage": usage,
				"last_token_usage":  usage,
			},
		},
	}
}

// ccusage sometimes reports the session file name with its extension; the
// attribution cache must still resolve it to the file on disk.
func TestCodexScopeWarmsCanonicalAttributionCacheForAFilenameWithItsExtension(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	stateDir := t.TempDir()
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "09", "session.jsonl"),
		provTokenEvent("2026-05-09T04:24:07.234Z", 10, "gpt-5"))
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("session") {
			return provJSON(t, provSessionResult("session.jsonl", "")), nil
		}
		return provJSON(t, provDailyResult), nil
	}}
	if _, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  stateDir,
		Timezone:  "Asia/Shanghai",
		Runner:    runner.run,
		Env: provEnv(provForceEnv(map[string]string{
			"TOKENBOARD_PACKAGE_MANAGER": "",
			"TOKENBOARD_SINCE":           "all",
		})),
	}); err != nil {
		t.Fatal(err)
	}
	assertAttributionCacheHasOneRow(t, stateDir)
}

// The same for a directory-qualified sessionId with its extension.
func TestCodexScopeWarmsCanonicalAttributionCacheForADirectoryQualifiedSessionIDWithItsExtension(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	stateDir := t.TempDir()
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "09", "session.jsonl"),
		provTokenEvent("2026-05-09T04:24:07.234Z", 10, "gpt-5"))
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("session") {
			return provJSON(t, provSessionResult("session.jsonl", "sessionId")), nil
		}
		return provJSON(t, provDailyResult), nil
	}}
	if _, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  stateDir,
		Timezone:  "Asia/Shanghai",
		Runner:    runner.run,
		Env: provEnv(provForceEnv(map[string]string{
			"TOKENBOARD_PACKAGE_MANAGER": "",
			"TOKENBOARD_SINCE":           "all",
		})),
	}); err != nil {
		t.Fatal(err)
	}
	assertAttributionCacheHasOneRow(t, stateDir)
}

// assertAttributionCacheHasOneRow checks the cache holds exactly one entry and
// that the entry names the date and model the file proved.
func assertAttributionCacheHasOneRow(t *testing.T, stateDir string) {
	t.Helper()
	content, err := os.ReadFile(filepath.Join(stateDir, codexSessionAttributionCacheFileName))
	if err != nil {
		t.Fatal(err)
	}
	var cache struct {
		Entries map[string]struct {
			UsageDate string `json:"usageDate"`
			Model     string `json:"model"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(content, &cache); err != nil {
		t.Fatal(err)
	}
	if len(cache.Entries) != 1 {
		t.Fatalf("entries = %v", cache.Entries)
	}
	for _, entry := range cache.Entries {
		if entry.UsageDate != "2026-05-09" || entry.Model != "gpt-5" {
			t.Errorf("entry = %+v", entry)
		}
	}
}

// A full history collection over a comma-separated home list scans them in one
// frozen scope that keeps both homes alive.
func TestCodexScopeScansAllConfiguredHomesTogetherDuringAFullHistoryCollection(t *testing.T) {
	firstHome := provEmptyCodexHome(t)
	secondHome := provEmptyCodexHome(t)
	provWriteJSONL(t, filepath.Join(firstHome, "sessions", "2026", "04", "20", "first.jsonl"),
		provTokenEvent("2026-04-20T04:24:07.234Z", 10, "gpt-5"))
	provWriteJSONL(t, filepath.Join(secondHome, "sessions", "2026", "05", "09", "second.jsonl"),
		provTokenEvent("2026-05-09T04:24:07.234Z", 20, "gpt-5"))
	scopedHomes := map[string]bool{}
	var checkErr error
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		homes := splitCommaHomes(call.envValue("CODEX_HOME"))
		scopedHomes[strings.Join(homes, ",")] = true
		if len(homes) != 2 {
			checkErr = fmt.Errorf("scoped homes = %v", homes)
			return provJSON(t, `{"data":[]}`), nil
		}
		first, err := os.ReadFile(filepath.Join(homes[0], "sessions", "2026", "04", "20", "first.jsonl"))
		if err != nil {
			checkErr = err
		} else if !containsText(string(first), "2026-04-20") {
			checkErr = fmt.Errorf("first scoped home lost its session")
		}
		second, err := os.ReadFile(filepath.Join(homes[1], "sessions", "2026", "05", "09", "second.jsonl"))
		if err != nil {
			checkErr = err
		} else if !containsText(string(second), "2026-05-09") {
			checkErr = fmt.Errorf("second scoped home lost its session")
		}
		if call.hasArg("session") {
			return provJSON(t, provSessionResult("first", "")), nil
		}
		return provJSON(t, provDailyResult), nil
	}}
	if _, err := Collect(context.Background(), Options{
		CodexHome: provHome(firstHome + "," + secondHome),
		Timezone:  "Asia/Shanghai",
		Since:     "all",
		StateDir:  t.TempDir(),
		Runner:    runner.run,
		Env:       provEnv(provForceEnv(nil)),
	}); err != nil {
		t.Fatal(err)
	}
	if checkErr != nil {
		t.Fatalf("scoped check: %v", checkErr)
	}
	if len(scopedHomes) != 1 {
		t.Fatalf("scoped homes = %v", scopedHomes)
	}
}

// Historical subagent rows carry the model name ccusage later canonicalizes;
// the snapshot must use the canonical name.
func TestCodexScopeMapsHistoricalSubagentModelNamesToCcusageCanonicalModels(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "07", "18", "session.jsonl"),
		map[string]any{"type": "session_meta", "id": "session"},
		provTurnContext("gpt-5.5"),
		provTokenEvent("2026-07-18T00:00:00.000Z", 10, "gpt-5.5"))
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("daily") {
			return provJSON(t, `{"daily":[{"date":"2026-07-18","modelBreakdowns":[
				{"modelName":"gpt-5.6-terra","inputTokens":10,"outputTokens":0,"totalTokens":10}],
				"totalTokens":10}]}`), nil
		}
		return provJSON(t, `{"sessions":[{"directory":"2026/07/18","sessionFile":"session",
			"lastActivity":"2026-07-18T00:00:00.000Z","modelBreakdowns":[
				{"modelName":"gpt-5.6-terra","inputTokens":10,"outputTokens":0,"totalTokens":10}]}]}`), nil
	}}
	snapshots, err := provCollect(t, Options{
		CodexHome: provHome(codexHome),
		Since:     "20260718",
		Timezone:  "UTC",
		Runner:    runner.run,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	got := provSnapshotFor(t, snapshots, "2026-07-18", "gpt-5.6-terra")
	if got.InputTokens != 10 || got.TotalTokens != 10 {
		t.Errorf("snapshot = %+v", got)
	}
	assertCloseTo(t, got.CostUSD, 10*2.0/1_000_000, 14)
}

// The selected package manager and the explicit since window both reach every
// frozen bounded report.
func TestCodexScopeUsesSinceAndTheSelectedPackageManagerForFrozenBoundedReports(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	stateDir := t.TempDir()
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "09", "active.jsonl"),
		provTokenEvent("2026-05-09T04:24:07.234Z", 10, "gpt-5"))
	runner := &provStubRunner{t: t, respond: func(provCall) (any, error) {
		return provJSON(t, `{"data":[]}`), nil
	}}
	if _, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  stateDir,
		Runner:    runner.run,
		Env: provEnv(map[string]string{
			"TOKENBOARD_PACKAGE_MANAGER":      "bun",
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
			"TOKENBOARD_BUNX_BIN":             "/opt/bin/bunx",
			"TOKENBOARD_SINCE":                "20260509",
		}),
	}); err != nil {
		t.Fatal(err)
	}
	configArgs := provConfigArgs(stateDir)
	if len(runner.calls) != 3 {
		t.Fatalf("calls = %+v", runner.calls)
	}
	provAssertArgs(t, runner.calls[0].args, append([]string{
		"ccusage@20.0.33", "codex", "daily", "--json", "--offline", "--single-thread",
		"--since", "20260509",
	}, configArgs...))
	provAssertArgs(t, runner.calls[1].args, append([]string{
		"ccusage@20.0.33", "codex", "session", "--json", "--offline", "--single-thread",
		"--since", "20260509",
	}, configArgs...))
	provAssertArgs(t, runner.calls[2].args, append([]string{
		"ccusage@20.0.33", "codex", "session", "--json", "--offline", "--single-thread",
	}, configArgs...))
	for _, call := range runner.calls {
		if call.command != "/opt/bin/bunx" {
			t.Errorf("command = %q", call.command)
		}
	}
}

// The batch size is a ceiling: three files with a batch size of two produce two
// scopes, not three.
func TestCodexScopeCapsTheConfiguredBatchSize(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	for index := 0; index < 3; index++ {
		provWriteJSONL(t,
			filepath.Join(codexHome, "sessions", "2026", "05", "09", fmt.Sprintf("session-%d.jsonl", index)),
			provTokenEvent("2026-05-09T04:24:07.234Z", 1, "gpt-5"))
	}
	scopedHomes := map[string]bool{}
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		scopedHomes[call.envValue("CODEX_HOME")] = true
		return provJSON(t, `{"data":[]}`), nil
	}}
	if _, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  t.TempDir(),
		Runner:    runner.run,
		Env: provEnv(provForceEnv(map[string]string{
			"TOKENBOARD_PACKAGE_MANAGER":  "",
			"TOKENBOARD_SINCE":            "all",
			"TOKENBOARD_CODEX_BATCH_SIZE": "2",
		})),
	}); err != nil {
		t.Fatal(err)
	}
	if len(scopedHomes) != 2 {
		t.Fatalf("scoped homes = %v", scopedHomes)
	}
	if len(runner.calls) != 4 {
		t.Fatalf("calls = %+v", runner.calls)
	}
}

// Bounded discovery can be empty (no file inside the window) while the daily
// report still has rows. The report must still be frozen and returned, and the
// canonical run still happens.
func TestCodexScopeCollectsAFrozenDailyReportWhenBoundedSessionDiscoveryIsEmpty(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "03", "25", "active-old-session.jsonl"),
		provTokenEvent("2026-05-09T04:24:07.234Z", 10, "gpt-5"))
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "03", "20", "inactive-old-session.jsonl"),
		provTokenEvent("2026-03-20T04:24:07.234Z", 10, "gpt-5"))
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "09", "active-current-session.jsonl"),
		provTokenEvent("2026-05-09T04:25:07.234Z", 10, "gpt-5"))
	homes := map[string]bool{}
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		homes[call.envValue("CODEX_HOME")] = true
		if call.hasArg("daily") {
			return provJSON(t, provDailyResult), nil
		}
		return provJSON(t, `{"sessions":[]}`), nil
	}}
	snapshots, err := Collect(context.Background(), Options{
		CodexHome:   provHome(codexHome),
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-09T10:00:00.000Z",
		StateDir:    t.TempDir(),
		Runner:      runner.run,
		Env: provEnv(provForceEnv(map[string]string{
			"TOKENBOARD_SINCE": "20260508",
		})),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(homes) != 1 || homes[codexHome] {
		t.Fatalf("homes = %v", homes)
	}
	if len(runner.calls) != 3 {
		t.Fatalf("calls = %+v", runner.calls)
	}
	if !runner.calls[0].hasArg("--since") || !runner.calls[0].hasArg("20260508") {
		t.Errorf("daily args = %v", runner.calls[0].args)
	}
	if !runner.calls[1].hasArg("--since") || !runner.calls[1].hasArg("20260508") {
		t.Errorf("session args = %v", runner.calls[1].args)
	}
	if runner.calls[2].hasArg("--since") {
		t.Errorf("the canonical report must be unwindowed: %v", runner.calls[2].args)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	got := provSnapshotFor(t, snapshots, "2026-05-09", "gpt-5")
	if got.TotalTokens != 10 || got.SessionCount != 0 {
		t.Errorf("snapshot = %+v", got)
	}
}

// A home with no session files produces an empty report and runs nothing.
func TestCodexScopeReturnsAnEmptyBoundedReportWithoutSessionFiles(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	calls := []provCall{}
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		calls = append(calls, call)
		return provJSON(t, `{"sessions":[]}`), nil
	}}
	snapshots, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  t.TempDir(),
		Runner:    runner.run,
		Env:       provEnv(provForceEnv(map[string]string{"TOKENBOARD_SINCE": "20260508"})),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 0 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	if len(calls) != 0 {
		t.Fatalf("calls = %+v", calls)
	}
}

// The frozen copy must outlive the reconciliation that reads it: a scope
// cleaned up before its result is normalized would lose the session files.
func TestCodexScopeKeepsScopedFilesAvailableUntilReconciliationCompletes(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "09", "active-session.jsonl"),
		provTokenEvent("2026-05-09T04:24:07.234Z", 10, "gpt-5"))
	var checkErr error
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		scopedSession := filepath.Join(call.envValue("CODEX_HOME"), "sessions", "2026", "05", "09", "active-session.jsonl")
		if _, err := os.Stat(scopedSession); err != nil {
			checkErr = err
		}
		if call.hasArg("session") {
			return provJSON(t, provSessionResult("active-session", "")), nil
		}
		return provJSON(t, provDailyResult), nil
	}}
	snapshots, err := Collect(context.Background(), Options{
		CodexHome:   provHome(codexHome),
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-09T10:00:00.000Z",
		StateDir:    t.TempDir(),
		Runner:      runner.run,
		Env:         provEnv(provForceEnv(map[string]string{"TOKENBOARD_SINCE": "20260509"})),
	})
	if err != nil {
		t.Fatal(err)
	}
	if checkErr != nil {
		t.Fatalf("scoped file missing: %v", checkErr)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	got := provSnapshotFor(t, snapshots, "2026-05-09", "gpt-5")
	if got.TotalTokens != 10 || got.SessionCount != 1 {
		t.Errorf("snapshot = %+v", got)
	}
}

func splitCommaHomes(value string) []string {
	if value == "" {
		return nil
	}
	return strings.Split(value, ",")
}

func containsText(haystack, needle string) bool {
	return strings.Contains(haystack, needle)
}
