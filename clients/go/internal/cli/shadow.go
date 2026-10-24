package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

const (
	// A real preview is a few megabytes at most; 64 MiB leaves room for a
	// full-history scan while keeping a misbehaving child from exhausting
	// memory before the context timeout would fire.
	maxShadowStdoutBytes = 64 << 20
	// shadowTSChildTimeout bounds the TypeScript preview child. A full scan on
	// a large history can take minutes, so the bound is generous; it exists so
	// a wedged child (tsx waiting on input, a lock it will never get) cannot
	// hold the shadow run forever.
	shadowTSChildTimeout = 15 * time.Minute
)

// limitedBuffer is a bytes.Buffer that refuses writes past limit.
type limitedBuffer struct {
	bytes.Buffer
	limit int64
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if int64(b.Len())+int64(len(p)) > b.limit {
		return 0, fmt.Errorf("shadow: TypeScript preview output exceeds %d bytes", b.limit)
	}
	return b.Buffer.Write(p)
}

// shadowTSInput is one TypeScript-side preview invocation.
type shadowTSInput struct {
	// RepoDir is the TokenBoard checkout root (packages/collector lives
	// under it).
	RepoDir string
	Source  string
	Since   string
	Until   string
	// HookMode compares the incremental hook path instead of a full preview.
	// Both sides must agree on which path they run, or the diff measures the
	// difference between two different code paths rather than between two
	// implementations.
	HookMode bool
	// StateDir is the temporary state directory this side owns.
	StateDir string
	Stderr   io.Writer
}

// runShadowTS runs the TypeScript collector's preview and parses its
// snapshots. It is a variable so tests can answer without node.
var runShadowTS = execShadowTS

// shadowReport is the JSON document `tokenboard shadow` prints.
//
// LiveWrite lists rows whose difference is explained by the source still being
// written while the comparison ran. The two scans are sequential — this client
// first, then the TypeScript collector — so a session file that grows between
// them legitimately yields more tokens on the TypeScript side. Those rows are
// reported but do not make the run a diff; see isLiveWriteDifference.
type shadowReport struct {
	Status    string              `json:"status"`
	Snapshots int                 `json:"snapshots,omitempty"`
	OnlyInTS  []shadowSnapshotKey `json:"onlyInTs,omitempty"`
	OnlyInGo  []shadowSnapshotKey `json:"onlyInGo,omitempty"`
	Differing []shadowDifference  `json:"differing,omitempty"`
	LiveWrite []shadowSnapshotKey `json:"liveWrite,omitempty"`
}

// shadowSnapshotKey identifies one snapshot row, matching the key both sides
// merge on: source, usage date, timezone and model.
type shadowSnapshotKey struct {
	Source    string `json:"source"`
	UsageDate string `json:"usageDate"`
	Timezone  string `json:"timezone"`
	Model     string `json:"model"`
}

type shadowDifference struct {
	Key    shadowSnapshotKey `json:"key"`
	Fields []shadowFieldDiff `json:"fields"`
}

type shadowFieldDiff struct {
	Field string `json:"field"`
	TS    any    `json:"ts"`
	Go    any    `json:"go"`
}

