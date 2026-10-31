package codex

import (
	"bytes"
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

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Port of codex.test.ts (minus the context-pricing reconciliation cases that
// provider_pricing_test.go already covers at the layer that owns the
// semantics): the provider orchestration around ccusage — argument assembly,
// the frozen session scopes, canonical attribution and the retry matrix — all
// driven through Collect().

// provCall is one recorded ccusage invocation.
type provCall struct {
	command string
	args    []string
	env     map[string]string
	timeout int
}

func (c provCall) hasArg(value string) bool {
	for _, arg := range c.args {
		if arg == value {
			return true
		}
	}
	return false
}

func (c provCall) envValue(key string) string { return c.env[key] }

// provStubRunner is the fake ccusage runner: it records the invocation and
// answers through the test's responder.
type provStubRunner struct {
	t       *testing.T
	calls   []provCall
	respond func(call provCall) (any, error)
}

func (r *provStubRunner) run(
	_ context.Context, command string, args []string, options ccusage.CommandOptions,
) (any, error) {
	r.t.Helper()
	call := provCall{
		command: command,
		args:    append([]string{}, args...),
		env:     provEnvMap(options.Env),
		timeout: options.TimeoutMs,
	}
	r.calls = append(r.calls, call)
	if r.respond == nil {
		r.t.Fatalf("unexpected ccusage call: %s %v", command, args)
	}
	value, err := r.respond(call)
	if err != nil {
		return nil, err
	}
	return ccusage.DecodeJSONValue(value)
}

// callsWith returns the recorded calls whose args contain value.
func (r *provStubRunner) callsWith(value string) []provCall {
	out := []provCall{}
	for _, call := range r.calls {
		if call.hasArg(value) {
			out = append(out, call)
		}
	}
	return out
}

// callsWithout returns the recorded calls whose args do not contain value.
func (r *provStubRunner) callsWithout(value string) []provCall {
	out := []provCall{}
	for _, call := range r.calls {
		if !call.hasArg(value) {
			out = append(out, call)
		}
	}
	return out
}

func provEnvMap(env []string) map[string]string {
	out := map[string]string{}
	for _, entry := range env {
		index := strings.Index(entry, "=")
		if index > 0 {
			out[entry[:index]] = entry[index+1:]
		}
	}
	return out
}

// provJSON decodes a fixture with document order preserved, the way the real
// runner's JSON.parse keeps ccusage's field order.
func provJSON(t *testing.T, text string) any {
	t.Helper()
	value, err := ccusage.DecodeJSON([]byte(text))
	if err != nil {
		t.Fatalf("decode fixture: %v\n%s", err, text)
	}
	return value
}

// provEnv builds the injected environment.
func provEnv(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

// provForceEnv is forceRunnerEnv plus the ts suite's usual blanks.
func provForceEnv(extra map[string]string) map[string]string {
	values := map[string]string{
		"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
	}
	for key, value := range extra {
		values[key] = value
	}
	return values
}

// provPlatformCommand is the TS platformCommand helper.
func provPlatformCommand(command string) string {
	if runtime.GOOS == "windows" {
		return command + ".cmd"
	}
	return command
}

// provConfigArgs is the --config pair every invocation carries. The Go client
// materializes the bundled ccusage config into the state directory instead of
// reading it from the collector package, so the path comes from there.
func provConfigArgs(stateDir string) []string {
	return []string{"--config", filepath.Join(stateDir, "ccusage.bundled.json")}
}

// provEmptyCodexHome ports createEmptyCodexHome.
func provEmptyCodexHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "sessions"), 0o700); err != nil {
		t.Fatal(err)
	}
	return home
}

// provHome is the single-home option.
func provHome(home string) *string { return &home }

// provWriteJSONL ports writeJsonl: compact JSON rows, one per line, trailing
// newline.
func provWriteJSONL(t *testing.T, path string, rows ...map[string]any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	var builder strings.Builder
	for _, row := range rows {
		encoded, err := json.Marshal(row)
		if err != nil {
			t.Fatalf("marshal row: %v", err)
		}
		builder.Write(encoded)
		builder.WriteByte('\n')
	}
	if err := os.WriteFile(path, []byte(builder.String()), 0o600); err != nil {
		t.Fatal(err)
	}
}

// provAppendRaw appends raw bytes, the way the TS suite's appendFile does.
func provAppendRaw(t *testing.T, path, text string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = file.Close() }()
	if _, err := file.WriteString(text); err != nil {
		t.Fatal(err)
	}
}

// provAppendJSONL appends one row with a trailing newline.
func provAppendJSONL(t *testing.T, path string, row map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(row)
	if err != nil {
		t.Fatalf("marshal row: %v", err)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = file.Close() }()
	if _, err := file.Write(append(encoded, '\n')); err != nil {
		t.Fatal(err)
	}
}

// provTokenEvent ports the suite's tokenCountEvent helper. An empty model
// omits the field, which is the TS helper's `model: null`.
func provTokenEvent(timestamp string, totalTokens int, model string) map[string]any {
	info := map[string]any{}
	if model != "" {
		info["model"] = model
	}
	info["last_token_usage"] = map[string]any{
		"input_tokens":  totalTokens,
		"output_tokens": 0,
		"total_tokens":  totalTokens,
	}
	return map[string]any{
		"type":      "event_msg",
		"timestamp": timestamp,
		"payload":   map[string]any{"type": "token_count", "info": info},
	}
}

// provTokenEventWithCost is the hook-race suite's tokenCountEvent: input plus
// output tokens, and a self-reported cost.
func provTokenEventWithCost(timestamp string, inputTokens, outputTokens int, costUsd float64) map[string]any {
	return map[string]any{
		"type":      "event_msg",
		"timestamp": timestamp,
		"payload": map[string]any{
			"type": "token_count",
			"info": map[string]any{
				"model": "gpt-5",
				"last_token_usage": map[string]any{
					"input_tokens":  inputTokens,
					"output_tokens": outputTokens,
					"total_tokens":  inputTokens + outputTokens,
					"cost_usd":      costUsd,
				},
			},
		},
	}
}

// provTurnContext is a turn_context record naming the model of the turns that
// follow it.
func provTurnContext(model string) map[string]any {
	return map[string]any{"type": "turn_context", "payload": map[string]any{"model": model}}
}

// provSnapshotFor finds the snapshot for one date and model.
func provSnapshotFor(t *testing.T, snapshots []contract.Snapshot, date, model string) contract.Snapshot {
	t.Helper()
	for _, snapshot := range snapshots {
		if snapshot.UsageDate == date && snapshot.Model == model {
			return snapshot
		}
	}
	t.Fatalf("no snapshot for %s/%s in %+v", date, model, snapshots)
	return contract.Snapshot{}
}

// provHasSnapshot reports whether a (date, model) row is present.
func provHasSnapshot(snapshots []contract.Snapshot, date, model string) bool {
	for _, snapshot := range snapshots {
		if snapshot.UsageDate == date && snapshot.Model == model {
			return true
		}
	}
	return false
}

// provAssertArgs compares two argument vectors exactly.
func provAssertArgs(t *testing.T, got, want []string) {
	t.Helper()
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("args = %v, want %v", got, want)
	}
}

// provAssertArgsContain checks that every wanted pair appears in order.
func provAssertArgsContain(t *testing.T, got, want []string) {
	t.Helper()
	position := 0
	for _, value := range got {
		if position < len(want) && value == want[position] {
			position++
		}
	}
	if position != len(want) {
		t.Fatalf("args = %v, want it to contain %v in order", got, want)
	}
}

// provSessionCountsByDateAndModel ports sessionCountsByDateAndModel: the
// (date, model) → sessionCount projection the TS suite compares.
func provSessionCountsByDateAndModel(snapshots []contract.Snapshot) map[string]int64 {
	out := map[string]int64{}
	for _, snapshot := range snapshots {
		out[snapshot.UsageDate+"\x00"+snapshot.Model] = snapshot.SessionCount
	}
	return out
}

func provAssertStringSet(t *testing.T, got map[string]int64, want map[string]int64) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("counts = %+v, want %+v", got, want)
	}
	for key, value := range want {
		actual, ok := got[key]
		if !ok || actual != value {
			t.Fatalf("counts = %+v, want %+v (key %q)", got, want, key)
		}
	}
}

