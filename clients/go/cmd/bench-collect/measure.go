// Measurement for bench-collect: the round loop, the ccusage invocations, the
// in-process native call, and the ccusage argument table they share.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	ccacq "github.com/MisonL/TokenBoard/clients/go/internal/ccusage/acquire"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// roundRequest is one round's inputs, handed to a roundRunner.
type roundRequest struct {
	Source   contract.Source
	Bin      string
	Window   collectWindow
	Timezone string
	Scenario scenario
	// StateDir is the run's single temporary state directory. The ccusage side
	// is pointed at the merged config inside it and the native side prepares
	// from the same directory, so both sides of the comparison price from one
	// configuration.
	StateDir string
	// ConfigPath is the merged ccusage config the run prepared, passed as
	// --config. Empty means no flag, matching ccrunner.ConfigArgs when neither
	// config variable is set.
	ConfigPath string
}

// roundResult is one round's measurement.
type roundResult struct {
	WallMs       float64
	PeakRSSBytes uint64
	RSSSource    string
	OutputBytes  uint64
	BytesRead    uint64
	Calls        int
}

// roundRunner measures one round of one side.
type roundRunner func(ctx context.Context, request roundRequest) (roundResult, error)

// measureRounds runs one side's rounds in order.
func measureRounds(
	ctx context.Context,
	run roundRunner,
	request roundRequest,
	rounds int,
) ([]roundResult, error) {
	results := make([]roundResult, 0, rounds)
	for round := 1; round <= rounds; round++ {
		result, err := run(ctx, request)
		if err != nil {
			return results, fmt.Errorf("round %d: %w", round, err)
		}
		results = append(results, result)
	}
	return results, nil
}

// collectCcusageRound runs the ccusage invocations one collection performs and
// sums them into one round.
func collectCcusageRound(ctx context.Context, request roundRequest) (roundResult, error) {
	if err := assertUsableBinary(request.Bin); err != nil {
		return roundResult{}, err
	}
	calls, err := ccusageCalls(request.Source, request.Window, request.Timezone, request.ConfigPath)
	if err != nil {
		return roundResult{}, err
	}
	total := roundResult{RSSSource: rssSourceUnavailable}
	for _, args := range calls {
		sample, err := runCcusageOnce(ctx, request.Bin, args)
		if err != nil {
			return roundResult{}, err
		}
		total.WallMs += sample.WallMs
		total.OutputBytes += sample.OutputBytes
		total.Calls++
		if sample.PeakRSSBytes > total.PeakRSSBytes {
			total.PeakRSSBytes = sample.PeakRSSBytes
		}
		if sample.RSSSource != rssSourceUnavailable || total.RSSSource == rssSourceUnavailable {
			total.RSSSource = sample.RSSSource
		}
	}
	return total, nil
}

// runCcusageOnce execs one ccusage report and measures the child.
//
// Stdout is counted and discarded rather than retained: the report can be a
// hundred megabytes of JSON, and holding it here would inflate the RSS the
// native side measures later in the same process. That also means this measures
// the ccusage process only — TokenBoard's own decode and normalize run in the
// parent, and the native side pays for its equivalent in-process.
func runCcusageOnce(ctx context.Context, bin string, args []string) (roundResult, error) {
	commandCtx, cancelCommand := context.WithTimeout(ctx, time.Duration(ccusageTimeoutMs)*time.Millisecond)
	defer cancelCommand()

	cmd := exec.CommandContext(commandCtx, bin, args...)
	// ccusage may be a downloaded package: it must never inherit the upload
	// token. The list lives in internal/ccusage so the two cannot drift.
	cmd.Env = ccusage.ScrubCredentialEnv(nil)
	output := &countingWriter{}
	diagnostics := newCappedBuffer(diagnosticsCapBytes)
	cmd.Stdout = output
	cmd.Stderr = diagnostics

	start := time.Now()
	runErr := cmd.Start()
	if runErr != nil {
		return roundResult{}, fmt.Errorf("start ccusage: %w", runErr)
	}
	observer := observeChild(cmd.Process)
	runErr = cmd.Wait()
	wall := time.Since(start)
	peak, rssSource := observer.peakRSS(cmd.ProcessState)
	if runErr != nil {
		return roundResult{}, fmt.Errorf("ccusage %s: %w%s", shortArgs(args), runErr, diagnostics.suffix())
	}
	return roundResult{
		WallMs:       millis(wall),
		PeakRSSBytes: peak,
		RSSSource:    rssSource,
		OutputBytes:  output.count,
	}, nil
}

