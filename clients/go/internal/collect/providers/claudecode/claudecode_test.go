package claudecode

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// stubRunner records the ccusage invocations and answers with canned JSON.
type stubRunner struct {
	calls     [][]string
	commands  []string
	timeouts  []int
	responses func(args []string) any
}

func (r *stubRunner) run(_ context.Context, command string, args []string, options ccusage.CommandOptions) (any, error) {
	r.calls = append(r.calls, append([]string{}, args...))
	r.commands = append(r.commands, command)
	r.timeouts = append(r.timeouts, options.TimeoutMs)
	return r.responses(args), nil
}

// dailyAndSession answers with a daily report and a session report covering
// one model on 2026-05-22.
func dailyAndSession(model string, input, output float64) func(args []string) any {
	return func(args []string) any {
		if contains(args, "session") {
			return map[string]any{"data": []any{
				map[string]any{
					"sessionId":    "s1",
					"lastActivity": "2026-05-22T02:00:00.000Z",
					"modelBreakdowns": map[string]any{
						model: map[string]any{"inputTokens": input, "outputTokens": output},
					},
				},
			}}
		}
		return map[string]any{"data": []any{
			map[string]any{
				"date": "2026-05-22",
				"breakdown": map[string]any{
					model: map[string]any{
						"inputTokens":         input,
						"outputTokens":        output,
						"cacheCreationTokens": 0,
						"cacheReadTokens":     0,
						"costUSD":             0.12,
					},
				},
			},
		}}
	}
}