// provCollect runs Collect with the forced package runner and a private state
// directory unless the test set one.
func provCollect(t *testing.T, options Options, extraEnv map[string]string) ([]contract.Snapshot, error) {
	t.Helper()
	if options.StateDir == "" {
		options.StateDir = t.TempDir()
	}
	if options.Env == nil {
		options.Env = provEnv(provForceEnv(extraEnv))
	}
	return Collect(context.Background(), options)
}

func TestProviderRejectsRelativeExplicitCodexSymlinkRootsBeforeCollection(t *testing.T) {
	runner := &provStubRunner{t: t, respond: func(provCall) (any, error) {
		return nil, fmt.Errorf("runner should not be called")
	}}
	_, err := provCollect(t, Options{
		CodexSymlinkRoots: []string{"relative/session-root"},
		Timezone:          "UTC",
		Since:             "all",
		Runner:            runner.run,
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "Invalid Codex symlink roots: expected absolute paths") {
		t.Fatalf("err = %v", err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("runner should not be called: %v", runner.calls)
	}
}

func TestProviderRunsCodexCcusageDailyJSONAndNormalizesCacheInputAliases(t *testing.T) {
	stateDir := t.TempDir()
	codexHome := provEmptyCodexHome(t)
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("session") {
			return provJSON(t, `{"data":[{"sessionId":"s1","lastActivity":"Apr 28, 2026","models":{
				"gpt-5":{"inputTokens":1,"outputTokens":2,"cachedInputTokens":4}}}]}`), nil
		}
		return provJSON(t, `{"data":[{"date":"2026-04-28","models":["gpt-5"],
			"inputTokens":1,"outputTokens":2,"cacheCreationInputTokens":3,"cacheReadInputTokens":4,"costUSD":0.01}]}`), nil
	}}
	snapshots, err := provCollect(t, Options{
		CodexHome:   provHome(codexHome),
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-04-28T10:00:00.000Z",
		StateDir:    stateDir,
		Runner:      runner.run,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}

	if len(runner.calls) != 2 {
		t.Fatalf("calls = %v", runner.calls)
	}
	configArgs := provConfigArgs(stateDir)
	provAssertArgs(t, runner.calls[0].args, append([]string{
		"ccusage@20.0.33", "codex", "daily", "--json", "--offline", "--timezone", "Asia/Shanghai",
	}, configArgs...))
	provAssertArgs(t, runner.calls[1].args, append([]string{
		"ccusage@20.0.33", "codex", "session", "--json", "--offline", "--timezone", "Asia/Shanghai",
	}, configArgs...))
	if runner.calls[0].command != provPlatformCommand("npx") {
		t.Errorf("command = %q", runner.calls[0].command)
	}

	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	got := snapshots[0]
	if got.Source != contract.SourceCodex || got.Model != "gpt-5" || got.CacheCreation != 3 ||
		got.CacheRead != 4 || got.TotalTokens != 10 || got.SessionCount != 1 {
		t.Errorf("snapshot = %+v", got)
	}
}

func TestProviderPassesTheBundledPricingConfigWithoutAnEndpoint(t *testing.T) {
	stateDir := t.TempDir()
	codexHome := provEmptyCodexHome(t)
	runner := &provStubRunner{t: t, respond: func(provCall) (any, error) {
		return provJSON(t, `{"data":[]}`), nil
	}}
	_, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  stateDir,
		Env: provEnv(map[string]string{
			"TOKENBOARD_ENDPOINT":             "",
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
		}),
		Runner: runner.run,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 2 {
		t.Fatalf("calls = %v", runner.calls)
	}
	configPath := provConfigArgs(stateDir)[1]
	for _, call := range runner.calls {
		if !call.hasArg("--config") {
			t.Errorf("missing --config in %v", call.args)
		}
		if !call.hasArg(configPath) {
			t.Errorf("missing bundled config %q in %v", configPath, call.args)
		}
	}
}

// Two Codex homes can hold the same relative session path. The daily rows are
// per model, so each profile's file must keep its own canonical attribution
// instead of both collapsing onto the first profile's model.
func TestProviderKeepsContextPricingAttributionSeparateForDuplicateSessionPathsAcrossCodexHomes(t *testing.T) {
	root := t.TempDir()
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	relativePath := filepath.Join("2026", "05", "20", "same.jsonl")
	canonicalModels := []string{"gpt-5.6-" + "luna", "gpt-5.6-" + "terra"}
	tokenEvent := provTokenEvent("2026-05-01T00:00:00.000Z", 10, "gpt-5.6")
	stateDir := t.TempDir()

	provWriteJSONL(t, filepath.Join(firstHome, "sessions", relativePath), tokenEvent)
	provWriteJSONL(t, filepath.Join(secondHome, "sessions", relativePath), tokenEvent)

	dailyJSON := `{"data":[{"date":"2026-05-01","breakdown":{
		"gpt-5.6-luna":{"inputTokens":10,"outputTokens":0,"totalTokens":10,"costUSD":0.01},
		"gpt-5.6-terra":{"inputTokens":10,"outputTokens":0,"totalTokens":10,"costUSD":0.01}}}]}`
	combinedHome := strings.Join([]string{firstHome, secondHome}, ",")

	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		codexHome := call.envValue("CODEX_HOME")
		if call.hasArg("daily") {
			return provJSON(t, dailyJSON), nil
		}
		row := func(model string) string {
			return `{"directory":"2026/05/20","sessionFile":"same","lastActivity":"2026-05-01T00:00:00.000Z",
				"models":{"` + model + `":{"inputTokens":10,"outputTokens":0,"totalTokens":10}}}`
		}
		if codexHome == combinedHome {
			return provJSON(t, `{"sessions":[`+row(canonicalModels[0])+`,`+row(canonicalModels[1])+`]}`), nil
		}
		homeIndex := -1
		if codexHome == firstHome {
			homeIndex = 0
		} else if codexHome == secondHome {
			homeIndex = 1
		}
		if homeIndex < 0 {
			return nil, fmt.Errorf("Unexpected Codex home: %s", codexHome)
		}
		return provJSON(t, `{"sessions":[`+row(canonicalModels[homeIndex])+`]}`), nil
	}}

	snapshots, err := provCollect(t, Options{
		CodexHomes:  []string{firstHome, secondHome},
		Timezone:    "UTC",
		CollectedAt: "2026-05-02T00:00:00.000Z",
		StateDir:    stateDir,
		Runner:      runner.run,
	}, map[string]string{
		"TOKENBOARD_SINCE":         "",
		"TOKENBOARD_DEFAULT_SINCE": "",
		"TOKENBOARD_UNTIL":         "",
	})
	if err != nil {
		t.Fatal(err)
	}

	if len(runner.callsWith("session")) != 3 {
		t.Fatalf("session calls = %v", runner.callsWith("session"))
	}
	if len(snapshots) != 2 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	first := provSnapshotFor(t, snapshots, "2026-05-01", canonicalModels[0])
	if first.TotalTokens != 10 || first.SessionCount != 1 {
		t.Errorf("first = %+v", first)
	}
	assertCloseTo(t, first.CostUSD, 10*0.2/1_000_000, 14)
	second := provSnapshotFor(t, snapshots, "2026-05-01", canonicalModels[1])
	if second.TotalTokens != 10 || second.SessionCount != 1 {
		t.Errorf("second = %+v", second)
	}
	assertCloseTo(t, second.CostUSD, 10*2.0/1_000_000, 14)
}

