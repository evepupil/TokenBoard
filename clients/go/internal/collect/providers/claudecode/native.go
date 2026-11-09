package claudecode

// The native adapter seam (S2, Task 7). The in-process adapter
// (internal/collect/adapters/claude) already produces ccusage-compatible
// reports; this file wires it into the provider behind a compile-time switch
// and registers it on the native registry so the parity harness can compare the
// two implementations.
//
// The switch is a constant, not an environment variable: flipping it is a
// reviewed commit, and a user must not be able to run an unvalidated code path
// on their own data. Until it flips, Collect keeps the ccusage subprocess path
// byte for byte.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/adapters/claude"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
	"github.com/MisonL/TokenBoard/clients/go/internal/pricing"
	"github.com/MisonL/TokenBoard/clients/go/internal/state"
)

// useNativeClaude selects the in-process adapter instead of the ccusage
// subprocess. It is a compile-time constant, not an environment variable:
// flipping it is a reviewed commit, and a user must not be able to run an
// unvalidated code path on their own data.
const useNativeClaude = false

// nativeInput is what Collect's dispatch hands the native path: the resolved
// environment, diagnostics sink, timezone and collection timestamp. The rest of
// the resolution (state dir, endpoint, hook mode) happens inside nativeCollect
// so the native provider can be driven directly from the registry, where there
// is no Collect call above it.
type nativeInput struct {
	options     Options
	env         func(string) string
	stderr      func(string)
	timezone    string
	collectedAt string
}

// nativeProvider is the registry adapter for LookupNative. It always runs the
// native path: a failure is returned as-is, never rewritten into a ccusage
// fallback, because a fallback would make the parity comparison "ccusage
// against ccusage" and pass silently.
type nativeProvider struct{}

// Collect adapts nativeCollect to the registry's Provider interface.
func (nativeProvider) Collect(ctx context.Context, options collect.Options) ([]contract.Snapshot, error) {
	env := options.EnvValue
	stderr := options.Stderr
	if stderr == nil {
		stderr = func(string) {}
	}
	return nativeCollect(ctx, nativeInput{
		options: Options{
			Timezone: options.Timezone,
			Since:    options.Since,
			Until:    options.Until,
			StateDir: options.StateDir,
			HomeDir:  options.HomeDir,
			Stderr:   stderr,
			Env:      env,
		},
		env:    env,
		stderr: stderr,
	})
}

