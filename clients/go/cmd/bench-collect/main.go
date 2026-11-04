// Command bench-collect measures what collecting one usage source costs: wall
// time, peak RSS and bytes read, per round, with the median and the max. It is
// the harness for §9.3 of
// docs/superpowers/specs/2026-11-03-native-usage-sources-design.md.
//
// The ccusage side execs the pinned binary; the native side runs
// collect.LookupNative in-process. S1 of the native pricing engine registers no
// native provider, so this run is a ccusage baseline: the native column reports
// notImplemented, and the report never treats that as a win.
//
// # Peak RSS of the ccusage child
//
// getrusage(RUSAGE_SELF) sees only this process — the ccusage child's 7.7-9.3 GB
// is invisible to it. A child's peak comes from the wait4 rusage Go stores in
// os.ProcessState, which is per-child and therefore attributable to one round.
// RUSAGE_CHILDREN is the second source: its ru_maxrss is a monotone high-water
// over every reaped child, so it cannot attribute a round by itself (round 3
// reports round 2's peak when it was the larger), but it is the fallback when
// wait4 yields nothing and the cross-check that the child figure is plausible.
// The platform split lives in rss_unix.go and rss_windows.go.
//
// Ru_maxrss is in platform units: bytes on darwin, kilobytes on Linux. Both
// paths normalize through rusageMaxRSSBytes before anything is compared or
// printed. Windows has no wait4 rusage at all; rss_windows.go opens a handle to
// the child and reads its PeakWorkingSetSize with GetProcessMemoryInfo, and
// reports the metric as unavailable when that fails rather than inventing a
// number.
//
// # Windows
//
// The two RSS files carry //go:build constraints (!windows / windows). Renaming
// a file is not a build constraint: without the tags the package would declare
// the same functions twice and fail to build for Windows. The Windows RSS path
// has been compile-verified on all six targets but not run on a Windows host;
// it fails closed to "unavailable" rather than reporting a wrong number.
//
// This command is deliberately absent from .goreleaser.yaml: it is dev-only and
// is not part of the released client.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/state"
)

// errUsage marks an error caused by the invocation itself, which run maps to
// the usage exit code rather than a failure.
var errUsage = errors.New("usage")

// errNoNativeProvider says S1 has no in-process implementation for the source.
// It is a report, not a failure: the ccusage baseline is still what the
// operator asked for.
var errNoNativeProvider = errors.New("no native provider")

const (
	exitOK      = 0
	exitFailure = 1
	exitUsage   = 2
)

const (
	// defaultRounds is the protocol's sample count.
	defaultRounds = 5
	// minRounds is the floor: the design fixes "≥5 轮取中位数" because a single
	// round on this host varies by up to 2x.
	minRounds = 5
	// ccusageTimeoutMs bounds one ccusage report. A claude-code report walks the
	// whole session tree, so the providers' 900s budget is reused; a wedged child
	// must fail the round rather than hang the harness.
	ccusageTimeoutMs = 900_000
	// diagnosticsCapBytes bounds the child's stderr the harness retains. A
	// runaway child must not be able to inflate the process whose RSS the native
	// side reports.
	diagnosticsCapBytes = 64 * 1024
)

// Side kinds and statuses. notImplemented is not a measurement: it says the
// native side has no provider for the source yet, and must never read as a win.
const (
	sideCcusage        = "ccusage"
	sideNative         = "native"
	sideMeasured       = "measured"
	sideNotImplemented = "notImplemented"
)

// RSS provenance labels. They travel into the report so a reader can tell an
// exact per-child figure from a high-water bound or from "not available here".
const (
	rssSourceWait4       = "wait4-rusage"
	rssSourceChildren    = "rusage-children-highwater"
	rssSourceSelf        = "rusage-self"
	rssSourceWindows     = "getprocessmemoryinfo-peakworkingset"
	rssSourceUnavailable = "unavailable"
)

// scenario is one of the four measurement windows.
type scenario string