// A session file that names the context model explicitly attributes those
// tokens to it even without a turn_context record, and the canonical row it
// came from is emptied and marked corrected.
func TestProviderPricesAnExplicitlyNamedContextRowWithoutATurnContextRecord(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	sessionPath := filepath.Join(codexHome, "sessions", "2026", "05", "20", "explicit-context.jsonl")
	provWriteJSONL(t, sessionPath, provTokenEvent("2026-05-20T00:01:00.000Z", 20, "gpt-5.6-sol"))

	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("daily") {
			return provJSON(t, `{"data":[{"date":"2026-05-20","models":{
				"deepseek-v4-flash":{"inputTokens":20,"outputTokens":0,"cacheCreationInputTokens":0,
				"cacheReadInputTokens":0,"totalTokens":20,"costUSD":0.001}}}]}`), nil
		}
		if call.hasArg("session") {
			return provJSON(t, `{"sessions":[{"directory":"2026/05/20","sessionFile":"explicit-context",
				"lastActivity":"2026-05-20T00:01:00.000Z",
				"models":{"deepseek-v4-flash":{"inputTokens":20,"totalTokens":20}}}]}`), nil
		}
		return nil, fmt.Errorf("Unexpected ccusage command")
	}}

	snapshots, err := provCollect(t, Options{
		CodexHome:   provHome(codexHome),
		Timezone:    "UTC",
		CollectedAt: "2026-05-20T01:00:00.000Z",
		Runner:      runner.run,
	}, map[string]string{
		"TOKENBOARD_SINCE":         "",
		"TOKENBOARD_DEFAULT_SINCE": "",
		"TOKENBOARD_UNTIL":         "",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 2 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	canonical := provSnapshotFor(t, snapshots, "2026-05-20", "deepseek-v4-flash")
	if canonical.TotalTokens != 0 {
		t.Errorf("canonical = %+v", canonical)
	}
	if canonical.Correction != contract.CorrectionCodexContextPricing {
		t.Errorf("correction = %q", canonical.Correction)
	}
	assertCloseTo(t, canonical.CostUSD, 0.001-20*4.0/1_000_000, 12)
	if canonical.SessionCount != 1 {
		t.Errorf("canonical session count = %d", canonical.SessionCount)
	}
	context := provSnapshotFor(t, snapshots, "2026-05-20", "gpt-5.6-sol")
	if context.TotalTokens != 20 || context.SessionCount != 0 {
		t.Errorf("context = %+v", context)
	}
	assertCloseTo(t, context.CostUSD, 20*4.0/1_000_000, 12)
}

// The session file changes while ccusage is answering: the unbounded
// collection must notice on its second inventory pass and retry once.
func TestProviderRetriesUnboundedContextPricingWhenASessionChangesDuringReconciliation(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	sessionPath := filepath.Join(codexHome, "sessions", "2026", "05", "01", "pricing.jsonl")
	provWriteJSONL(t, sessionPath, provTokenEvent("2026-05-01T00:00:00.000Z", 10, "gpt-5.6-sol"))

	sessionCalls := 0
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("daily") {
			return provJSON(t, `{"data":[{"date":"2026-05-01","models":["gpt-5.6-sol"],
				"inputTokens":10,"outputTokens":0,"cacheCreationInputTokens":0,
				"cacheReadInputTokens":0,"costUSD":0.01}]}`), nil
		}
		if !call.hasArg("session") {
			return nil, fmt.Errorf("Unexpected ccusage command")
		}
		sessionCalls++
		if sessionCalls == 1 {
			provAppendRaw(t, sessionPath, "\n")
		}
		return provJSON(t, `{"sessions":[]}`), nil
	}}

	snapshots, err := provCollect(t, Options{
		CodexHome: provHome(codexHome),
		Timezone:  "UTC",
		Runner:    runner.run,
	}, map[string]string{
		"TOKENBOARD_SINCE":         "",
		"TOKENBOARD_DEFAULT_SINCE": "",
		"TOKENBOARD_UNTIL":         "",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(runner.callsWith("daily")) != 2 {
		t.Errorf("daily calls = %v", runner.callsWith("daily"))
	}
	if len(runner.callsWith("session")) != 2 {
		t.Errorf("session calls = %v", runner.callsWith("session"))
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	got := provSnapshotFor(t, snapshots, "2026-05-01", "gpt-5.6-sol")
	if got.TotalTokens != 10 {
		t.Errorf("snapshot = %+v", got)
	}
	assertCloseTo(t, got.CostUSD, 10*4.0/1_000_000, 12)
}

// The first daily report does not yet carry the canonical row the context
// split needs; the reconciliation failure is retryable and the second report
// completes the split.
func TestProviderRetriesMixedModelReconciliationWhenTheDailyRowIsNotYetVisible(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	sessionPath := filepath.Join(codexHome, "sessions", "2026", "05", "20", "mixed-reconciliation.jsonl")
	provWriteJSONL(t, sessionPath,
		provTurnContext("deepseek-v4-flash"),
		provTokenEvent("2026-05-20T00:00:00.000Z", 10, ""),
		provTurnContext("gpt-5.6-luna"),
		provTokenEvent("2026-05-20T00:01:00.000Z", 20, ""),
	)

	dailyCalls := 0
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("daily") {
			dailyCalls++
			if dailyCalls == 1 {
				return provJSON(t, `{"data":[{"date":"2026-05-20","models":{
					"gpt-5.6-luna":{"inputTokens":20,"outputTokens":0,"totalTokens":20,"costUSD":0.0001}}}]}`), nil
			}
			return provJSON(t, `{"data":[{"date":"2026-05-20","models":{
				"deepseek-v4-flash":{"inputTokens":30,"outputTokens":0,"totalTokens":30,"costUSD":0.001}}}]}`), nil
		}
		if call.hasArg("session") {
			return provJSON(t, `{"sessions":[{"directory":"2026/05/20","sessionFile":"mixed-reconciliation",
				"lastActivity":"2026-05-20T00:01:00.000Z",
				"models":{"deepseek-v4-flash":{"inputTokens":30,"totalTokens":30}}}]}`), nil
		}
		return nil, fmt.Errorf("Unexpected ccusage command")
	}}

	snapshots, err := provCollect(t, Options{
		CodexHome: provHome(codexHome),
		Timezone:  "UTC",
		Runner:    runner.run,
	}, map[string]string{
		"TOKENBOARD_SINCE":         "",
		"TOKENBOARD_DEFAULT_SINCE": "",
		"TOKENBOARD_UNTIL":         "",
	})
	if err != nil {
		t.Fatal(err)
	}
	if dailyCalls != 2 {
		t.Fatalf("daily calls = %d", dailyCalls)
	}
	if len(snapshots) != 2 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	canonical := provSnapshotFor(t, snapshots, "2026-05-20", "deepseek-v4-flash")
	if canonical.TotalTokens != 10 {
		t.Errorf("canonical = %+v", canonical)
	}
	assertCloseTo(t, canonical.CostUSD, 0.001-20*0.2/1_000_000, 12)
	context := provSnapshotFor(t, snapshots, "2026-05-20", "gpt-5.6-luna")
	if context.TotalTokens != 20 {
		t.Errorf("context = %+v", context)
	}
	assertCloseTo(t, context.CostUSD, 20*0.2/1_000_000, 12)
}