// lookupNativeProvider is collect.LookupNative, replaceable by a test so a
// round can be exercised without running a real provider over the machine's own
// history.
var lookupNativeProvider = collect.LookupNative

// collectNativeRound runs the registered native provider in-process. A source
// with no native provider is errNoNativeProvider, not a failure.
//
// The state directory comes from the run, not from a fresh os.MkdirTemp here:
// it is the directory the ccusage side's --config lives in, so the provider's
// own pricing preparation resolves the same catalogue and writes to the same
// place. It is still a throwaway directory — a benchmark must never move the
// machine's own cursors — and the hook scenario resets the cursor before each
// round so every round sees a cold scan.
func collectNativeRound(ctx context.Context, request roundRequest) (roundResult, error) {
	provider, ok := lookupNativeProvider(request.Source)
	if !ok || provider == nil {
		return roundResult{}, errNoNativeProvider
	}
	if strings.TrimSpace(request.StateDir) == "" {
		return roundResult{}, errors.New("bench-collect: native round has no state directory")
	}

	hookMode := request.Scenario == scenarioHook
	if hookMode {
		// The previous round's cursor lives here. Without this reset the second
		// round onward would measure the warm-cursor path under the hook
		// scenario's name.
		if err := resetHookCursor(request.StateDir, request.Source); err != nil {
			return roundResult{}, err
		}
	}
	start := time.Now()
	_, err := provider.Collect(ctx, collect.Options{
		Timezone: request.Timezone,
		Since:    isoDate(request.Window.Since),
		Until:    isoDate(request.Window.Until),
		StateDir: request.StateDir,
		// An ambient TOKENBOARD_HOOK_MODE belongs to a notifier and would
		// silently measure the incremental path under another scenario's name.
		Env: func(key string) string {
			if key == "TOKENBOARD_HOOK_MODE" {
				if hookMode {
					return "1"
				}
				return ""
			}
			return os.Getenv(key)
		},
	})
	wall := time.Since(start)
	if err != nil {
		return roundResult{}, err
	}
	peak, rssSource := selfPeakRSS()
	return roundResult{
		WallMs:       millis(wall),
		PeakRSSBytes: peak,
		RSSSource:    rssSource,
		Calls:        1,
	}, nil
}

// resetHookCursor removes the source's hook cursor files from a benchmark state
// directory before a hook round, so every round measures a cold cursor scan.
// Only the unscoped file and its per-scope variants are touched, all inside a
// directory this run created: a missing file is fine, an unreadable directory
// is an error.
func resetHookCursor(stateDir string, source contract.Source) error {
	pattern, ok := hookCursorPattern(source)
	if !ok {
		return fmt.Errorf("bench-collect: %s installs no hook cursor to reset", source)
	}
	paths, err := filepath.Glob(filepath.Join(stateDir, pattern))
	if err != nil {
		return fmt.Errorf("bench-collect: reset hook cursor in %s: %w", stateDir, err)
	}
	for _, path := range paths {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("bench-collect: reset hook cursor %s: %w", path, err)
		}
	}
	return nil
}