const (
	// scenarioSingle is one settled day: the "empty run" cost, where process
	// start-up and the JSON round trip dominate.
	scenarioSingle scenario = "single"
	// scenario30d is the typical scheduled-sync window.
	scenario30d scenario = "30d"
	// scenarioFull is the whole history: throughput and peak memory.
	scenarioFull scenario = "full"
	// scenarioHook is the incremental window a warm hook cursor narrows to.
	scenarioHook scenario = "hook"
)

func parseScenario(value string) (scenario, error) {
	switch parsed := scenario(strings.TrimSpace(value)); parsed {
	case scenarioSingle, scenario30d, scenarioFull, scenarioHook:
		return parsed, nil
	}
	return "", fmt.Errorf("%w: unknown scenario %q (want single, 30d, full or hook)", errUsage, value)
}

// collectWindow is the date filter one round applies, in the compact YYYYMMDD
// form the providers hand to ccusage. Both fields empty means every date.
type collectWindow struct {
	Since string `json:"since,omitempty"`
	Until string `json:"until,omitempty"`
}

// rangeArgs renders the window as ccusage flags. An empty window yields nil, not
// an empty slice: the full scenario must add nothing at all.
func (w collectWindow) rangeArgs() []string {
	if w.Since == "" && w.Until == "" {
		return nil
	}
	args := []string{}
	if w.Since != "" {
		args = append(args, "--since", w.Since)
	}
	if w.Until != "" {
		args = append(args, "--until", w.Until)
	}
	return args
}

func (w collectWindow) String() string {
	switch {
	case w.Since == "" && w.Until == "":
		return "all"
	case w.Since == w.Until:
		return w.Since
	}
	return w.Since + ".." + w.Until
}

// roundSample is one measured round, as printed and stored in the report.
type roundSample struct {
	Round int `json:"round"`
	// WallMs is the child's wall time: the sum of the round's ccusage calls for
	// the ccusage side, the provider call for the native side.
	WallMs float64 `json:"wallMs"`
	// PeakRSSBytes is normalized to bytes on every platform.
	PeakRSSBytes uint64 `json:"peakRssBytes"`
	// OutputBytes is the ccusage JSON the child wrote (0 on the native side).
	OutputBytes uint64 `json:"outputBytes"`
	// BytesRead is the source bytes the collection read. It is 0 in S1 and
	// BytesReadPending says so: the adapter read counter lands in S2.
	BytesRead        uint64 `json:"bytesRead"`
	BytesReadPending bool   `json:"bytesReadPending"`
	// Calls is the number of ccusage invocations the round made: 2 for claude
	// and codex (daily + session), 1 for an empty-window tool source, 0 native.
	Calls int `json:"calls"`
}

// sideReport is one side of the comparison.
type sideReport struct {
	Kind               string        `json:"kind"`
	Status             string        `json:"status"`
	Rounds             []roundSample `json:"rounds,omitempty"`
	MedianWallMs       float64       `json:"medianWallMs"`
	MaxWallMs          float64       `json:"maxWallMs"`
	MedianPeakRSSBytes uint64        `json:"medianPeakRssBytes"`
	MaxPeakRSSBytes    uint64        `json:"maxPeakRssBytes"`
	MedianOutputBytes  uint64        `json:"medianOutputBytes"`
	MaxOutputBytes     uint64        `json:"maxOutputBytes"`
	// RSSSource names where PeakRSS came from: an exact per-child wait4 figure,
	// a monotone children high-water, this process's own high-water, Windows'
	// peak working set, or unavailable.
	RSSSource string `json:"rssSource,omitempty"`
	// BytesRead is 0 in S1: the adapter read counter lands in S2. Pending says
	// the zero is a placeholder rather than a measurement of no reads.
	BytesRead        uint64 `json:"bytesRead"`
	BytesReadPending bool   `json:"bytesReadPending"`
}

