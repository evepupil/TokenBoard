package main

// The harness-fidelity contract for bench-collect: the ccusage side runs with
// the merged pricing config and the native side runs in the same state
// directory, and the report says what was measured.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/pricing"
)

// offlinePrepare is the real Prepare pinned offline: the endpoint, the explicit
// config and the fetcher are cleared so a test never reaches the developer's
// own server through an ambient TOKENBOARD_ENDPOINT.
func offlinePrepare(input pricing.PrepareInput) (pricing.PreparedConfig, error) {
	input.Endpoint = ""
	input.ExplicitConfig = ""
	input.Fetcher = nil
	return pricing.Prepare(input)
}

// noAmbientConfig clears the pricing variables from the environment a
// benchmark reads.
func noAmbientConfig(key string) string {
	switch key {
	case "TOKENBOARD_ENDPOINT", "TOKENBOARD_CCUSAGE_CONFIG":
		return ""
	}
	return os.Getenv(key)
}

// fakeBenchMarkers builds a benchInput that measures without a binary, a
// native provider or a real collection. offlinePrepare is the seam, so a test
// that overrides Env cannot accidentally reach the developer's own catalogue.
func fakeBenchMarkers(ccusage roundRunner, native roundRunner) benchInput {
	return benchInput{
		Source:         contract.SourceClaudeCode,
		Scenario:       scenarioSingle,
		Rounds:         minRounds,
		Timezone:       "UTC",
		Now:            func() time.Time { return time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC) },
		Env:            noAmbientConfig,
		Prepare:        offlinePrepare,
		CollectCcusage: ccusage,
		CollectNative:  native,
	}
}

// TestBenchGivesBothSidesThePreparedConfigAndOneStateDirectory pins the two
// halves together: every round of both sides gets the config path the run
// prepared and the state directory that config lives in, the file exists while
// the rounds run, and the directory is removed afterwards.
func TestBenchGivesBothSidesThePreparedConfigAndOneStateDirectory(t *testing.T) {
	var ccusageRequests, nativeRequests []roundRequest
	report, err := runBench(context.Background(), fakeBenchMarkers(
		func(_ context.Context, request roundRequest) (roundResult, error) {
			ccusageRequests = append(ccusageRequests, request)
			return roundResult{WallMs: 10, RSSSource: rssSourceWait4, Calls: 2}, nil
		},
		func(_ context.Context, request roundRequest) (roundResult, error) {
			nativeRequests = append(nativeRequests, request)
			return roundResult{WallMs: 5, RSSSource: rssSourceSelf, Calls: 1}, nil
		},
	))
	if err != nil {
		t.Fatalf("runBench: %v", err)
	}
	if len(ccusageRequests) != minRounds || len(nativeRequests) != minRounds {
		t.Fatalf("rounds = %d/%d, want %d/%d", len(ccusageRequests), len(nativeRequests), minRounds, minRounds)
	}
	first := ccusageRequests[0]
	if first.ConfigPath == "" {
		t.Fatal("ccusage round carries no config path; it would price from ccusage's built-in catalogue")
	}
	if _, err := os.Stat(first.ConfigPath); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("prepared config %s survived the run (err = %v)", first.ConfigPath, err)
	}
	for _, request := range append(append([]roundRequest{}, ccusageRequests...), nativeRequests...) {
		if request.ConfigPath != first.ConfigPath {
			t.Errorf("config path = %q, want every round to share %q", request.ConfigPath, first.ConfigPath)
		}
		if request.StateDir != first.StateDir {
			t.Errorf("state dir = %q, want every round to share %q", request.StateDir, first.StateDir)
		}
	}
	if got := filepath.Dir(first.ConfigPath); got != first.StateDir {
		t.Errorf("config lives in %q but the native side ran in %q; both sides must share one state directory", got, first.StateDir)
	}
	if report.CcusageConfigPath != first.ConfigPath || report.PricingSource != "static" {
		t.Errorf("report = (config %q, source %q), want (%q, static)", report.CcusageConfigPath, report.PricingSource, first.ConfigPath)
	}
	if !report.CcusageNetworkAllowed {
		t.Error("ccusageNetworkAllowed = false for claude-code; production runs it without --offline")
	}
}