// nativeCollect produces the snapshots from the in-process adapter.
//
// Every failure is returned verbatim. In particular the roots resolution, the
// pricing preparation, the report decode and the normalization are not allowed
// to degrade into an empty result: an empty result is indistinguishable from
// "this machine has no usage" on the dashboard.
func nativeCollect(ctx context.Context, input nativeInput) ([]contract.Snapshot, error) {
	env := input.env
	if env == nil {
		env = os.Getenv
	}
	stderr := input.stderr
	if stderr == nil {
		stderr = func(string) {}
	}

	// Collect resolves timezone and collectedAt before it dispatches; the
	// registry path has no Collect above it, so resolve them here too with the
	// same rules. The two must stay identical or the same machine would
	// attribute a day differently depending on which entry point ran.
	timezone := strings.TrimSpace(input.timezone)
	if timezone == "" {
		timezone = strings.TrimSpace(input.options.Timezone)
	}
	if timezone == "" {
		timezone = sessionusage.LocalTimezone()
	}
	collectedAt := input.collectedAt
	if collectedAt == "" {
		collectedAt = input.options.CollectedAt
	}
	if collectedAt == "" {
		collectedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}

	hookMode := env("TOKENBOARD_HOOK_MODE") == "1"

	stateDir := strings.TrimSpace(input.options.StateDir)
	if stateDir == "" {
		stateDir = state.ResolveDir(env, homeDir(input.options))
	}
	endpoint := strings.TrimSpace(env("TOKENBOARD_ENDPOINT"))

	// Same diagnostics rule as the ccusage path: the pricing narration only
	// belongs in the log when a server is configured.
	var pricingStderr func(string)
	if endpoint != "" {
		pricingStderr = stderr
	}
	// ConfigPath is deliberately ignored: it exists to point the ccusage
	// subprocess at a config file, and the native path never spawns one. The
	// rates this path bills from are resolved below with ResolveScope, which
	// reads the same config ccusage would have read.
	prepared, err := pricing.Prepare(pricing.PrepareInput{
		Endpoint:       endpoint,
		StateDir:       stateDir,
		HookMode:       hookMode,
		ExplicitConfig: env("TOKENBOARD_CCUSAGE_CONFIG"),
		Fetcher:        input.options.PricingFetcher,
		Stderr:         pricingStderr,
	})
	if err != nil {
		// The parse error alone ("unexpected EOF") names no file; the operator
		// has to know which config broke collection.
		if explicit := strings.TrimSpace(env("TOKENBOARD_CCUSAGE_CONFIG")); explicit != "" {
			return nil, fmt.Errorf("claudecode: model pricing config %s: %w", explicit, err)
		}
		return nil, err
	}

	// The ccusage path runs `ccusage claude daily`, so the rates and cost mode
	// that apply are the ones ccusage resolves for that scope - root defaults
	// plus commands.<...> and claude.* sections. Reading the config's root
	// defaults block alone (or hardcoding the mode) would bill a machine that
	// scopes its overrides differently from its own ccusage runs.
	scope := prepared.ResolveScope(pricing.Scope{Agent: "claude", Report: "daily"})
	mode := claudeCostMode(scope.Mode)
	covered := prepared.CoveredModelIDs
	if extra := scope.Overrides; len(extra) > 0 {
		covered = make(map[string]bool, len(prepared.CoveredModelIDs)+len(extra))
		for modelID := range prepared.CoveredModelIDs {
			covered[modelID] = true
		}
		for modelID := range extra {
			covered[modelID] = true
		}
	}

	roots, err := resolveNativeRoots(env, input.options)
	if err != nil {
		return nil, err
	}

	// claude.Collect always names dates in the zone it is given and falls back
	// to UTC for a value it cannot load (sessionusage.FormatDate). A local zone
	// this binary's tzdata lacks (a stripped container) would therefore move
	// midnight-adjacent rows to a different day than the normalizer's session
	// dates below, which resolve against the same timezone string. Fail closed
	// instead: the ccusage path passes the same string to ccusage, which would
	// fail outright.
	if _, err := contract.LoadLocation(timezone); err != nil {
		return nil, fmt.Errorf("claudecode: native timezone %q: %w", timezone, err)
	}

	if hookMode {
		return nativeCollectHook(ctx, nativeHookInput{
			env:         env,
			stderr:      stderr,
			timezone:    timezone,
			collectedAt: collectedAt,
			stateDir:    stateDir,
			homeDir:     input.options.HomeDir,
			roots:       roots,
			overrides:   scope.Overrides,
			mode:        mode,
			covered:     covered,
		})
	}

	// The window first goes through the provider-level environment fallbacks, so
	// a caller that bypasses the CLI still scans the same range the ccusage path
	// records. The adapter then validates and normalizes it (including the "all"
	// lower bound); no rule is duplicated here.
	sinceBound, untilBound := resolveWindowEnv(input.options.Since, input.options.Until, env)
	dailyJSON, sessionsJSON, err := claude.Collect(ctx, claude.Options{
		Timezone:  timezone,
		Since:     sinceBound,
		Until:     untilBound,
		Roots:     roots,
		Overrides: scope.Overrides,
		Mode:      mode,
		Stderr:    stderr,
	})
	if err != nil {
		return nil, err
	}

	// Decode both documents explicitly. The ccusage path hands the normalizer
	// raw bytes, which it decodes internally; decoding here makes the session
	// report arrive in exactly the shape the normalizer expects for
	// NormalizeOptions.Sessions, and surfaces a malformed report as an error
	// instead of a silently missing session count.
	daily, err := ccusage.DecodeJSON(dailyJSON)
	if err != nil {
		return nil, err
	}
	sessions, err := ccusage.DecodeJSON(sessionsJSON)
	if err != nil {
		return nil, err
	}
	snapshots, err := ccusage.NormalizeCcusageDailyJSON(daily, ccusage.NormalizeOptions{
		Source:      contract.SourceClaudeCode,
		Timezone:    timezone,
		CollectedAt: collectedAt,
		Sessions:    sessions,
		// The adapter always builds the session report, so an empty report
		// means "no sessions", not "sessions were not collected".
		HasSessions: true,
	})
	if err != nil {
		return nil, err
	}
	reportUnpriced(snapshots, prepared.CoveredModelIDs, stderr)
	return snapshots, nil
}

// claudeCostMode maps the config's mode string onto the pricing engine's
// ladder. ResolveScope only ever returns the three values ccusage accepts.
func claudeCostMode(mode string) nativepricing.CostMode {
	switch mode {
	case "calculate":
		return nativepricing.ModeCalculate
	case "display":
		return nativepricing.ModeDisplay
	default:
		return nativepricing.ModeAuto
	}
}