// benchReport is what the command prints, in both output modes.
type benchReport struct {
	Source     string        `json:"source"`
	Scenario   string        `json:"scenario"`
	Timezone   string        `json:"timezone"`
	Window     collectWindow `json:"window"`
	Rounds     int           `json:"rounds"`
	CcusageBin string        `json:"ccusageBin"`
	Platform   string        `json:"platform"`
	Ccusage    sideReport    `json:"ccusage"`
	Native     sideReport    `json:"native"`
	// Regression is true when the native side is slower than the ccusage side
	// it replaces. Regressions names each one; the text report prints them, so
	// a slower native side is never hidden behind its better memory numbers.
	Regression  bool     `json:"regression"`
	Regressions []string `json:"regressions,omitempty"`
	Notes       []string `json:"notes,omitempty"`
}

// benchInput is one run's inputs. The function seams exist so the loop,
// aggregation and reporting are testable without a ccusage binary.
type benchInput struct {
	Source     contract.Source
	Scenario   scenario
	Rounds     int
	CcusageBin string
	Timezone   string
	// Now is the run clock; nil means time.Now.
	Now func() time.Time
	// CollectCcusage measures one ccusage round; nil means exec the binary.
	CollectCcusage roundRunner
	// CollectNative measures one native round; nil means run the registered
	// native provider, or report notImplemented when there is none.
	CollectNative roundRunner
	// HookWindow reads the hook cursor watermark for the hook scenario; nil
	// means read it from the configured state directory.
	HookWindow func() (string, error)
	// StateDir is where the hook cursor lives; nil resolves it from the
	// environment the way the CLI does.
	StateDir func() string
}

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

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run parses the flags and executes one benchmark. It is separate from main so
// the exit-code contract is testable without spawning the binary.
func run(args []string, stdout, stderr io.Writer) int {
	return runWith(args, stdout, stderr, benchInput{})
}

// runWith is run with the measurement seams injectable.
func runWith(args []string, stdout, stderr io.Writer, input benchInput) int {
	flags := flag.NewFlagSet("bench-collect", flag.ContinueOnError)
	flags.SetOutput(stderr)
	source := flags.String("source", "", "usage source to benchmark (required)")
	scenarioName := flags.String("scenario", "", "window to measure: single, 30d, full or hook (required)")
	rounds := flags.Int("rounds", defaultRounds, "rounds per scenario (minimum 5)")
	ccusageBin := flags.String("ccusage-bin", "", "ccusage binary (default ~/.tokenboard/bin/ccusage)")
	jsonOutput := flags.Bool("json", false, "print a machine-readable report")
	flags.Usage = func() {
		fmt.Fprintln(stderr, "Usage: bench-collect -source S -scenario single|30d|full|hook [-rounds 5] [-ccusage-bin PATH] [-json]")
		flags.PrintDefaults()
	}
	if err := flags.Parse(args); err != nil {
		return exitUsage
	}
	if flags.NArg() > 0 {
		flags.Usage()
		return exitUsage
	}
	trimmedSource := strings.TrimSpace(*source)
	if trimmedSource == "" || !contract.IsValidSource(trimmedSource) {
		if trimmedSource != "" {
			fmt.Fprintf(stderr, "bench-collect: unknown source %q\n", trimmedSource)
		}
		flags.Usage()
		return exitUsage
	}
	parsedScenario, err := parseScenario(*scenarioName)
	if err != nil {
		fmt.Fprintf(stderr, "bench-collect: %v\n", err)
		flags.Usage()
		return exitUsage
	}

	input.Source = contract.Source(trimmedSource)
	input.Scenario = parsedScenario
	input.Rounds = *rounds
	input.CcusageBin = strings.TrimSpace(*ccusageBin)

	report, err := runBench(context.Background(), input)
	if err != nil {
		fmt.Fprintf(stderr, "bench-collect: %v\n", err)
		if errors.Is(err, errUsage) {
			return exitUsage
		}
		return exitFailure
	}

	if *jsonOutput {
		payload, err := json.MarshalIndent(report, "", "  ")
		if err != nil {
			fmt.Fprintf(stderr, "bench-collect: %v\n", err)
			return exitFailure
		}
		fmt.Fprintln(stdout, string(payload))
	} else {
		writeTextReport(stdout, report)
	}
	// A regression is reported, not fatal: the harness exists to measure, and an
	// operator comparing two builds still wants the numbers. The text report
	// names it and the exit code stays 0 so a loop over scenarios can finish.
	return exitOK
}

