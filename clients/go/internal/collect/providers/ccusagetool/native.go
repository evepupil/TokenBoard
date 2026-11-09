package ccusagetool

// The in-process report source for the twelve ccusage tool sources (S4a, plus
// the copilot adapter in S4b). This is the same seam as the Codex adapter
// (providers/codex/native.go): the provider pipeline above it is unchanged and
// only the step that ran `ccusage <tool> daily|session --json` is replaced with
// the native adapter's report.
//
// Two contracts are preserved verbatim:
//
//   - the report shape is what ccusage prints (`{daily|monthly|sessions,
//     totals}` with the `sessionId` period key), so ccusage.NormalizeCcusageDailyJSON
//     still turns it into contract.Snapshot;
//   - pricing comes from the same merged config ccusage would have read:
//     ResolveScope for `<tool> <report>` replayed onto the embedded corpus. The
//     tools never read `speed` (Codex only) and always run offline here, so the
//     frozen corpus is the whole price table.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	// The copilot adapter registers itself from its init(); this import is
	// what puts that registration into every production build. A _test.go
	// import would not (TestCopilotAdapterIsImportedFromAProductionFile).
	_ "github.com/MisonL/TokenBoard/clients/go/internal/collect/adapters/copilot"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/adapters/tools"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
	"github.com/MisonL/TokenBoard/clients/go/internal/pricing"
)

// useNativeTools selects the in-process adapters instead of the ccusage
// subprocess. It is a compile-time constant, not an environment variable:
// flipping it is a reviewed commit, and the switch must never fall back to
// ccusage silently (a parity run would then compare ccusage with itself).
const useNativeTools = false

// nativeCollect is the native entry point: the same pipeline as Collect, with
// the in-process report source.
func nativeCollect(ctx context.Context, source contract.Source, options Options) ([]contract.Snapshot, error) {
	options.useNativeReport = true
	return Collect(ctx, source, options)
}

// nativeProvider is the collect.Provider registered under RegisterNative for
// every tool source that has a native adapter.
type nativeProvider struct{ source contract.Source }

func (p nativeProvider) Collect(ctx context.Context, options collect.Options) ([]contract.Snapshot, error) {
	return nativeCollect(ctx, p.source, Options{
		Timezone: options.Timezone,
		Since:    options.Since,
		Until:    options.Until,
		StateDir: options.StateDir,
		HomeDir:  options.HomeDir,
		Stderr:   options.Stderr,
		Env:      options.EnvValue,
	})
}

// nativePackageRunner keeps the package-runner seam intact without a package:
// the args are the ones the provider built, and the command name the native
// runner sees is the plain `ccusage` label.
var nativePackageRunner = ccusage.PackageRunner{
	Command: "ccusage",
	RunPackageArgs: func(_, _ string, packageArgs []string) []string {
		return packageArgs
	},
}

// nativeToolRunner answers one `ccusage <tool> <report> --json …` invocation.
type nativeToolRunner struct {
	prepared pricing.PreparedConfig
	homeDir  string
	debug    func(string)
	// envFn is the provider's configuration probe (TOKENBOARD_* and, in tests,
	// injected data-dir overrides). The adapters read the tool data-directory
	// variables (AMP_DATA_DIR, …) the way the ccusage subprocess would: from
	// the process environment, with a non-empty provider value winning. A
	// set-but-empty variable keeps its "zero roots" meaning through LookupEnv.
	envFn func(string) string
	// overrides are test-only data-directory values that win over both envFn
	// and the process environment (the copilot goldens point COPILOT_HOME at
	// their fixture tree this way, even when the maintainer's shell sets it).
	overrides map[string]string
	pricing   map[string]nativeToolPricing
}

type nativeToolPricing struct {
	corpus nativepricing.Corpus
	mode   nativepricing.CostMode
}

func newNativeToolRunner(prepared pricing.PreparedConfig, homeDir string, env func(string) string, debug func(string)) *nativeToolRunner {
	if env == nil {
		env = func(string) string { return "" }
	}
	return &nativeToolRunner{prepared: prepared, homeDir: homeDir, envFn: env, debug: debug,
		pricing: map[string]nativeToolPricing{}}
}

