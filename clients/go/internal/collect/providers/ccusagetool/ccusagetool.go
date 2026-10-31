// Package ccusagetool ports providers/ccusage-tools.ts: the twelve tools that
// ccusage answers with an identical report shape, so one parameterised
// provider serves all of them.
//
// Each tool runs `<tool> daily --json` for totals and `<tool> session --json`
// for session counts. ccusage exits 0 with an empty daily report for a tool
// that is not installed, so an empty report ends the collection without the
// second spawn: most machines have none of these tools.
//
// Unlike the claude-code and codex providers this one never prepares a
// dynamic pricing catalogue. The TS side does not either: the tool reports
// carry their own cost figures, so a config produced here would only change
// arguments the tools do not read. An ambient TOKENBOARD_CCUSAGE_CONFIG still
// reaches ccusage through the package runner, exactly as it does in TS.
package ccusagetool

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// DefaultCcusageTimeoutMs matches the claude-code budget: ccusage walks the
// tool's whole session tree to build one day's totals.
const DefaultCcusageTimeoutMs = 900_000

// DefaultPackageCommandRetries retries a transient ccusage failure twice.
const DefaultPackageCommandRetries = 2

// Options configures one collection. Zero values fall back to the environment
// and the clock, like the TS provider's optional arguments.
type Options struct {
	Timezone    string
	CollectedAt string
	Since       string
	Until       string
	HomeDir     string
	Stderr      func(line string)
	// Env resolves configuration; nil means the process environment.
	Env func(string) string
	// Runner runs ccusage; nil means ccusage.RunJSON.
	Runner ccusage.CommandRunner
	// ResolveBinary acquires the local ccusage binary; nil means
	// ccusage.Resolve. Tests inject it so no real install is probed.
	ResolveBinary func(ccusage.AcquireOptions) (ccusage.Binary, error)
}

// Collect gathers one ccusage-tool source's usage.
func Collect(ctx context.Context, source contract.Source, options Options) ([]contract.Snapshot, error) {
	command, ok := contract.CcusageToolCommand(source)
	if !ok {
		return nil, fmt.Errorf("%s is not a ccusage tool source", source)
	}
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

	rangeArgs, err := buildRangeArgs(options.Since, options.Until)
	if err != nil {
		return nil, err
	}
	packageRunner, err := resolveRunner(env, options, stderr)
	if err != nil {
		return nil, err
	}
	commandOptions := ccusage.CommandOptions{
		TimeoutMs: readCcusageTimeoutMs(env),
		Retries:   readPackageCommandRetries(env),
		OnRetry:   stderr,
	}

	dailyArgs, err := packageRunner.Args(append(
		[]string{command, "daily", "--json"}, append(rangeArgs, "--timezone", timezone)...), env, nil)
	if err != nil {
		return nil, err
	}
	daily, err := runner(ctx, packageRunner.Command, dailyArgs, commandOptions)
	if err != nil {
		return nil, err
	}
	// ccusage exits 0 with an empty report for a tool that is not installed, so
	// most machines would pay the second spawn for nothing. Session counts only
	// matter when there is usage to attribute.
	if !ccusage.HasDailyRows(daily) {
		return []contract.Snapshot{}, nil
	}

	sessionArgs, err := packageRunner.Args(append(
		[]string{command, "session", "--json"}, append(rangeArgs, "--timezone", timezone)...), env, nil)
	if err != nil {
		return nil, err
	}
	sessions, err := runner(ctx, packageRunner.Command, sessionArgs, commandOptions)
	if err != nil {
		return nil, err
	}

	return ccusage.NormalizeCcusageDailyJSON(daily, ccusage.NormalizeOptions{
		Source:      source,
		Timezone:    timezone,
		CollectedAt: collectedAt,
		Sessions:    sessions,
		HasSessions: true,
	})
}

// buildRangeArgs ports the TS buildRangeArgs. The tools read the window the
// CLI already resolved, so this provider deliberately has no
// TOKENBOARD_SINCE/TOKENBOARD_UNTIL fallback of its own: the TS provider
// receives the CLI-resolved values and would apply such a variable twice.
func buildRangeArgs(since, until string) ([]string, error) {
	normalizedSince, normalizedUntil, err := sessionusage.AssertValidDateFilterRange(
		since, until, "ccusage tool since date", "ccusage tool until date")
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

// resolveRunner picks the ccusage invocation the way the claude-code and codex
// providers do: the resolved local binary when there is one, the package
// runner otherwise. Tool sources never collect in hook mode, so unlike those
// providers this one may fall through to the package runner (and its download
// layer) instead of reporting the source unavailable.
func resolveRunner(env func(string) string, options Options, stderr func(string)) (ccusage.PackageRunner, error) {
	resolveBinary := options.ResolveBinary
	if resolveBinary == nil {
		resolveBinary = ccusage.Resolve
	}
	// Boolean(env.X) in TS: any non-empty value, whitespace included.
	var localBinary string
	if env("TOKENBOARD_FORCE_PACKAGE_RUNNER") == "" {
		binary, err := resolveBinary(ccusage.AcquireOptions{
			Env:     env,
			HomeDir: options.HomeDir,
			Stderr:  stderr,
		})
		if err != nil {
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

func init() {
	for _, source := range contract.CcusageToolSources() {
		collect.Register(source, provider{source: source})
	}
}

// provider adapts Collect to collect.Provider per source.
type provider struct{ source contract.Source }

func (p provider) Collect(ctx context.Context, options collect.Options) ([]contract.Snapshot, error) {
	return Collect(ctx, p.source, Options{
		Timezone: options.Timezone,
		Since:    options.Since,
		Until:    options.Until,
		HomeDir:  options.HomeDir,
		Stderr:   options.Stderr,
		Env:      options.EnvValue,
	})
}