// runBench resolves the window, then measures each side for the configured
// number of rounds.
func runBench(ctx context.Context, input benchInput) (benchReport, error) {
	now := time.Now
	if input.Now != nil {
		now = input.Now
	}
	timezone := strings.TrimSpace(input.Timezone)
	if timezone == "" {
		timezone = sessionusage.LocalTimezone()
	}
	if !contract.IsValidTimezone(timezone) {
		return benchReport{}, fmt.Errorf("%w: unknown timezone %q", errUsage, timezone)
	}
	location, err := contract.LoadLocation(timezone)
	if err != nil {
		return benchReport{}, fmt.Errorf("%w: unknown timezone %q", errUsage, timezone)
	}
	if input.Rounds < minRounds {
		return benchReport{}, fmt.Errorf(
			"%w: -rounds must be at least %d (the protocol takes a median over %d rounds); got %d",
			errUsage, minRounds, minRounds, input.Rounds)
	}
	if !contract.IsValidSource(string(input.Source)) {
		return benchReport{}, fmt.Errorf("%w: unknown source %q", errUsage, input.Source)
	}
	if input.Scenario == scenarioHook && !hasHookCursor(input.Source) {
		return benchReport{}, fmt.Errorf(
			"%w: %s installs no hook cursor; the hook scenario covers claude-code and codex",
			errUsage, input.Source)
	}

	hookWindow := input.HookWindow
	if hookWindow == nil {
		stateDir := input.StateDir
		if stateDir == nil {
			stateDir = func() string {
				home, err := os.UserHomeDir()
				if err != nil {
					home = "."
				}
				return state.ResolveDir(nil, home)
			}
		}
		hookWindow = func() (string, error) {
			return readHookWatermark(input.Source, stateDir())
		}
	}
	window, err := scenarioWindow(input.Scenario, now(), location, hookWindow)
	if err != nil {
		return benchReport{}, err
	}

	bin := input.CcusageBin
	if bin == "" {
		bin = defaultCcusageBin()
	}
	collectCcusage := input.CollectCcusage
	if collectCcusage == nil {
		if err := assertUsableBinary(bin); err != nil {
			return benchReport{}, err
		}
		collectCcusage = collectCcusageRound
	}
	collectNative := input.CollectNative
	if collectNative == nil {
		collectNative = collectNativeRound
	}

	request := roundRequest{
		Source:   input.Source,
		Bin:      bin,
		Window:   window,
		Timezone: timezone,
		Scenario: input.Scenario,
	}

	report := benchReport{
		Source:     string(input.Source),
		Scenario:   string(input.Scenario),
		Timezone:   timezone,
		Window:     window,
		Rounds:     input.Rounds,
		CcusageBin: bin,
		Platform:   runtime.GOOS + "/" + runtime.GOARCH,
	}

	ccusageRounds, err := measureRounds(ctx, collectCcusage, request, input.Rounds)
	if err != nil {
		return report, fmt.Errorf("ccusage side: %w", err)
	}
	report.Ccusage = summarizeSide(sideCcusage, ccusageRounds)

	nativeRounds, nativeErr := measureRounds(ctx, collectNative, request, input.Rounds)
	switch {
	case errors.Is(nativeErr, errNoNativeProvider):
		report.Native = sideReport{Kind: sideNative, Status: sideNotImplemented}
		report.Notes = append(report.Notes,
			"native: notImplemented — S1 registers no native provider for this source, so this run is a ccusage baseline")
	case nativeErr != nil:
		return report, fmt.Errorf("native side: %w", nativeErr)
	default:
		report.Native = summarizeSide(sideNative, nativeRounds)
	}

	if input.Scenario == scenarioHook && window == (collectWindow{}) {
		report.Notes = append(report.Notes,
			"hook: no cursor watermark found, so the window is unfiltered — this measures the cold-cursor path")
	}
	report.Notes = append(report.Notes,
		"ccusage --since/--until filter the report's output, not its scan: a one-day window costs about what the full history costs")
	report.Notes = append(report.Notes,
		"bytesRead is pending until the S2 adapter read counter lands")
	report.markRegressions()
	return report, nil
}

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
	rangeArgs := window.rangeArgs()
	reports := []string{"daily", "session"}
	if _, ok := contract.CcusageToolCommand(source); !ok {
		if source != contract.SourceClaudeCode && source != contract.SourceCodex {
			return nil, fmt.Errorf("%w: %s has no ccusage path; bench-collect measures ccusage-backed sources",
				errUsage, source)
		}
	}

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