// A ccusage row whose directory climbs out of its session root must not be
// used to attribute the session file: the file it points at is elsewhere.
func TestProviderDoesNotUseASessionRowDirectoryThatEscapesItsSessionRoot(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	sessionPath := filepath.Join(codexHome, "archived_sessions", "2026", "05", "20", "escaping.jsonl")
	provWriteJSONL(t, sessionPath,
		provTurnContext("gpt-5.6-sol"),
		provTokenEvent("2026-05-20T04:24:07.234Z", 10, ""),
	)

	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("daily") {
			return provJSON(t, `{"data":[{"date":"2026-05-20","models":{
				"gpt-5.6-sol":{"inputTokens":10,"outputTokens":0,"cacheCreationInputTokens":0,
				"cacheReadInputTokens":0,"totalTokens":10,"costUSD":0.01}}}]}`), nil
		}
		if !call.hasArg("session") {
			return nil, fmt.Errorf("Unexpected ccusage command")
		}
		return provJSON(t, `{"sessions":[{"directory":"../archived_sessions/2026/05/20",
			"sessionFile":"escaping","lastActivity":"2026-05-20T04:24:07.234Z",
			"models":{"deepseek-v4-flash":{"inputTokens":10,"totalTokens":10}}}]}`), nil
	}}

	snapshots, err := provCollect(t, Options{
		CodexHome: provHome(codexHome),
		Timezone:  "UTC",
		Runner:    runner.run,
	}, map[string]string{
		"TOKENBOARD_SINCE":         "",
		"TOKENBOARD_DEFAULT_SINCE": "",
		"TOKENBOARD_UNTIL":         "",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	got := provSnapshotFor(t, snapshots, "2026-05-20", "gpt-5.6-sol")
	if got.TotalTokens != 10 {
		t.Errorf("snapshot = %+v", got)
	}
	assertCloseTo(t, got.CostUSD, 10*4.0/1_000_000, 12)
}

// The bounded report runs against a frozen copy, and its window comes from the
// configured default since when the environment leaves TOKENBOARD_SINCE unset.
func TestProviderPassesTheConfiguredDefaultSinceWindowToFrozenBoundedReports(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "01", "active.jsonl"),
		provTokenEvent("2026-05-01T04:24:07.234Z", 10, "gpt-5"))
	stateDir := t.TempDir()
	runner := &provStubRunner{t: t, respond: func(provCall) (any, error) {
		return provJSON(t, `{"data":[]}`), nil
	}}
	_, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  stateDir,
		Runner:    runner.run,
		Env: provEnv(map[string]string{
			"TOKENBOARD_PACKAGE_MANAGER":      "",
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
			"TOKENBOARD_SINCE":                "",
			"TOKENBOARD_DEFAULT_SINCE":        "20260501",
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 3 {
		t.Fatalf("calls = %v", runner.calls)
	}
	configArgs := provConfigArgs(stateDir)
	provAssertArgs(t, runner.calls[0].args, append([]string{
		"ccusage@20.0.33", "codex", "daily", "--json", "--offline", "--single-thread",
		"--since", "20260501",
	}, configArgs...))
	provAssertArgs(t, runner.calls[1].args, append([]string{
		"ccusage@20.0.33", "codex", "session", "--json", "--offline", "--single-thread",
		"--since", "20260501",
	}, configArgs...))
	provAssertArgs(t, runner.calls[2].args, append([]string{
		"ccusage@20.0.33", "codex", "session", "--json", "--offline", "--single-thread",
	}, configArgs...))
}

// An explicit since/until wins over the process environment for the same
// reason: the caller owns the window, not whatever the shell exported.
func TestProviderPrefersAnExplicitSinceWindowOverTheProcessEnvironment(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "07", "07", "active.jsonl"),
		provTokenEvent("2026-07-07T16:30:00.000Z", 10, "gpt-5"))
	stateDir := t.TempDir()
	runner := &provStubRunner{t: t, respond: func(provCall) (any, error) {
		return provJSON(t, `{"data":[]}`), nil
	}}
	_, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		Timezone:  "Asia/Shanghai",
		Since:     "20260708",
		Until:     "20260709",
		StateDir:  stateDir,
		Runner:    runner.run,
		Env: provEnv(map[string]string{
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
			"TOKENBOARD_SINCE":                "20260501",
			"TOKENBOARD_UNTIL":                "20260502",
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 3 {
		t.Fatalf("calls = %v", runner.calls)
	}
	configArgs := provConfigArgs(stateDir)
	provAssertArgs(t, runner.calls[0].args, append([]string{
		"ccusage@20.0.33", "codex", "daily", "--json", "--offline", "--single-thread",
		"--since", "20260708", "--until", "20260709", "--timezone", "Asia/Shanghai",
	}, configArgs...))
	provAssertArgs(t, runner.calls[1].args, append([]string{
		"ccusage@20.0.33", "codex", "session", "--json", "--offline", "--single-thread",
		"--since", "20260708", "--until", "20260709", "--timezone", "Asia/Shanghai",
	}, configArgs...))
	provAssertArgs(t, runner.calls[2].args, append([]string{
		"ccusage@20.0.33", "codex", "session", "--json", "--offline", "--single-thread",
		"--timezone", "Asia/Shanghai",
	}, configArgs...))
}

func TestProviderRejectsShellMetacharactersInDateFiltersBeforeRunningCcusage(t *testing.T) {
	runner := &provStubRunner{t: t, respond: func(provCall) (any, error) {
		return nil, fmt.Errorf("runner should not be called")
	}}
	_, err := provCollect(t, Options{
		Since:  "20260708&echo injected",
		Runner: runner.run,
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "Invalid Codex since date") {
		t.Fatalf("err = %v", err)
	}

	_, err = provCollect(t, Options{
		Since:  "20260708",
		Runner: runner.run,
	}, map[string]string{"TOKENBOARD_UNTIL": "20260708&echo injected"})
	if err == nil || !strings.Contains(err.Error(), "Invalid Codex until date") {
		t.Fatalf("err = %v", err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("runner should not be called: %v", runner.calls)
	}
}

func TestProviderRejectsAReversedDateWindowBeforeRunningCcusage(t *testing.T) {
	runner := &provStubRunner{t: t, respond: func(provCall) (any, error) {
		return nil, fmt.Errorf("runner should not be called")
	}}
	_, err := provCollect(t, Options{
		Since:  "20260709",
		Until:  "20260708",
		Runner: runner.run,
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "since date must not be after until date") {
		t.Fatalf("err = %v", err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("runner should not be called: %v", runner.calls)
	}
}

// The unscoped commands must see the configured home through CODEX_HOME.
func TestProviderPassesConfiguredCodexHomeToUnscopedCcusageCommands(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	homes := map[string]bool{}
	stateDir := t.TempDir()
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		homes[call.envValue("CODEX_HOME")] = true
		return provJSON(t, `{"data":[]}`), nil
	}}
	_, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  stateDir,
		Runner:    runner.run,
		Env: provEnv(map[string]string{
			"TOKENBOARD_PACKAGE_MANAGER":      "",
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(homes) != 1 || !homes[codexHome] {
		t.Fatalf("homes = %v, want only %q", homes, codexHome)
	}
}

// A bounded report never runs against the live home: every call — daily and
// session alike — sees the same frozen copy.
func TestProviderUsesAFrozenHomeForEveryBoundedReport(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "12", "active.jsonl"),
		provTokenEvent("2026-05-12T04:24:07.234Z", 10, "gpt-5"))
	homes := map[string]bool{}
	dailyHomes := map[string]bool{}
	stateDir := t.TempDir()
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		home := call.envValue("CODEX_HOME")
		homes[home] = true
		if call.hasArg("daily") {
			dailyHomes[home] = true
		}
		return provJSON(t, `{"data":[]}`), nil
	}}
	_, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		Since:     "20260512",
		StateDir:  stateDir,
		Runner:    runner.run,
		Env: provEnv(map[string]string{
			"TOKENBOARD_PACKAGE_MANAGER":      "",
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(homes) != 1 {
		t.Fatalf("homes = %v", homes)
	}
	if homes[codexHome] {
		t.Errorf("the live home was used: %v", homes)
	}
	if len(dailyHomes) != 1 {
		t.Fatalf("daily homes = %v", dailyHomes)
	}
	for home := range dailyHomes {
		if !homes[home] {
			t.Errorf("daily home %q is not the session home", home)
		}
	}
}

// The session report's model must not invent a snapshot: an unbounded report
// only carries what the daily rows say.
func TestProviderDoesNotCreateASessionOnlySnapshotForAnUnboundedReport(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "21", "pricing.jsonl"),
		provTokenEvent("2026-05-21T04:24:07.234Z", 10, "gpt-5.4"))
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("session") {
			return provJSON(t, `{"sessions":[{"sessionId":"session-only",
				"lastActivity":"2026-05-21T04:24:07.234Z","models":{"gpt-5.6":{"totalTokens":1}}}]}`), nil
		}
		return provJSON(t, `{"data":[{"date":"2026-05-21","models":{"gpt-5.4":{"inputTokens":10,"totalTokens":10}}}]}`), nil
	}}
	snapshots, err := provCollect(t, Options{
		CodexHome:   provHome(codexHome),
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-21T10:00:00.000Z",
		Runner:      runner.run,
	}, map[string]string{
		"TOKENBOARD_SINCE":         "",
		"TOKENBOARD_DEFAULT_SINCE": "",
		"TOKENBOARD_UNTIL":         "",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	got := provSnapshotFor(t, snapshots, "2026-05-21", "gpt-5.4")
	if got.TotalTokens != 10 || got.SessionCount != 0 {
		t.Errorf("snapshot = %+v", got)
	}
}

// windowPricingEvents is the suite's three-model, two-day fixture.
func windowPricingEvents() []map[string]any {
	rows := []map[string]any{}
	for _, model := range []string{"gpt-5.4", "gpt-5.5", "gpt-5.6"} {
		rows = append(rows,
			provTokenEvent("2026-05-20T04:24:07.234Z", 10, model),
			provTokenEvent("2026-05-21T04:24:07.234Z", 10, model))
	}
	return rows
}

// windowSensitiveDailyResult is the daily report the window tests answer with.
const windowSensitiveDailyResult = `{"data":[
	{"date":"2026-05-20","models":{
		"gpt-5.4":{"inputTokens":10,"totalTokens":10},
		"gpt-5.5":{"inputTokens":10,"totalTokens":10},
		"gpt-5.6":{"inputTokens":10,"totalTokens":10}}},
	{"date":"2026-05-21","models":{
		"gpt-5.4":{"inputTokens":10,"totalTokens":10},
		"gpt-5.5":{"inputTokens":10,"totalTokens":10},
		"gpt-5.6":{"inputTokens":10,"totalTokens":10}}}]}`

// missingCanonicalModelDailyResult lacks the canonical model's own row.
const missingCanonicalModelDailyResult = `{"data":[{"date":"2026-05-21","models":{
	"gpt-5.4":{"inputTokens":10,"totalTokens":10}}}]}`

// boundedSessionResult is what a `--since`/`--until` session report answers.
const boundedSessionResult = `{"sessions":[{"directory":"2026/05/20","sessionFile":"stable-session",
	"lastActivity":"2026-05-20T04:24:07.234Z",
	"models":{"gpt-5.4":{"inputTokens":20,"totalTokens":20},"gpt-5.5":{"inputTokens":10,"totalTokens":10}}}]}`

func provCanonicalSessionResult(model string) string {
	return `{"sessions":[{"directory":"2026/05/20","sessionFile":"stable-session",
		"lastActivity":"2026-05-21T04:24:07.234Z","models":{"gpt-5.4":{"inputTokens":10,"totalTokens":10},"` +
		model + `":{"inputTokens":20,"totalTokens":20}}}]}`
}

func provMultiBoundedSessionResult() string {
	row := func(name string) string {
		return `{"directory":"2026/05/20","sessionFile":"` + name + `","lastActivity":"2026-05-20T04:24:07.234Z",
			"models":{"gpt-5.4":{"totalTokens":10}}}`
	}
	return `{"sessions":[` + row("first") + `,` + row("second") + `]}`
}

func provMultiCanonicalSessionResult() string {
	row := func(name string) string {
		return `{"directory":"2026/05/20","sessionFile":"` + name + `","lastActivity":"2026-05-21T04:24:07.234Z",
			"models":{"gpt-5.5":{"totalTokens":20}}}`
	}
	return `{"sessions":[` + row("first") + `,` + row("second") + `]}`
}

// provWindowSensitiveRunner answers the daily report, the bounded session
// report for a windowed call, and the canonical (unwindowed) session report.
func provWindowSensitiveRunner(
	t *testing.T, calls *[]provCall, getCanonicalModel func() string, dailyResult string,
) func(provCall) (any, error) {
	if getCanonicalModel == nil {
		getCanonicalModel = func() string { return "gpt-5.5" }
	}
	if dailyResult == "" {
		dailyResult = windowSensitiveDailyResult
	}
	return func(call provCall) (any, error) {
		if calls != nil {
			*calls = append(*calls, call)
		}
		if call.hasArg("daily") {
			return provJSON(t, dailyResult), nil
		}
		if !call.hasArg("session") {
			return nil, fmt.Errorf("Unexpected ccusage command")
		}
		if call.hasArg("--since") || call.hasArg("--until") {
			return provJSON(t, boundedSessionResult), nil
		}
		return provJSON(t, provCanonicalSessionResult(getCanonicalModel())), nil
	}
}

// An until-only window still gets the canonical attribution: the bounded
// report cannot see the session's later turns, so the file's own model decides.
func TestProviderUsesCanonicalSessionAttributionForAnUntilOnlyWindow(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "20", "stable-session.jsonl"),
		append([]map[string]any{provTokenEvent("2026-05-20T04:24:07.234Z", 10, "gpt-5")}, windowPricingEvents()...)...)
	stateDir := t.TempDir()
	calls := []provCall{}
	runner := &provStubRunner{t: t, respond: provWindowSensitiveRunner(t, &calls, nil, "")}
	snapshots, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		Timezone:  "Asia/Shanghai",
		StateDir:  stateDir,
		Runner:    runner.run,
		Env: provEnv(map[string]string{
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
			"TOKENBOARD_SINCE":                "",
			"TOKENBOARD_DEFAULT_SINCE":        "",
			"TOKENBOARD_UNTIL":                "20260521",
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	counts := provSessionCountsByDateAndModel(snapshots)
	if counts["2026-05-21\x00gpt-5.5"] != 1 {
		t.Fatalf("counts = %+v", counts)
	}
	foundDaily := false
	for _, call := range calls {
		if call.hasArg("daily") && call.hasArg("--until") && call.hasArg("20260521") {
			foundDaily = true
		}
	}
	if !foundDaily {
		t.Errorf("no bounded daily call: %+v", calls)
	}
	foundSession := false
	for _, call := range calls {
		if call.hasArg("session") && call.hasArg("--until") && call.hasArg("20260521") {
			foundSession = true
		}
	}
	if !foundSession {
		t.Errorf("no bounded session call: %+v", calls)
	}
	unwindowed := 0
	for _, call := range calls {
		if call.hasArg("session") && !call.hasArg("--until") {
			unwindowed++
		}
	}
	if unwindowed != 1 {
		t.Errorf("canonical session calls = %d (%+v)", unwindowed, calls)
	}
}

// The canonical attribution may be newer than the window. The bounded row
// keeps its own date then, and nothing outside the window appears.
func TestProviderKeepsABoundedSessionDateWhenCanonicalAttributionIsNewerThanTheWindow(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "20", "stable-session.jsonl"),
		provTokenEvent("2026-05-20T04:24:07.234Z", 10, "gpt-5"),
		provTokenEvent("2026-05-21T04:24:07.234Z", 10, "gpt-5.4"))
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("daily") {
			return provJSON(t, `{"data":[{"date":"2026-05-21","models":{"gpt-5.4":{"inputTokens":10,"totalTokens":10}}}]}`), nil
		}
		if call.hasArg("--until") {
			return provJSON(t, boundedSessionResult), nil
		}
		return provJSON(t, `{"sessions":[{"directory":"2026/05/20","sessionFile":"stable-session",
			"lastActivity":"2026-05-24T04:24:07.234Z","models":{"gpt-5.5":{"inputTokens":20,"totalTokens":20}}}]}`), nil
	}}
	snapshots, err := provCollect(t, Options{
		CodexHome: provHome(codexHome),
		Timezone:  "Asia/Shanghai",
		Runner:    runner.run,
	}, map[string]string{
		"TOKENBOARD_SINCE":         "",
		"TOKENBOARD_DEFAULT_SINCE": "",
		"TOKENBOARD_UNTIL":         "20260521",
	})
	if err != nil {
		t.Fatal(err)
	}
	row := provSnapshotFor(t, snapshots, "2026-05-20", "gpt-5.5")
	if row.TotalTokens != 0 || row.SessionCount != 1 {
		t.Errorf("row = %+v", row)
	}
	for _, snapshot := range snapshots {
		if snapshot.UsageDate > "2026-05-21" {
			t.Errorf("snapshot outside the window: %+v", snapshot)
		}
	}
}

