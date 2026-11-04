// Command parity compares one source's native collection against the ccusage
// path over the same window. It is a development harness for the transition
// away from the ccusage binary.
//
// The native side comes from collect.LookupNative, never from collect.Lookup:
// every Lookup provider for a ccusage-backed source execs ccusage itself, so
// using it here would compare ccusage with itself and always pass. In S1 the
// native registry is empty, so every source reports notImplemented on the
// native side while the ccusage side still runs.
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
	"sort"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// errUsage marks an error caused by the invocation itself (an invalid source
// or window), which run maps to the usage exit code rather than a failure.
var errUsage = errors.New("usage")

const (
	exitOK      = 0
	exitFailure = 1
	exitUsage   = 2
)

// Report statuses. notImplemented is not a difference: it says the native side
// has no provider for the source yet (S1), so there is nothing to compare. It
// must never read as a clean match. empty is likewise not a difference: both
// sides agreed on zero rows in the window, which is not evidence that the two
// implementations agree — a source whose data sits outside the window would
// otherwise inflate the coverage claim. Both exit 0; a real clean match is the
// only statusMatch that stands for coverage.
const (
	statusMatch          = "match"
	statusEmpty          = "empty"
	statusDiff           = "diff"
	statusNotImplemented = "notImplemented"
)

// ccusageTimeoutMs bounds one ccusage report. ccusage walks the whole session
// tree to build a single day's totals, so the providers' 900s budget is reused;
// the parity run is a foreground dev command, where a wedged child must fail
// rather than hang forever.
const ccusageTimeoutMs = 900_000

// parityKey is the comparison key the design fixes: the usage date and the
// model. The source is constant on both sides, so it needs no place in the key.
type parityKey struct {
	UsageDate string `json:"usageDate"`
	Model     string `json:"model"`
}

// parityFieldDiff is one field two same-key rows disagree on.
type parityFieldDiff struct {
	Field   string `json:"field"`
	Native  any    `json:"native"`
	Ccusage any    `json:"ccusage"`
}

// parityValueDiff is a same-key row whose values differ.
type parityValueDiff struct {
	Key    parityKey         `json:"key"`
	Fields []parityFieldDiff `json:"fields"`
}

// parityReport is what the command prints, in both output modes.
//
// LiveWrite lists rows whose difference is explained by the source still being
// written while the comparison ran. The scans are sequential — native first,
// then ccusage — so a session file that grows between them legitimately yields
// more usage on the ccusage side. Those rows are reported but are not failures;
// see isLiveWriteDifference.
type parityReport struct {
	Source           string            `json:"source"`
	Since            string            `json:"since,omitempty"`
	Until            string            `json:"until,omitempty"`
	Timezone         string            `json:"timezone"`
	Status           string            `json:"status"`
	NativeSnapshots  int               `json:"nativeSnapshots"`
	CcusageSnapshots int               `json:"ccusageSnapshots"`
	Matched          int               `json:"matched"`
	OnlyInNative     []parityKey       `json:"onlyInNative,omitempty"`
	OnlyInCcusage    []parityKey       `json:"onlyInCcusage,omitempty"`
	ValueDiffs       []parityValueDiff `json:"valueDiffs,omitempty"`
	LiveWrite        []parityKey       `json:"liveWrite,omitempty"`
}