// scenarioWindow resolves a scenario's date filter.
//
// settledDay, not today: a window that includes today races the source being
// appended to while the rounds run (the live-write problem tokenboard shadow
// documents), and the window only filters ccusage's output, so the settled date
// measures the same scan without the noise.
func scenarioWindow(
	scn scenario,
	now time.Time,
	location *time.Location,
	hook func() (string, error),
) (collectWindow, error) {
	switch scn {
	case scenarioSingle:
		day := settledDay(now, location)
		return collectWindow{Since: compactDate(day), Until: compactDate(day)}, nil
	case scenario30d:
		until := settledDay(now, location)
		since := until.AddDate(0, 0, -29)
		return collectWindow{Since: compactDate(since), Until: compactDate(until)}, nil
	case scenarioFull:
		return collectWindow{}, nil
	case scenarioHook:
		if hook == nil {
			return collectWindow{}, fmt.Errorf("%w: the hook scenario needs a cursor watermark", errUsage)
		}
		watermark, err := hook()
		if err != nil {
			return collectWindow{}, err
		}
		watermark = strings.TrimSpace(watermark)
		if watermark == "" {
			// A cold cursor reconciles every date, which is the unfiltered window.
			return collectWindow{}, nil
		}
		// Normalize before validating: the cursor stores YYYY-MM-DD and ccusage
		// takes YYYYMMDD. The length check has to come first — slicing a short
		// value would panic instead of reporting a corrupt cursor.
		compact := strings.ReplaceAll(watermark, "-", "")
		if len(compact) != 8 || !contract.IsValidIsoDate(
			compact[:4]+"-"+compact[4:6]+"-"+compact[6:8]) {
			return collectWindow{}, fmt.Errorf("%w: hook cursor watermark %q is not a date", errUsage, watermark)
		}
		today := compactDate(now.In(location))
		// A watermark ahead of the clock (skew, or a date recorded in another
		// zone) must not render a reversed range: ccusage rejects since > until.
		if compact > today {
			compact = today
		}
		return collectWindow{Since: compact, Until: today}, nil
	}
	return collectWindow{}, fmt.Errorf("%w: unknown scenario %q", errUsage, scn)
}

// readHookWatermark returns the newest usage date already recorded in the
// source's hook cursor, or "" when there is no cursor on this machine.
//
// It only reads: the cursor belongs to the running collector, and a benchmark
// that committed to it would change what the next hook reconciles. Scoped
// cursors (a codex profile, a per-server file) are all considered — the newest
// date across them is the boundary the next hook starts from.
func readHookWatermark(source contract.Source, stateDir string) (string, error) {
	pattern, ok := hookCursorPattern(source)
	if !ok {
		return "", fmt.Errorf("%w: %s installs no hook cursor", errUsage, source)
	}
	paths, err := filepath.Glob(filepath.Join(stateDir, pattern))
	if err != nil {
		return "", err
	}
	newest := ""
	for _, path := range paths {
		cursor, err := sessioncursor.Read(path, string(source))
		if err != nil {
			return "", fmt.Errorf("read hook cursor %s: %w", path, err)
		}
		for _, entry := range cursor.Files {
			for _, snapshot := range entry.Snapshots {
				if snapshot.UsageDate > newest {
					newest = snapshot.UsageDate
				}
			}
		}
	}
	return newest, nil
}

