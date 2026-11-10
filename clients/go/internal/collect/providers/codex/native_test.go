package codex

// The native report source seam (S3, Task 8). These tests drive the whole
// provider pipeline - frozen scopes, session attribution, normalization,
// projections, hook cursors - with the in-process adapter standing in for the
// ccusage subprocess, and pin that the default path still runs ccusage.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	adapter "github.com/MisonL/TokenBoard/clients/go/internal/collect/adapters/codex"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
	"github.com/MisonL/TokenBoard/clients/go/internal/pricing"
)

// nativeExpectedSnapshots derives the fixture's snapshots along the path the
// pipeline is supposed to take after the report source: the adapter's daily and
// session reports, decoded to the ordered shape the runner hands over, through
// ccusage.NormalizeCcusageDailyJSON and the daily cost projection. It prices
// from the same prepared overrides Collect would use, so the comparison covers
// cost as well as tokens.
func nativeExpectedSnapshots(t *testing.T, codexHome string, collectedAt string) []contract.Snapshot {
	t.Helper()
	prepared, err := pricing.Prepare(pricing.PrepareInput{
		StateDir: t.TempDir(),
		Stderr:   func(string) {},
	})
	if err != nil {
		t.Fatalf("prepare pricing: %v", err)
	}
	scope := prepared.ResolveScope(pricing.Scope{Agent: "codex", Report: "daily"})
	corpus, err := nativepricing.LoadEmbeddedCorpus()
	if err != nil {
		t.Fatal(err)
	}
	if len(scope.Overrides) > 0 {
		corpus, err = corpus.WithOverrides(scope.Overrides)
		if err != nil {
			t.Fatalf("apply overrides: %v", err)
		}
	}
	env := func(key string) (string, bool) {
		if key == "CODEX_HOME" {
			return codexHome, true
		}
		return "", false
	}
	homes, err := adapter.HomePaths(env, func() (string, error) {
		return "", errors.New("no home")
	})
	if err != nil {
		t.Fatal(err)
	}
	sources := adapter.CollectDedupedSources(adapter.UsageSources(homes))
	speed := adapter.ResolveSpeedPolicy(codexSpeed(scope.Speed), homes)
	report := func(kind adapter.ReportKind) any {
		t.Helper()
		groups, err := adapter.LoadGroups(sources, kind, "UTC", "", "")
		if err != nil {
			t.Fatalf("load groups: %v", err)
		}
		encoded, err := json.Marshal(adapter.ReportJSON(groups, kind, &corpus, speed, codexCostMode(scope.Mode)))
		if err != nil {
			t.Fatalf("marshal report: %v", err)
		}
		decoded, err := ccusage.DecodeJSON(encoded)
		if err != nil {
			t.Fatalf("decode report: %v", err)
		}
		return decoded
	}
	snapshots, err := ccusage.NormalizeCcusageDailyJSON(report(adapter.ReportDaily), ccusage.NormalizeOptions{
		Source:      contract.SourceCodex,
		Timezone:    "UTC",
		CollectedAt: collectedAt,
		Sessions:    report(adapter.ReportSession),
		HasSessions: true,
	})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	projected, err := ProjectCodexDailyCosts(snapshots)
	if err != nil {
		t.Fatalf("project: %v", err)
	}
	return projected
}

// TestRegisterNativeAlwaysInstallsTheCodexProvider pins that the parity seam is
// registered unconditionally: LookupNative answers with a distinct native
// provider whether or not the switch is flipped.
func TestRegisterNativeAlwaysInstallsTheCodexProvider(t *testing.T) {
	provider, ok := collect.LookupNative(contract.SourceCodex)
	if !ok || provider == nil {
		t.Fatalf("collect.LookupNative(%q) = (%v, %v), want the native provider", contract.SourceCodex, provider, ok)
	}
	ccusageProvider, ok := collect.Lookup(contract.SourceCodex)
	if !ok || ccusageProvider == nil {
		t.Fatalf("collect.Lookup(%q) has no provider", contract.SourceCodex)
	}
	if reflect.TypeOf(provider) != reflect.TypeOf(nativeProvider{}) {
		t.Fatalf("native provider is %T, want %T", provider, nativeProvider{})
	}
	if reflect.TypeOf(provider) == reflect.TypeOf(ccusageProvider) {
		t.Fatalf("native and ccusage providers share type %T; the parity side must be a distinct implementation",
			reflect.TypeOf(provider))
	}
}

