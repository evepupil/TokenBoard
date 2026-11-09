package codex

// The in-process report source (S3, Task 8): the Codex counterpart of
// adapters/claude + providers/claudecode/native.go.
//
// The provider pipeline above this file is unchanged - frozen session scopes,
// session attribution, subagent corrections, the daily cost projection, context
// pricing, hook cursors and their retries all still run, and every document
// they normalize or inspect keeps ccusage's report shape (spec §6.1.1). This
// file only replaces the step that ran `ccusage codex daily` / `ccusage codex
// session`: a stand-in for ccusage.CommandRunner that answers the same
// invocation with the in-process adapter's report.
//
// Substituting at the runner seam rather than at Collect is deliberate. The
// hook path's whole-window recompute (§6.1.3) is the scoped collection, which
// reaches ccusage only through this runner, so one seam covers the plain,
// scoped, bounded and hook dispatches without touching any of their scheduling.
//
// The reports bill from the pricing ccusage would have read: the merged config
// ccusage was pointed at, resolved for the report's scope and replayed onto the
// embedded corpus. ccusage reaches the same overrides through that `--config`
// file, so parity and bench - which hand both sides the same prepared config -
// compare equal price bases.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	adapter "github.com/MisonL/TokenBoard/clients/go/internal/collect/adapters/codex"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
	"github.com/MisonL/TokenBoard/clients/go/internal/pricing"
)

// useNativeCodex selects the in-process report source instead of the ccusage
// subprocess. It is a compile-time constant, not an environment variable:
// flipping it is a reviewed commit (and its own commit), and a user must not be
// able to run an unvalidated code path on their own data. Until it flips,
// Collect keeps the ccusage path byte for byte.
const useNativeCodex = false

// nativeInput is what the native entry point hands the pipeline. Everything
// else - env, timezone, collectedAt, state directory, pricing preparation - is
// resolved inside Collect, so the two report sources cannot drift apart.
type nativeInput struct {
	options Options
}

// nativeCollect is the native entry point: the same pipeline as Collect, with
// the in-process report source. The switch and the registry provider both call
// it. A failure is returned as-is, never rewritten into a ccusage fallback,
// because a fallback would make a parity comparison "ccusage against ccusage"
// and pass silently.
func nativeCollect(ctx context.Context, options Options) ([]contract.Snapshot, error) {
	options.useNativeReport = true
	return Collect(ctx, options)
}

// nativeProvider is the registry adapter for LookupNative. It always runs the
// native path, whatever the switch says; the parity harness looks the native
// side up here.
type nativeProvider struct{}

// Collect adapts nativeCollect to the registry's Provider interface.
func (nativeProvider) Collect(ctx context.Context, options collect.Options) ([]contract.Snapshot, error) {
	return nativeCollect(ctx, Options{
		Timezone:            options.Timezone,
		Since:               options.Since,
		Until:               options.Until,
		StateDir:            options.StateDir,
		HomeDir:             options.HomeDir,
		Stderr:              options.Stderr,
		Env:                 options.EnvValue,
		HookAcknowledgement: options.HookAcknowledgement,
	})
}

// nativePackageRunner keeps the provider's argument construction (including
// the `--config` pair ConfigArgs appends, so a broken explicit config fails
// exactly as it would on the ccusage path) without resolving or spawning a
// ccusage binary. The native runner parses the resulting argument list.
var nativePackageRunner = ccusage.PackageRunner{
	Command: "ccusage",
	RunPackageArgs: func(_, _ string, packageArgs []string) []string {
		return append([]string{}, packageArgs...)
	},
}

// nativeReportRunner answers the provider's report calls in process. It is a
// value, not a closure over a per-scope corpus: the corpus only depends on the
// report's pricing scope, so it is built on first use and reused for the rest
// of the collection (a multi-scope hook run makes two calls per scope).
type nativeReportRunner struct {
	prepared pricing.PreparedConfig
	// pricing caches the corpus and cost mode per report name.
	pricing map[string]nativeReportPricing
}

