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

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

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
	// PricingFetcher replaces the catalogue HTTP client; tests use it.
	PricingFetcher func(request *http.Request) (*http.Response, error)
	// ccusagePath forces the ccusage subprocess implementation even though
	// the native one is the default. Only tests and the parity harness set
	// it; it is unexported so no configuration can reach it.
	ccusagePath bool
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
	timezone := strings.TrimSpace(options.Timezone)
	if timezone == "" {
		timezone = sessionusage.LocalTimezone()
	}
	collectedAt := options.CollectedAt
	if collectedAt == "" {
		collectedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return nativeCollect(ctx, nativeInput{
		options:     options,
		env:         env,
		stderr:      stderr,
		timezone:    timezone,
		collectedAt: collectedAt,
	})
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

// resolveWindowEnv applies the provider-level date window fallbacks: an unset
// --since is TOKENBOARD_SINCE then TOKENBOARD_DEFAULT_SINCE, an unset --until is
// TOKENBOARD_UNTIL. It does NOT validate or normalize; that stays in
// sessionusage.AssertValidDateFilterRange so the ccusage path and the native
// path share one rule.
func resolveWindowEnv(since, until string, env func(string) string) (string, string) {
	if since == "" {
		since = firstNonEmpty(env("TOKENBOARD_SINCE"), env("TOKENBOARD_DEFAULT_SINCE"))
	}
	if until == "" {
		until = env("TOKENBOARD_UNTIL")
	}
	return since, until
}

// buildRangeArgs ports buildRangeArgs: validate the window (rejecting shell
// metacharacters and a reversed range) and render ccusage's --since/--until.
func buildRangeArgs(since, until string, env func(string) string) ([]string, error) {
	since, until = resolveWindowEnv(since, until, env)
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
