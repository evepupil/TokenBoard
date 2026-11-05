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
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/adapters/claude"
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
	// Hook mode is not wired yet (Task 8 owns it). Refusing here is the whole
	// contract: a full scan from a notifier would read the entire history on
	// every prompt, and a ccusage fallback would hide the gap. The refusal comes
	// after the catalogue load because every network decision it needs (the
	// cache freshness, the offline rule) is taken inside pricing.Prepare, whose
	// HookMode is derived from this same value below; the cost pass still never
	// sees hook mode, which the stub-fetcher test pins.

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
	// The merged override block is the only part of the prepared config this
	// path uses, and it must be MergedPricingOverrides rather than Overrides:
	// Overrides carries just the bundled/catalogue layer, while the user's
	// TOKENBOARD_CCUSAGE_CONFIG rates reach ccusage only through the merged
	// file. Passing Overrides here would bill a machine that set an explicit
	// config differently from its own ccusage runs.
	//
	// ConfigPath is deliberately ignored: it exists to point the ccusage
	// subprocess at a config file, and the native path never spawns one.
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
	if hookMode {
		return nil, errors.New("claudecode: native hook collection is not wired yet")
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
		Overrides: prepared.MergedPricingOverrides,
		Mode:      nativepricing.ModeAuto,
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