type nativeReportPricing struct {
	corpus *nativepricing.Corpus
	mode   nativepricing.CostMode
	speed  adapter.RequestedSpeed
}

// newNativeReportRunner builds the report source for one collection.
func newNativeReportRunner(prepared pricing.PreparedConfig) *nativeReportRunner {
	return &nativeReportRunner{prepared: prepared, pricing: map[string]nativeReportPricing{}}
}

// Run implements ccusage.CommandRunner.
func (runner *nativeReportRunner) Run(ctx context.Context, _ string, args []string, options ccusage.CommandOptions) (any, error) {
	// The subprocess path bounds ccusage by killing the child at TimeoutMs
	// (TOKENBOARD_CODEX_DAILY_TIMEOUT_MS). There is no child here, so the budget
	// becomes a deadline on the scan, which polls it between files; dropping it
	// would let a hook run overrun the budget the user set.
	var budgetCtx context.Context
	if options.TimeoutMs > 0 {
		var cancel context.CancelFunc
		budgetCtx, cancel = context.WithTimeout(ctx, time.Duration(options.TimeoutMs)*time.Millisecond)
		defer cancel()
		ctx = budgetCtx
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	call, err := parseNativeCodexArgs(args)
	if err != nil {
		return nil, err
	}
	pricingForCall, err := runner.pricingFor(call.report)
	if err != nil {
		return nil, err
	}
	// The child environment is what ccusage would have seen: the provider
	// materializes it per scope (CODEX_HOME points at the frozen copy), and
	// environOf drops empty keys, so an absent CODEX_HOME means unset.
	env := nativeEnvLookup(options.Env)
	homes, err := adapter.HomePaths(env, func() (string, error) {
		return adapter.ResolveHomeDir(env)
	})
	if err != nil {
		return nil, err
	}
	kind := adapter.ReportDaily
	if call.report == "session" {
		kind = adapter.ReportSession
	}
	sources := adapter.CollectDedupedSources(adapter.UsageSources(homes))
	// LoadGroups prunes with FilterByEligibility itself (Task 5: it takes the
	// unpruned discovery output), and the bounded replay plan sees the same
	// discovery set, exactly like codex_replay_plan::for_bounded_files.
	groups, err := adapter.LoadGroupsContext(ctx, sources, kind, call.timezone, call.since, call.until)
	if err != nil {
		if budgetCtx != nil && budgetCtx.Err() == context.DeadlineExceeded {
			return nil, nativeTimeoutError(options.TimeoutMs, args)
		}
		return nil, err
	}
	speed := adapter.ResolveSpeedPolicy(pricingForCall.speed, homes)
	document := adapter.ReportJSON(groups, kind, pricingForCall.corpus, speed, pricingForCall.mode)
	// Round-trip through JSON so the provider sees exactly what the subprocess
	// path hands it: ordered records with json.Number scalars.
	encoded, err := json.Marshal(document)
	if err != nil {
		return nil, fmt.Errorf("codex native report: %w", err)
	}
	decoded, err := ccusage.DecodeJSON(encoded)
	if err != nil {
		return nil, fmt.Errorf("codex native report: %w", err)
	}
	return decoded, nil
}

// pricingFor resolves the corpus and cost mode for one report's scope. ccusage
// resolves the config's mode and pricingOverrides per command, so the session
// report is resolved as `codex session` rather than inheriting the daily scope.
func (runner *nativeReportRunner) pricingFor(report string) (nativeReportPricing, error) {
	if cached, ok := runner.pricing[report]; ok {
		return cached, nil
	}
	scope := runner.prepared.ResolveScope(pricing.Scope{Agent: "codex", Report: report})
	corpus, err := nativepricing.LoadEmbeddedCorpus()
	if err != nil {
		return nativeReportPricing{}, err
	}
	if len(scope.Overrides) > 0 {
		corpus, err = corpus.WithOverrides(scope.Overrides)
		if err != nil {
			return nativeReportPricing{}, err
		}
	}
	resolved := nativeReportPricing{corpus: &corpus, mode: codexCostMode(scope.Mode), speed: codexSpeed(scope.Speed)}
	runner.pricing[report] = resolved
	return resolved, nil
}

// nativeCodexCommand is what the runner reads out of one `codex <report> …`
// invocation: the report, the window and the timezone.
type nativeCodexCommand struct {
	report   string
	since    string
	until    string
	timezone string
}

// parseNativeCodexArgs parses the argument list the provider builds
// (CommandArgs + the `--config` pair). Unknown flags are an error: the native
// source must not silently ignore a flag a future provider starts passing.
func parseNativeCodexArgs(args []string) (nativeCodexCommand, error) {
	if len(args) < 2 || args[0] != "codex" {
		return nativeCodexCommand{}, fmt.Errorf("codex native report: unexpected arguments %v", args)
	}
	command := nativeCodexCommand{report: args[1]}
	switch command.report {
	case "daily", "session":
	default:
		return nativeCodexCommand{}, fmt.Errorf("codex native report: unsupported report %q", command.report)
	}
	for index := 2; index < len(args); index++ {
		arg := args[index]
		name, inline, hasInline := strings.Cut(arg, "=")
		switch name {
		case "--json", "--offline", "--single-thread":
			if hasInline {
				return nativeCodexCommand{}, fmt.Errorf("codex native report: unexpected value in %q", arg)
			}
		case "--since", "--until", "--timezone", "--config":
			value := inline
			if !hasInline {
				index++
				if index >= len(args) {
					return nativeCodexCommand{}, fmt.Errorf("codex native report: missing value for %q", name)
				}
				value = args[index]
			}
			switch name {
			case "--since":
				command.since = value
			case "--until":
				command.until = value
			case "--timezone":
				command.timezone = value
			}
			// --config names the merged ccusage config the native side has
			// already resolved through ResolveScope; nothing to read here.
		default:
			return nativeCodexCommand{}, fmt.Errorf("codex native report: unknown argument %q", arg)
		}
	}
	if command.since != "" && command.until != "" {
		normalizedSince, err := normalizeDateFilter(command.since, "Codex since date")
		if err != nil {
			return nativeCodexCommand{}, err
		}
		normalizedUntil, err := normalizeDateFilter(command.until, "Codex until date")
		if err != nil {
			return nativeCodexCommand{}, err
		}
		command.since, command.until = normalizedSince, normalizedUntil
	}
	return command, nil
}

// nativeEnvLookup turns the child environment the provider materialized into
// the Lookup-style probe the adapter's home resolution takes.
func nativeEnvLookup(env []string) func(string) (string, bool) {
	values := make(map[string]string, len(env))
	for _, entry := range env {
		if key, value, ok := strings.Cut(entry, "="); ok {
			values[key] = value
		}
	}
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

// nativeTimeoutError keeps the wording describeCommandFailure gives the
// subprocess path, so a timed-out nightly sync logs the same line whichever
// report source ran.
func nativeTimeoutError(timeoutMs int, args []string) error {
	return fmt.Errorf("Command timed out after %dms: %s", timeoutMs,
		strings.Join(append([]string{"ccusage"}, args...), " "))
}

// codexSpeed maps the config's speed string onto the adapter's CLI value.
// ResolveScope only ever returns the four names ConfigCodexSpeed accepts.
func codexSpeed(speed string) adapter.RequestedSpeed {
	switch speed {
	case "standard":
		return adapter.SpeedStandard
	case "fast":
		return adapter.SpeedFast
	case "flex":
		return adapter.SpeedFlex
	default:
		return adapter.SpeedAuto
	}
}

// codexCostMode maps the config's mode string onto the pricing engine's ladder.
// ResolveScope only ever returns the three values ccusage accepts.
func codexCostMode(mode string) nativepricing.CostMode {
	switch mode {
	case "calculate":
		return nativepricing.ModeCalculate
	case "display":
		return nativepricing.ModeDisplay
	default:
		return nativepricing.ModeAuto
	}
}
