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
// is exercised by TestChildPeakRSSMeasuresTheRealChildWindows in
// rss_windows_test.go, which runs on Windows CI; the first CI run is what
// produces the real execution evidence. Until then, and on any host where the
// measurement fails, it fails closed to "unavailable" rather than reporting a
// wrong number.
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
	"runtime"
	"strings"
	"time"

	// The providers register both seams (collect.Lookup and
	// collect.LookupNative) from their own init(); without this blank import
	// this binary would link only collect (through measure.go) and see an empty
	// native registry, so the native column would always read notImplemented.
	_ "github.com/MisonL/TokenBoard/clients/go/internal/collect/providers"
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
	// Calls is the number of ccusage invocations the round made: always 2 for a
	// ccusage-backed source (daily + session), and 0 for an unmeasured native
	// side. The tool sources' empty-daily short circuit lives inside their
	// provider, which this harness deliberately does not go through.
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
	// A source ccusage cannot answer has nothing to benchmark: report it as a
	// usage error here rather than as a failed round after the harness has
	// already measured the native side.
	if !hasCcusagePath(input.Source) {
		return benchReport{}, fmt.Errorf(
			"%w: %s has no ccusage path; bench-collect measures ccusage-backed sources", errUsage, input.Source)
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
