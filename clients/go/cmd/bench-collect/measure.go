// Measurement for bench-collect: the round loop, the ccusage invocations, the
// in-process native call, and the ccusage argument table they share.
package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
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
	calls, err := ccusageCalls(request.Source, request.Window, request.Timezone)
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

// collectNativeRound runs the registered native provider in-process. S1 has
// none, which is errNoNativeProvider, not a failure.
func collectNativeRound(ctx context.Context, request roundRequest) (roundResult, error) {
	provider, ok := collect.LookupNative(request.Source)
	if !ok || provider == nil {
		return roundResult{}, errNoNativeProvider
	}
	stateDir, err := os.MkdirTemp("", "tokenboard-bench-")
	if err != nil {
		return roundResult{}, err
	}
	defer os.RemoveAll(stateDir)

	hookMode := request.Scenario == scenarioHook
	start := time.Now()
	// The native provider writes a real cursor into this throwaway state
	// directory: a benchmark must never move the machine's own hook cursors.
	_, err = provider.Collect(ctx, collect.Options{
		Timezone: request.Timezone,
		Since:    isoDate(request.Window.Since),
		Until:    isoDate(request.Window.Until),
		StateDir: stateDir,
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

// ccusageCalls builds the invocations one collection performs, mirroring the
// providers: Claude runs `daily --breakdown` and `session`, both with
// `--single-thread` and never `--offline` (that flag prices from ccusage's
// builtin catalogue, which changes the cost the collector stores); Codex runs
// both reports with `--offline --single-thread`; the twelve tool sources run
// `<tool> daily` and `<tool> session` and use the subcommand-name map from the
// contract, which is where `gemini-cli` becomes `gemini`.
//
// The table duplicates the providers on purpose: this harness must not import
// the code it is meant to measure out of, but a provider flag change has to be
// mirrored here. cmd/parity carries the same table for the same reason.
func ccusageCalls(source contract.Source, window collectWindow, timezone string) ([][]string, error) {
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
		calls = append(calls, args)
	}
	return calls, nil
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

// defaultCcusageBin is the install layout the skill uses, resolved through the
// shared helper so this command and the collector agree on the path.
func defaultCcusageBin() string {
	return ccusage.DefaultBinaryPath(nil, "")
}
