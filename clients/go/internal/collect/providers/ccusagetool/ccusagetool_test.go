// Port of providers/ccusage-tools.test.ts. The TS suite drives the provider
// through a recording package runner; here the same observable arguments come
// from TOKENBOARD_CCUSAGE_BIN pointing at a real file, which resolves to the
// local runner whose RunPackageArgs forwards the provider's arguments
// untouched — the same shape the TS stub returns.

package ccusagetool

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

const (
	testTimezone    = "Asia/Shanghai"
	testCollectedAt = "2026-10-14T10:00:00.000Z"
)

// testRunner records each invocation's arguments and answers from a map keyed
// by the joined arguments, failing the way the TS recorder does on an
// unexpected command.
type testRunner struct {
	t         *testing.T
	responses map[string]any
	calls     []string
	commands  []string
}

func (r *testRunner) run(_ context.Context, command string, args []string, _ ccusage.CommandOptions) (any, error) {
	key := strings.Join(args, " ")
	r.calls = append(r.calls, key)
	r.commands = append(r.commands, command)
	response, ok := r.responses[key]
	if !ok {
		r.t.Fatalf("unexpected command: %s", key)
	}
	return response, nil
}

// ordered decodes a JSON fixture with the runner's conventions so the provider
// sees the same ordered records a real ccusage run produces.
func ordered(t *testing.T, text string) any {
	t.Helper()
	value, err := ccusage.DecodeOrderedJSON([]byte(text))
	if err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	return value
}

func dailyReport(t *testing.T, date string) any {
	t.Helper()
	return ordered(t, `{"daily":[{
		"date": "`+date+`",
		"inputTokens": 100,
		"outputTokens": 20,
		"cacheCreationTokens": 5,
		"cacheReadTokens": 10,
		"totalTokens": 135,
		"totalCost": 0.25,
		"modelsUsed": ["test-model"],
		"modelBreakdowns": [{
			"modelName": "test-model",
			"inputTokens": 100,
			"outputTokens": 20,
			"cacheCreationTokens": 5,
			"cacheReadTokens": 10,
			"totalTokens": 135,
			"cost": 0.25
		}]
	}]}`)
}

func sessionReport(t *testing.T, sessionID string, lastActivity string) any {
	t.Helper()
	dateField := ""
	if lastActivity != "" {
		dateField = `"lastActivity": "` + lastActivity + `",`
	}
	return ordered(t, `{"sessions":[{
		"sessionId": "`+sessionID+`",
		`+dateField+`
		"inputTokens": 50,
		"outputTokens": 10,
		"cacheCreationTokens": 0,
		"cacheReadTokens": 0,
		"totalTokens": 60,
		"totalCost": 0.05,
		"modelsUsed": ["test-model"],
		"modelBreakdowns": []
	}]}`)
}

// toolEnv points the package runner at a real file so it selects the local
// runner, whose argument list is exactly what the provider built.
func toolEnv(t *testing.T) map[string]string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "ccusage")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return map[string]string{"TOKENBOARD_CCUSAGE_BIN": binary}
}