// With every history bounded by until, the canonical run is still the
// unwindowed one — it is the only report that sees the whole file.
func TestProviderUsesCanonicalSessionAttributionWhenAllHistoryIsBoundedByUntil(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "20", "stable-session.jsonl"),
		append([]map[string]any{provTokenEvent("2026-05-20T04:24:07.234Z", 10, "gpt-5")}, windowPricingEvents()...)...)
	stateDir := t.TempDir()
	calls := []provCall{}
	runner := &provStubRunner{t: t, respond: provWindowSensitiveRunner(t, &calls, nil, "")}
	snapshots, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		Timezone:  "Asia/Shanghai",
		Since:     "all",
		StateDir:  stateDir,
		Runner:    runner.run,
		Env: provEnv(map[string]string{
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
			"TOKENBOARD_UNTIL":                "20260521",
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	counts := provSessionCountsByDateAndModel(snapshots)
	if counts["2026-05-21\x00gpt-5.5"] != 1 {
		t.Fatalf("counts = %+v", counts)
	}
	unwindowed := 0
	for _, call := range calls {
		if call.hasArg("session") && !call.hasArg("--until") {
			unwindowed++
		}
	}
	if unwindowed != 1 {
		t.Errorf("canonical session calls = %d (%+v)", unwindowed, calls)
	}
}

// An archived session is a session: the bounded attribution reads it too.
func TestProviderUsesAnArchiveOnlyLocalSessionForCanonicalBoundedAttribution(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	provWriteJSONL(t, filepath.Join(codexHome, "archived_sessions", "2026", "05", "20", "stable-session.jsonl"),
		append([]map[string]any{provTokenEvent("2026-05-20T04:24:07.234Z", 10, "gpt-5")}, windowPricingEvents()...)...)
	stateDir := t.TempDir()
	runner := &provStubRunner{t: t, respond: provWindowSensitiveRunner(t, nil, nil, "")}
	snapshots, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		Timezone:  "Asia/Shanghai",
		Since:     "20260515",
		StateDir:  stateDir,
		Runner:    runner.run,
		Env:       provEnv(provForceEnv(nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	counts := provSessionCountsByDateAndModel(snapshots)
	if counts["2026-05-21\x00gpt-5.5"] != 1 {
		t.Fatalf("counts = %+v", counts)
	}
}

// The same relative path can exist under sessions/ and archived_sessions/. The
// active copy is the one the run continues, so the frozen scope must carry it
// (and not the archive) for canonical attribution.
func TestProviderPrefersAnActiveSessionOverAnArchiveWithTheSameBoundedReportPath(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	activeSession := filepath.Join(codexHome, "sessions", "2026", "05", "20", "stable-session.jsonl")
	archivedSession := filepath.Join(codexHome, "archived_sessions", "2026", "05", "20", "stable-session.jsonl")
	activeRows := append([]map[string]any{{"source": "active"}}, windowPricingEvents()...)
	provWriteJSONL(t, activeSession, activeRows...)
	provWriteJSONL(t, archivedSession, map[string]any{"source": "archive"})

	var checkErr error
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("daily") {
			return provJSON(t, windowSensitiveDailyResult), nil
		}
		if call.hasArg("--since") {
			return provJSON(t, boundedSessionResult), nil
		}
		scopedHome := call.envValue("CODEX_HOME")
		activeContent, err := os.ReadFile(filepath.Join(scopedHome, "sessions", "2026", "05", "20", "stable-session.jsonl"))
		if err != nil {
			checkErr = err
		} else if !strings.Contains(string(activeContent), "active") {
			checkErr = fmt.Errorf("scoped active session does not carry the active source")
		}
		if _, err := os.ReadFile(filepath.Join(scopedHome, "archived_sessions", "2026", "05", "20", "stable-session.jsonl")); err == nil {
			checkErr = fmt.Errorf("the archive was copied into the canonical scope")
		}
		return provJSON(t, provCanonicalSessionResult("gpt-5.5")), nil
	}}
	snapshots, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		Timezone:  "Asia/Shanghai",
		Since:     "20260515",
		StateDir:  t.TempDir(),
		Runner:    runner.run,
		Env:       provEnv(provForceEnv(nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if checkErr != nil {
		t.Fatalf("scoped check: %v", checkErr)
	}
	counts := provSessionCountsByDateAndModel(snapshots)
	if counts["2026-05-21\x00gpt-5.5"] != 1 {
		t.Fatalf("counts = %+v", counts)
	}
}

// Two configured homes are both preserved in the canonical attribution: the
// scope must not collapse them onto the comma-joined value.
func TestProviderPreservesEveryConfiguredCodexHomeWhileResolvingBoundedCanonicalAttribution(t *testing.T) {
	firstHome := provEmptyCodexHome(t)
	secondHome := provEmptyCodexHome(t)
	provWriteJSONL(t, filepath.Join(firstHome, "sessions", "2026", "05", "20", "first.jsonl"),
		provTokenEvent("2026-05-20T04:24:07.234Z", 10, "gpt-5"))
	provWriteJSONL(t, filepath.Join(secondHome, "sessions", "2026", "05", "20", "second.jsonl"),
		provTokenEvent("2026-05-20T04:24:07.234Z", 10, "gpt-5"))
	provWriteJSONL(t, filepath.Join(firstHome, "sessions", "2026", "05", "20", "window-pricing.jsonl"),
		windowPricingEvents()...)
	combinedHome := firstHome + "," + secondHome
	stateDir := t.TempDir()

	var checkErr error
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		codexHome := call.envValue("CODEX_HOME")
		if call.hasArg("daily") {
			return provJSON(t, windowSensitiveDailyResult), nil
		}
		if call.hasArg("--since") {
			return provJSON(t, provMultiBoundedSessionResult()), nil
		}
		if len(strings.Split(codexHome, ",")) != 2 {
			checkErr = fmt.Errorf("canonical scope home = %q", codexHome)
		}
		if codexHome == combinedHome {
			checkErr = fmt.Errorf("the canonical scope reused the comma-joined home")
		}
		return provJSON(t, provMultiCanonicalSessionResult()), nil
	}}
	snapshots, err := Collect(context.Background(), Options{
		Timezone: "Asia/Shanghai",
		Since:    "20260515",
		StateDir: stateDir,
		Runner:   runner.run,
		Env: provEnv(provForceEnv(map[string]string{
			"CODEX_HOME": combinedHome,
		})),
	})
	if err != nil {
		t.Fatal(err)
	}
	if checkErr != nil {
		t.Fatalf("scoped check: %v", checkErr)
	}
	counts := provSessionCountsByDateAndModel(snapshots)
	if counts["2026-05-21\x00gpt-5.5"] != 2 {
		t.Fatalf("counts = %+v", counts)
	}
	sinceCalls := 0
	unwindowed := 0
	for _, call := range runner.calls {
		if call.hasArg("--since") {
			sinceCalls++
		}
		if call.hasArg("session") && !call.hasArg("--since") {
			unwindowed++
		}
		if call.envValue("CODEX_HOME") == combinedHome {
			t.Errorf("call reused the comma-joined home: %v", call.args)
		}
		if len(strings.Split(call.envValue("CODEX_HOME"), ",")) != 2 {
			t.Errorf("call home = %q", call.envValue("CODEX_HOME"))
		}
	}
	if sinceCalls != 2 {
		t.Errorf("--since calls = %d (%+v)", sinceCalls, runner.calls)
	}
	if unwindowed != 1 {
		t.Errorf("canonical calls = %d (%+v)", unwindowed, runner.calls)
	}
	if len(runner.calls) != 3 {
		t.Errorf("calls = %d (%+v)", len(runner.calls), runner.calls)
	}
}

// A partially cached canonical scope rebuilds only the missing files; the
// symlink roots must still be passed so an archived session reached through a
// symlinked root stays readable.
func TestProviderPassesConfiguredSymlinkRootsWhenRebuildingAPartiallyCachedCanonicalScope(t *testing.T) {
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex-home")
	archiveTarget := filepath.Join(root, "archive-target")
	activeSession := filepath.Join(codexHome, "sessions", "2026", "05", "20", "active.jsonl")
	archivedSession := filepath.Join(archiveTarget, "2026", "05", "20", "archived.jsonl")
	stateDir := filepath.Join(root, "state")
	provWriteJSONL(t, activeSession, provTokenEvent("2026-05-20T04:24:07.234Z", 10, "gpt-5"))
	provWriteJSONL(t, archivedSession, provTokenEvent("2026-05-20T04:25:07.234Z", 10, "gpt-5"))
	if err := os.Symlink(archiveTarget, filepath.Join(codexHome, "archived_sessions")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("daily") {
			return provJSON(t, `{"data":[{"date":"2026-05-20","models":{"gpt-5":{"inputTokens":20,"totalTokens":20}}}]}`), nil
		}
		return provJSON(t, `{"sessions":[
			{"directory":"2026/05/20","sessionFile":"active","lastActivity":"2026-05-20T04:24:07.234Z",
			 "models":{"gpt-5":{"inputTokens":10,"totalTokens":10}}},
			{"directory":"2026/05/20","sessionFile":"archived","lastActivity":"2026-05-20T04:25:07.234Z",
			 "models":{"gpt-5":{"inputTokens":10,"totalTokens":10}}}]}`), nil
	}}
	options := Options{
		CodexHome:         provHome(codexHome),
		StateDir:          stateDir,
		Since:             "20260515",
		Timezone:          "Asia/Shanghai",
		CodexSymlinkRoots: []string{archiveTarget},
		Runner:            runner.run,
		Env:               provEnv(provForceEnv(nil)),
	}
	if _, err := Collect(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	provAppendJSONL(t, archivedSession, provTokenEvent("2026-05-20T04:26:07.234Z", 12, "gpt-5"))

	snapshots, err := Collect(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if !provHasSnapshot(snapshots, "2026-05-20", "gpt-5") {
		t.Fatalf("snapshots = %+v", snapshots)
	}
}

// Two homes can hold the same relative session path; the merged bounded row
// must keep each home's own canonical model rather than one overwriting the
// other.
func TestProviderKeepsAMergedBoundedSessionFromDuplicatePathsAcrossCodexHomesCanonical(t *testing.T) {
	firstHome := provEmptyCodexHome(t)
	secondHome := provEmptyCodexHome(t)
	provWriteJSONL(t, filepath.Join(firstHome, "sessions", "2026", "05", "20", "shared.jsonl"),
		map[string]any{"source": "first"})
	provWriteJSONL(t, filepath.Join(secondHome, "sessions", "2026", "05", "20", "shared.jsonl"),
		map[string]any{"source": "second"})
	provWriteJSONL(t, filepath.Join(firstHome, "sessions", "2026", "05", "20", "window-pricing.jsonl"),
		windowPricingEvents()...)
	combinedHome := firstHome + "," + secondHome

	var checkErr error
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("daily") {
			return provJSON(t, windowSensitiveDailyResult), nil
		}
		scopedHomes := strings.Split(call.envValue("CODEX_HOME"), ",")
		if call.hasArg("--since") {
			if len(scopedHomes) != 1 {
				checkErr = fmt.Errorf("bounded scope homes = %v", scopedHomes)
			}
			return provJSON(t, `{"sessions":[{"directory":"2026/05/20","sessionFile":"shared",
				"lastActivity":"2026-05-20T04:24:07.234Z","models":{"gpt-5.4":{"totalTokens":20}}}]}`), nil
		}
		if len(scopedHomes) != 1 {
			checkErr = fmt.Errorf("canonical scope homes = %v", scopedHomes)
		}
		source, err := os.ReadFile(filepath.Join(scopedHomes[0], "sessions", "2026", "05", "20", "shared.jsonl"))
		if err != nil {
			checkErr = err
		}
		model := "gpt-5.5"
		if strings.Contains(string(source), "first") {
			model = "gpt-5.4"
		}
		return provJSON(t, `{"sessions":[{"directory":"2026/05/20","sessionFile":"shared",
			"lastActivity":"2026-05-21T04:24:07.234Z","models":{"`+model+`":{"totalTokens":20}}}]}`), nil
	}}
	snapshots, err := Collect(context.Background(), Options{
		Timezone: "Asia/Shanghai",
		Since:    "20260515",
		StateDir: t.TempDir(),
		Runner:   runner.run,
		Env:      provEnv(provForceEnv(map[string]string{"CODEX_HOME": combinedHome})),
	})
	if err != nil {
		t.Fatal(err)
	}
	if checkErr != nil {
		t.Fatalf("scoped check: %v", checkErr)
	}
	counts := provSessionCountsByDateAndModel(snapshots)
	if counts["2026-05-21\x00gpt-5.4"] != 1 || counts["2026-05-21\x00gpt-5.5"] != 1 {
		t.Fatalf("counts = %+v", counts)
	}
}