// TestUseNativeCodexSelectsTheNativeSource pins the switch's current state: the
// constant is true (S5, 2026-11-10), so Collect takes the in-process report
// source and the caller's ccusage runner is never invoked. An injected
// useNativeReport = false still asks for the ccusage path, which is how the
// parity harness keeps exercising it.
func TestUseNativeCodexSelectsTheNativeSource(t *testing.T) {
	if !useNativeCodex {
		t.Fatal("useNativeCodex is false; the native path regressed to the ccusage source")
	}
	codexHome := provEmptyCodexHome(t)
	runner := &provStubRunner{t: t, respond: func(provCall) (any, error) {
		return provJSON(t, `{"data":[]}`), nil
	}}
	if _, err := provCollect(t, Options{
		CodexHome:   provHome(codexHome),
		Timezone:    "UTC",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		Runner:      runner.run,
	}, nil); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("calls = %v, want none: the native source must not invoke ccusage", runner.calls)
	}
}

// nativeFixtureSession writes one Codex session carrying a single token event.
func nativeFixtureSession(t *testing.T, codexHome string) {
	t.Helper()
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "22", "session.jsonl"),
		provHookEvent("2026-05-22T01:00:00.000Z", 10, 5, 0.03))
}

// TestNativeBoundedReportFindsThePrunedParentOfAFork pins the bounded replay
// wiring: the nightly run passes a window, the fork's parent log falls outside
// it, and the child's copied prefix must still be recognised as a replay (it is
// in the report only once, so the fork does not bill its parent's tokens again).
// A native source that handed the replay plan only the windowed files would
// count the prefix a second time.
func TestNativeBoundedReportFindsThePrunedParentOfAFork(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	parentPath := filepath.Join(codexHome, "sessions", "2026", "05", "20", "rollout-parent.jsonl")
	childPath := filepath.Join(codexHome, "sessions", "2026", "05", "22", "rollout-child.jsonl")
	provWriteJSONL(t, parentPath,
		map[string]any{"type": "session_meta", "timestamp": "2026-05-20T00:00:00.000Z",
			"payload": map[string]any{"id": "parent"}},
		provHookEvent("2026-05-20T01:00:00.000Z", 100, 10, 0.1),
	)
	provWriteJSONL(t, childPath,
		map[string]any{"type": "session_meta", "timestamp": "2026-05-22T00:00:00.000Z",
			"payload": map[string]any{"id": "child", "forked_from_id": "parent"}},
		provHookEvent("2026-05-20T01:00:00.000Z", 100, 10, 0.1),
		provHookEvent("2026-05-22T01:00:00.000Z", 7, 3, 0.05),
	)
	// The parent log is older than the window, so the forward eligibility
	// filter drops it from the child set but keeps it as available.
	parentTime := time.Date(2026, 5, 20, 2, 0, 0, 0, time.UTC)
	if err := os.Chtimes(parentPath, parentTime, parentTime); err != nil {
		t.Fatal(err)
	}
	snapshots, err := nativeCollect(context.Background(), Options{
		CodexHome:   provHome(codexHome),
		StateDir:    t.TempDir(),
		Timezone:    "UTC",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		Since:       "20260522",
		Until:       "20260522",
		Env:         provEnv(nil),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v, want the child's 2026-05-22 row", snapshots)
	}
	got := snapshots[0]
	if got.UsageDate != "2026-05-22" || got.InputTokens != 7 || got.OutputTokens != 3 {
		t.Fatalf("snapshot = %+v, want only the post-fork event", got)
	}
}

// TestNativeCollectMatchesNormalizePipeline runs the native entry end to end
// and checks that the pipeline reads exactly the adapter's report: the same
// tokens, session count and per-model cost the ccusage-shaped document carries.
// The expected values are derived independently - the adapter's reports pushed
// through ccusage.NormalizeCcusageDailyJSON and the daily cost projection - so a
// wiring mistake (a missing session report, a wrong report kind) fails here.
func TestNativeCollectMatchesNormalizePipeline(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	nativeFixtureSession(t, codexHome)
	collectedAt := "2026-05-22T10:00:00.000Z"
	options := Options{
		CodexHome:   provHome(codexHome),
		StateDir:    t.TempDir(),
		Timezone:    "UTC",
		CollectedAt: collectedAt,
		Env:         provEnv(nil),
	}

	snapshots, err := nativeCollect(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v, want one", snapshots)
	}
	got := snapshots[0]
	if got.Source != contract.SourceCodex || got.UsageDate != "2026-05-22" || got.Model != "gpt-5" {
		t.Fatalf("snapshot = %+v, want codex/gpt-5 on 2026-05-22", got)
	}
	if got.InputTokens != 10 || got.OutputTokens != 5 || got.TotalTokens != 15 || got.SessionCount != 1 {
		t.Fatalf("snapshot = %+v, want the fixture's tokens and one session", got)
	}
	if got.CostUSD <= 0 {
		t.Fatalf("costUSD = %v, want the model priced from the corpus", got.CostUSD)
	}

	// The same fixture through the pipeline's own normalizer must agree
	// field for field.
	expected := nativeExpectedSnapshots(t, codexHome, collectedAt)
	if len(expected) != len(snapshots) {
		t.Fatalf("expected %+v, got %+v", expected, snapshots)
	}
	for index := range expected {
		if expected[index] != snapshots[index] {
			t.Fatalf("snapshot %d = %+v, want %+v", index, snapshots[index], expected[index])
		}
	}
}

// TestNativeHookRecomputesAndReconcilesTheSameWindow pins §6.1.3 on the native
// path: the incremental cursor scan runs as before, the whole-window recompute
// runs the same in-process implementation, the reconciliation assertion passes,
// and neither ccusage nor its binary is consulted.
func TestNativeHookRecomputesAndReconcilesTheSameWindow(t *testing.T) {
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex")
	nativeFixtureSession(t, codexHome)
	neverRuns := func(context.Context, string, []string, ccusage.CommandOptions) (any, error) {
		t.Error("native hook mode must not run ccusage")
		return nil, os.ErrClosed
	}
	resolveBinary := func(ccusage.AcquireOptions) (ccusage.Binary, error) {
		t.Error("native hook mode must not resolve a ccusage binary")
		return ccusage.Binary{}, os.ErrClosed
	}
	options := Options{
		CodexHome:     provHome(codexHome),
		StateDir:      filepath.Join(root, "state"),
		Timezone:      "UTC",
		CollectedAt:   "2026-05-22T10:00:00.000Z",
		Runner:        neverRuns,
		ResolveBinary: resolveBinary,
		Env:           provEnv(map[string]string{"TOKENBOARD_HOOK_MODE": "1"}),
	}

	snapshots, err := nativeCollect(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("hook snapshots = %+v, want the recomputed fixture", snapshots)
	}
	if got := snapshots[0]; got.UsageDate != "2026-05-22" || got.Model != "gpt-5" ||
		got.InputTokens != 10 || got.OutputTokens != 5 || got.SessionCount != 1 {
		t.Fatalf("hook snapshot = %+v, want the fixture's tokens and one session", got)
	}

	// The CLI uploads and then acknowledges; once acknowledged, an unchanged
	// tree must produce no work at all.
	if err := sessioncursor.AcknowledgePendingUploads(sessioncursor.AcknowledgeInput{
		StateDir:           options.StateDir,
		Source:             contract.SourceCodex,
		AcknowledgedGroups: map[string]bool{"codex\x002026-05-22\x00UTC\x00gpt-5": true},
	}); err != nil {
		t.Fatal(err)
	}
	options.CollectedAt = "2026-05-22T10:05:00.000Z"
	again, err := nativeCollect(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != 0 {
		t.Fatalf("second hook run = %+v, want no changed window", again)
	}
}

// TestNativeCollectReturnsEmptyForAnEmptyWindow pins the empty-window contract:
// a window that excludes every session yields no snapshots and no error, the
// same result ccusage's empty report produces.
func TestNativeCollectReturnsEmptyForAnEmptyWindow(t *testing.T) {
	codexHome := provEmptyCodexHome(t)
	nativeFixtureSession(t, codexHome)
	snapshots, err := nativeCollect(context.Background(), Options{
		CodexHome:   provHome(codexHome),
		StateDir:    t.TempDir(),
		Timezone:    "UTC",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		Since:       "20260601",
		Until:       "20260602",
		Env:         provEnv(nil),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 0 {
		t.Fatalf("snapshots = %+v, want none outside the window", snapshots)
	}
}

// TestNativeReportBillsAtTheConfiguredCodexSpeed pins the `speed` wiring: the
// runner must resolve the tier from the pricing config's option maps (the same
// way ccusage's apply_config_to_agent_args does) instead of always detecting
// it from config.toml. Without this, a config that names `speed: "fast"` gets
// one cost from ccusage and another from the in-process pricer. gpt-5.5 carries
// a 2.5x fast multiplier in the embedded corpus, so the forced tier is visible
// in costUSD.
func TestNativeReportBillsAtTheConfiguredCodexSpeed(t *testing.T) {
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex")
	provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "22", "session.jsonl"),
		map[string]any{
			"type":      "event_msg",
			"timestamp": "2026-05-22T01:00:00.000Z",
			"payload": map[string]any{
				"type": "token_count",
				"info": map[string]any{
					"model": "gpt-5.5",
					"last_token_usage": map[string]any{
						"input_tokens":  1000,
						"output_tokens": 500,
						"total_tokens":  1500,
						"cost_usd":      0.03,
					},
				},
			},
		})

	auto := nativeReportCost(t, codexHome, "")
	if auto <= 0 {
		t.Fatalf("auto cost = %v, want the fixture's standard-tier cost", auto)
	}

	configPath := filepath.Join(root, "ccusage.json")
	if err := os.WriteFile(configPath, []byte(`{"codex":{"defaults":{"speed":"fast"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	fast := nativeReportCost(t, codexHome, configPath)
	if ratio := fast / auto; ratio < 2.49 || ratio > 2.51 {
		t.Fatalf("fast/auto cost ratio = %v (auto %v, fast %v), want the 2.5x fast multiplier", ratio, auto, fast)
	}
}

// nativeReportCost runs one `codex daily --json` through the native runner with
// the given explicit pricing config ("" for none) and returns the report's
// costUSD.
func nativeReportCost(t *testing.T, codexHome, explicitConfig string) float64 {
	t.Helper()
	prepared, err := pricing.Prepare(pricing.PrepareInput{
		StateDir:       t.TempDir(),
		Stderr:         func(string) {},
		ExplicitConfig: explicitConfig,
	})
	if err != nil {
		t.Fatalf("prepare pricing: %v", err)
	}
	runner := newNativeReportRunner(prepared)
	decoded, err := runner.Run(context.Background(), "ccusage",
		[]string{"codex", "daily", "--json", "--config", prepared.ConfigPath},
		ccusage.CommandOptions{Env: []string{"CODEX_HOME=" + codexHome}})
	if err != nil {
		t.Fatalf("native report: %v", err)
	}
	document, ok := decoded.(ccusage.OrderedObject)
	if !ok {
		t.Fatalf("report = %T, want an ordered record", decoded)
	}
	rowsValue, ok := document.Get("daily")
	if !ok {
		t.Fatal("report has no daily rows")
	}
	rows, ok := rowsValue.([]any)
	if !ok || len(rows) != 1 {
		t.Fatalf("daily = %#v, want one row", rowsValue)
	}
	row, ok := rows[0].(ccusage.OrderedObject)
	if !ok {
		t.Fatalf("daily row = %#v, want an ordered record", rows[0])
	}
	costValue, ok := row.Get("costUSD")
	if !ok {
		t.Fatal("daily row has no costUSD")
	}
	var cost float64
	switch number := costValue.(type) {
	case json.Number:
		cost, err = number.Float64()
		if err != nil {
			t.Fatal(err)
		}
	case float64:
		cost = number
	default:
		t.Fatalf("costUSD = %#v, want a number", costValue)
	}
	return cost
}

// TestNativeReportHonoursTheCommandTimeout pins the TimeoutMs contract: the
// ccusage subprocess path kills the child at the prepared budget
// (TOKENBOARD_CODEX_DAILY_TIMEOUT_MS), and the in-process source has no process
// to kill, so the budget must become a deadline on the scan instead of being
// dropped. The fixture is far larger than one millisecond of parsing, so a
// runner that ignores TimeoutMs cannot finish inside it.
func TestNativeReportHonoursTheCommandTimeout(t *testing.T) {
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex")
	for fileIndex := 0; fileIndex < 100; fileIndex++ {
		events := make([]map[string]any, 0, 2000)
		for eventIndex := 0; eventIndex < 2000; eventIndex++ {
			events = append(events, map[string]any{
				"model":     "gpt-5.5",
				"timestamp": "2026-05-22T01:00:00Z",
				"usage":     map[string]any{"input_tokens": 1000, "output_tokens": 500},
			})
		}
		provWriteJSONL(t, filepath.Join(codexHome, "sessions", "2026", "05", "22",
			fmt.Sprintf("session-%03d.jsonl", fileIndex)), events...)
	}

	prepared, err := pricing.Prepare(pricing.PrepareInput{StateDir: t.TempDir(), Stderr: func(string) {}})
	if err != nil {
		t.Fatalf("prepare pricing: %v", err)
	}
	runner := newNativeReportRunner(prepared)
	_, err = runner.Run(context.Background(), "ccusage",
		[]string{"codex", "daily", "--json", "--config", prepared.ConfigPath},
		ccusage.CommandOptions{Env: []string{"CODEX_HOME=" + codexHome}, TimeoutMs: 1})
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("err = %v, want the ccusage timeout line", err)
	}
}