// TestBenchCcusageArgvCarriesThePreparedConfig drives the real ccusage argv
// table: each report ends with `--config <path>`, and an empty path adds no
// flag.
func TestBenchCcusageArgvCarriesThePreparedConfig(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "ccusage.dynamic.json")
	day := collectWindow{Since: "20261103", Until: "20261103"}
	calls, err := ccusageCalls(contract.SourceClaudeCode, day, "UTC", configPath)
	if err != nil {
		t.Fatalf("ccusageCalls: %v", err)
	}
	if len(calls) != 2 {
		t.Fatalf("calls = %d, want 2", len(calls))
	}
	for index, args := range calls {
		if len(args) < 2 || args[len(args)-2] != "--config" || args[len(args)-1] != configPath {
			t.Errorf("call %d = %q, want it to end with --config %s", index+1, args, configPath)
		}
	}

	withoutConfig, err := ccusageCalls(contract.SourceClaudeCode, day, "UTC", "")
	if err != nil {
		t.Fatalf("ccusageCalls(no config): %v", err)
	}
	for _, args := range withoutConfig {
		for _, arg := range args {
			if arg == "--config" {
				t.Fatalf("empty config path produced %q; production adds no flag in that case", args)
			}
		}
	}
}

// TestBenchFailsWhenThePricingConfigCannotBePrepared keeps a broken config from
// becoming a measurement of some other command.
func TestBenchFailsWhenThePricingConfigCannotBePrepared(t *testing.T) {
	t.Run("malformed explicit config", func(t *testing.T) {
		explicit := filepath.Join(t.TempDir(), "broken.json")
		if err := os.WriteFile(explicit, []byte("[not an object"), 0o600); err != nil {
			t.Fatalf("write explicit config: %v", err)
		}
		// Not using fakeBenchMarkers (which hardcodes offlinePrepare that would
		// clear ExplicitConfig before Prepare sees it). Build the input
		// explicitly so the explicit config reaches Prepare.
		input := benchInput{
			Source:   contract.SourceClaudeCode,
			Scenario: scenarioSingle,
			Rounds:   minRounds,
			Timezone: "UTC",
			Now:      func() time.Time { return time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC) },
			Env: func(key string) string {
				if key == "TOKENBOARD_CCUSAGE_CONFIG" {
					return explicit
				}
				return noAmbientConfig(key)
			},
			CollectCcusage: func(context.Context, roundRequest) (roundResult, error) {
				t.Fatal("a ccusage round ran without the merged config")
				return roundResult{}, nil
			},
			CollectNative: func(context.Context, roundRequest) (roundResult, error) {
				t.Fatal("a native round ran without the merged config")
				return roundResult{}, nil
			},
		}
		_, err := runBench(context.Background(), input)
		if err == nil || !strings.Contains(err.Error(), "pricing config") {
			t.Fatalf("error = %v, want a pricing config failure", err)
		}
	})

	t.Run("prepare failure seam", func(t *testing.T) {
		sentinel := errors.New("catalogue is unreadable")
		input := fakeBenchMarkers(nil, nil)
		input.Prepare = func(pricing.PrepareInput) (pricing.PreparedConfig, error) {
			return pricing.PreparedConfig{}, sentinel
		}
		_, err := runBench(context.Background(), input)
		if !errors.Is(err, sentinel) {
			t.Fatalf("error = %v, want the prepare failure to surface verbatim", err)
		}
	})
}

// TestBenchReportRecordsTheNetworkPolicy pins the honest-report requirement on
// both output modes: the JSON says whether ccusage could reach the network, and
// the text report says so too.
func TestBenchReportRecordsTheNetworkPolicy(t *testing.T) {
	for _, source := range []contract.Source{contract.SourceClaudeCode, contract.SourceCodex} {
		t.Run(string(source), func(t *testing.T) {
			input := fakeBenchMarkers(
				func(context.Context, roundRequest) (roundResult, error) {
					return roundResult{WallMs: 10, RSSSource: rssSourceWait4, Calls: 2}, nil
				},
				func(context.Context, roundRequest) (roundResult, error) {
					return roundResult{}, errNoNativeProvider
				},
			)
			input.Source = source
			var stdout, stderr bytes.Buffer
			code := runWith([]string{"-source", string(source), "-scenario", "single", "-json"},
				&stdout, &stderr, input)
			if code != exitOK {
				t.Fatalf("exit = %d, want 0 (stderr: %s)", code, stderr.String())
			}
			var report benchReport
			if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
				t.Fatalf("decode JSON report: %v\n%s", err, stdout.String())
			}
			wantNetwork := source == contract.SourceClaudeCode
			if report.CcusageNetworkAllowed != wantNetwork {
				t.Errorf("ccusageNetworkAllowed = %v, want %v for %s",
					report.CcusageNetworkAllowed, wantNetwork, source)
			}
			if report.CcusageConfigPath == "" {
				t.Error("ccusageConfigPath is empty; the report must name the config both sides ran under")
			}

			var text bytes.Buffer
			writeTextReport(&text, report)
			if !strings.Contains(text.String(), "ccusageNetwork=") {
				t.Errorf("text report hides the network policy:\n%s", text.String())
			}
		})
	}
}

