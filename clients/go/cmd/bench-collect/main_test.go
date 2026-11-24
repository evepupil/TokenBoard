package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// TestMedianOfOddAndEvenCounts pins the two median shapes the benchmark
// protocol needs: an odd count has a middle sample, an even count has two and
// takes their mean. The input order must not matter, and the caller's slice
// must come back untouched — a sorting median would silently reorder the round
// samples the report prints.
func TestMedianOfOddAndEvenCounts(t *testing.T) {
	floats := []float64{30, 10, 20}
	if got := medianFloat64(floats); got != 20 {
		t.Errorf("medianFloat64(odd) = %v, want 20", got)
	}
	if floats[0] != 30 || floats[1] != 10 || floats[2] != 20 {
		t.Errorf("medianFloat64 reordered its input: %v", floats)
	}
	if got := medianFloat64([]float64{40, 10, 30, 20}); got != 25 {
		t.Errorf("medianFloat64(even) = %v, want 25", got)
	}
	if got := medianFloat64([]float64{7}); got != 7 {
		t.Errorf("medianFloat64(single) = %v, want 7", got)
	}
	if got := medianFloat64(nil); got != 0 {
		t.Errorf("medianFloat64(empty) = %v, want 0", got)
	}

	sizes := []uint64{300, 100, 200}
	if got := medianUint64(sizes); got != 200 {
		t.Errorf("medianUint64(odd) = %d, want 200", got)
	}
	if sizes[0] != 300 || sizes[1] != 100 || sizes[2] != 200 {
		t.Errorf("medianUint64 reordered its input: %v", sizes)
	}
	// An even count averages the two middle samples; {1,2,3,4} means 2 and 3,
	// which truncates to 2 in integer arithmetic.
	if got := medianUint64([]uint64{4, 1, 3, 2}); got != 2 {
		t.Errorf("medianUint64(even, truncating) = %d, want 2", got)
	}
	if got := medianUint64([]uint64{400, 100, 300, 200}); got != 250 {
		t.Errorf("medianUint64(even, exact) = %d, want 250", got)
	}
	if got := medianUint64(nil); got != 0 {
		t.Errorf("medianUint64(empty) = %d, want 0", got)
	}
}

// TestScenarioWindowsProduceTheExpectedRanges pins the four windows against a
// fixed clock: single is exactly one settled day, 30d is exactly thirty,
// full has no date filter, and hook starts at the cursor watermark and ends
// today.
//
// Windows end at yesterday, not today: the benchmark must not race the source
// being appended to while it runs (tokenboard shadow's live-write problem), and
// the window only filters ccusage's output anyway, so the settled date measures
// the same scan without the noise.
func TestScenarioWindowsProduceTheExpectedRanges(t *testing.T) {
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatalf("load Asia/Shanghai: %v", err)
	}
	// 2026-11-04T12:00Z is 2026-11-04 20:00 in Shanghai, so "today" is
	// 2026-11-04 in the configured zone and the settled day is 2026-11-03.
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)

	single, err := scenarioWindow(scenarioSingle, now, shanghai, nil)
	if err != nil {
		t.Fatalf("single: %v", err)
	}
	if single.Since != "20261103" || single.Until != "20261103" {
		t.Errorf("single window = %+v, want 20261103..20261103", single)
	}
	if got, want := single.rangeArgs(), []string{"--since", "20261103", "--until", "20261103"}; !equalStrings(got, want) {
		t.Errorf("single rangeArgs = %q, want %q", got, want)
	}

	thirty, err := scenarioWindow(scenario30d, now, shanghai, nil)
	if err != nil {
		t.Fatalf("30d: %v", err)
	}
	if thirty.Until != "20261103" {
		t.Errorf("30d until = %q, want 20261103", thirty.Until)
	}
	if span := inclusiveDays(t, thirty.Since, thirty.Until); span != 30 {
		t.Errorf("30d window spans %d days, want 30 (%+v)", span, thirty)
	}

	full, err := scenarioWindow(scenarioFull, now, shanghai, nil)
	if err != nil {
		t.Fatalf("full: %v", err)
	}
	if full != (collectWindow{}) {
		t.Errorf("full window = %+v, want the zero window", full)
	}
	if args := full.rangeArgs(); args != nil {
		t.Errorf("full rangeArgs = %q, want nil", args)
	}

	hook, err := scenarioWindow(scenarioHook, now, shanghai, func() (string, error) {
		return "2026-11-01", nil
	})
	if err != nil {
		t.Fatalf("hook: %v", err)
	}
	if hook.Since != "20261101" || hook.Until != "20261104" {
		t.Errorf("hook window = %+v, want 20261101..20261104 (watermark..today)", hook)
	}

	// A cold cursor has no watermark: the hook path reconciles everything, so
	// the window is the unfiltered one.
	cold, err := scenarioWindow(scenarioHook, now, shanghai, func() (string, error) { return "", nil })
	if err != nil {
		t.Fatalf("hook cold: %v", err)
	}
	if cold != (collectWindow{}) {
		t.Errorf("cold hook window = %+v, want the zero window", cold)
	}

	if _, err := scenarioWindow(scenarioHook, now, shanghai, func() (string, error) {
		return "", errors.New("cursor is corrupt")
	}); err == nil {
		t.Error("hook window with a failing cursor reader = nil error, want the reader's error")
	}

	// A watermark ahead of the clock (skew, or a date in another zone) must not
	// produce a reversed range: ccusage rejects since > until.
	skewed, err := scenarioWindow(scenarioHook, now, shanghai, func() (string, error) {
		return "2026-11-09", nil
	})
	if err != nil {
		t.Fatalf("hook skew: %v", err)
	}
	if skewed.Since != "20261104" || skewed.Until != "20261104" {
		t.Errorf("skewed hook window = %+v, want it clamped to 20261104", skewed)
	}

	if _, err := scenarioWindow("week", now, shanghai, nil); err == nil {
		t.Error("scenarioWindow(unknown) = nil error, want a usage error")
	}
}