// parityInput is one comparison's inputs. The function seams exist so tests can
// drive the comparison without a ccusage binary or a native provider.
type parityInput struct {
	Source     contract.Source
	Since      string
	Until      string
	Timezone   string
	CcusageBin string
	// LookupNative resolves the native side; nil means collect.LookupNative.
	LookupNative func(contract.Source) (collect.Provider, bool)
	// CollectCcusage gathers the ccusage side; nil means exec the binary.
	CollectCcusage func(ctx context.Context, source contract.Source, bin, since, until, timezone string) ([]contract.Snapshot, error)
	// Now is the comparison clock; nil means time.Now.
	Now func() time.Time
	// Stderr receives native-side diagnostics; nil discards them.
	Stderr io.Writer
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run parses the flags and executes one comparison. It is separate from main so
// the exit-code contract is testable without spawning the binary.
func run(args []string, stdout, stderr io.Writer) int {
	return runWith(args, stdout, stderr, parityInput{})
}

// runWith is run with the comparison's function seams injectable, so the
// exit-code contract can be exercised without a ccusage binary.
func runWith(args []string, stdout, stderr io.Writer, input parityInput) int {
	flags := flag.NewFlagSet("parity", flag.ContinueOnError)
	flags.SetOutput(stderr)
	source := flags.String("source", "", "usage source to compare (required)")
	since := flags.String("since", "", "first usage date to compare, YYYY-MM-DD")
	until := flags.String("until", "", "last usage date to compare, YYYY-MM-DD")
	ccusageBin := flags.String("ccusage-bin", "", "ccusage binary (default ~/.tokenboard/bin/ccusage)")
	jsonOutput := flags.Bool("json", false, "print a machine-readable report")
	flags.Usage = func() {
		fmt.Fprintln(stderr, "Usage: parity -source S -since YYYY-MM-DD -until YYYY-MM-DD [-ccusage-bin PATH] [-json]")
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
			fmt.Fprintf(stderr, "parity: unknown source %q\n", trimmedSource)
		}
		flags.Usage()
		return exitUsage
	}

	input.Source = contract.Source(trimmedSource)
	input.Since = *since
	input.Until = *until
	input.CcusageBin = *ccusageBin
	if input.Stderr == nil {
		input.Stderr = stderr
	}
	report, err := runParity(context.Background(), input)
	if err != nil {
		fmt.Fprintf(stderr, "parity: %v\n", err)
		if errors.Is(err, errUsage) {
			return exitUsage
		}
		return exitFailure
	}

	if *jsonOutput {
		payload, err := json.MarshalIndent(report, "", "  ")
		if err != nil {
			fmt.Fprintf(stderr, "parity: %v\n", err)
			return exitFailure
		}
		fmt.Fprintln(stdout, string(payload))
	} else {
		writeTextReport(stdout, report)
	}
	// notImplemented is not a failure: S1 ships no native provider, and the
	// operator asked for the boundary, not an error. empty likewise exits 0:
	// both sides agreeing on zero rows is not a difference. A diff exits 1; a
	// clean match (live-write rows included) exits 0.
	if report.Status == statusDiff {
		return exitFailure
	}
	return exitOK
}

// runParity performs one comparison. A missing native provider is a report,
// not an error: S1 ships none, and the operator still wants the ccusage side's
// output.
func runParity(ctx context.Context, input parityInput) (parityReport, error) {
	report := parityReport{Source: string(input.Source)}
	if !contract.IsValidSource(string(input.Source)) {
		return report, fmt.Errorf("%w: unknown source %q", errUsage, input.Source)
	}
	now := time.Now
	if input.Now != nil {
		now = input.Now
	}
	timezone := strings.TrimSpace(input.Timezone)
	if timezone == "" {
		timezone = sessionusage.LocalTimezone()
	}
	if !contract.IsValidTimezone(timezone) {
		return report, fmt.Errorf("%w: unknown timezone %q", errUsage, timezone)
	}
	normalizedSince, normalizedUntil, err := sessionusage.AssertValidDateFilterRange(
		input.Since, input.Until, "parity since date", "parity until date")
	if err != nil {
		return report, fmt.Errorf("%w: %v", errUsage, err)
	}
	report.Since = normalizedSince
	report.Until = normalizedUntil
	report.Timezone = timezone

	collectCcusage := input.CollectCcusage
	if collectCcusage == nil {
		// A source ccusage cannot report has no parity comparison at all; that
		// is an invocation error, not a failed run.
		if !hasCcusageSide(input.Source) {
			return report, fmt.Errorf("%w: %s has no ccusage path; parity compares ccusage-backed sources only",
				errUsage, input.Source)
		}
		collectCcusage = execCcusage
	}
	// The ccusage side runs even when the native side is missing: the operator
	// wants to see what production would collect from this machine.
	ccusageRows, err := collectCcusage(ctx, input.Source, input.CcusageBin, normalizedSince, normalizedUntil, timezone)
	if err != nil {
		return report, fmt.Errorf("ccusage side: %w", err)
	}
	report.CcusageSnapshots = len(ccusageRows)

	lookupNative := input.LookupNative
	if lookupNative == nil {
		lookupNative = collect.LookupNative
	}
	nativeProvider, ok := lookupNative(input.Source)
	if !ok || nativeProvider == nil {
		// Deliberately no fallback to collect.Lookup: those providers exec
		// ccusage, so taking one here would compare ccusage with itself.
		report.Status = statusNotImplemented
		return report, nil
	}

	nativeRows, err := collectNative(ctx, nativeProvider, timezone, normalizedSince, normalizedUntil, input.Stderr)
	if err != nil {
		return report, fmt.Errorf("native side: %w", err)
	}
	report.NativeSnapshots = len(nativeRows)

	comparison := compareParity(nativeRows, ccusageRows, now())
	comparison.Source = report.Source
	comparison.Since = report.Since
	comparison.Until = report.Until
	comparison.Timezone = report.Timezone
	comparison.NativeSnapshots = report.NativeSnapshots
	comparison.CcusageSnapshots = report.CcusageSnapshots
	return comparison, nil
}