// TestBenchStateDirectoryIsSharedWithTheRealProviderPath proves the default
// wiring, not just the seam: collectNativeRound hands the provider exactly the
// run's state directory, so its own pricing preparation resolves that
// directory's catalogue cache rather than a second one. A fresh os.MkdirTemp
// inside the round (the regression) would hand it a different path.
func TestBenchStateDirectoryIsSharedWithTheRealProviderPath(t *testing.T) {
	restore := lookupNativeProvider
	recorder := &stateDirRecorder{}
	lookupNativeProvider = func(contract.Source) (collect.Provider, bool) { return recorder, true }
	defer func() { lookupNativeProvider = restore }()

	stateDir := t.TempDir()
	if _, err := collectNativeRound(context.Background(), roundRequest{
		Source:   contract.SourceClaudeCode,
		StateDir: stateDir,
		Timezone: "UTC",
		Scenario: scenarioSingle,
	}); err != nil {
		t.Fatalf("collectNativeRound: %v", err)
	}
	if recorder.stateDir != stateDir {
		t.Fatalf("provider state dir = %q, want the run's %q", recorder.stateDir, stateDir)
	}
	if _, err := os.Stat(stateDir); err != nil {
		t.Fatalf("the round removed the run's state directory: %v", err)
	}

	if _, err := collectNativeRound(context.Background(), roundRequest{
		Source:   contract.SourceClaudeCode,
		Timezone: "UTC",
		Scenario: scenarioSingle,
	}); err == nil || !strings.Contains(err.Error(), "no state directory") {
		t.Fatalf("missing state directory = %v, want a hard error instead of a second temp directory", err)
	}
	if recorder.calls != 1 {
		t.Errorf("provider ran %d time(s) without a state directory, want 0", recorder.calls)
	}
}

// stateDirRecorder records the options a native round hands its provider.
type stateDirRecorder struct {
	calls    int
	stateDir string
}

func (r *stateDirRecorder) Collect(_ context.Context, options collect.Options) ([]contract.Snapshot, error) {
	r.calls++
	r.stateDir = options.StateDir
	return nil, nil
}

// TestResetHookCursorClearsTheBenchmarkDirectory pins the hook-scenario reset:
// every round must see a cold cursor, and only this run's cursor files may be
// touched.
func TestResetHookCursorClearsTheBenchmarkDirectory(t *testing.T) {
	stateDir := t.TempDir()
	cursor := filepath.Join(stateDir, sessioncursor.FileName(contract.SourceClaudeCode, ""))
	other := filepath.Join(stateDir, sessioncursor.FileName(contract.SourceCodex, ""))
	keep := filepath.Join(stateDir, pricing.CacheFileName)
	for _, path := range []string{cursor, other, keep} {
		if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}
	if err := resetHookCursor(stateDir, contract.SourceClaudeCode); err != nil {
		t.Fatalf("resetHookCursor: %v", err)
	}
	if _, err := os.Stat(cursor); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("claude cursor survived the reset (err = %v)", err)
	}
	for _, path := range []string{other, keep} {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("resetHookCursor removed %s: %v", path, err)
		}
	}
	// A second reset over an empty directory is not an error.
	if err := resetHookCursor(stateDir, contract.SourceClaudeCode); err != nil {
		t.Fatalf("second resetHookCursor: %v", err)
	}
	if err := resetHookCursor(stateDir, contract.SourceKimi); err == nil {
		t.Error("resetHookCursor(kimi) = nil error, want a usage error for a source with no hook cursor")
	}
}

// TestBenchEmptyExplicitConfigStillWritesAConfig covers an empty
// TOKENBOARD_CCUSAGE_CONFIG: Prepare materializes the bundled config, so the
// ccusage side still gets a real, readable file rather than falling back to its
// built-in prices.
func TestBenchEmptyExplicitConfigStillWritesAConfig(t *testing.T) {
	var configPath string
	report, err := runBench(context.Background(), fakeBenchMarkers(
		func(_ context.Context, request roundRequest) (roundResult, error) {
			configPath = request.ConfigPath
			if info, err := os.Stat(configPath); err != nil || !info.Mode().IsRegular() {
				t.Errorf("prepared config %q is not a readable file during the round: %v", configPath, err)
			}
			return roundResult{WallMs: 1, RSSSource: rssSourceWait4, Calls: 2}, nil
		},
		func(context.Context, roundRequest) (roundResult, error) {
			return roundResult{}, errNoNativeProvider
		},
	))
	if err != nil {
		t.Fatalf("runBench: %v", err)
	}
	if configPath == "" {
		t.Fatal("empty explicit config produced no config path")
	}
	if report.PricingSource != "static" {
		t.Errorf("pricingSource = %q, want static", report.PricingSource)
	}
}