// TestReportMarksRegressions pins the honesty rule: when the native side is
// slower than the ccusage side it replaces, the report says so instead of
// cherry-picking the metric that looks better. A native side that was never
// measured is not a win either.
func TestReportMarksRegressions(t *testing.T) {
	slower := benchReport{
		Source:   string(contract.SourceClaudeCode),
		Scenario: string(scenarioFull),
		Ccusage:  sideReport{Kind: sideCcusage, Status: sideMeasured, MedianWallMs: 30_000},
		Native:   sideReport{Kind: sideNative, Status: sideMeasured, MedianWallMs: 42_000},
	}
	slower.markRegressions()
	if !slower.Regression {
		t.Fatal("regression = false, want true when native is slower")
	}
	if len(slower.Regressions) != 1 || !strings.Contains(slower.Regressions[0], "native") {
		t.Fatalf("regressions = %q, want one native entry", slower.Regressions)
	}
	var text bytes.Buffer
	writeTextReport(&text, slower)
	if !strings.Contains(strings.ToLower(text.String()), "regression") {
		t.Errorf("text report hides the regression:\n%s", text.String())
	}

	faster := benchReport{
		Ccusage: sideReport{Kind: sideCcusage, Status: sideMeasured, MedianWallMs: 30_000},
		Native:  sideReport{Kind: sideNative, Status: sideMeasured, MedianWallMs: 1_200},
	}
	faster.markRegressions()
	if faster.Regression || len(faster.Regressions) != 0 {
		t.Errorf("regression = %v (%q), want none when native is faster", faster.Regression, faster.Regressions)
	}

	unmeasured := benchReport{
		Ccusage: sideReport{Kind: sideCcusage, Status: sideMeasured, MedianWallMs: 30_000},
		Native:  sideReport{Kind: sideNative, Status: sideNotImplemented, MedianWallMs: 0},
	}
	unmeasured.markRegressions()
	if unmeasured.Regression {
		t.Error("regression = true for an unmeasured native side; notImplemented must never read as a win")
	}

	emptyBaseline := benchReport{
		Ccusage: sideReport{Kind: sideCcusage, Status: sideMeasured},
		Native:  sideReport{Kind: sideNative, Status: sideMeasured, MedianWallMs: 10},
	}
	emptyBaseline.markRegressions()
	if !emptyBaseline.Regression {
		t.Error("regression = false with a zero ccusage baseline; the division guard must not hide it")
	}
}