func envFunc(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func collectTool(t *testing.T, source contract.Source, runner *testRunner, options Options) []contract.Snapshot {
	t.Helper()
	if options.Env == nil {
		options.Env = envFunc(toolEnv(t))
	}
	if options.Timezone == "" {
		options.Timezone = testTimezone
	}
	if options.CollectedAt == "" {
		options.CollectedAt = testCollectedAt
	}
	options.Runner = runner.run
	snapshots, err := Collect(context.Background(), source, options)
	if err != nil {
		t.Fatal(err)
	}
	return snapshots
}

// TestCoversEveryCcusageToolSource guards the two hand-written lists against
// drifting apart: every source the contract exposes as a ccusage tool has a
// subcommand, and the family stays inside the contract's closed source set.
func TestCoversEveryCcusageToolSource(t *testing.T) {
	sources := contract.CcusageToolSources()
	if len(sources) != 12 {
		t.Fatalf("ccusage tool sources = %v, want the twelve-tool family", sources)
	}
	valid := map[contract.Source]bool{}
	for _, source := range contract.AllSources() {
		valid[source] = true
	}
	for _, source := range sources {
		command, ok := contract.CcusageToolCommand(source)
		if !ok || command == "" {
			t.Errorf("CcusageToolCommand(%q) = %q, %v", source, command, ok)
		}
		if !valid[source] {
			t.Errorf("%q is not in AllSources", source)
		}
	}
	// The provider registers one collector per source, so the CLI's all-source
	// run reaches each of them instead of reporting "not implemented".
	for _, source := range sources {
		if _, ok := collect.Lookup(source); !ok {
			t.Errorf("no provider registered for %q", source)
		}
	}
}

func TestCollectsDailySnapshotsWithSessionCountsPerToolSubcommand(t *testing.T) {
	runner := &testRunner{t: t, responses: map[string]any{
		"amp daily --json --timezone Asia/Shanghai":   dailyReport(t, "2026-10-13"),
		"amp session --json --timezone Asia/Shanghai": sessionReport(t, "s1", "2026-10-13T01:00:00Z"),
	}}
	snapshots := collectTool(t, contract.SourceAmp, runner, Options{})

	wantCalls := []string{
		"amp daily --json --timezone Asia/Shanghai",
		"amp session --json --timezone Asia/Shanghai",
	}
	if strings.Join(runner.calls, "\n") != strings.Join(wantCalls, "\n") {
		t.Fatalf("calls = %v, want %v", runner.calls, wantCalls)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	got := snapshots[0]
	want := contract.Snapshot{
		Source:        contract.SourceAmp,
		UsageDate:     "2026-10-13",
		Timezone:      testTimezone,
		Model:         "test-model",
		InputTokens:   100,
		OutputTokens:  20,
		CacheCreation: 5,
		CacheRead:     10,
		TotalTokens:   135,
		CostUSD:       0.25,
		SessionCount:  1,
		CollectedAt:   testCollectedAt,
	}
	if got != want {
		t.Errorf("snapshot = %+v, want %+v", got, want)
	}
}

func TestKeepsSessionCountAtZeroWhenTheSessionReportCarriesNoDates(t *testing.T) {
	runner := &testRunner{t: t, responses: map[string]any{
		"amp daily --json --timezone Asia/Shanghai":   dailyReport(t, "2026-10-13"),
		"amp session --json --timezone Asia/Shanghai": sessionReport(t, "s-no-date", ""),
	}}
	snapshots := collectTool(t, contract.SourceAmp, runner, Options{})
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	if snapshots[0].SessionCount != 0 {
		t.Errorf("sessionCount = %d, want 0", snapshots[0].SessionCount)
	}
}

func TestUsesTheGeminiSubcommandForGeminiCLI(t *testing.T) {
	runner := &testRunner{t: t, responses: map[string]any{
		"gemini daily --json --timezone Asia/Shanghai":   dailyReport(t, "2026-10-13"),
		"gemini session --json --timezone Asia/Shanghai": ordered(t, `{"sessions": []}`),
	}}
	collectTool(t, contract.SourceGeminiCLI, runner, Options{})
	want := []string{
		"gemini daily --json --timezone Asia/Shanghai",
		"gemini session --json --timezone Asia/Shanghai",
	}
	if strings.Join(runner.calls, "\n") != strings.Join(want, "\n") {
		t.Fatalf("calls = %v, want %v", runner.calls, want)
	}
}

func TestPassesSinceAndUntilThroughToBothSubcommands(t *testing.T) {
	window := "--since 2026-10-09 --until 2026-10-10 --timezone Asia/Shanghai"
	runner := &testRunner{t: t, responses: map[string]any{
		"kimi daily --json " + window:   dailyReport(t, "2026-10-09"),
		"kimi session --json " + window: ordered(t, `{"sessions": []}`),
	}}
	snapshots := collectTool(t, contract.SourceKimi, runner, Options{Since: "2026-10-09", Until: "2026-10-10"})
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	if !strings.Contains(runner.calls[0], "--since 2026-10-09") || !strings.Contains(runner.calls[0], "--until 2026-10-10") {
		t.Errorf("daily args = %q, want the resolved window", runner.calls[0])
	}
	if !strings.Contains(runner.calls[1], "--since 2026-10-09") || !strings.Contains(runner.calls[1], "--until 2026-10-10") {
		t.Errorf("session args = %q, want the resolved window", runner.calls[1])
	}
}

func TestReturnsEmptySnapshotsForAnEmptyDailyReport(t *testing.T) {
	runner := &testRunner{t: t, responses: map[string]any{
		"droid daily --json --timezone Asia/Shanghai": ordered(t, `{"daily": []}`),
	}}
	snapshots := collectTool(t, contract.SourceDroid, runner, Options{})
	if len(snapshots) != 0 {
		t.Fatalf("snapshots = %+v, want none", snapshots)
	}
}

// ccusage exits 0 with an empty daily report for a tool that is not installed,
// so most machines would pay the second spawn for nothing on every run.
func TestSkipsTheSessionReportWhenTheDailyReportIsEmpty(t *testing.T) {
	runner := &testRunner{t: t, responses: map[string]any{
		"zcode daily --json --timezone Asia/Shanghai": ordered(t, `{"daily": [], "totals": null}`),
	}}
	snapshots := collectTool(t, contract.SourceZcode, runner, Options{})
	if len(snapshots) != 0 {
		t.Fatalf("snapshots = %+v, want none", snapshots)
	}
	want := []string{"zcode daily --json --timezone Asia/Shanghai"}
	if strings.Join(runner.calls, "\n") != strings.Join(want, "\n") {
		t.Fatalf("calls = %v, want %v", runner.calls, want)
	}
}

func TestRejectsASourceOutsideTheCcusageToolFamily(t *testing.T) {
	runner := &testRunner{t: t, responses: map[string]any{}}
	_, err := Collect(context.Background(), contract.SourceDeepSeekHarness, Options{Runner: runner.run})
	if err == nil || !strings.Contains(err.Error(), "not a ccusage tool source") {
		t.Fatalf("error = %v, want the non-tool rejection", err)
	}
	if len(runner.calls) != 0 {
		t.Errorf("calls = %v, want none", runner.calls)
	}
}

func TestRejectsAnInvalidWindow(t *testing.T) {
	runner := &testRunner{t: t, responses: map[string]any{}}
	_, err := Collect(context.Background(), contract.SourceAmp, Options{
		Since:  "2026-10-10",
		Until:  "2026-10-09",
		Runner: runner.run,
	})
	if err == nil || !strings.Contains(err.Error(), "since date must not be after until date") {
		t.Fatalf("error = %v, want the reversed-window rejection", err)
	}
	if len(runner.calls) != 0 {
		t.Errorf("calls = %v, want none", runner.calls)
	}
}