// A session whose file did not change keeps its cached canonical attribution
// across a wider window, and the cache never stores the file name.
func TestProviderKeepsAnUnchangedSessionCountAttributedToItsCanonicalModelAcrossBoundedWindows(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	stateDir := t.TempDir()
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "20", "stable-session.jsonl"),
		append([]map[string]any{provTokenEvent("2026-05-20T04:24:07.234Z", 10, "gpt-5")}, windowPricingEvents()...)...)
	calls := []provCall{}

	run := func(since string) []contract.Snapshot {
		runner := &provStubRunner{t: t, respond: provWindowSensitiveRunner(t, &calls, nil, "")}
		snapshots, err := Collect(context.Background(), Options{
			CodexHome: provHome(codexHome),
			StateDir:  stateDir,
			Timezone:  "Asia/Shanghai",
			Since:     since,
			Runner:    runner.run,
			Env:       provEnv(provForceEnv(nil)),
		})
		if err != nil {
			t.Fatal(err)
		}
		return snapshots
	}
	first := run("20260501")
	second := run("20260515")

	want := map[string]int64{
		"2026-05-20\x00gpt-5.4": 0,
		"2026-05-20\x00gpt-5.5": 0,
		"2026-05-20\x00gpt-5.6": 0,
		"2026-05-21\x00gpt-5.4": 0,
		"2026-05-21\x00gpt-5.5": 1,
		"2026-05-21\x00gpt-5.6": 0,
	}
	provAssertStringSet(t, provSessionCountsByDateAndModel(first), want)
	provAssertStringSet(t, provSessionCountsByDateAndModel(second), want)

	unwindowed := 0
	for _, call := range calls {
		if call.hasArg("session") && !call.hasArg("--since") {
			unwindowed++
		}
	}
	if unwindowed != 1 {
		t.Errorf("canonical calls = %d (%+v)", unwindowed, calls)
	}
	content, err := os.ReadFile(filepath.Join(stateDir, "codex-session-attribution-cache.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(content), "stable-session") {
		t.Errorf("the cache stores the file name: %s", content)
	}
}