// TestPeakRSSReportsBytesOnDarwinAndKilobytesOnLinux pins the unit split.
//
// Measured on this darwin host (2026-11-04, probe in the task report): a
// process holding ~300 MiB resident reported RUSAGE_SELF Ru_maxrss =
// 318,177,280 while Go's HeapAlloc was 314,906,784 bytes — the rusage field is
// bytes here, not kilobytes (318,177,280 KiB would be 303 GiB). Linux's
// ru_maxrss is kilobytes, so the two platforms need different multipliers
// before anything is compared or printed as a size.
func TestPeakRSSReportsBytesOnDarwinAndKilobytesOnLinux(t *testing.T) {
	cases := []struct {
		goos string
		raw  int64
		want uint64
	}{
		{"darwin", 318_177_280, 318_177_280},
		{"linux", 2_633, 2_633 * 1024},
		{"linux", 0, 0},
		{"darwin", 0, 0},
		{"linux", -1, 0},
		{"freebsd", 1_024, 1_024 * 1024},
	}
	for _, testCase := range cases {
		if got := rusageMaxRSSBytes(testCase.raw, testCase.goos); got != testCase.want {
			t.Errorf("rusageMaxRSSBytes(%d, %q) = %d, want %d", testCase.raw, testCase.goos, got, testCase.want)
		}
	}
}

// TestCcusageCallsMatchTheProviderFlags pins the argument lists against the
// providers they mirror: a flag present in one place and missing in the other
// makes the benchmark measure a command no client ever runs. Claude runs
// `--breakdown` on the daily report only and never `--offline` (that flag moves
// its costs onto ccusage's builtin catalogue, which the collector rejected);
// Codex always runs `--offline`; both pass `--single-thread`; the twelve tool
// sources pass neither and use their own subcommand name.
func TestCcusageCallsMatchTheProviderFlags(t *testing.T) {
	day := collectWindow{Since: "20261103", Until: "20261103"}
	rangeArgs := []string{"--since", "20261103", "--until", "20261103"}
	tz := []string{"--timezone", "Asia/Shanghai"}

	claude, err := ccusageCalls(contract.SourceClaudeCode, day, "Asia/Shanghai", "")
	if err != nil {
		t.Fatalf("claude-code: %v", err)
	}
	wantClaude := [][]string{
		concat([]string{"claude", "daily", "--json", "--breakdown", "--single-thread"}, rangeArgs, tz),
		concat([]string{"claude", "session", "--json", "--single-thread"}, rangeArgs, tz),
	}
	assertCalls(t, "claude-code", claude, wantClaude)

	codex, err := ccusageCalls(contract.SourceCodex, day, "Asia/Shanghai", "")
	if err != nil {
		t.Fatalf("codex: %v", err)
	}
	wantCodex := [][]string{
		concat([]string{"codex", "daily", "--json", "--offline", "--single-thread"}, rangeArgs, tz),
		concat([]string{"codex", "session", "--json", "--offline", "--single-thread"}, rangeArgs, tz),
	}
	assertCalls(t, "codex", codex, wantCodex)

	kimi, err := ccusageCalls(contract.SourceKimi, day, "Asia/Shanghai", "")
	if err != nil {
		t.Fatalf("kimi: %v", err)
	}
	wantKimi := [][]string{
		concat([]string{"kimi", "daily", "--json"}, rangeArgs, tz),
		concat([]string{"kimi", "session", "--json"}, rangeArgs, tz),
	}
	assertCalls(t, "kimi", kimi, wantKimi)

	// ccusage has no `gemini-cli` subcommand; the tool family maps the source
	// to `gemini`. Getting this wrong exits 2 on every run.
	gemini, err := ccusageCalls(contract.SourceGeminiCLI, day, "Asia/Shanghai", "")
	if err != nil {
		t.Fatalf("gemini-cli: %v", err)
	}
	if got := gemini[0][0]; got != "gemini" {
		t.Errorf("gemini-cli subcommand = %q, want %q", got, "gemini")
	}

	// The full scenario passes no date filter at all.
	full, err := ccusageCalls(contract.SourceClaudeCode, collectWindow{}, "Asia/Shanghai", "")
	if err != nil {
		t.Fatalf("full: %v", err)
	}
	if strings.Contains(strings.Join(full[0], " "), "--since") {
		t.Errorf("full-window daily args = %q, want no --since", full[0])
	}

	// Sources with no ccusage side cannot be benchmarked on the ccusage path.
	if _, err := ccusageCalls(contract.SourceOpenCode, day, "Asia/Shanghai", ""); err == nil {
		t.Error("ccusageCalls(opencode) = nil error, want a usage error")
	}
}