// toolEnvLookup layers the provider probe over the process environment the way
// the subprocess would inherit it.
func (runner *nativeToolRunner) toolEnvLookup() func(string) (string, bool) {
	return func(key string) (string, bool) {
		if value, overridden := runner.overrides[key]; overridden {
			return value, true
		}
		if value := runner.envFn(key); value != "" {
			return value, true
		}
		return os.LookupEnv(key)
	}
}

// Run implements ccusage.CommandRunner.
func (runner *nativeToolRunner) Run(ctx context.Context, _ string, args []string, options ccusage.CommandOptions) (any, error) {
	// The subprocess path bounds the run by killing the child at TimeoutMs.
	// Here the same budget becomes a context deadline, but the adapters' loader
	// signature (func(Options) ([]Entry, error)) cannot observe it: LoadCommand
	// checks it before and after the load only, so an over-budget scan finishes
	// before the deadline is noticed. The run still fails with
	// nativeTimeoutError; it just cannot stop mid-scan.
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
	call, err := parseNativeToolArgs(args)
	if err != nil {
		return nil, err
	}
	resolved, err := runner.pricingFor(call)
	if err != nil {
		return nil, err
	}
	opts := tools.Options{
		Env:      runner.toolEnvLookup(),
		Timezone: call.timezone,
		Mode:     resolved.mode,
		Corpus:   resolved.corpus,
		Debug:    runner.debug,
	}
	if runner.homeDir != "" {
		opts.HomeDir = func() (string, error) { return runner.homeDir, nil }
	}
	// The window reaches the adapters that narrow themselves (the copilot
	// reconciliation, loader.rs:81-91); the report filter below still applies
	// the same bounds to the rows.
	sinceMs, untilMs := tools.DateRangeBoundsMs(call.since, call.until, call.timezone)
	entries, err := tools.LoadCommandInWindow(ctx, call.command, opts,
		&tools.Window{Since: call.since, Until: call.until, SinceMs: sinceMs, UntilMs: untilMs})
	if err != nil {
		if budgetCtx != nil && budgetCtx.Err() == context.DeadlineExceeded {
			return nil, nativeTimeoutError(options.TimeoutMs, args)
		}
		return nil, err
	}
	kind := tools.Daily
	if call.report == "session" {
		kind = tools.Session
	}
	var rows []tools.Row
	var totals tools.Totals
	if call.command == "qwen" && kind == tools.Session {
		// qwen applies its window differently per report (lib.rs:22-31):
		// daily/monthly drop out-of-window entries before summarising, while
		// session keeps every entry, summarises, and filters rows by
		// lastActivity (lib.rs:53-67) - so a session spanning the window start
		// keeps its earlier usage.
		rows, _ = tools.Summarize(entries, kind)
		rows = tools.FilterQwenSessionRows(rows, call.since, call.until)
		totals = tools.TotalsFromRows(rows)
	} else {
		rows, totals = tools.Summarize(filterToolEntries(entries, call), kind)
	}
	var document map[string]any
	if call.command == "qwen" {
		// qwen is the one source whose empty report prints `"totals": null`
		// (qwen/src/report.rs:11-20).
		document = tools.QwenReportJSON(rows, totals, kind)
	} else {
		sessionMetadata := kind == tools.Session && tools.RichSessionMetadata(call.command)
		document = tools.ReportJSON(rows, totals, kind, sessionMetadata)
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return nil, fmt.Errorf("ccusage tool native report: %w", err)
	}
	decoded, err := ccusage.DecodeJSON(encoded)
	if err != nil {
		return nil, fmt.Errorf("ccusage tool native report: %w", err)
	}
	return decoded, nil
}

// filterToolEntries is filter_loaded_entries_by_date (adapters/common/src/lib.rs:48-59):
// the entry's local date must fall inside the window, both ends inclusive.
// qwen's session report is the documented exception and is handled after
// summarisation instead (see Run).
func filterToolEntries(entries []tools.Entry, call nativeToolCall) []tools.Entry {
	if call.since == "" && call.until == "" {
		return entries
	}
	kept := entries[:0]
	for _, entry := range entries {
		if tools.DateWithinRange(entry.Date, call.since, call.until) {
			kept = append(kept, entry)
		}
	}
	return kept
}