// ccusageCalls builds the invocations one collection performs, mirroring the
// providers: Claude runs `daily --breakdown` and `session`, both with
// `--single-thread` and never `--offline` (that flag prices from ccusage's
// builtin catalogue, which changes the cost the collector stores); Codex runs
// both reports with `--offline --single-thread`; the twelve tool sources run
// `<tool> daily` and `<tool> session` and use the subcommand-name map from the
// contract, which is where `gemini-cli` becomes `gemini`.
//
// The `--config` pair goes last, exactly where the providers append it through
// ccrunner.ConfigArgs, and an empty path adds no flag at all.
//
// The table duplicates the providers on purpose: this harness must not import
// the code it is meant to measure out of, but a provider flag change has to be
// mirrored here. cmd/parity carries the same table for the same reason.
func ccusageCalls(source contract.Source, window collectWindow, timezone, configPath string) ([][]string, error) {
	if !hasCcusagePath(source) {
		return nil, fmt.Errorf("%w: %s has no ccusage path; bench-collect measures ccusage-backed sources",
			errUsage, source)
	}
	rangeArgs := window.rangeArgs()
	reports := []string{"daily", "session"}

	calls := make([][]string, 0, len(reports))
	for _, report := range reports {
		var args []string
		switch source {
		case contract.SourceClaudeCode:
			args = []string{"claude", report, "--json"}
			if report == "daily" {
				args = append(args, "--breakdown")
			}
			args = append(args, "--single-thread")
		case contract.SourceCodex:
			args = []string{"codex", report, "--json", "--offline", "--single-thread"}
		default:
			command, _ := contract.CcusageToolCommand(source)
			args = []string{command, report, "--json"}
		}
		args = append(args, rangeArgs...)
		if timezone != "" {
			args = append(args, "--timezone", timezone)
		}
		if path := strings.TrimSpace(configPath); path != "" {
			args = append(args, "--config", path)
		}
		calls = append(calls, args)
	}
	return calls, nil
}

// ccusageNetworkAllowed reports whether the source's ccusage invocations may
// reach the network for pricing, which is exactly whether they pass --offline.
func ccusageNetworkAllowed(source contract.Source) bool {
	return source != contract.SourceCodex
}

// pricingDiagnostics returns the preparation's diagnostic sink. A run without
// an endpoint fetches nothing, so it narrates nothing: the providers apply the
// same rule. A nil writer discards the lines.
func pricingDiagnostics(w io.Writer, endpoint string) func(string) {
	if w == nil || endpoint == "" {
		return nil
	}
	return func(line string) {
		fmt.Fprintf(w, "bench-collect: pricing: %s\n", line)
	}
}

// hasCcusagePath reports whether the ccusage binary answers for a source. The
// remaining sources (the Antigravity family, OpenCode, Pi, Grok Build and Deep
// Seek Harness) are read from their own stores, so there is no ccusage command
// to time.
func hasCcusagePath(source contract.Source) bool {
	switch source {
	case contract.SourceClaudeCode, contract.SourceCodex:
		return true
	}
	_, ok := contract.CcusageToolCommand(source)
	return ok
}

// assertUsableBinary fails before the first round rather than after a
// half-finished measurement. A path that exists but is not executable would
// otherwise fail each round's start with a generic "permission denied".
func assertUsableBinary(bin string) error {
	info, err := os.Stat(bin)
	if err != nil {
		return fmt.Errorf("ccusage binary not found at %s: %w", bin, err)
	}
	if info.IsDir() {
		return fmt.Errorf("ccusage binary path %s is a directory", bin)
	}
	if runtime.GOOS != "windows" && info.Mode()&0o111 == 0 {
		return fmt.Errorf("ccusage binary at %s is not executable", bin)
	}
	return nil
}

// defaultCcusageBin is the install layout the skill uses:
// <BundledBinDir>/ccusage[.exe]. BundledBinDir is the same directory the
// collector's bundled layer probes, so both sides agree on the install; the
// executable name is resolved here because internal/ccusage keeps it unexported.
func defaultCcusageBin() string {
	return filepath.Join(ccacq.BundledBinDir(nil, ""), ccusageBinaryName())
}

// ccusageBinaryName is the bundled ccusage executable's platform name.
func ccusageBinaryName() string {
	if runtime.GOOS == "windows" {
		return "ccusage.exe"
	}
	return "ccusage"
}