// TestBenchRunSummarizesInjectedRounds drives the whole loop with injected
// measurements: the round count, the median/max aggregation, the resolved
// window reaching the runner, the pending bytes-read marker, and the
// regression flag.
func TestBenchRunSummarizesInjectedRounds(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	var requests []roundRequest
	input := benchInput{
		Source:   contract.SourceClaudeCode,
		Scenario: scenarioSingle,
		Rounds:   7,
		Timezone: "UTC",
		Now:      func() time.Time { return now },
		CollectCcusage: func(_ context.Context, request roundRequest) (roundResult, error) {
			requests = append(requests, request)
			round := float64(len(requests))
			return roundResult{
				WallMs:       1_000 + round,
				PeakRSSBytes: uint64(round) * 100,
				RSSSource:    rssSourceWait4,
				OutputBytes:  64,
				Calls:        2,
			}, nil
		},
		CollectNative: func(context.Context, roundRequest) (roundResult, error) {
			return roundResult{WallMs: 2_000, PeakRSSBytes: 50, RSSSource: rssSourceSelf, Calls: 1}, nil
		},
	}
	report, err := runBench(context.Background(), input)
	if err != nil {
		t.Fatalf("runBench: %v", err)
	}
	if len(report.Ccusage.Rounds) != 7 || len(report.Native.Rounds) != 7 {
		t.Fatalf("rounds = %d/%d, want 7/7", len(report.Ccusage.Rounds), len(report.Native.Rounds))
	}
	if report.Ccusage.MedianWallMs != 1_004 {
		t.Errorf("ccusage median wall = %v, want 1004", report.Ccusage.MedianWallMs)
	}
	if report.Ccusage.MaxWallMs != 1_007 {
		t.Errorf("ccusage max wall = %v, want 1007", report.Ccusage.MaxWallMs)
	}
	if report.Ccusage.MedianPeakRSSBytes != 400 {
		t.Errorf("ccusage median peak RSS = %d, want 400", report.Ccusage.MedianPeakRSSBytes)
	}
	if report.Ccusage.MaxPeakRSSBytes != 700 {
		t.Errorf("ccusage max peak RSS = %d, want 700", report.Ccusage.MaxPeakRSSBytes)
	}
	if !report.Ccusage.BytesReadPending || report.Ccusage.BytesRead != 0 {
		t.Errorf("bytesRead = %d pending=%v, want 0/pending", report.Ccusage.BytesRead, report.Ccusage.BytesReadPending)
	}
	if report.Window != (collectWindow{Since: "20261103", Until: "20261103"}) {
		t.Errorf("window = %+v, want 20261103..20261103", report.Window)
	}
	if len(requests) != 7 || requests[0].Window != report.Window {
		t.Errorf("runner requests = %+v, want 7 carrying the resolved window", requests)
	}
	if requests[0].Timezone != "UTC" {
		t.Errorf("request timezone = %q, want UTC", requests[0].Timezone)
	}
	if !report.Regression {
		t.Error("regression = false, want true (native 2000ms vs ccusage 1004ms)")
	}
	if report.Ccusage.RSSSource != rssSourceWait4 {
		t.Errorf("ccusage rss source = %q, want %q", report.Ccusage.RSSSource, rssSourceWait4)
	}
}