// runShadow implements `tokenboard shadow`: collect the same source with this
// client and with the TypeScript collector, normalize both result sets, and
// diff them. Each side gets its own temporary state directory, so neither can
// touch the machine's real cursors; preview never uploads on either side.
//
// The two scans run sequentially, so a source whose files are being written
// while the comparison runs (an active Claude Code session, say) can differ
// on the current day even when the implementations agree: the second scan
// sees the newer bytes, and pro-rata cost allocation shifts with them. Use
// --until <yesterday> for a stable comparison of settled days.
func runShadow(ctx context.Context, options Options, env Env, stdout, stderr io.Writer) int {
	repoDir := strings.TrimSpace(env("TOKENBOARD_COLLECTOR_DIR"))
	if repoDir == "" {
		fmt.Fprintln(stderr,
			"shadow requires TOKENBOARD_COLLECTOR_DIR pointing at a TokenBoard checkout (packages/collector)")
		return ExitUsage
	}
	collectorDir := filepath.Join(repoDir, "packages", "collector")
	if info, err := os.Stat(filepath.Join(collectorDir, "src", "cli.ts")); err != nil || !info.Mode().IsRegular() {
		fmt.Fprintf(stderr, "shadow: %s does not look like the collector checkout (src/cli.ts is missing)\n", collectorDir)
		return ExitUsage
	}

	goStateDir, err := os.MkdirTemp("", "tokenboard-shadow-go-")
	if err != nil {
		fmt.Fprintf(stderr, "shadow: %v\n", err)
		return ExitFailure
	}
	defer os.RemoveAll(goStateDir)
	tsStateDir, err := os.MkdirTemp("", "tokenboard-shadow-ts-")
	if err != nil {
		fmt.Fprintf(stderr, "shadow: %v\n", err)
		return ExitFailure
	}
	defer os.RemoveAll(tsStateDir)

	// Shadow always compares one code path on both sides. Without --hook that
	// is a full preview, and an inherited TOKENBOARD_HOOK_MODE would make the
	// Go side collect only the two hook-installed sources while the TS child
	// (whose environment is set to match) runs a full scan. With --hook the
	// operator asked for the incremental path, and both sides get it.
	//
	// The providers read hook mode from the environment themselves, so the
	// flag has to reach them through Env as well: setting Options.HookMode
	// alone would only change which sources expand and when a failure aborts,
	// leaving the Go side on the full-preview path while the TS child ran the
	// hook path.
	options.HookMode = options.ShadowHook
	goEnv := shadowCollectEnv(env, options.HookMode)

	outcome, abortErr := collectAll(ctx, options, goEnv, goStateDir, "", stderr)
	if abortErr != nil {
		fmt.Fprintf(stderr, "shadow: Go collection failed: %v\n", abortErr)
		return ExitFailure
	}
	if collectionFailed(outcome, options) {
		fmt.Fprintf(stderr, "shadow: Go collection reported failures: %s\n", formatSourceFailures(outcome.failures))
		return ExitFailure
	}

	tsSnapshots, err := runShadowTS(ctx, shadowTSInput{
		RepoDir:  repoDir,
		Source:   options.Source,
		Since:    options.Since,
		Until:    options.Until,
		HookMode: options.HookMode,
		StateDir: tsStateDir,
		Stderr:   stderr,
	})
	if err != nil {
		fmt.Fprintf(stderr, "shadow: TypeScript preview failed: %v\n", err)
		return ExitFailure
	}

	report := compareShadow(outcome.snapshots, tsSnapshots, time.Now())
	payload, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		fmt.Fprintf(stderr, "shadow: %v\n", err)
		return ExitFailure
	}
	fmt.Fprintln(stdout, string(payload))
	if report.Status != "match" {
		return ExitFailure
	}
	return ExitOK
}