// A scoped full-history collection warms the cache, so the following bounded
// window needs no canonical run at all.
func TestProviderWarmsCanonicalSessionAttributionFromAScopedFullHistoryCollection(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	stateDir := t.TempDir()
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "20", "stable-session.jsonl"),
		append([]map[string]any{provTokenEvent("2026-05-20T04:24:07.234Z", 10, "gpt-5")}, windowPricingEvents()...)...)
	calls := []provCall{}
	runner := &provStubRunner{t: t, respond: provWindowSensitiveRunner(t, &calls, nil, "")}

	if _, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  stateDir,
		Timezone:  "Asia/Shanghai",
		Since:     "all",
		Runner:    runner.run,
		Env:       provEnv(provForceEnv(nil)),
	}); err != nil {
		t.Fatal(err)
	}
	bounded, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  stateDir,
		Timezone:  "Asia/Shanghai",
		Since:     "20260515",
		Runner:    runner.run,
		Env:       provEnv(provForceEnv(nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	provAssertStringSet(t, provSessionCountsByDateAndModel(bounded), map[string]int64{
		"2026-05-20\x00gpt-5.4": 0,
		"2026-05-20\x00gpt-5.5": 0,
		"2026-05-20\x00gpt-5.6": 0,
		"2026-05-21\x00gpt-5.4": 0,
		"2026-05-21\x00gpt-5.5": 1,
		"2026-05-21\x00gpt-5.6": 0,
	})
	unwindowed := 0
	for _, call := range calls {
		if call.hasArg("session") && !call.hasArg("--since") {
			unwindowed++
		}
	}
	if unwindowed != 1 {
		t.Errorf("canonical calls = %d (%+v)", unwindowed, calls)
	}
}

// When the source file changes, the cached attribution is stale: the next run
// rescans it and picks up the new canonical model.
func TestProviderRefreshesCanonicalSessionAttributionWhenItsSourceFileChanges(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	stateDir := t.TempDir()
	sessionPath := filepath.Join(codexHome, "sessions", "2026", "05", "20", "stable-session.jsonl")
	provWriteJSONL(t, sessionPath,
		append([]map[string]any{provTokenEvent("2026-05-20T04:24:07.234Z", 10, "gpt-5")}, windowPricingEvents()...)...)
	calls := []provCall{}
	canonicalModel := "gpt-5.5"
	runner := &provStubRunner{t: t, respond: provWindowSensitiveRunner(t, &calls, func() string { return canonicalModel }, "")}

	run := func() []contract.Snapshot {
		snapshots, err := Collect(context.Background(), Options{
			CodexHome: provHome(codexHome),
			StateDir:  stateDir,
			Timezone:  "Asia/Shanghai",
			Since:     "20260515",
			Runner:    runner.run,
			Env:       provEnv(provForceEnv(nil)),
		})
		if err != nil {
			t.Fatal(err)
		}
		return snapshots
	}
	run()
	canonicalModel = "gpt-5.6"
	provAppendJSONL(t, sessionPath, provTokenEvent("2026-05-21T04:24:07.234Z", 10, "gpt-5"))
	refreshed := run()

	provAssertStringSet(t, provSessionCountsByDateAndModel(refreshed), map[string]int64{
		"2026-05-20\x00gpt-5.4": 0,
		"2026-05-20\x00gpt-5.5": 0,
		"2026-05-20\x00gpt-5.6": 0,
		"2026-05-21\x00gpt-5.4": 0,
		"2026-05-21\x00gpt-5.5": 0,
		"2026-05-21\x00gpt-5.6": 1,
	})
	unwindowed := 0
	for _, call := range calls {
		if call.hasArg("session") && !call.hasArg("--since") {
			unwindowed++
		}
	}
	if unwindowed != 2 {
		t.Errorf("canonical calls = %d (%+v)", unwindowed, calls)
	}
}

// The canonical run reads a frozen copy; a change to the live source while it
// answers must not change the snapshot this run reports.
func TestProviderKeepsAFrozenSnapshotWhenItsSourceSessionChangesAfterCanonicalAttributionBegins(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	sessionPath := filepath.Join(codexHome, "sessions", "2026", "05", "20", "stable-session.jsonl")
	provWriteJSONL(t, sessionPath,
		append([]map[string]any{provTokenEvent("2026-05-20T04:24:07.234Z", 10, "gpt-5")}, windowPricingEvents()...)...)

	var checkErr error
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("daily") {
			return provJSON(t, windowSensitiveDailyResult), nil
		}
		if call.hasArg("--since") {
			return provJSON(t, boundedSessionResult), nil
		}
		provWriteJSONL(t, sessionPath, provTokenEvent("2026-05-21T04:24:07.234Z", 20, "gpt-5"))
		if call.envValue("CODEX_HOME") == codexHome {
			checkErr = fmt.Errorf("the canonical run used the live home")
		}
		return provJSON(t, provCanonicalSessionResult("gpt-5.5")), nil
	}}
	snapshots, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		Timezone:  "Asia/Shanghai",
		Since:     "20260515",
		StateDir:  t.TempDir(),
		Runner:    runner.run,
		Env:       provEnv(provForceEnv(nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if checkErr != nil {
		t.Fatalf("scoped check: %v", checkErr)
	}
	counts := provSessionCountsByDateAndModel(snapshots)
	if counts["2026-05-21\x00gpt-5.5"] != 1 {
		t.Fatalf("counts = %+v", counts)
	}
}

// A canonical model with no daily token row still keeps its session count:
// the count is real even when the day's tokens were all attributed elsewhere.
func TestProviderPreservesACanonicalSessionCountWhenItsModelHasNoDailyTokenRow(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	stateDir := t.TempDir()
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "20", "stable-session.jsonl"),
		provTokenEvent("2026-05-20T04:24:07.234Z", 10, "gpt-5"))
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "21", "pricing.jsonl"),
		provTokenEvent("2026-05-21T04:24:07.234Z", 10, "gpt-5.4"))
	runner := &provStubRunner{t: t, respond: provWindowSensitiveRunner(
		t, nil, func() string { return "gpt-5.6" }, missingCanonicalModelDailyResult)}
	snapshots, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  stateDir,
		Timezone:  "Asia/Shanghai",
		Since:     "20260515",
		Runner:    runner.run,
		Env:       provEnv(provForceEnv(nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	row := provSnapshotFor(t, snapshots, "2026-05-21", "gpt-5.6")
	if row.InputTokens != 0 || row.OutputTokens != 0 || row.TotalTokens != 0 || row.SessionCount != 1 {
		t.Errorf("row = %+v", row)
	}
}

// The session report is a refinement, not a prerequisite: when it fails the
// daily tokens still go out with sessionCount=0 and a diagnostic says so.
func TestProviderReportsPartialCollectionWhenSessionCountsFail(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	errors := []string{}
	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("session") {
			return nil, fmt.Errorf("session timed out")
		}
		return provJSON(t, `{"data":[{"date":"2026-05-12","model":"gpt-5",
			"inputTokens":1,"outputTokens":2,"totalTokens":3}]}`), nil
	}}
	snapshots, err := Collect(context.Background(), Options{
		CodexHome: provHome(codexHome),
		StateDir:  t.TempDir(),
		Runner:    runner.run,
		Stderr:    func(line string) { errors = append(errors, line) },
		Env: provEnv(map[string]string{
			"TOKENBOARD_PACKAGE_MANAGER":      "",
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	got := snapshots[0]
	if got.Source != contract.SourceCodex || got.UsageDate != "2026-05-12" || got.Model != "gpt-5" ||
		got.TotalTokens != 3 || got.SessionCount != 0 {
		t.Errorf("snapshot = %+v", got)
	}
	want := []string{
		"Codex daily tokens collected, but session counts are unavailable; continuing with sessionCount=0: session timed out",
	}
	if len(errors) != len(want) || errors[0] != want[0] {
		t.Errorf("errors = %v, want %v", errors, want)
	}
}

// The rule set the provider prices with is the static table widened by the
// running catalogue. A model the catalogue prices but the static table does
// not must be repriced from its request-level usage; falling back to the
// default rules would leave it on ccusage's day-level cost, and the same
// machine would then produce a different snapshot than the TS collector.
func TestProviderPricesAModelTheCatalogueAdds(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	sessionPath := filepath.Join(codexHome, "sessions", "2026", "05", "20", "dynamic.jsonl")
	provWriteJSONL(t, sessionPath, provTokenEvent("2026-05-20T00:01:00.000Z", 20, "gpt-6-astra"))

	runner := &provStubRunner{t: t, respond: func(call provCall) (any, error) {
		if call.hasArg("daily") {
			return provJSON(t, `{"data":[{"date":"2026-05-20","models":{
				"gpt-6-astra":{"inputTokens":20,"outputTokens":0,"cacheCreationInputTokens":0,
				"cacheReadInputTokens":0,"totalTokens":20,"costUSD":0.001}}}]}`), nil
		}
		if call.hasArg("session") {
			return provJSON(t, `{"sessions":[{"directory":"2026/05/20","sessionFile":"dynamic",
				"lastActivity":"2026-05-20T00:01:00.000Z",
				"models":{"gpt-6-astra":{"inputTokens":20,"totalTokens":20}}}]}`), nil
		}
		return nil, fmt.Errorf("Unexpected ccusage command")
	}}
	fetcher := func(*http.Request) (*http.Response, error) {
		body := map[string]any{"models": []any{map[string]any{
			"provider":                 "openai",
			"modelId":                  "gpt-6-astra",
			"inputCostPerMillion":      5,
			"outputCostPerMillion":     30,
			"cacheReadCostPerMillion":  0.5,
			"cacheWriteCostPerMillion": 6.25,
			"contextWindow":            1_050_000,
			"maxInputTokens":           1_050_000,
			"pricing": map[string]any{"tiers": []any{
				map[string]any{
					"tier":        map[string]any{"type": "context", "size": float64(272_000)},
					"input":       float64(10),
					"output":      float64(45),
					"cache_read":  float64(1),
					"cache_write": float64(12),
				},
			}},
		}}, "nextCursor": nil}
		payload, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       io.NopCloser(bytes.NewReader(payload)),
		}, nil
	}

	var diagnostics []string
	snapshots, err := provCollect(t, Options{
		CodexHome:      provHome(codexHome),
		Timezone:       "UTC",
		CollectedAt:    "2026-05-20T01:00:00.000Z",
		Runner:         runner.run,
		PricingFetcher: fetcher,
		Stderr:         func(line string) { diagnostics = append(diagnostics, line) },
	}, map[string]string{
		"TOKENBOARD_ENDPOINT":      "https://tokenboard.example/api/v1/ingest",
		"TOKENBOARD_SINCE":         "",
		"TOKENBOARD_DEFAULT_SINCE": "",
		"TOKENBOARD_UNTIL":         "",
	})
	if err != nil {
		t.Fatal(err)
	}

	t.Logf("diagnostics: %v", diagnostics)
	got := provSnapshotFor(t, snapshots, "2026-05-20", "gpt-6-astra")
	// 20 fresh input tokens at 5/M from the catalogue row, not ccusage's 0.001.
	assertCloseTo(t, got.CostUSD, 20*5.0/1_000_000, 12)
	if got.TotalTokens != 20 {
		t.Errorf("total tokens = %d, want the session's 20", got.TotalTokens)
	}
}