// TestRunRejectsInvalidInvocations covers the exit-code contract: a bad source,
// an unknown scenario, too few rounds, and the hook scenario on a source that
// has no hook cursor are all usage errors (exit 2), never a failed run.
func TestRunRejectsInvalidInvocations(t *testing.T) {
	cases := []struct {
		name string
		args []string
	}{
		{"unknown source", []string{"-source", "nope", "-scenario", "full"}},
		{"missing source", []string{"-scenario", "full"}},
		{"unknown scenario", []string{"-source", "claude-code", "-scenario", "week"}},
		{"too few rounds", []string{"-source", "claude-code", "-scenario", "full", "-rounds", "4"}},
		{"hook without a cursor source", []string{"-source", "kimi", "-scenario", "hook"}},
		// A source ccusage does not answer for has no baseline to compare
		// against: asking for one is an invocation error, not a failed run.
		{"baseline for a source without a ccusage path", []string{"-source", "opencode", "-scenario", "full", "-ccusage-bin", "/usr/bin/false"}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := runWith(testCase.args, &stdout, &stderr, benchInput{
				// Never reached: the invocation is rejected before a round runs.
				CollectCcusage: func(context.Context, roundRequest) (roundResult, error) {
					t.Fatal("a rejected invocation must not run a round")
					return roundResult{}, nil
				},
			})
			if code != exitUsage {
				t.Errorf("exit = %d, want %d (stderr: %s)", code, exitUsage, stderr.String())
			}
		})
	}
}

// TestRunPrintsJSONAndText drives both output modes end to end, with the native
// side injected so the notImplemented branch is exercised without collecting
// the developer's own history. The seam is no longer "the real registry is
// empty": since S2 it holds a native claude-code provider (pinned by
// TestBenchBinarySeesTheNativeRegistry), so leaving it nil here would run a
// real collection five times.
func TestRunPrintsJSONAndText(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	seam := benchInput{
		CcusageBin: "/injected/ccusage",
		Now:        func() time.Time { return now },
		Timezone:   "UTC",
		CollectCcusage: func(context.Context, roundRequest) (roundResult, error) {
			return roundResult{WallMs: 1_500, PeakRSSBytes: 1 << 30, RSSSource: rssSourceWait4, Calls: 2}, nil
		},
		CollectNative: func(context.Context, roundRequest) (roundResult, error) {
			return roundResult{}, errNoNativeProvider
		},
	}

	var stdout, stderr bytes.Buffer
	code := runWith([]string{
		"-source", "claude-code", "-scenario", "full", "-rounds", "5", "-json",
	}, &stdout, &stderr, seam)
	if code != exitOK {
		t.Fatalf("exit = %d, want %d (stderr: %s)", code, exitOK, stderr.String())
	}
	var report benchReport
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("decode JSON report: %v\n%s", err, stdout.String())
	}
	if report.Source != "claude-code" || report.Scenario != "full" || report.Rounds != 5 {
		t.Errorf("report header = %+v, want claude-code/full/5", report)
	}
	if len(report.Ccusage.Rounds) != 5 {
		t.Errorf("ccusage rounds = %d, want 5", len(report.Ccusage.Rounds))
	}
	if report.Native.Status != sideNotImplemented {
		t.Errorf("native status = %q, want %q when the native seam has no provider",
			report.Native.Status, sideNotImplemented)
	}
	if len(report.Ccusage.Rounds) != 5 || report.Ccusage.Status != sideMeasured {
		t.Errorf("ccusage = %d rounds / %q, want 5 measured with -ccusage-bin",
			len(report.Ccusage.Rounds), report.Ccusage.Status)
	}
	if !report.Ccusage.BytesReadPending {
		t.Error("bytesReadPending = false, want true until the S2 adapter counter lands")
	}

	stdout.Reset()
	code = runWith([]string{
		"-source", "claude-code", "-scenario", "single", "-rounds", "5",
	}, &stdout, &stderr, seam)
	if code != exitOK {
		t.Fatalf("exit = %d, want %d (stderr: %s)", code, exitOK, stderr.String())
	}
	text := stdout.String()
	for _, want := range []string{"bench-collect", "ccusage: measured", "native: notImplemented", "median", "bytesRead"} {
		if !strings.Contains(text, want) {
			t.Errorf("text report is missing %q:\n%s", want, text)
		}
	}
}

// TestCollectCcusageRoundReportsAFailingBinary proves a wedged or missing
// binary is a failure (exit 1), not a silent zero-cost round.
func TestCollectCcusageRoundReportsAFailingBinary(t *testing.T) {
	_, err := collectCcusageRound(context.Background(), roundRequest{
		Source:   contract.SourceClaudeCode,
		Bin:      "/nonexistent/ccusage-bench-test",
		Timezone: "UTC",
	})
	if err == nil {
		t.Fatal("collectCcusageRound with a missing binary = nil error, want a failure")
	}
}