// resolveNativeRoots is the root-resolution switch for the native path.
//
// CLAUDE_CONFIG_DIR is handed to ResolveRoots as "unset" (homeDir == "") so one
// place keeps ccusage's rules: comma splitting, a hard error when no entry is
// usable, and no XDG fallback once the user pointed at a specific install.
// CLAUDE_HOME is TokenBoard's own alias (ccusage does not know it), so it is
// read here. An explicit Options.HomeDir is the test/home seam. Everything else
// is left to ResolveRoots, which looks at $XDG_CONFIG_HOME/claude before
// $HOME/.claude - readClaudeHome only knows the second one, so passing its
// result would make a machine configured through XDG look empty.
func resolveNativeRoots(env func(string) string, options Options) (claude.Roots, error) {
	var homeArg string
	switch {
	case strings.TrimSpace(env("CLAUDE_CONFIG_DIR")) != "":
		homeArg = ""
	case strings.TrimSpace(env("CLAUDE_HOME")) != "":
		homeArg = readClaudeHome(env, options.HomeDir)
	case options.HomeDir != "":
		homeArg = filepath.Join(options.HomeDir, ".claude")
	default:
		homeArg = ""
	}
	return claude.ResolveRoots(env, homeArg)
}

// nativeHookInput is the resolved state the hook branch needs. Everything in it
// is already validated by nativeCollect: the timezone loads, the roots resolved
// and the pricing is prepared in hook (offline) mode.
type nativeHookInput struct {
	env         func(string) string
	stderr      func(string)
	timezone    string
	collectedAt string
	stateDir    string
	// homeDir is Options.HomeDir: the fallback path below must resolve the
	// Claude home exactly as the ccusage hook path did.
	homeDir   string
	roots     claude.Roots
	overrides map[string]any
	mode      nativepricing.CostMode
	covered   map[string]bool
}

// nativeCollectHook is the hook-mode half of the native path.
//
// It keeps the exact incremental machinery the ccusage hook path uses
// (sessioncursor.CollectHookIncremental: scan, cursor, cache,
// ChangedDates/ChangedKeys/RangeArgs) and reconciles its result against a full
// in-process recompute of the reported window. The two halves see the same
// tree: the scan is handed every resolved root's projects/ directory and the
// recompute is handed the same roots, so a key the parser saw and the report
// does not return means the two layers disagree - a hard error, never a
// silently unuploaded row.
//
// No subprocess and no network: ccusage is not involved at all, and pricing was
// prepared with HookMode: true (cache/static only) before this function ran.
//
// Known limitations inherited from this design, all of them deliberate:
//
//   - Multi-root cursors are keyed by the path relative to each root
//     (sessioncursor/scan.go:209-216 dedupes on that key), so two roots holding
//     the same relative path - a copy or a backup of a config directory - are
//     tracked as one file and the second copy's later changes are never
//     scanned. This is the shared sessioncursor contract (Codex behaves the
//     same way), not something this provider can fix; a first scan still reads
//     the whole tree through the recompute, so nothing is under-counted on the
//     first run and the server's five-key upsert keeps the repeat from
//     double-counting.
//   - The scan is wider than the ccusage hook ever was: ResolveRoots expands a
//     comma-separated CLAUDE_CONFIG_DIR, strips "~", reads a CLAUDE_HOME list
//     and walks both $XDG_CONFIG_HOME/claude and $HOME/.claude in the default
//     branch, where ccusage silently collected nothing. The direction is
//     "reports real usage that used to be dropped", which matches the non-hook
//     native path - but `shadow-dual-run --hook` will report the difference as
//     a diff on a multi-root or XDG-configured machine.
//   - A file whose mtime predates the window while its content is inside it
//     (restored by `cp -p` or `rsync -t`) makes claude.Collect prune the whole
//     session group, so the reconciliation assertion fails on every hook run
//     until the mtime is refreshed. The ccusage path has exactly the same
//     behaviour; this port did not change it.
func nativeCollectHook(ctx context.Context, input nativeHookInput) ([]contract.Snapshot, error) {
	// SessionDirs, not SessionsDir, carries the roots: a comma-separated
	// CLAUDE_CONFIG_DIR or an XDG-configured install has more than one, and a
	// single joined path would point the scan at a directory that does not
	// exist while the recompute reads them all. An empty dirs list leaves
	// SessionDirs empty, and sessioncursor then falls back to SessionsDir - the
	// same single-directory behaviour the ccusage hook path always had.
	sessionDirs := make([]string, 0, len(input.roots.Dirs))
	for _, dir := range input.roots.Dirs {
		sessionDirs = append(sessionDirs, filepath.Join(dir, "projects"))
	}
	incremental, err := sessioncursor.CollectHookIncremental(sessioncursor.HookInput{
		Source:      contract.SourceClaudeCode,
		SessionsDir: filepath.Join(readClaudeHome(input.env, input.homeDir), "projects"),
		SessionDirs: sessionDirs,
		StateDir:    input.stateDir,
		CursorName:  CursorName,
		Stderr:      input.stderr,
		Timezone:    input.timezone,
		CollectedAt: input.collectedAt,
	})
	if err != nil {
		return nil, err
	}
	if !incremental.Changed {
		return []contract.Snapshot{}, nil
	}

	var snapshots []contract.Snapshot
	// The decision lives in hookRecomputeWindow so the "dates changed but the
	// args are malformed" shape can be tested directly: sessioncursor produces
	// both fields from the same date set today, so the test cannot build that
	// shape through CollectHookIncremental.
	since, until, recompute, err := hookRecomputeWindow(incremental)
	if err != nil {
		return nil, err
	}
	if recompute {
		dailyJSON, sessionsJSON, err := claude.Collect(ctx, claude.Options{
			Timezone:  input.timezone,
			Since:     since,
			Until:     until,
			Roots:     input.roots,
			Overrides: input.overrides,
			Mode:      input.mode,
			Stderr:    input.stderr,
		})
		if err != nil {
			return nil, err
		}
		daily, err := ccusage.DecodeJSON(dailyJSON)
		if err != nil {
			return nil, err
		}
		sessions, err := ccusage.DecodeJSON(sessionsJSON)
		if err != nil {
			return nil, err
		}
		snapshots, err = ccusage.NormalizeCcusageDailyJSON(daily, ccusage.NormalizeOptions{
			Source:      contract.SourceClaudeCode,
			Timezone:    input.timezone,
			CollectedAt: input.collectedAt,
			Sessions:    sessions,
			HasSessions: true,
		})
		if err != nil {
			return nil, err
		}
		// Not relaxed, not wrapped: the strings the parser proved exist must all
		// be in the recompute's answer.
		if err := sessioncursor.AssertHookReconciliationSnapshots(
			"Claude", incremental.ChangedDates, incremental.ChangedKeys, snapshots); err != nil {
			return nil, err
		}
	}
	cached := sessioncursor.SnapshotsOf(incremental.CachedSnapshots, input.collectedAt)
	merged := sessioncursor.MergeSnapshots(append(snapshots, cached...))
	reportUnpriced(merged, input.covered, input.stderr)
	return merged, nil
}