// nativeToolCall is what the runner reads out of one invocation.
type nativeToolCall struct {
	command  string
	report   string
	since    string
	until    string
	timezone string
	// mode is the --mode override; empty means the config's mode applies.
	mode string
}

// parseNativeToolArgs parses the argument list the provider builds. Unknown
// flags are an error: the native source must not silently ignore a flag a
// future provider starts passing.
func parseNativeToolArgs(args []string) (nativeToolCall, error) {
	if len(args) < 2 {
		return nativeToolCall{}, fmt.Errorf("ccusage tool native report: unexpected arguments %v", args)
	}
	call := nativeToolCall{command: args[0], report: args[1]}
	switch call.report {
	case "daily", "session":
	default:
		return nativeToolCall{}, fmt.Errorf("ccusage tool native report: unsupported report %q", call.report)
	}
	for index := 2; index < len(args); index++ {
		arg := args[index]
		name, inline, hasInline := strings.Cut(arg, "=")
		switch name {
		case "--json", "--offline", "--single-thread", "--compact":
			if hasInline {
				return nativeToolCall{}, fmt.Errorf("ccusage tool native report: unexpected value in %q", arg)
			}
		case "--since", "--until", "--timezone", "--config", "--mode":
			value := inline
			if !hasInline {
				index++
				if index >= len(args) {
					return nativeToolCall{}, fmt.Errorf("ccusage tool native report: missing value for %q", name)
				}
				value = args[index]
			}
			switch name {
			case "--since":
				call.since = value
			case "--until":
				call.until = value
			case "--timezone":
				call.timezone = value
			case "--mode":
				if value != "auto" && value != "calculate" && value != "display" {
					return nativeToolCall{}, fmt.Errorf("ccusage tool native report: unsupported mode %q", value)
				}
				call.mode = value
			}
			// --config is resolved from the prepared config, which is the same
			// file the subprocess path would have read.
		default:
			return nativeToolCall{}, fmt.Errorf("ccusage tool native report: unknown argument %q", arg)
		}
	}
	if call.timezone == "" {
		call.timezone = "UTC"
	}
	return call, nil
}

// pricingFor resolves the corpus and cost mode for one invocation. A --mode
// flag on the command line beats the config's (ccusage's CLI overrides the
// config file), so it is part of the cache key.
func (runner *nativeToolRunner) pricingFor(call nativeToolCall) (nativeToolPricing, error) {
	key := call.command + "\x00" + call.report + "\x00" + call.mode
	if cached, ok := runner.pricing[key]; ok {
		return cached, nil
	}
	scope := runner.prepared.ResolveScope(pricing.Scope{Agent: call.command, Report: call.report})
	if call.mode != "" {
		scope.Mode = call.mode
	}
	corpus, err := nativepricing.LoadEmbeddedCorpus()
	if err != nil {
		return nativeToolPricing{}, err
	}
	if len(scope.Overrides) > 0 {
		corpus, err = corpus.WithOverrides(scope.Overrides)
		if err != nil {
			return nativeToolPricing{}, err
		}
	}
	resolved := nativeToolPricing{corpus: corpus, mode: toolCostMode(scope.Mode)}
	runner.pricing[key] = resolved
	return resolved, nil
}

// toolCostMode maps the config's mode string onto the pricing engine's ladder.
func toolCostMode(mode string) nativepricing.CostMode {
	switch mode {
	case "calculate":
		return nativepricing.ModeCalculate
	case "display":
		return nativepricing.ModeDisplay
	default:
		return nativepricing.ModeAuto
	}
}

// nativeTimeoutError keeps the wording describeCommandFailure gives the
// subprocess path.
func nativeTimeoutError(timeoutMs int, args []string) error {
	return fmt.Errorf("Command timed out after %dms: %s", timeoutMs,
		strings.Join(append([]string{"ccusage"}, args...), " "))
}

func init() {
	for _, source := range contract.CcusageToolSources() {
		collect.RegisterNative(source, nativeProvider{source: source})
	}
}