// TestAssertUsableBinaryRejectsUnusablePaths pins the up-front checks: a missing
// path, a directory, and — on unix — a file without an execute bit all fail
// before the first round instead of once per round with a generic "permission
// denied". Windows has no execute bit, so that case is skipped there.
func TestAssertUsableBinaryRejectsUnusablePaths(t *testing.T) {
	if err := assertUsableBinary("/nonexistent/ccusage-bench-test"); err == nil {
		t.Error("missing path = nil error, want a failure")
	}
	if err := assertUsableBinary(t.TempDir()); err == nil {
		t.Error("directory = nil error, want a failure")
	}

	dataFile := filepath.Join(t.TempDir(), "ccusage")
	if err := os.WriteFile(dataFile, []byte("#!/bin/sh\n"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	err := assertUsableBinary(dataFile)
	if runtime.GOOS == "windows" {
		if err != nil {
			t.Errorf("windows = %v, want nil (no execute bit on Windows)", err)
		}
		return
	}
	if err == nil || !strings.Contains(err.Error(), "not executable") {
		t.Fatalf("non-executable file = %v, want a 'not executable' error", err)
	}
	if err := os.Chmod(dataFile, 0o755); err != nil {
		t.Fatalf("chmod fixture: %v", err)
	}
	if err := assertUsableBinary(dataFile); err != nil {
		t.Errorf("executable file = %v, want nil", err)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func concat(groups ...[]string) []string {
	out := []string{}
	for _, group := range groups {
		out = append(out, group...)
	}
	return out
}

func assertCalls(t *testing.T, name string, got, want [][]string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: %d calls, want %d (%v)", name, len(got), len(want), got)
	}
	for i := range want {
		if !equalStrings(got[i], want[i]) {
			t.Errorf("%s call %d = %q, want %q", name, i+1, got[i], want[i])
		}
	}
}

// inclusiveDays counts the calendar days a compact window covers.
func inclusiveDays(t *testing.T, since, until string) int {
	t.Helper()
	parse := func(value string) time.Time {
		parsed, err := time.Parse("20060102", value)
		if err != nil {
			t.Fatalf("parse compact date %q: %v", value, err)
		}
		return parsed
	}
	days := int(parse(until).Sub(parse(since)).Hours()/24) + 1
	return days
}

// TestBenchBinarySeesTheNativeRegistry pins the blank import in main.go. The
// providers register both seams from their own init(), and Go only runs an
// imported package's init() when it is linked: without the import this binary
// compiles, but its native column would read notImplemented for every source
// because collect.LookupNative sees an empty registry.
func TestBenchBinarySeesTheNativeRegistry(t *testing.T) {
	provider, ok := collect.LookupNative(contract.SourceClaudeCode)
	if !ok || provider == nil {
		t.Fatalf("collect.LookupNative(%q) = (%v, %v), want the claude-code native provider", contract.SourceClaudeCode, provider, ok)
	}
}

// TestBenchRunWithoutABaselineMeasuresOnlyTheNativeSide pins the post-S5
// default at the CLI boundary: with no -ccusage-bin the ccusage column is
// skipped and no round is measured for it.
func TestBenchRunWithoutABaselineMeasuresOnlyTheNativeSide(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	input := benchInput{
		Source:   contract.SourceClaudeCode,
		Scenario: scenarioSingle,
		Rounds:   defaultRounds,
		Timezone: "UTC",
		Now:      func() time.Time { return now },
		CollectNative: func(context.Context, roundRequest) (roundResult, error) {
			return roundResult{WallMs: 10, PeakRSSBytes: 10, RSSSource: rssSourceSelf, Calls: 1}, nil
		},
	}
	report, err := runBench(context.Background(), input)
	if err != nil {
		t.Fatalf("runBench: %v", err)
	}
	if report.Ccusage.Status != sideSkipped || len(report.Ccusage.Rounds) != 0 {
		t.Fatalf("ccusage = %q / %d rounds, want skipped", report.Ccusage.Status, len(report.Ccusage.Rounds))
	}
	if report.Native.Status != sideMeasured || len(report.Native.Rounds) != defaultRounds {
		t.Fatalf("native = %q / %d rounds, want %d measured",
			report.Native.Status, len(report.Native.Rounds), defaultRounds)
	}
	if report.Regression {
		t.Error("a skipped baseline is no regression")
	}
}
