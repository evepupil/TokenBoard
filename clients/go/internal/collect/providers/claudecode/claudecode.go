// Package claudecode ports providers/claude-code.ts: Claude Code usage comes
// from ccusage (daily + session reports), and in hook mode the changed session
// files narrow that ccusage call to the dates the parser actually saw.
package claudecode

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/pricing"
	"github.com/MisonL/TokenBoard/clients/go/internal/state"
)

// DefaultCcusageTimeoutMs is the ccusage budget. ccusage walks the whole
// session tree to build one day's totals, so a large session library on a
// loaded machine can outlast the generic two-minute command default — the
// difference between a hook sync finishing and a bare "Command failed".
const DefaultCcusageTimeoutMs = 900_000

// DefaultPackageCommandRetries retries a transient ccusage failure twice.
const DefaultPackageCommandRetries = 2

// CursorName is the hook cursor file. The Claude cursor is never scoped by
// endpoint: the TS provider passes this literal name regardless of sync scope.
const CursorName = "claude-code-cursor.json"

// Options configures one collection. Zero values fall back to the environment
// and the clock, like the TS provider's optional arguments.
type Options struct {
	Timezone    string
	CollectedAt string
	Since       string
	Until       string
	StateDir    string
	HomeDir     string
	Stderr      func(line string)
	// Env resolves configuration; nil means the process environment.
	Env func(string) string
	// Runner runs ccusage; nil means ccusage.RunJSON.
	Runner ccusage.CommandRunner
	// ResolveBinary acquires ccusage; nil means ccusage.Resolve.
	ResolveBinary func(ccusage.AcquireOptions) (ccusage.Binary, error)
	// PricingFetcher replaces the catalogue HTTP client; tests use it.
	PricingFetcher func(request *http.Request) (*http.Response, error)
}