// hookRecomputeWindow decides whether the incremental result requires a window
// recompute, and with which bounds.
//
// The guard is ChangedDates, not RangeArgs. Today sessioncursor produces both
// from the same date set (buildDateRangeArgs is only a rendering of it), so the
// two conditions are equivalent - but RangeArgs is derived data. If a future
// sessioncursor ever built the args differently, an empty RangeArgs beside a
// non-empty ChangedDates would skip the recompute AND the reconciliation
// assertion, leaving parsed usage silently unuploaded. Keying off the fact
// instead, and parsing the rendering, turns that shape into an error.
func hookRecomputeWindow(incremental sessioncursor.HookIncrementalResult) (since, until string, recompute bool, err error) {
	if len(incremental.ChangedDates) == 0 {
		return "", "", false, nil
	}
	since, until, err = parseHookRangeArgs(incremental.RangeArgs)
	if err != nil {
		return "", "", false, err
	}
	return since, until, true, nil
}

// parseHookRangeArgs turns the incremental window into claude.Options bounds.
//
// The shape is fixed by sessioncursor.buildDateRangeArgs:
// ["--since", YYYYMMDD, "--until", YYYYMMDD]. Anything else is a contract
// break, and treating it as "no window" would silently turn a hook run into a
// full-history scan - so every deviation, including the otherwise-acceptable
// dashed spelling and the open "all" bound, is an error.
func parseHookRangeArgs(args []string) (string, string, error) {
	if len(args) != 4 || args[0] != "--since" || args[2] != "--until" {
		return "", "", fmt.Errorf(
			"claudecode: unexpected hook range args %v; want [--since YYYYMMDD --until YYYYMMDD]", args)
	}
	since, until := args[1], args[3]
	if !isCompactDate(since) || !isCompactDate(until) {
		return "", "", fmt.Errorf(
			"claudecode: hook range args %v: dates must be compact YYYYMMDD", args)
	}
	normalizedSince, normalizedUntil, err := sessionusage.AssertValidDateFilterRange(
		since, until, "Claude hook --since", "Claude hook --until")
	if err != nil {
		return "", "", fmt.Errorf("claudecode: hook range args %v: %w", args, err)
	}
	return normalizedSince, normalizedUntil, nil
}

// isCompactDate is the YYYYMMDD test the range sender guarantees. The calendar
// validity is AssertValidDateFilterRange's job.
func isCompactDate(value string) bool {
	if len(value) != 8 {
		return false
	}
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	return true
}
