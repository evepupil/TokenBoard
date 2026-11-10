package codex

import (
	"os"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Port of codex-command-options.ts: the ccusage invocation shape for Codex and
// the per-report timeouts. Codex always runs `--offline`: the collector must
// not reach the network from a hook, and ccusage's online paths only add
// pricing the bundled config already carries.

const (
	// DefaultDailyTimeoutMs and DefaultSessionTimeoutMs are the Codex budgets;
	// a full session scan is much larger than the shared command default.
	DefaultDailyTimeoutMs   = 900_000
	DefaultSessionTimeoutMs = 900_000
	// DefaultPackageCommandRetries matches the TS retry default.
	DefaultPackageCommandRetries = 2
)

// CommandArgs builds `codex <report> --json --offline …`.
func CommandArgs(report string, rangeArgs []string, singleThread bool, timezone string) []string {
	args := []string{"codex", report, "--json", "--offline"}
	if singleThread {
		args = append(args, "--single-thread")
	}
	args = append(args, rangeArgs...)
	if timezone != "" {
		args = append(args, "--timezone", timezone)
	}
	return args
}

// PackageCommandOptions builds the command options for one ccusage run.
func PackageCommandOptions(env []string, timeoutMs int, stderr func(string)) ccusage.CommandOptions {
	return ccusage.CommandOptions{
		Env:        env,
		TimeoutMs:  timeoutMs,
		Retries:    readPackageCommandRetries(),
		RetryDelay: 0,
		OnRetry:    stderr,
	}
}

// ReadDailyTimeoutMs ports readDailyTimeoutMs.
func ReadDailyTimeoutMs(env func(string) string) int {
	return positiveIntEnv(env, "TOKENBOARD_CODEX_DAILY_TIMEOUT_MS", DefaultDailyTimeoutMs)
}

// ReadSessionTimeoutMs ports readSessionTimeoutMs.
func ReadSessionTimeoutMs(env func(string) string) int {
	return positiveIntEnv(env, "TOKENBOARD_CODEX_SESSION_TIMEOUT_MS", DefaultSessionTimeoutMs)
}

func readPackageCommandRetries() int {
	// TS reads this with Number.parseInt(…, 10); Atoi would reject the
	// trailing-suffix forms parseInt accepts.
	if value, ok := contract.ParseInt(os.Getenv("TOKENBOARD_PACKAGE_COMMAND_RETRIES")); ok && value >= 0 {
		return value
	}
	return DefaultPackageCommandRetries
}

// positiveIntEnv reads a positive integer override, falling back when the
// value is absent, unparsable or non-positive (the TS `Number.parseInt` rules).
func positiveIntEnv(env func(string) string, key string, fallback int) int {
	if env == nil {
		env = os.Getenv
	}
	if value, ok := contract.ParseInt(env(key)); ok && value > 0 {
		return value
	}
	return fallback
}