// hookCursorPattern matches the cursor files a source's hook writes: the
// unscoped name and any scoped variant (codex profiles, per-server files).
func hookCursorPattern(source contract.Source) (string, bool) {
	if !hasHookCursor(source) {
		return "", false
	}
	base := strings.TrimSuffix(sessioncursor.FileName(source, ""), ".json")
	return base + "*.json", true
}

// hasHookCursor reports whether the source runs through the hook path at all.
// The twelve tool sources and the locally-read sources install no hook.
func hasHookCursor(source contract.Source) bool {
	switch source {
	case contract.SourceClaudeCode, contract.SourceCodex:
		return true
	}
	return false
}

// summarizeSide aggregates one side's rounds.
func summarizeSide(kind string, results []roundResult) sideReport {
	report := sideReport{Kind: kind, Status: sideMeasured}
	if len(results) == 0 {
		report.Status = sideNotImplemented
		return report
	}
	report.BytesReadPending = true
	walls := make([]float64, 0, len(results))
	rss := make([]uint64, 0, len(results))
	outputs := make([]uint64, 0, len(results))
	source := ""
	labeled := true
	for index, result := range results {
		// BytesRead is pending for the whole side: S1 has no adapter read
		// counter, so the zero is a placeholder and the report says so. S2
		// replaces this constant with the counter's value once it exists.
		report.Rounds = append(report.Rounds, roundSample{
			Round:            index + 1,
			WallMs:           result.WallMs,
			PeakRSSBytes:     result.PeakRSSBytes,
			OutputBytes:      result.OutputBytes,
			BytesRead:        result.BytesRead,
			BytesReadPending: true,
			Calls:            result.Calls,
		})
		walls = append(walls, result.WallMs)
		rss = append(rss, result.PeakRSSBytes)
		outputs = append(outputs, result.OutputBytes)
		if result.BytesRead > report.BytesRead {
			report.BytesRead = result.BytesRead
		}
		if index == 0 {
			source = result.RSSSource
		} else if source != result.RSSSource {
			labeled = false
		}
	}
	report.MedianWallMs = medianFloat64(walls)
	report.MaxWallMs = maxFloat64(walls)
	report.MedianPeakRSSBytes = medianUint64(rss)
	report.MaxPeakRSSBytes = maxUint64(rss)
	report.MedianOutputBytes = medianUint64(outputs)
	report.MaxOutputBytes = maxUint64(outputs)
	if labeled {
		report.RSSSource = source
	} else {
		report.RSSSource = "mixed"
	}
	return report
}

// markRegressions flags every way the native side is slower than the ccusage
// side it replaces. Only a measured pair can regress: an absent native provider
// made no claim, and a zero ccusage baseline still counts so the guard cannot
// hide a regression behind a division.
func (report *benchReport) markRegressions() {
	report.Regression = false
	report.Regressions = nil
	if report.Ccusage.Status != sideMeasured || report.Native.Status != sideMeasured {
		return
	}
	if report.Native.MedianWallMs <= report.Ccusage.MedianWallMs {
		return
	}
	report.Regression = true
	change := ""
	if report.Ccusage.MedianWallMs > 0 {
		change = fmt.Sprintf(" (+%.1f%%)",
			(report.Native.MedianWallMs-report.Ccusage.MedianWallMs)/report.Ccusage.MedianWallMs*100)
	}
	report.Regressions = append(report.Regressions, fmt.Sprintf(
		"native median wall %s exceeds ccusage %s%s",
		formatDurationMs(report.Native.MedianWallMs),
		formatDurationMs(report.Ccusage.MedianWallMs),
		change))
}