// compareShadow normalizes both sides to a key-ordered map and reports the
// differences. collectedAt is wall clock, not semantics, and is excluded by
// comparing the hash payloads (which already omit it).
//
// now is the comparison's clock, used to recognise the live-write race; it is
// a parameter so the classification is testable without touching the clock.
func compareShadow(goSnapshots, tsSnapshots []contract.Snapshot, now time.Time) shadowReport {
	goByKey := shadowSnapshotMap(goSnapshots)
	tsByKey := shadowSnapshotMap(tsSnapshots)

	keys := make([]string, 0, len(goByKey)+len(tsByKey))
	seen := map[string]bool{}
	for key := range goByKey {
		keys = append(keys, key)
		seen[key] = true
	}
	for key := range tsByKey {
		if !seen[key] {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)

	report := shadowReport{Status: "match"}
	for _, key := range keys {
		goSnapshot, inGo := goByKey[key]
		tsSnapshot, inTS := tsByKey[key]
		switch {
		case inGo && !inTS:
			report.OnlyInGo = append(report.OnlyInGo, shadowKeyOf(goSnapshot))
		case inTS && !inGo:
			report.OnlyInTS = append(report.OnlyInTS, shadowKeyOf(tsSnapshot))
		default:
			if goSnapshot.HashPayload() == tsSnapshot.HashPayload() {
				report.Snapshots++
				continue
			}
			fields := shadowFieldDiffs(tsSnapshot, goSnapshot)
			if isLiveWriteDifference(goSnapshot, tsSnapshot, fields, now) {
				report.LiveWrite = append(report.LiveWrite, shadowKeyOf(goSnapshot))
				continue
			}
			report.Differing = append(report.Differing, shadowDifference{
				Key:    shadowKeyOf(goSnapshot),
				Fields: fields,
			})
		}
	}
	if len(report.OnlyInGo) > 0 || len(report.OnlyInTS) > 0 || len(report.Differing) > 0 {
		report.Status = "diff"
	}
	return report
}

// isLiveWriteDifference reports whether a differing row is explained by the
// source still being appended to while the comparison ran, rather than by the
// two implementations disagreeing.
//
// The two scans are sequential — this client collects first, then the
// TypeScript collector — so a session file that grows between them yields more
// usage on the TypeScript side. Every condition below must hold; anything else
// stays a difference:
//
//   - the row is for today in its own timezone. Settled dates have no writes
//     left to race, so a difference there is always real drift, and the
//     --until <yesterday> comparison is what proves those dates.
//   - only token counts and costUsd differ. sessionCount and correction are
//     never derived from a partial read, so a difference in either is a real
//     disagreement even on today's row.
//   - every token field is non-decreasing towards the later scan. Appending can
//     only add usage; a row where the later scan sees fewer tokens means the
//     read itself disagrees, not the timing.
//
// costUsd is deliberately not direction-constrained. A row ccusage prices at 0
// (a subscription or free-quota model) is allocated cost pro-rata from its day
// total, so when another model's usage grows between the two scans the day's
// denominator changes and the share shrinks — the cost moves opposite to the
// token growth. That is the same single cause, and a real pricing bug would
// also show on a settled date, which this rule never excuses.
func isLiveWriteDifference(goSnapshot, tsSnapshot contract.Snapshot, fields []shadowFieldDiff, now time.Time) bool {
	if !isToday(goSnapshot.UsageDate, goSnapshot.Timezone, now) {
		return false
	}
	for _, field := range fields {
		switch field.Field {
		case "inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "totalTokens":
			// The diff carries the field values as the concrete types the
			// snapshots hold (int64 for tokens), not as JSON-decoded floats.
			goValue, goOK := field.Go.(int64)
			tsValue, tsOK := field.TS.(int64)
			if !goOK || !tsOK || tsValue < goValue {
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

func shadowSnapshotMap(snapshots []contract.Snapshot) map[string]contract.Snapshot {
	rows := make(map[string]contract.Snapshot, len(snapshots))
	for _, snapshot := range snapshots {
		rows[shadowKeyString(snapshot)] = snapshot
	}
	return rows
}

func shadowKeyString(snapshot contract.Snapshot) string {
	return string(snapshot.Source) + "\x00" + snapshot.UsageDate + "\x00" +
		snapshot.Timezone + "\x00" + snapshot.Model
}

func shadowKeyOf(snapshot contract.Snapshot) shadowSnapshotKey {
	return shadowSnapshotKey{
		Source:    string(snapshot.Source),
		UsageDate: snapshot.UsageDate,
		Timezone:  snapshot.Timezone,
		Model:     snapshot.Model,
	}
}

// shadowFieldDiffs lists the fields two same-key snapshots disagree on. The
// fields are the ones the upload contract carries; collectedAt is excluded
// because it is wall clock.
func shadowFieldDiffs(tsSnapshot, goSnapshot contract.Snapshot) []shadowFieldDiff {
	fields := []struct {
		name string
		ts   any
		goV  any
	}{
		{"inputTokens", tsSnapshot.InputTokens, goSnapshot.InputTokens},
		{"outputTokens", tsSnapshot.OutputTokens, goSnapshot.OutputTokens},
		{"cacheCreationTokens", tsSnapshot.CacheCreation, goSnapshot.CacheCreation},
		{"cacheReadTokens", tsSnapshot.CacheRead, goSnapshot.CacheRead},
		{"totalTokens", tsSnapshot.TotalTokens, goSnapshot.TotalTokens},
		{"costUsd", tsSnapshot.CostUSD, goSnapshot.CostUSD},
		{"sessionCount", tsSnapshot.SessionCount, goSnapshot.SessionCount},
		{"correction", string(tsSnapshot.Correction), string(goSnapshot.Correction)},
	}
	diffs := make([]shadowFieldDiff, 0, len(fields))
	for _, field := range fields {
		if field.ts != field.goV {
			diffs = append(diffs, shadowFieldDiff{Field: field.name, TS: field.ts, Go: field.goV})
		}
	}
	return diffs
}

// execShadowTS runs `node --import tsx src/cli.ts preview` in the checkout
// and parses the snapshot array it prints. The child sees the process
// environment with its own state directory, and never sees hook mode: shadow
// always compares full preview semantics.
func execShadowTS(ctx context.Context, input shadowTSInput) ([]contract.Snapshot, error) {
	node, err := exec.LookPath("node")
	if err != nil {
		return nil, fmt.Errorf("node not found on PATH: %w", err)
	}
	args := []string{"--import", "tsx", "src/cli.ts", "preview", "--source", input.Source}
	if input.Since != "" {
		args = append(args, "--since", input.Since)
	}
	if input.Until != "" {
		args = append(args, "--until", input.Until)
	}
	// The parent context may have no deadline (an interactive `tokenboard
	// shadow`), so the child gets its own bound regardless.
	childCtx, cancel := context.WithTimeout(ctx, shadowTSChildTimeout)
	defer cancel()
	cmd := exec.CommandContext(childCtx, node, args...)
	cmd.Dir = filepath.Join(input.RepoDir, "packages", "collector")
	cmd.Env = shadowChildEnv(input.StateDir, input.HookMode)
	// The preview array is the child's whole stdout, so it has to be buffered
	// to parse. A child that starts printing something else (a debug log, a
	// runaway retry loop) would otherwise grow the buffer without bound; the
	// cap is far above a real preview and the run fails closed past it.
	var stdout limitedBuffer
	stdout.limit = maxShadowStdoutBytes
	cmd.Stdout = &stdout
	if input.Stderr != nil {
		cmd.Stderr = input.Stderr
	}
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	var snapshots []contract.Snapshot
	if err := json.Unmarshal(stdout.Bytes(), &snapshots); err != nil {
		return nil, fmt.Errorf("preview output is not a snapshot array: %w", err)
	}
	return snapshots, nil
}

// shadowChildEnv is the process environment with the TypeScript side's state
// directory swapped in. Hook mode is set explicitly, never inherited: the
// child must run the same code path the Go side runs, and an ambient
// TOKENBOARD_HOOK_MODE belongs to a notifier rather than to this comparison.
func shadowChildEnv(stateDir string, hookMode bool) []string {
	parent := os.Environ()
	out := make([]string, 0, len(parent)+2)
	for _, entry := range parent {
		if strings.HasPrefix(entry, "TOKENBOARD_STATE_DIR=") ||
			strings.HasPrefix(entry, "TOKENBOARD_HOOK_MODE=") {
			continue
		}
		out = append(out, entry)
	}
	out = append(out, "TOKENBOARD_STATE_DIR="+stateDir)
	if hookMode {
		out = append(out, "TOKENBOARD_HOOK_MODE=1")
	}
	return out
}

// shadowCollectEnv is shadowChildEnv's counterpart for the Go side: providers
// branch on TOKENBOARD_HOOK_MODE rather than on Options, so the same explicit
// set/strip applies to the environment they are handed. It runs before
// collection, so an ambient hook mode from the notifier that started the run
// cannot silently change which path this comparison measures.
func shadowCollectEnv(env Env, hookMode bool) Env {
	return func(key string) string {
		if key == "TOKENBOARD_HOOK_MODE" {
			if hookMode {
				return "1"
			}
			return ""
		}
		return env(key)
	}
}