// collectNative runs the native provider with an isolated state directory and
// hook mode stripped. Parity compares the full-preview path on both sides, and
// a comparison must never write the machine's real cursors.
func collectNative(
	ctx context.Context,
	provider collect.Provider,
	timezone, since, until string,
	stderr io.Writer,
) ([]contract.Snapshot, error) {
	stateDir, err := os.MkdirTemp("", "tokenboard-parity-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(stateDir)
	return provider.Collect(ctx, collect.Options{
		Timezone: timezone,
		Since:    since,
		Until:    until,
		StateDir: stateDir,
		Stderr: func(line string) {
			if stderr != nil {
				fmt.Fprintf(stderr, "native: %s\n", line)
			}
		},
		Env: parityEnv,
	})
}

// parityEnv strips hook mode: an ambient TOKENBOARD_HOOK_MODE belongs to a
// notifier and would silently compare the incremental path against a full
// ccusage report.
func parityEnv(key string) string {
	if key == "TOKENBOARD_HOOK_MODE" {
		return ""
	}
	return os.Getenv(key)
}

// compareParity normalizes both sides to a key-ordered map and reports the
// differences. Values are compared through HashPayload, which already omits
// collectedAt (wall clock, not semantics).
//
// A comparison over zero rows on both sides is statusEmpty, not statusMatch: an
// empty window is not evidence that the two implementations agree, and reporting
// it as a match would let a source whose data sits outside the window claim
// coverage every day (shadow-dual-run's "empty" bucket exists for the same
// reason).
//
// now is the comparison clock, used to recognise the live-write race; it is a
// parameter so the classification is testable without touching the clock.
func compareParity(native, ccusageRows []contract.Snapshot, now time.Time) parityReport {
	nativeByKey := paritySnapshotMap(native)
	ccusageByKey := paritySnapshotMap(ccusageRows)

	keys := make([]string, 0, len(nativeByKey)+len(ccusageByKey))
	seen := map[string]bool{}
	for key := range nativeByKey {
		keys = append(keys, key)
		seen[key] = true
	}
	for key := range ccusageByKey {
		if !seen[key] {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)

	report := parityReport{Status: statusMatch}
	for _, key := range keys {
		nativeRow, inNative := nativeByKey[key]
		ccusageRow, inCcusage := ccusageByKey[key]
		switch {
		case inNative && !inCcusage:
			report.OnlyInNative = append(report.OnlyInNative, parityKeyOf(nativeRow))
		case inCcusage && !inNative:
			report.OnlyInCcusage = append(report.OnlyInCcusage, parityKeyOf(ccusageRow))
		default:
			if nativeRow.HashPayload() == ccusageRow.HashPayload() {
				report.Matched++
				continue
			}
			fields := parityFieldDiffs(nativeRow, ccusageRow)
			if isLiveWriteDifference(nativeRow, fields, now) {
				report.LiveWrite = append(report.LiveWrite, parityKeyOf(nativeRow))
				continue
			}
			report.ValueDiffs = append(report.ValueDiffs, parityValueDiff{
				Key:    parityKeyOf(nativeRow),
				Fields: fields,
			})
		}
	}
	if len(report.OnlyInNative) > 0 || len(report.OnlyInCcusage) > 0 || len(report.ValueDiffs) > 0 {
		report.Status = statusDiff
	} else if len(nativeByKey) == 0 && len(ccusageByKey) == 0 {
		// Both sides produced nothing: the window may sit entirely outside the
		// source's data. This is not the same claim as a clean match.
		report.Status = statusEmpty
	}
	return report
}

// isLiveWriteDifference reports whether a differing row is explained by the
// source still being appended to while the comparison ran, rather than by the
// two implementations disagreeing. It mirrors tokenboard shadow's rule, with
// ccusage in the later-scan role.
//
// Every condition below must hold; anything else stays a difference:
//
//   - the row is for today in its own timezone. Settled dates have no writes
//     left to race, so a difference there is always real drift.
//   - only token counts and costUsd differ. sessionCount and correction are
//     never derived from a partial read, so a difference in either is a real
//     disagreement even on today's row.
//   - every token field is non-decreasing towards the later (ccusage) scan.
//     Appending can only add usage; a row where the later scan sees fewer
//     tokens means the read itself disagrees, not the timing.
//
// costUsd is deliberately not direction-constrained: a row ccusage prices at 0
// is allocated cost pro-rata from its day total, so another model growing
// between the scans can shrink this row's share. That is the same single cause,
// and a real pricing bug would also show on a settled date.
func isLiveWriteDifference(nativeRow contract.Snapshot, fields []parityFieldDiff, now time.Time) bool {
	if !isToday(nativeRow.UsageDate, nativeRow.Timezone, now) {
		return false
	}
	for _, field := range fields {
		switch field.Field {
		case "inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "totalTokens":
			nativeValue, nativeOK := field.Native.(int64)
			ccusageValue, ccusageOK := field.Ccusage.(int64)
			if !nativeOK || !ccusageOK || ccusageValue < nativeValue {
				return false
			}
		case "costUsd":
			// Explained by the day denominator; see the comment above.
		default:
			return false
		}
	}
	return len(fields) > 0
}

// isToday answers whether usageDate is today's calendar date in the row's own
// timezone. An unparseable date is never treated as today: the row then stays
// a difference rather than being excused.
func isToday(usageDate, timezone string, now time.Time) bool {
	if usageDate == "" {
		return false
	}
	location, err := contract.LoadLocation(timezone)
	if err != nil {
		return false
	}
	return now.In(location).Format("2006-01-02") == usageDate
}

// paritySnapshotMap indexes rows by the comparison key. A provider should never
// emit two rows for the same date and model (the merge layer guarantees it), so
// a collision collapses to the last row; both sides' totals are reported next to
// the matched count, which is where such a collapse would show up.
func paritySnapshotMap(snapshots []contract.Snapshot) map[string]contract.Snapshot {
	rows := make(map[string]contract.Snapshot, len(snapshots))
	for _, snapshot := range snapshots {
		rows[parityKeyString(snapshot)] = snapshot
	}
	return rows
}

func parityKeyString(snapshot contract.Snapshot) string {
	return snapshot.UsageDate + "\x00" + snapshot.Model
}

func parityKeyOf(snapshot contract.Snapshot) parityKey {
	return parityKey{UsageDate: snapshot.UsageDate, Model: snapshot.Model}
}

// parityFieldDiffs lists the fields two same-key rows disagree on. The fields
// are the ones the upload contract carries; collectedAt is excluded because it
// is wall clock.
func parityFieldDiffs(nativeRow, ccusageRow contract.Snapshot) []parityFieldDiff {
	fields := []struct {
		name    string
		native  any
		ccusage any
	}{
		{"timezone", nativeRow.Timezone, ccusageRow.Timezone},
		{"inputTokens", nativeRow.InputTokens, ccusageRow.InputTokens},
		{"outputTokens", nativeRow.OutputTokens, ccusageRow.OutputTokens},
		{"cacheCreationTokens", nativeRow.CacheCreation, ccusageRow.CacheCreation},
		{"cacheReadTokens", nativeRow.CacheRead, ccusageRow.CacheRead},
		{"totalTokens", nativeRow.TotalTokens, ccusageRow.TotalTokens},
		{"costUsd", nativeRow.CostUSD, ccusageRow.CostUSD},
		{"sessionCount", nativeRow.SessionCount, ccusageRow.SessionCount},
		{"correction", string(nativeRow.Correction), string(ccusageRow.Correction)},
	}
	diffs := make([]parityFieldDiff, 0, len(fields))
	for _, field := range fields {
		if field.native != field.ccusage {
			diffs = append(diffs, parityFieldDiff{Field: field.name, Native: field.native, Ccusage: field.ccusage})
		}
	}
	return diffs
}

// execCcusage runs the ccusage binary for a source and normalizes its daily and
// session reports, mirroring the shape each provider uses.
func execCcusage(
	ctx context.Context,
	source contract.Source,
	bin, since, until, timezone string,
) ([]contract.Snapshot, error) {
	binary := strings.TrimSpace(bin)
	if binary == "" {
		binary = defaultCcusageBin()
	}
	info, err := os.Stat(binary)
	if err != nil {
		return nil, fmt.Errorf("ccusage binary not found at %s: %w", binary, err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("ccusage binary path %s is a directory", binary)
	}

	rangeArgs := []string{}
	if since != "" {
		rangeArgs = append(rangeArgs, "--since", since)
	}
	if until != "" {
		rangeArgs = append(rangeArgs, "--until", until)
	}
	commandOptions := ccusage.CommandOptions{TimeoutMs: ccusageTimeoutMs}

	dailyArgs, err := ccusageReportArgs(source, "daily", rangeArgs, timezone)
	if err != nil {
		return nil, err
	}
	daily, err := ccusage.RunJSON(ctx, binary, dailyArgs, commandOptions)
	if err != nil {
		return nil, fmt.Errorf("ccusage daily: %w", err)
	}
	// An empty daily report means the tool has no data in the window; the
	// session report would only attribute counts to rows that do not exist.
	if !ccusage.HasDailyRows(daily) {
		return []contract.Snapshot{}, nil
	}

	sessionArgs, err := ccusageReportArgs(source, "session", rangeArgs, timezone)
	if err != nil {
		return nil, err
	}
	sessions, err := ccusage.RunJSON(ctx, binary, sessionArgs, commandOptions)
	if err != nil {
		return nil, fmt.Errorf("ccusage session: %w", err)
	}

	return ccusage.NormalizeCcusageDailyJSON(daily, ccusage.NormalizeOptions{
		Source:      source,
		Timezone:    timezone,
		CollectedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Sessions:    sessions,
		HasSessions: true,
	})
}

// hasCcusageSide reports whether the ccusage binary answers for a source. The
// remaining sources (the Antigravity family, OpenCode, Pi, Grok Build and DeepSeek
// Harness) are read natively from their own stores, so there is no second
// implementation to compare against.
func hasCcusageSide(source contract.Source) bool {
	switch source {
	case contract.SourceClaudeCode, contract.SourceCodex:
		return true
	}
	_, ok := contract.CcusageToolCommand(source)
	return ok
}

// ccusageReportArgs builds the invocation for one report, matching the
// provider's flags: Claude and the twelve tool sources take `[--]breakdown`
// and `--single-thread`, Codex additionally runs `--offline`.
func ccusageReportArgs(source contract.Source, report string, rangeArgs []string, timezone string) ([]string, error) {
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
		command, ok := contract.CcusageToolCommand(source)
		if !ok {
			return nil, fmt.Errorf("%s is not collected through ccusage; parity has no ccusage side for it", source)
		}
		args = []string{command, report, "--json"}
	}
	args = append(args, rangeArgs...)
	if timezone != "" {
		args = append(args, "--timezone", timezone)
	}
	return args, nil
}

// defaultCcusageBin is the install layout the skill uses. It comes from
// internal/ccusage so this command and the collector resolve the same path.
func defaultCcusageBin() string {
	return ccusage.DefaultBinaryPath(nil, "")
}

// writeTextReport prints the count summary and one line per diverging row.
func writeTextReport(w io.Writer, report parityReport) {
	fmt.Fprintf(w, "parity source=%s window=%s timezone=%s\n",
		report.Source, displayWindow(report.Since, report.Until), report.Timezone)
	if report.Status == statusNotImplemented {
		fmt.Fprintln(w, "native: notImplemented (no native provider for this source yet)")
	} else {
		fmt.Fprintf(w, "native: %d snapshots\n", report.NativeSnapshots)
	}
	fmt.Fprintf(w, "ccusage: %d snapshots\n", report.CcusageSnapshots)
	fmt.Fprintf(w, "matched=%d onlyInNative=%d onlyInCcusage=%d valueDiff=%d liveWrite=%d\n",
		report.Matched, len(report.OnlyInNative), len(report.OnlyInCcusage),
		len(report.ValueDiffs), len(report.LiveWrite))
	if report.Status == statusEmpty {
		fmt.Fprintln(w, "(both sides produced 0 rows in this window; an empty comparison is not coverage)")
	}
	for _, key := range report.OnlyInNative {
		fmt.Fprintf(w, "onlyInNative %s %s\n", key.UsageDate, key.Model)
	}
	for _, key := range report.OnlyInCcusage {
		fmt.Fprintf(w, "onlyInCcusage %s %s\n", key.UsageDate, key.Model)
	}
	for _, diff := range report.ValueDiffs {
		fmt.Fprintf(w, "valueDiff %s %s\n", diff.Key.UsageDate, diff.Key.Model)
		for _, field := range diff.Fields {
			fmt.Fprintf(w, "  %s native=%v ccusage=%v\n", field.Field, field.Native, field.Ccusage)
		}
	}
	for _, key := range report.LiveWrite {
		fmt.Fprintf(w, "liveWrite %s %s (today's row; live-write race, not a failure)\n", key.UsageDate, key.Model)
	}
	fmt.Fprintf(w, "status: %s\n", report.Status)
}

func displayWindow(since, until string) string {
	if since == "" && until == "" {
		return "all"
	}
	return displayDate(since) + ".." + displayDate(until)
}

func displayDate(date string) string {
	if date == "" {
		return "*"
	}
	return date
}