// medianFloat64 returns the middle sample, or the mean of the two middle
// samples for an even count. The input slice is copied: the caller's round order
// is part of the report.
func medianFloat64(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	middle := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[middle]
	}
	return (sorted[middle-1] + sorted[middle]) / 2
}

// medianUint64 is medianFloat64 in integer arithmetic; an even count truncates
// the mean of the two middle samples.
func medianUint64(values []uint64) uint64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]uint64(nil), values...)
	sort.Slice(sorted, func(left, right int) bool { return sorted[left] < sorted[right] })
	middle := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[middle]
	}
	left, right := sorted[middle-1], sorted[middle]
	return left + (right-left)/2
}

func maxFloat64(values []float64) float64 {
	var maximum float64
	for _, value := range values {
		if value > maximum {
			maximum = value
		}
	}
	return maximum
}

func maxUint64(values []uint64) uint64 {
	var maximum uint64
	for _, value := range values {
		if value > maximum {
			maximum = value
		}
	}
	return maximum
}

// rusageMaxRSSBytes normalizes a rusage Ru_maxrss to bytes. darwin reports
// bytes; Linux and the other unix systems report kilobytes. See
// TestPeakRSSReportsBytesOnDarwinAndKilobytesOnLinux for the probe behind it.
func rusageMaxRSSBytes(raw int64, goos string) uint64 {
	if raw <= 0 {
		return 0
	}
	if goos == "darwin" {
		return uint64(raw)
	}
	return uint64(raw) * 1024
}

// writeTextReport prints the summary, the per-round samples and every
// regression.
func writeTextReport(w io.Writer, report benchReport) {
	fmt.Fprintf(w, "bench-collect source=%s scenario=%s window=%s timezone=%s rounds=%d\n",
		report.Source, report.Scenario, report.Window.String(), report.Timezone, report.Rounds)
	fmt.Fprintf(w, "ccusage bin=%s platform=%s\n", report.CcusageBin, report.Platform)
	writeSideReport(w, report.Ccusage)
	writeSideReport(w, report.Native)
	if report.Ccusage.BytesReadPending || report.Native.BytesReadPending {
		fmt.Fprintf(w, "bytesRead: %d (pending — the adapter read counter lands in S2)\n", report.Ccusage.BytesRead)
	}
	for _, regression := range report.Regressions {
		fmt.Fprintf(w, "regression: %s\n", regression)
	}
	if !report.Regression && report.Native.Status == sideMeasured {
		fmt.Fprintf(w, "regression: none (native median wall %s vs ccusage %s)\n",
			formatDurationMs(report.Native.MedianWallMs), formatDurationMs(report.Ccusage.MedianWallMs))
	}
	for _, note := range report.Notes {
		fmt.Fprintf(w, "note: %s\n", note)
	}
}

func writeSideReport(w io.Writer, side sideReport) {
	if side.Status != sideMeasured {
		fmt.Fprintf(w, "%s: %s (no in-process provider for this source yet)\n", side.Kind, side.Status)
		return
	}
	fmt.Fprintf(w, "%s: measured (rss=%s)\n", side.Kind, side.RSSSource)
	for _, round := range side.Rounds {
		fmt.Fprintf(w, "  round %d wall=%s peak=%s output=%s bytesRead=%d%s calls=%d\n",
			round.Round,
			formatDurationMs(round.WallMs),
			formatBytes(round.PeakRSSBytes),
			formatBytes(round.OutputBytes),
			round.BytesRead,
			pendingMarker(round.BytesReadPending),
			round.Calls)
	}
	fmt.Fprintf(w, "  median wall=%s peak=%s output=%s\n",
		formatDurationMs(side.MedianWallMs),
		formatBytes(side.MedianPeakRSSBytes),
		formatBytes(side.MedianOutputBytes))
	fmt.Fprintf(w, "  max    wall=%s peak=%s output=%s\n",
		formatDurationMs(side.MaxWallMs),
		formatBytes(side.MaxPeakRSSBytes),
		formatBytes(side.MaxOutputBytes))
}