// packageCommand mirrors internal/ccusage's packageCommand: the shim carries
// a .cmd suffix on Windows, where the bare name is not executable.
func packageCommand(command, platform string) string {
	if platform == "windows" {
		return command + ".cmd"
	}
	return command
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func testEnv(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func forceRunnerEnv(extra map[string]string) map[string]string {
	values := map[string]string{"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1"}
	for key, value := range extra {
		values[key] = value
	}
	return values
}

func newStateDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

func configArgs(stateDir string) []string {
	return []string{"--config", filepath.Join(stateDir, "ccusage.bundled.json")}
}

func TestCollectRunsDailyAndSessionAndNormalizes(t *testing.T) {
	stateDir := newStateDir(t)
	runner := &stubRunner{responses: dailyAndSession("claude-sonnet-4-5", 1, 2)}
	snapshots, err := Collect(context.Background(), Options{
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-04-28T10:00:00.000Z",
		StateDir:    stateDir,
		Env:         testEnv(forceRunnerEnv(nil)),
		Runner:      runner.run,
	})
	if err != nil {
		t.Fatal(err)
	}
	wantDaily := append([]string{"ccusage@20.0.33", "claude", "daily", "--json", "--breakdown", "--single-thread"}, configArgs(stateDir)...)
	wantSession := append([]string{"ccusage@20.0.33", "claude", "session", "--json", "--single-thread"}, configArgs(stateDir)...)
	if len(runner.calls) != 2 {
		t.Fatalf("calls = %v, want 2", runner.calls)
	}
	if strings.Join(runner.calls[0], "\x00") != strings.Join(wantDaily, "\x00") {
		t.Errorf("daily args = %v, want %v", runner.calls[0], wantDaily)
	}
	if strings.Join(runner.calls[1], "\x00") != strings.Join(wantSession, "\x00") {
		t.Errorf("session args = %v, want %v", runner.calls[1], wantSession)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %v", snapshots)
	}
	got := snapshots[0]
	if got.Source != contract.SourceClaudeCode || got.Model != "claude-sonnet-4-5" ||
		got.TotalTokens != 3 || got.SessionCount != 1 {
		t.Errorf("snapshot = %+v", got)
	}
}

func TestCollectUsesConfiguredSinceWindow(t *testing.T) {
	stateDir := newStateDir(t)
	runner := &stubRunner{responses: func([]string) any { return map[string]any{"data": []any{}} }}
	_, err := Collect(context.Background(), Options{
		Timezone: "UTC",
		StateDir: stateDir,
		Env: testEnv(forceRunnerEnv(map[string]string{
			"TOKENBOARD_PACKAGE_MANAGER": "npm",
			"TOKENBOARD_SINCE":           "20260509",
		})),
		Runner: runner.run,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !contains(runner.calls[0], "--since") || !contains(runner.calls[0], "20260509") {
		t.Errorf("daily args = %v", runner.calls[0])
	}
	// The package command carries the platform suffix: "npm" on POSIX,
	// "npm.cmd" on Windows (packageCommand in internal/ccusage).
	if want := packageCommand("npm", runtime.GOOS); runner.commands[0] != want {
		t.Errorf("command = %q, want %q", runner.commands[0], want)
	}
}

func TestCollectUsesDefaultSinceWhenPrimaryEmpty(t *testing.T) {
	stateDir := newStateDir(t)
	runner := &stubRunner{responses: func([]string) any { return map[string]any{"data": []any{}} }}
	_, err := Collect(context.Background(), Options{
		Timezone: "UTC",
		StateDir: stateDir,
		Env: testEnv(forceRunnerEnv(map[string]string{
			"TOKENBOARD_SINCE":         "",
			"TOKENBOARD_DEFAULT_SINCE": "20260501",
		})),
		Runner: runner.run,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, call := range runner.calls {
		if !contains(call, "20260501") {
			t.Errorf("args = %v, want the default since", call)
		}
	}
}

func TestCollectPrefersExplicitWindowOverEnvironment(t *testing.T) {
	stateDir := newStateDir(t)
	runner := &stubRunner{responses: func([]string) any { return map[string]any{"data": []any{}} }}
	_, err := Collect(context.Background(), Options{
		Timezone: "UTC",
		StateDir: stateDir,
		Since:    "20260708",
		Until:    "20260709",
		Env: testEnv(forceRunnerEnv(map[string]string{
			"TOKENBOARD_SINCE": "20260509",
			"TOKENBOARD_UNTIL": "20260510",
		})),
		Runner: runner.run,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !contains(runner.calls[0], "20260708") || !contains(runner.calls[0], "20260709") {
		t.Errorf("daily args = %v", runner.calls[0])
	}
}

func TestCollectRejectsShellMetacharactersBeforeRunning(t *testing.T) {
	stateDir := newStateDir(t)
	runner := &stubRunner{responses: func([]string) any { return map[string]any{"data": []any{}} }}
	_, err := Collect(context.Background(), Options{
		Timezone: "UTC",
		StateDir: stateDir,
		Since:    "20260708&echo injected",
		Env:      testEnv(forceRunnerEnv(nil)),
		Runner:   runner.run,
	})
	if err == nil || !strings.Contains(err.Error(), "Invalid Claude since date") {
		t.Errorf("err = %v", err)
	}
	if len(runner.calls) != 0 {
		t.Errorf("runner must not run: %v", runner.calls)
	}

	_, err = Collect(context.Background(), Options{
		Timezone: "UTC",
		StateDir: stateDir,
		Since:    "20260708",
		Env: testEnv(forceRunnerEnv(map[string]string{
			"TOKENBOARD_UNTIL": "20260708&echo injected",
		})),
		Runner: runner.run,
	})
	if err == nil || !strings.Contains(err.Error(), "Invalid Claude until date") {
		t.Errorf("err = %v", err)
	}
}

func TestCollectRejectsReversedWindow(t *testing.T) {
	stateDir := newStateDir(t)
	runner := &stubRunner{responses: func([]string) any { return map[string]any{"data": []any{}} }}
	_, err := Collect(context.Background(), Options{
		Timezone: "UTC",
		StateDir: stateDir,
		Since:    "20260709",
		Until:    "20260708",
		Env:      testEnv(forceRunnerEnv(nil)),
		Runner:   runner.run,
	})
	if err == nil || !strings.Contains(err.Error(), "since date must not be after until date") {
		t.Errorf("err = %v", err)
	}
}

func TestCollectAllowsExplicitAllScan(t *testing.T) {
	stateDir := newStateDir(t)
	runner := &stubRunner{responses: func([]string) any { return map[string]any{"data": []any{}} }}
	_, err := Collect(context.Background(), Options{
		Timezone: "UTC",
		StateDir: stateDir,
		Since:    "all",
		Env: testEnv(forceRunnerEnv(map[string]string{
			"TOKENBOARD_SINCE":         "20260708",
			"TOKENBOARD_DEFAULT_SINCE": "20260509",
		})),
		Runner: runner.run,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, call := range runner.calls {
		if contains(call, "--since") {
			t.Errorf("args = %v, want no --since", call)
		}
	}
}

func TestCollectBudgetsCcusageCommands(t *testing.T) {
	stateDir := newStateDir(t)
	runner := &stubRunner{responses: func([]string) any { return map[string]any{"data": []any{}} }}
	_, err := Collect(context.Background(), Options{
		Timezone: "UTC",
		StateDir: stateDir,
		Since:    "20260708",
		Env:      testEnv(forceRunnerEnv(nil)),
		Runner:   runner.run,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(runner.timeouts) != 2 || runner.timeouts[0] != 900_000 || runner.timeouts[1] != 900_000 {
		t.Errorf("timeouts = %v", runner.timeouts)
	}
}

func TestCollectHonoursTimeoutOverride(t *testing.T) {
	stateDir := newStateDir(t)
	runner := &stubRunner{responses: func([]string) any { return map[string]any{"data": []any{}} }}
	_, err := Collect(context.Background(), Options{
		Timezone: "UTC",
		StateDir: stateDir,
		Env: testEnv(forceRunnerEnv(map[string]string{
			"TOKENBOARD_CCUSAGE_TIMEOUT_MS": "1234",
		})),
		Runner: runner.run,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(runner.timeouts) != 2 || runner.timeouts[0] != 1234 || runner.timeouts[1] != 1234 {
		t.Errorf("timeouts = %v", runner.timeouts)
	}
}

func TestCollectPassesGeneratedDynamicPricingConfig(t *testing.T) {
	stateDir := newStateDir(t)
	runner := &stubRunner{responses: func([]string) any { return map[string]any{"data": []any{}} }}
	_, err := Collect(context.Background(), Options{
		Timezone: "UTC",
		StateDir: stateDir,
		Env: testEnv(forceRunnerEnv(map[string]string{
			"TOKENBOARD_ENDPOINT": "https://tokenboard.example/api/v1/ingest",
		})),
		Runner: runner.run,
		PricingFetcher: func(*http.Request) (*http.Response, error) {
			body := `{"models":[{"provider":"anthropic","modelId":"claude-fable-5-1",` +
				`"inputCostPerMillion":10,"outputCostPerMillion":50,"cacheReadCostPerMillion":1,` +
				`"cacheWriteCostPerMillion":12.5,"contextWindow":1000000,"maxInputTokens":1000000,"pricing":{}}],` +
				`"nextCursor":null}`
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(body)),
				Header:     http.Header{},
			}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(stateDir, "ccusage.dynamic.json")
	for _, call := range runner.calls {
		if !contains(call, "--config") || !contains(call, want) {
			t.Errorf("args = %v, want --config %s", call, want)
		}
	}
}

func TestCollectPassesBundledConfigWithoutEndpoint(t *testing.T) {
	stateDir := newStateDir(t)
	runner := &stubRunner{responses: func([]string) any { return map[string]any{"data": []any{}} }}
	_, err := Collect(context.Background(), Options{
		Timezone: "UTC",
		StateDir: stateDir,
		Env:      testEnv(forceRunnerEnv(map[string]string{"TOKENBOARD_ENDPOINT": ""})),
		Runner:   runner.run,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(stateDir, "ccusage.bundled.json")
	if len(runner.calls) != 2 {
		t.Fatalf("calls = %v", runner.calls)
	}
	for _, call := range runner.calls {
		if !contains(call, want) {
			t.Errorf("args = %v, want bundled config %s", call, want)
		}
	}
}

// hookFixture writes one Claude session file and returns the home plus state
// directory.
func hookFixture(t *testing.T, rows ...string) (claudeHome, stateDir, sessionFile string) {
	t.Helper()
	root := t.TempDir()
	claudeHome = filepath.Join(root, "claude")
	stateDir = filepath.Join(root, "state")
	sessionFile = filepath.Join(claudeHome, "projects", "project-a", "session.jsonl")
	if err := os.MkdirAll(filepath.Dir(sessionFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	content := strings.Join(rows, "\n") + "\n"
	if err := os.WriteFile(sessionFile, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return claudeHome, stateDir, sessionFile
}

func claudeUsageRow(timestamp, model string, input, output int, cost *float64) string {
	row := map[string]any{
		"type":      "assistant",
		"timestamp": timestamp,
		"message": map[string]any{
			"model": model,
			"usage": map[string]any{
				"input_tokens":  input,
				"output_tokens": output,
			},
		},
	}
	if cost != nil {
		row["costUSD"] = *cost
	}
	encoded, _ := json.Marshal(row)
	return string(encoded)
}

func floatPtr(value float64) *float64 { return &value }

func TestHookModeUsesChangedFilesToNarrowReconciliation(t *testing.T) {
	cost := 0.12
	claudeHome, stateDir, _ := hookFixture(t,
		claudeUsageRow("2026-05-22T02:00:00.000Z", "claude-sonnet-4-5", 8, 13, &cost))
	runner := &stubRunner{responses: dailyAndSession("claude-sonnet-4-5", 16, 26)}
	snapshots, err := Collect(context.Background(), Options{
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		StateDir:    stateDir,
		Since:       "all",
		Env: testEnv(forceRunnerEnv(map[string]string{
			"TOKENBOARD_HOOK_MODE": "1",
			"CLAUDE_CONFIG_DIR":    claudeHome,
			"TOKENBOARD_STATE_DIR": stateDir,
		})),
		Runner: runner.run,
	})
	if err != nil {
		t.Fatal(err)
	}
	wantDaily := append([]string{
		"ccusage@20.0.33", "claude", "daily", "--json", "--breakdown", "--single-thread",
		"--since", "20260522", "--until", "20260522", "--timezone", "Asia/Shanghai",
	}, configArgs(stateDir)...)
	if len(runner.calls) != 2 {
		t.Fatalf("calls = %v", runner.calls)
	}
	if strings.Join(runner.calls[0], "\x00") != strings.Join(wantDaily, "\x00") {
		t.Errorf("daily args = %v, want %v", runner.calls[0], wantDaily)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %v", snapshots)
	}
	if snapshots[0].TotalTokens != 42 || snapshots[0].CostUSD != 0.12 || snapshots[0].SessionCount != 1 {
		t.Errorf("snapshot = %+v", snapshots[0])
	}
}

func TestHookModeUsesClaudeHomeWhenConfigDirUnset(t *testing.T) {
	cost := 0.12
	claudeHome, stateDir, _ := hookFixture(t,
		claudeUsageRow("2026-05-22T02:00:00.000Z", "claude-sonnet-4-5", 8, 13, &cost))
	runner := &stubRunner{responses: dailyAndSession("claude-sonnet-4-5", 8, 13)}
	_, err := Collect(context.Background(), Options{
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		StateDir:    stateDir,
		Env: testEnv(forceRunnerEnv(map[string]string{
			"TOKENBOARD_HOOK_MODE": "1",
			"CLAUDE_HOME":          claudeHome,
			"CLAUDE_CONFIG_DIR":    "",
			"TOKENBOARD_STATE_DIR": stateDir,
		})),
		Runner: runner.run,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 2 {
		t.Fatalf("calls = %v", runner.calls)
	}
	if !contains(runner.calls[0], "20260522") {
		t.Errorf("daily args = %v", runner.calls[0])
	}
}

func TestHookModeReconcilesWhenParsedCostIsMissing(t *testing.T) {
	claudeHome, stateDir, _ := hookFixture(t,
		claudeUsageRow("2026-05-22T02:00:00.000Z", "claude-sonnet-4-5", 8, 13, nil))
	runner := &stubRunner{responses: dailyAndSession("claude-sonnet-4-5", 8, 13)}
	snapshots, err := Collect(context.Background(), Options{
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		StateDir:    stateDir,
		Env: testEnv(forceRunnerEnv(map[string]string{
			"TOKENBOARD_HOOK_MODE": "1",
			"CLAUDE_CONFIG_DIR":    claudeHome,
		})),
		Runner: runner.run,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 || snapshots[0].CostUSD != 0.12 {
		t.Errorf("snapshots = %+v", snapshots)
	}
}

func TestHookModeIgnoresSyntheticZeroUsageRows(t *testing.T) {
	synthetic := `{"type":"assistant","timestamp":"2026-05-22T02:00:00.000Z",` +
		`"message":{"model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0,` +
		`"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"total_tokens":0}}}`
	cost := 0.12
	claudeHome, stateDir, _ := hookFixture(t, synthetic,
		claudeUsageRow("2026-05-22T03:00:00.000Z", "claude-haiku-4-5", 8, 13, &cost))
	runner := &stubRunner{responses: dailyAndSession("claude-haiku-4-5", 8, 13)}
	snapshots, err := Collect(context.Background(), Options{
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		StateDir:    stateDir,
		Env: testEnv(forceRunnerEnv(map[string]string{
			"TOKENBOARD_HOOK_MODE": "1",
			"CLAUDE_CONFIG_DIR":    claudeHome,
		})),
		Runner: runner.run,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 || snapshots[0].Model != "claude-haiku-4-5" {
		t.Errorf("snapshots = %+v", snapshots)
	}
}

func TestHookModeFailsWhenReconciliationHasNoSnapshots(t *testing.T) {
	cost := 0.12
	claudeHome, stateDir, _ := hookFixture(t,
		claudeUsageRow("2026-05-22T02:00:00.000Z", "claude-sonnet-4-5", 8, 13, &cost))
	runner := &stubRunner{responses: func([]string) any { return map[string]any{"data": []any{}} }}
	_, err := Collect(context.Background(), Options{
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		StateDir:    stateDir,
		Env: testEnv(forceRunnerEnv(map[string]string{
			"TOKENBOARD_HOOK_MODE": "1",
			"CLAUDE_CONFIG_DIR":    claudeHome,
		})),
		Runner: runner.run,
	})
	if err == nil || !strings.Contains(err.Error(), "Claude hook reconciliation returned no snapshots") {
		t.Fatalf("err = %v", err)
	}
	cursor, readErr := sessioncursor.Read(filepath.Join(stateDir, CursorName), "claude-code")
	if readErr != nil {
		t.Fatal(readErr)
	}
	entry, ok := cursor.Files["project-a/session.jsonl"]
	if !ok || entry.PendingUpload == nil || !*entry.PendingUpload {
		t.Errorf("pending upload must survive the failed reconciliation: %+v", entry)
	}
}

func TestHookModeSkipsCcusageWhenNothingChanged(t *testing.T) {
	claudeHome, stateDir, _ := hookFixture(t,
		claudeUsageRow("2026-05-22T02:00:00.000Z", "claude-sonnet-4-5", 8, 13, floatPtr(0.12)))
	runner := &stubRunner{responses: dailyAndSession("claude-sonnet-4-5", 8, 13)}
	env := forceRunnerEnv(map[string]string{
		"TOKENBOARD_HOOK_MODE": "1",
		"CLAUDE_CONFIG_DIR":    claudeHome,
	})
	first, err := Collect(context.Background(), Options{
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		StateDir:    stateDir,
		Env:         testEnv(env),
		Runner:      runner.run,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 1 {
		t.Fatalf("first run snapshots = %v", first)
	}
	// The CLI acknowledges the cursor after a successful upload; until then a
	// pending entry is deliberately re-read on every hook run.
	groups := map[string]bool{}
	for _, snapshot := range first {
		groups[snapshot.AckGroupKey()] = true
	}
	if err := sessioncursor.AcknowledgePendingUploads(sessioncursor.AcknowledgeInput{
		StateDir:           stateDir,
		Source:             "claude-code",
		AcknowledgedGroups: groups,
	}); err != nil {
		t.Fatal(err)
	}
	callsAfterFirst := len(runner.calls)
	second, err := Collect(context.Background(), Options{
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:05:00.000Z",
		StateDir:    stateDir,
		Env:         testEnv(env),
		Runner:      runner.run,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 0 {
		t.Errorf("unchanged run must return no snapshots: %v", second)
	}
	if len(runner.calls) != callsAfterFirst {
		t.Errorf("unchanged run must not call ccusage: %v", runner.calls)
	}
}

func TestHookModeNeverDownloadsCcusage(t *testing.T) {
	_, stateDir, _ := hookFixture(t,
		claudeUsageRow("2026-05-22T02:00:00.000Z", "claude-sonnet-4-5", 8, 13, floatPtr(0.12)))
	runner := &stubRunner{responses: dailyAndSession("claude-sonnet-4-5", 8, 13)}
	_, err := Collect(context.Background(), Options{
		Timezone: "Asia/Shanghai",
		StateDir: stateDir,
		Env: testEnv(map[string]string{
			"TOKENBOARD_HOOK_MODE": "1",
			"CLAUDE_CONFIG_DIR":    filepath.Dir(stateDir),
		}),
		Runner: runner.run,
		ResolveBinary: func(ccusage.AcquireOptions) (ccusage.Binary, error) {
			return ccusage.Binary{}, os.ErrNotExist
		},
	})
	if err == nil || !strings.Contains(err.Error(), "not exist") {
		t.Fatalf("hook mode must fail closed without a binary: %v", err)
	}
	if len(runner.calls) != 0 {
		t.Errorf("runner must not run: %v", runner.calls)
	}
}

func TestCollectReportsUnpricedModelsOnce(t *testing.T) {
	stateDir := newStateDir(t)
	runner := &stubRunner{responses: func(args []string) any {
		if contains(args, "session") {
			return map[string]any{"data": []any{}}
		}
		return map[string]any{"data": []any{
			map[string]any{"date": "2026-05-22", "breakdown": map[string]any{
				"mystery-model": map[string]any{
					"inputTokens": 1, "outputTokens": 2, "totalTokens": 3, "costUSD": 0,
				},
			}},
			map[string]any{"date": "2026-05-23", "breakdown": map[string]any{
				"mystery-model": map[string]any{
					"inputTokens": 1, "outputTokens": 2, "totalTokens": 3, "costUSD": 0,
				},
			}},
		}}
	}}
	lines := []string{}
	_, err := Collect(context.Background(), Options{
		Timezone: "UTC",
		StateDir: stateDir,
		Env:      testEnv(forceRunnerEnv(nil)),
		Runner:   runner.run,
		Stderr:   func(line string) { lines = append(lines, line) },
	})
	if err != nil {
		t.Fatal(err)
	}
	matches := 0
	for _, line := range lines {
		if strings.Contains(line, "TokenBoard model pricing unavailable for Claude Code model mystery-model") {
			matches++
		}
	}
	if matches != 1 {
		t.Errorf("unpriced diagnostics = %v", lines)
	}
}

// ccusage prices models from its own builtin catalogue, so a model missing from the
// TokenBoard override set still arrives with a real cost. Warning about it buried the
// log: on one machine 43-44 models per run, all priced, 1666 lines in a rotated stderr.
// The warning only carries information when the cost actually came back as zero.
func TestCollectStaysQuietAboutModelsCcusagePricedItself(t *testing.T) {
	stateDir := newStateDir(t)
	runner := &stubRunner{responses: func(args []string) any {
		if contains(args, "session") {
			return map[string]any{"data": []any{}}
		}
		return map[string]any{"data": []any{
			map[string]any{"date": "2026-05-22", "breakdown": map[string]any{
				"ccusage-priced-model": map[string]any{
					"inputTokens": 10, "outputTokens": 2, "totalTokens": 12, "costUSD": 0.25,
				},
			}},
		}}
	}}
	lines := []string{}
	_, err := Collect(context.Background(), Options{
		Timezone: "UTC",
		StateDir: stateDir,
		Env:      testEnv(forceRunnerEnv(nil)),
		Runner:   runner.run,
		Stderr:   func(line string) { lines = append(lines, line) },
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range lines {
		if strings.Contains(line, "model pricing unavailable") {
			t.Errorf("a model ccusage priced itself must not be reported as unpriced: %v", lines)
		}
	}
}

// Ports hook-oversized-jsonl.test.ts "lets the Claude hook advance past an
// oversized assistant row without a usage object": the row is dropped with a
// content-free diagnostic, the cursor records the file, and a second hook run
// neither re-reads the file nor repeats the diagnostic.
func TestHookModeAdvancesPastOversizedAssistantRowWithoutUsage(t *testing.T) {
	root := t.TempDir()
	claudeHome := filepath.Join(root, "claude")
	stateDir := filepath.Join(root, "state")
	sessionFile := filepath.Join(claudeHome, "projects", "project-a", "oversized.jsonl")
	if err := os.MkdirAll(filepath.Dir(sessionFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	oversized := `{"type":"assistant","timestamp":"2026-05-22T02:00:00.000Z","message":{"content":"` +
		strings.Repeat("x", 1024*1024+64) + `"}}`
	if err := os.WriteFile(sessionFile, []byte(oversized+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var warnings []string
	runner := &stubRunner{responses: func([]string) any {
		t.Error("ccusage must not run when no usage rows changed")
		return map[string]any{"data": []any{}}
	}}
	options := Options{
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		StateDir:    stateDir,
		Env: testEnv(forceRunnerEnv(map[string]string{
			"TOKENBOARD_HOOK_MODE": "1",
			"CLAUDE_CONFIG_DIR":    claudeHome,
			"TOKENBOARD_STATE_DIR": stateDir,
		})),
		Runner: runner.run,
		Stderr: func(line string) { warnings = append(warnings, line) },
	}
	snapshots, err := Collect(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 0 {
		t.Fatalf("snapshots = %v, want none", snapshots)
	}
	want := fmt.Sprintf(
		"Skipped 1 oversized claude-code session JSONL row without token or usage metadata (largest %d bytes)",
		len(oversized))
	if len(warnings) != 1 || warnings[0] != want {
		t.Fatalf("warnings = %q, want [%q]", warnings, want)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("ccusage calls = %v, want none", runner.calls)
	}

	cursor, err := sessioncursor.Read(filepath.Join(stateDir, CursorName), "claude-code")
	if err != nil {
		t.Fatal(err)
	}
	entry, ok := cursor.Files["project-a/oversized.jsonl"]
	if !ok {
		t.Fatalf("cursor entries = %v, want project-a/oversized.jsonl", cursor.Files)
	}
	if entry.Size != float64(len(oversized)+1) {
		t.Errorf("size = %v, want %d", entry.Size, len(oversized)+1)
	}
	if len(entry.Snapshots) != 0 {
		t.Errorf("snapshots = %v, want none", entry.Snapshots)
	}
	if entry.PendingUpload != nil {
		t.Errorf("pendingUpload = %v, want absent", *entry.PendingUpload)
	}

	options.CollectedAt = "2026-05-22T10:05:00.000Z"
	second, err := Collect(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 0 {
		t.Fatalf("second run snapshots = %v, want none", second)
	}
	if len(warnings) != 1 {
		t.Errorf("second run repeated the diagnostic: %q", warnings)
	}
}

// Ports the cursor half of hook-oversized-jsonl.test.ts cases 2 and 3: a row
// the reader cannot prove is non-usage-bearing fails the hook before the
// cursor is committed, so the next run reads the same bytes again instead of
// recording them as parsed.
func TestHookModeDoesNotCommitCursorForUnreadableOversizedRows(t *testing.T) {
	invalidUTF8 := append([]byte(`{"type":"response_item","payload":"`), 0xc3, 0x28)
	invalidUTF8 = append(invalidUTF8, []byte(`"}`)...)
	cases := []struct {
		name      string
		row       []byte
		wantError string
	}{
		{
			name: "usage metadata after the line limit",
			row: []byte(`{"type":"assistant","timestamp":"2026-05-22T02:00:00.000Z","padding":"` +
				strings.Repeat("x", 1024*1024+64) + `","message":{"usage":{"input_tokens":1}}}`),
			wantError: "Session JSONL contains an oversized line with token or usage metadata",
		},
		{
			name:      "invalid UTF-8 in a short row",
			row:       invalidUTF8,
			wantError: "Session JSONL contains invalid UTF-8",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			root := t.TempDir()
			claudeHome := filepath.Join(root, "claude")
			stateDir := filepath.Join(root, "state")
			sessionFile := filepath.Join(claudeHome, "projects", "project-a", "oversized.jsonl")
			if err := os.MkdirAll(filepath.Dir(sessionFile), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(stateDir, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(sessionFile, append(append([]byte{}, testCase.row...), '\n'), 0o600); err != nil {
				t.Fatal(err)
			}

			runner := &stubRunner{responses: func([]string) any {
				t.Error("ccusage must not run when the session file cannot be read")
				return map[string]any{"data": []any{}}
			}}
			_, err := Collect(context.Background(), Options{
				Timezone:    "Asia/Shanghai",
				CollectedAt: "2026-05-22T10:00:00.000Z",
				StateDir:    stateDir,
				Env: testEnv(forceRunnerEnv(map[string]string{
					"TOKENBOARD_HOOK_MODE": "1",
					"CLAUDE_CONFIG_DIR":    claudeHome,
					"TOKENBOARD_STATE_DIR": stateDir,
				})),
				Runner: runner.run,
			})
			if err == nil || !strings.Contains(err.Error(), testCase.wantError) {
				t.Fatalf("err = %v, want %q", err, testCase.wantError)
			}
			if len(runner.calls) != 0 {
				t.Errorf("ccusage calls = %v, want none", runner.calls)
			}
			cursorPath := filepath.Join(stateDir, CursorName)
			if _, statErr := os.Stat(cursorPath); !os.IsNotExist(statErr) {
				t.Fatalf("cursor %s must not be committed, stat error = %v", cursorPath, statErr)
			}
		})
	}
}

var _ = time.Now

// Non-hook mode keeps the TS fallback: a machine with no bundled binary still
// reaches ccusage through the package runner, and the reason is logged once.
func TestCollectFallsBackToPackageRunnerOutsideHookMode(t *testing.T) {
	stateDir := newStateDir(t)
	runner := &stubRunner{responses: dailyAndSession("claude-sonnet-4-5", 1, 2)}
	lines := []string{}
	snapshots, err := Collect(context.Background(), Options{
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-04-28T10:00:00.000Z",
		StateDir:    stateDir,
		Env:         testEnv(map[string]string{"TOKENBOARD_PACKAGE_MANAGER": "pnpm"}),
		Runner:      runner.run,
		Stderr:      func(line string) { lines = append(lines, line) },
		ResolveBinary: func(ccusage.AcquireOptions) (ccusage.Binary, error) {
			return ccusage.Binary{}, os.ErrNotExist
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 {
		t.Errorf("snapshots = %+v", snapshots)
	}
	if len(runner.commands) == 0 || !strings.HasSuffix(runner.commands[0], packageCommand("pnpm", runtime.GOOS)) {
		t.Errorf("commands = %v, want the pnpm package runner", runner.commands)
	}
	fallbackLines := 0
	for _, line := range lines {
		if strings.Contains(line, "falling back to the package runner") {
			fallbackLines++
		}
	}
	if fallbackLines != 1 {
		t.Errorf("fallback diagnostic = %v", lines)
	}
}

// A missing explicit pricing config fails closed before ccusage runs: the TS
// readOptionalJsonConfig lets the read error propagate, and so does the Go
// prepare step.
func TestCollectRejectsAMissingExplicitPricingConfig(t *testing.T) {
	stateDir := newStateDir(t)
	missing := filepath.Join(stateDir, "absent.json")
	runner := &stubRunner{responses: dailyAndSession("claude-sonnet-4-5", 1, 2)}
	_, err := Collect(context.Background(), Options{
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-04-28T10:00:00.000Z",
		StateDir:    stateDir,
		Env: testEnv(forceRunnerEnv(map[string]string{
			"TOKENBOARD_CCUSAGE_CONFIG": missing,
		})),
		Runner: runner.run,
	})
	if err == nil {
		t.Fatal("missing explicit config must fail closed")
	}
	if len(runner.calls) != 0 {
		t.Errorf("runner must not run: %v", runner.calls)
	}
}