// Collect gathers Claude Code usage.
func Collect(ctx context.Context, options Options) ([]contract.Snapshot, error) {
	env := options.Env
	if env == nil {
		env = os.Getenv
	}
	stderr := options.Stderr
	if stderr == nil {
		stderr = func(string) {}
	}
	runner := options.Runner
	if runner == nil {
		runner = ccusage.RunJSON
	}
	timezone := strings.TrimSpace(options.Timezone)
	if timezone == "" {
		timezone = sessionusage.LocalTimezone()
	}
	collectedAt := options.CollectedAt
	if collectedAt == "" {
		collectedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	stateDir := strings.TrimSpace(options.StateDir)
	if stateDir == "" {
		stateDir = state.ResolveDir(env, homeDir(options))
	}
	hookMode := env("TOKENBOARD_HOOK_MODE") == "1"
	endpoint := strings.TrimSpace(env("TOKENBOARD_ENDPOINT"))

	// The pricing diagnostics only belong in the log when a server is
	// configured: a bare preview should not narrate a catalogue it never
	// fetched.
	var pricingStderr func(string)
	if endpoint != "" {
		pricingStderr = stderr
	}
	prepared, err := pricing.Prepare(pricing.PrepareInput{
		Endpoint:       endpoint,
		StateDir:       stateDir,
		HookMode:       hookMode,
		ExplicitConfig: env("TOKENBOARD_CCUSAGE_CONFIG"),
		Fetcher:        options.PricingFetcher,
		Stderr:         pricingStderr,
	})
	if err != nil {
		return nil, err
	}
	commandEnv := env
	if prepared.ConfigPath != "" {
		base := env
		commandEnv = func(key string) string {
			if key == "TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG" {
				return prepared.ConfigPath
			}
			return base(key)
		}
	}

	packageRunner, err := resolveRunner(commandEnv, hookMode, options, stderr)
	if err != nil {
		return nil, err
	}

	var snapshots []contract.Snapshot
	if hookMode {
		snapshots, err = collectHookUsage(ctx, hookInput{
			runner:        runner,
			packageRunner: packageRunner,
			timezone:      timezone,
			collectedAt:   collectedAt,
			stateDir:      stateDir,
			env:           commandEnv,
			options:       options,
			stderr:        stderr,
		})
	} else {
		rangeArgs, err := buildRangeArgs(options.Since, options.Until, env)
		if err != nil {
			return nil, err
		}
		snapshots, err = collectRange(ctx, rangeInput{
			runner:        runner,
			packageRunner: packageRunner,
			rangeArgs:     rangeArgs,
			timezone:      timezone,
			collectedAt:   collectedAt,
			env:           commandEnv,
			stderr:        stderr,
		})
	}
	if err != nil {
		return nil, err
	}
	reportUnpriced(snapshots, prepared.CoveredModelIDs, stderr)
	return snapshots, nil
}

// resolveRunner picks the ccusage invocation: the resolved local binary when
// there is one, the package runner otherwise.
//
// Hook mode never downloads (the hook path must stay offline), so a machine
// with no usable binary reports the source unavailable instead of falling
// through to a package manager that would fetch the package.
func resolveRunner(
	env func(string) string,
	hookMode bool,
	options Options,
	stderr func(string),
) (ccusage.PackageRunner, error) {
	resolveBinary := options.ResolveBinary
	if resolveBinary == nil {
		resolveBinary = ccusage.Resolve
	}
	// Boolean(env.X) in TS: any non-empty value, whitespace included.
	forceRunner := env("TOKENBOARD_FORCE_PACKAGE_RUNNER") != ""
	var localBinary string
	if !forceRunner {
		binary, err := resolveBinary(ccusage.AcquireOptions{
			Env:      env,
			HomeDir:  homeDir(options),
			HookMode: hookMode,
			Stderr:   stderr,
		})
		if err != nil {
			if hookMode {
				return ccusage.PackageRunner{}, err
			}
			// The TypeScript collector has no bundled binary: it always
			// reaches ccusage through the package manager. Keep that fallback
			// so an existing skill install (which pins
			// TOKENBOARD_PACKAGE_MANAGER) keeps working.
			stderr(fmt.Sprintf("TokenBoard ccusage: %s; falling back to the package runner", err.Error()))
		} else {
			localBinary = binary.Path
		}
	}
	return ccusage.ResolvePackageRunner(ccusage.RunnerInput{
		Env:         env,
		LocalBinary: localBinary,
	})
}

type hookInput struct {
	runner        ccusage.CommandRunner
	packageRunner ccusage.PackageRunner
	timezone      string
	collectedAt   string
	stateDir      string
	env           func(string) string
	options       Options
	stderr        func(string)
}

// collectHookUsage ports collectClaudeHookUsage: scan the changed session
// files, then reconcile only the dates they cover through ccusage.
func collectHookUsage(ctx context.Context, input hookInput) ([]contract.Snapshot, error) {
	claudeHome := readClaudeHome(input.env, input.options.HomeDir)
	incremental, err := sessioncursor.CollectHookIncremental(sessioncursor.HookInput{
		Source:      contract.SourceClaudeCode,
		SessionsDir: filepath.Join(claudeHome, "projects"),
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
	if len(incremental.RangeArgs) > 0 {
		// ccusage reads the same home the incremental scan just walked; a
		// machine configured through CLAUDE_HOME only would otherwise have
		// ccusage look at the default location.
		hookEnv := func(key string) string {
			switch key {
			case "CLAUDE_CONFIG_DIR", "CLAUDE_HOME":
				return claudeHome
			}
			return input.env(key)
		}
		rangeArgs := append(append([]string{}, incremental.RangeArgs...), "--timezone", input.timezone)
		snapshots, err = collectRange(ctx, rangeInput{
			runner:        input.runner,
			packageRunner: input.packageRunner,
			rangeArgs:     rangeArgs,
			timezone:      input.timezone,
			collectedAt:   input.collectedAt,
			env:           hookEnv,
			stderr:        input.stderr,
		})
		if err != nil {
			return nil, err
		}
		if err := sessioncursor.AssertHookReconciliationSnapshots(
			"Claude", incremental.ChangedDates, incremental.ChangedKeys, snapshots); err != nil {
			return nil, err
		}
	}
	cached := sessioncursor.SnapshotsOf(incremental.CachedSnapshots, input.collectedAt)
	return sessioncursor.MergeSnapshots(append(snapshots, cached...)), nil
}

type rangeInput struct {
	runner        ccusage.CommandRunner
	packageRunner ccusage.PackageRunner
	rangeArgs     []string
	timezone      string
	collectedAt   string
	env           func(string) string
	stderr        func(string)
}

// collectRange runs `claude daily --json --breakdown` and `claude session
// --json` over the same window and normalizes the pair.
//
// Both calls pass --single-thread. ccusage otherwise loads every session JSONL
// in parallel, which peaks at 4.6-7.6 GB of resident memory on a large history
// while running as a background hook; the Codex provider passes the same flag
// everywhere. The TS provider must stay in step with this: the two clients are
// diffed against each other on real data, so a flag present on one side only
// would show up as a divergence.
func collectRange(ctx context.Context, input rangeInput) ([]contract.Snapshot, error) {
	commandOptions := packageCommandOptions(input.env, input.stderr)
	dailyArgs, err := input.packageRunner.Args(
		append([]string{"claude", "daily", "--json", "--breakdown", "--single-thread"}, input.rangeArgs...), input.env, nil)
	if err != nil {
		return nil, err
	}
	daily, err := input.runner(ctx, input.packageRunner.Command, dailyArgs, commandOptions)
	if err != nil {
		return nil, err
	}
	sessionArgs, err := input.packageRunner.Args(
		append([]string{"claude", "session", "--json", "--single-thread"}, input.rangeArgs...), input.env, nil)
	if err != nil {
		return nil, err
	}
	sessions, err := input.runner(ctx, input.packageRunner.Command, sessionArgs, commandOptions)
	if err != nil {
		return nil, err
	}
	return ccusage.NormalizeCcusageDailyJSON(daily, ccusage.NormalizeOptions{
		Source:      contract.SourceClaudeCode,
		Timezone:    input.timezone,
		CollectedAt: input.collectedAt,
		Sessions:    sessions,
		// The session command always runs in this provider, so the counts are
		// authoritative even when the report is empty.
		HasSessions: true,
	})
}

func packageCommandOptions(env func(string) string, stderr func(string)) ccusage.CommandOptions {
	return ccusage.CommandOptions{
		TimeoutMs: readCcusageTimeoutMs(env),
		Retries:   readPackageCommandRetries(env),
		OnRetry:   stderr,
	}
}

// reportUnpriced ports reportUnpricedClaudeSnapshots: one line per model the
// catalogue does not cover, so the operator knows the cost came from ccusage's
// own pricing rather than TokenBoard's.
//
// Only a snapshot with real usage and a zero cost is worth a line. ccusage prices
// models from its own builtin catalogue, so a model missing from the TokenBoard
// override set still arrives with a real cost; tracking the override set instead of
// the shipped cost made this fire on every run for 43-44 models that were all
// priced — 1666 lines in one week of a rotated daily-sync.err.log, burying the
// errors that matter. The TS side was fixed first (bcd4004) and this port missed it.
func reportUnpriced(snapshots []contract.Snapshot, covered map[string]bool, stderr func(string)) {
	seen := map[string]bool{}
	order := []string{}
	for _, snapshot := range snapshots {
		if snapshot.Source != contract.SourceClaudeCode || snapshot.TotalTokens <= 0 {
			continue
		}
		if snapshot.CostUSD > 0 {
			continue
		}
		if covered[snapshot.Model] || seen[snapshot.Model] {
			continue
		}
		seen[snapshot.Model] = true
		order = append(order, snapshot.Model)
	}
	for _, model := range order {
		stderr(fmt.Sprintf(
			"TokenBoard model pricing unavailable for Claude Code model %s; preserving ccusage result", model))
	}
}

// buildRangeArgs ports buildRangeArgs: validate the window (rejecting shell
// metacharacters and a reversed range) and render ccusage's --since/--until.
func buildRangeArgs(since, until string, env func(string) string) ([]string, error) {
	if since == "" {
		since = firstNonEmpty(env("TOKENBOARD_SINCE"), env("TOKENBOARD_DEFAULT_SINCE"))
	}
	if until == "" {
		until = env("TOKENBOARD_UNTIL")
	}
	normalizedSince, normalizedUntil, err := sessionusage.AssertValidDateFilterRange(since, until,
		"Claude since date", "Claude until date")
	if err != nil {
		return nil, err
	}
	args := []string{}
	if normalizedSince != "" {
		args = append(args, "--since", normalizedSince)
	}
	if normalizedUntil != "" {
		args = append(args, "--until", normalizedUntil)
	}
	return args, nil
}

func readCcusageTimeoutMs(env func(string) string) int {
	// parseInt semantics: TS reads this with Number.parseInt(…, 10), so a
	// trailing suffix ("1200abc", "1200.9") still yields a usable number.
	if value, ok := contract.ParseInt(env("TOKENBOARD_CCUSAGE_TIMEOUT_MS")); ok && value > 0 {
		return value
	}
	return DefaultCcusageTimeoutMs
}

func readPackageCommandRetries(env func(string) string) int {
	if value, ok := contract.ParseInt(env("TOKENBOARD_PACKAGE_COMMAND_RETRIES")); ok && value >= 0 {
		return value
	}
	return DefaultPackageCommandRetries
}

// readClaudeHome ports readClaudeHome: CLAUDE_CONFIG_DIR, then CLAUDE_HOME,
// then ~/.claude.
func readClaudeHome(env func(string) string, configuredHome string) string {
	if value := strings.TrimSpace(env("CLAUDE_CONFIG_DIR")); value != "" {
		return value
	}
	if value := strings.TrimSpace(env("CLAUDE_HOME")); value != "" {
		return value
	}
	return filepath.Join(homeDir(Options{HomeDir: configuredHome}), ".claude")
}

func homeDir(options Options) string {
	if options.HomeDir != "" {
		return options.HomeDir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return home
}

// firstNonEmpty is the TS `a || b` chain: only the empty string is false
// there, so a whitespace-only value is a value. Trimming before the test would
// skip it and quietly fall through to the next variable, which is the silent
// downgrade the TS collector avoids by letting its date validation reject it.
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