// formatBytes prints powers of 1024 with their exact unit names: the report
// feeds a comparison, so 7.7 GiB must not be written as 7.7 GB.
func formatBytes(bytes uint64) string {
	const (
		kib = 1024
		mib = 1024 * kib
		gib = 1024 * mib
	)
	switch {
	case bytes >= gib:
		return fmt.Sprintf("%.2f GiB", float64(bytes)/gib)
	case bytes >= mib:
		return fmt.Sprintf("%.1f MiB", float64(bytes)/mib)
	case bytes >= kib:
		return fmt.Sprintf("%.1f KiB", float64(bytes)/kib)
	}
	return fmt.Sprintf("%d B", bytes)
}

func formatDurationMs(ms float64) string {
	return time.Duration(ms * float64(time.Millisecond)).Round(time.Millisecond).String()
}

// pendingMarker marks a zero that is a placeholder, so a reader does not mistake
// "not measured yet" for "read nothing".
func pendingMarker(pending bool) string {
	if pending {
		return " (pending)"
	}
	return ""
}

// millis converts a duration to milliseconds as a float, so sub-millisecond
// rounds stay distinguishable.
func millis(duration time.Duration) float64 {
	return float64(duration) / float64(time.Millisecond)
}

// assertUsableBinary fails before the first round rather than after a
// half-finished measurement.
func assertUsableBinary(bin string) error {
	info, err := os.Stat(bin)
	if err != nil {
		return fmt.Errorf("ccusage binary not found at %s: %w", bin, err)
	}
	if info.IsDir() {
		return fmt.Errorf("ccusage binary path %s is a directory", bin)
	}
	return nil
}

// defaultCcusageBin is the install layout the skill uses. Windows ships
// ccusage.exe, so the name has to follow the platform.
func defaultCcusageBin() string {
	name := "ccusage"
	if runtime.GOOS == "windows" {
		name = "ccusage.exe"
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".tokenboard", "bin", name)
	}
	return filepath.Join(home, ".tokenboard", "bin", name)
}

// settledDay is yesterday in the configured zone: the most recent day whose
// session files have stopped growing.
func settledDay(now time.Time, location *time.Location) time.Time {
	return now.In(location).AddDate(0, 0, -1)
}

func compactDate(day time.Time) string {
	return day.Format("20060102")
}

// isoDate renders a compact window value back into the YYYY-MM-DD form the
// providers' Options take. An empty value stays empty.
func isoDate(compact string) string {
	if len(compact) != 8 {
		return compact
	}
	return compact[:4] + "-" + compact[4:6] + "-" + compact[6:]
}

// countingWriter counts and discards: the child's stdout can be a hundred
// megabytes, and retaining it would inflate this process's RSS.
type countingWriter struct {
	count uint64
}

func (w *countingWriter) Write(data []byte) (int, error) {
	w.count += uint64(len(data))
	return len(data), nil
}

// cappedBuffer keeps the tail of a child's diagnostics, bounded.
type cappedBuffer struct {
	limit int
	tail  []byte
}

func newCappedBuffer(limit int) *cappedBuffer {
	return &cappedBuffer{limit: limit}
}

func (b *cappedBuffer) Write(data []byte) (int, error) {
	b.tail = append(b.tail, data...)
	if len(b.tail) > b.limit {
		b.tail = b.tail[len(b.tail)-b.limit:]
	}
	return len(data), nil
}

// suffix renders the retained diagnostics for an error message.
func (b *cappedBuffer) suffix() string {
	trimmed := strings.TrimSpace(string(b.tail))
	if trimmed == "" {
		return ""
	}
	return ": " + trimmed
}

// shortArgs names the invocation in an error without dumping a whole report.
func shortArgs(args []string) string {
	if len(args) > 3 {
		args = args[:3]
	}
	return strings.Join(args, " ")
}
