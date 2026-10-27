// Package cli wires the tokenboard subcommands: argument/env parsing, the
// preview/sync/warm-hooks dispatch, and the exit-code contract
// (0 ok, 1 failure, 2 usage, 75 transient retry) the skill scripts mirror.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	_ "github.com/MisonL/TokenBoard/clients/go/internal/collect/providers"
	antigravityprovider "github.com/MisonL/TokenBoard/clients/go/internal/collect/providers/antigravitycli"
	antigravityguiprovider "github.com/MisonL/TokenBoard/clients/go/internal/collect/providers/antigravitygui"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/providers/codex"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/selfupdate"
	"github.com/MisonL/TokenBoard/clients/go/internal/state"
	"github.com/MisonL/TokenBoard/clients/go/internal/upload"
)

// Exit codes. 75 is the scheduler retry contract: a transient failure the
// launchd/systemd/schtasks wrapper may re-run.
//
// ExitUsage is deliberately 2, where the TS collector returns 1 for the same
// usage error. The TS CLI has a single failure code, so a usage error and a
// collection failure look alike there; here they do not. No consumer parses
// the number — the skill scripts only distinguish 0, 75 and "something else"
// — so the split is diagnostic, not a protocol difference. The exit codes
// that are a protocol (0, 1, 75) match the TS collector exactly.
const (
	ExitOK        = 0
	ExitFailure   = 1
	ExitUsage     = 2
	ExitTransient = collect.TransientSyncExitCode
)

// Env abstracts the process environment so tests can drive it.
type Env func(string) string

// Options is the parsed invocation.
type Options struct {
	Command         string
	Source          string
	Timezone        string
	Endpoint        string
	UploadToken     string
	Since           string
	Until           string
	HookMode        bool
	FailOnSourceErr bool
	// ShadowHook makes `shadow` compare the incremental hook path instead of a
	// full preview. It is a flag, never an environment variable: the ambient
	// TOKENBOARD_HOOK_MODE belongs to a notifier and must not silently change
	// which code path a comparison measures.
	ShadowHook bool
}

// Run executes one CLI invocation and returns the process exit code.
func Run(args []string, stdout, stderr io.Writer) int {
	return runWithLookup(context.Background(), args, os.LookupEnv, stdout, stderr)
}

// RunWithEnv is Run with an injectable environment, for tests. An empty value
// counts as unset: the injected form cannot tell the two apart, and the
// process environment is the only place the distinction is available.
func RunWithEnv(ctx context.Context, args []string, env Env, stdout, stderr io.Writer) int {
	return runWithLookup(ctx, args, func(key string) (string, bool) {
		value := env(key)
		return value, value != ""
	}, stdout, stderr)
}

// lookupFunc reports a variable's value and whether it is set at all.
type lookupFunc func(string) (string, bool)

func runWithLookup(ctx context.Context, args []string, lookup lookupFunc, stdout, stderr io.Writer) int {
	env := func(key string) string {
		value, _ := lookup(key)
		return value
	}
	if len(args) == 0 {
		fmt.Fprintln(stderr, usageLine())
		return ExitUsage
	}
	switch args[0] {
	case "self-update":
		return runSelfUpdate(args[1:], env, stdout, stderr)
	case "version":
		fmt.Fprintln(stdout, versionString())
		return ExitOK
	case "help", "-h", "--help":
		fmt.Fprintln(stdout, usageLine())
		return ExitOK
	}

	options, err := parseArgsWithLookup(args, env, lookup)
	if err != nil {
		fmt.Fprintln(stderr, err.Error())
		return ExitUsage
	}
	// Providers report every unpriced model on every run; the sink folds those
	// into one line per provider when the run ends, the way the TS CLI does.
	sink := newPricingDiagnosticSink(stderr)
	defer sink.Flush()
	return dispatch(ctx, options, env, stdout, sink)
}

func dispatch(ctx context.Context, options Options, env Env, stdout, stderr io.Writer) int {
	// The hook warm mark is stamped with the run's start, not its end: the
	// scan is only guaranteed to cover files that existed when it began.
	startedAt := time.Now()
	home, err := os.UserHomeDir()
	if err != nil {
		// A missing home directory would silently turn the state dir into a
		// relative path — locks and cursors would land in the working
		// directory instead. Refuse instead.
		fmt.Fprintf(stderr, "Cannot resolve the home directory: %v\n", err)
		return ExitFailure
	}
	stateDir := state.ResolveDir(env, home)

	switch options.Command {
	case "warm-hooks":
		return withRunLock(stateDir, stderr, func() int {
			// The TS collector advances the hook cursors' high-water mark after
			// a full scan so the next hook run does not rescan the whole tree.
			// Only the two hook-installed sources have a cursor to warm; the
			// others are reported (the TS JSON lists every expanded source)
			// but left untouched.
			sources := expandWarmHookSources(options.Source)
			if err := warmHookCursors(sources, stateDir, startedAt, options, env, "all", "", stderr); err != nil {
				fmt.Fprintln(stderr, err.Error())
				return ExitFailure
			}
			payload, _ := json.MarshalIndent(map[string]any{"warmed": sources}, "", "  ")
			fmt.Fprintln(stdout, string(payload))
			return ExitOK
		})
	case "preview":
		return withRunLock(stateDir, stderr, func() int {
			outcome, abortErr := collectAll(ctx, options, env, stateDir, "", stderr)
			if abortErr != nil {
				fmt.Fprintln(stderr, abortErr.Error())
				return ExitFailure
			}
			snapshots := outcome.snapshots
			if snapshots == nil {
				snapshots = []contract.Snapshot{}
			}
			payload, _ := json.MarshalIndent(snapshots, "", "  ")
			fmt.Fprintln(stdout, string(payload))
			if collectionFailed(outcome, options) {
				fmt.Fprintf(stderr, "One or more sources failed: %s\n", formatSourceFailures(outcome.failures))
				return ExitFailure
			}
			return ExitOK
		})
	case "shadow":
		// Shadow does not take the run lock. Both sides of the comparison
		// collect into their own temporary state directories and shadow never
		// touches a real cursor, so the lock would protect nothing — while a
		// comparison can run for twenty minutes on a large history, and
		// holding the machine's lock for that long makes scheduled syncs and
		// hooks fail with the lock timeout (observed 2026-10-21: the 18:00
		// sync timed out behind a shadow run). A concurrent sync is safe: both
		// sides only read the session files.
		return runShadow(ctx, options, env, stateDir, stdout, stderr)
	case "sync":
		return runSync(ctx, options, env, stateDir, startedAt, stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown command %q\n", options.Command)
		return ExitUsage
	}
}

// withRunLock serializes the command on collector-run.lock. The TS CLI takes
// this lock for all three commands, not just sync, so a preview cannot race
// a running sync's cursor writes.
func withRunLock(stateDir string, stderr io.Writer, body func() int) int {
	lock, err := state.Acquire(filepath.Join(stateDir, "collector-run.lock"), 35*time.Second)
	if err != nil {
		fmt.Fprintln(stderr, err.Error())
		return ExitFailure
	}
	if lock == nil {
		fmt.Fprintln(stderr, "TokenBoard collector lock timed out")
		return ExitFailure
	}
	defer func() { _ = lock.Release() }()
	return body()
}

func runSync(
	ctx context.Context, options Options, env Env, stateDir string,
	startedAt time.Time, stdout, stderr io.Writer,
) int {
	missing := requiredSyncConfig(options)
	if len(missing) > 0 {
		fmt.Fprintf(stderr, "Missing required config for sync: %s\n", strings.Join(missing, ", "))
		return ExitFailure
	}
	return withRunLock(stateDir, stderr, func() int {
		return syncLocked(ctx, options, env, stateDir, startedAt, stdout, stderr)
	})
}

func syncLocked(
	ctx context.Context, options Options, env Env, stateDir string,
	startedAt time.Time, stdout, stderr io.Writer,
) int {
	cursorScope, err := cursorScopeFromEndpoint(options.Endpoint)
	if err != nil {
		fmt.Fprintln(stderr, err.Error())
		return ExitFailure
	}
	// The TS collector prints per-phase durations next to the upload result,
	// and the skill's notify forwards them into the coordinator run record.
	// Go's providers fold cursor scanning and the ccusage calls into one
	// collection, so the phases it can attribute honestly are collect, upload
	// and cursorAck; the names travel as-is and are additive.
	timings := map[string]int64{}
	phaseStarted := time.Now()
	outcome, abortErr := collectAll(ctx, options, env, stateDir, cursorScope, stderr)
	timings["collect"] = elapsedMillis(phaseStarted)
	if abortErr != nil {
		fmt.Fprintln(stderr, abortErr.Error())
		return ExitFailure
	}
	shouldFailForSourceErrors := collectionFailed(outcome, options)

	if pausedUntil, paused := upload.IsPaused(stateDir, time.Now()); paused {
		fmt.Fprintf(stderr,
			"TokenBoard upload paused until %s after repeated non-transient failures; collected snapshots remain queued in the cursor\n",
			pausedUntil)
		if shouldFailForSourceErrors {
			return ExitFailure
		}
		return ExitOK
	}

	config := upload.Config{Endpoint: options.Endpoint, UploadToken: options.UploadToken}
	phaseStarted = time.Now()
	result, uploadErr := upload.UploadSnapshots(ctx, config, outcome.snapshots, nil)
	timings["upload"] = elapsedMillis(phaseStarted)
	if uploadErr == nil {
		upload.RecordSuccess(stateDir)
	} else {
		if !collect.IsTransientNetworkError(uploadErr) {
			// The backoff bookkeeping must not replace the original upload error:
			// if recording the failure itself fails (disk full, permissions), say
			// so and keep classifying the one that actually failed the sync.
			recorded, recordErr := upload.RecordFailure(stateDir, uploadErr, time.Now())
			if recordErr != nil {
				fmt.Fprintf(stderr, "TokenBoard upload failure could not be recorded: %s\n",
					upload.Summarize(recordErr))
			} else {
				suffix := ""
				if recorded.PausedUntil != "" {
					suffix = fmt.Sprintf("; pausing uploads until %s", recorded.PausedUntil)
				}
				fmt.Fprintf(stderr, "TokenBoard upload failed (%d consecutive non-transient failures%s)\n",
					recorded.ConsecutiveFailures, suffix)
			}
		}
		// The TS collector prints the failure itself before classifying it;
		// keep that so the scheduled runner's log names the cause. URLs are
		// reduced to their origin: the scheduled log is long-lived and a
		// transport error's full URL may carry query parameters.
		fmt.Fprintln(stderr, upload.RedactURLs(uploadErr.Error()))
		return classifyFailure(uploadErr, options, env)
	}

	phaseStarted = time.Now()
	if err := acknowledgeUploadCursors(stateDir, outcome, options, cursorScope, env); err != nil {
		fmt.Fprintln(stderr, err.Error())
		return ExitFailure
	}
	timings["cursorAck"] = elapsedMillis(phaseStarted)
	// The high-water mark claims a full scan covered everything up to the run's
	// start; only the runs that actually did (unbounded, not hook mode) may
	// advance it.
	if err := warmHookCursors(sourceNames(outcome.collectedSources), stateDir, startedAt, options, env,
		options.Since, options.Until, stderr); err != nil {
		fmt.Fprintln(stderr, err.Error())
		return ExitFailure
	}

	payload, _ := json.MarshalIndent(map[string]any{
		"upserted": result.Upserted,
		"skipped":  result.Skipped,
		"timings":  timings,
	}, "", "  ")
	fmt.Fprintln(stdout, string(payload))
	if shouldFailForSourceErrors {
		fmt.Fprintf(stderr, "One or more sources failed: %s\n", formatSourceFailures(outcome.failures))
		return ExitFailure
	}
	return ExitOK
}

// elapsedMillis reports a phase duration the way the TS phase timings do:
// rounded to whole milliseconds and never negative.
func elapsedMillis(start time.Time) int64 {
	elapsed := time.Since(start).Milliseconds()
	if elapsed < 0 {
		return 0
	}
	return elapsed
}

// classifyFailure applies the exit-code contract: only a non-hook sync run
// can be deferred (75); preview and warm-hooks report a plain failure, and
// hook syncs are never retried by the scheduler.
func classifyFailure(cause error, options Options, env Env) int {
	if options.Command == "sync" && !options.HookMode && collect.IsTransientNetworkError(cause) {
		return ExitTransient
	}
	return ExitFailure
}

// sourceFailure records one source that did not finish cleanly, the way the
// TS sourceFailures entry does. Fatal marks a failure an all-source run must
// report even without TOKENBOARD_FAIL_ON_SOURCE_ERROR.
type sourceFailure struct {
	source  contract.Source
	message string
	fatal   bool
}

// collection is the outcome of collectAll before the upload: what to upload,
// which sources to acknowledge, and the failures to report afterwards.
type collection struct {
	snapshots        []contract.Snapshot
	collectedSources []contract.Source
	failures         []sourceFailure
	// codexAcknowledgement is the per-scope file list the Codex hook run
	// uploaded. The TS side attaches it to the snapshots; Go carries it out of
	// band through collect.Options.
	codexAcknowledgement []collect.CursorScopeFiles
}

// collectionFailed mirrors the TS exit contract: a fatal source failure always
// fails the run; a non-fatal one fails it only when the run named that one
// source or the operator set TOKENBOARD_FAIL_ON_SOURCE_ERROR.
func collectionFailed(outcome collection, options Options) bool {
	for _, failure := range outcome.failures {
		if failure.fatal {
			return true
		}
	}
	return len(outcome.failures) > 0 && (options.FailOnSourceErr || options.Source != "all")
}

// formatSourceFailures is the TS formatSourceFailures: source: message,
// semicolon-separated. Antigravity messages are already category redactions.
func formatSourceFailures(failures []sourceFailure) string {
	messages := make([]string, 0, len(failures))
	for _, failure := range failures {
		messages = append(messages, fmt.Sprintf("%s: %s", failure.source, failure.message))
	}
	return strings.Join(messages, "; ")
}

// collectAll gathers snapshots from the registered providers, mirroring the
// TS collectCollectOptionalSource semantics. A concrete --source run aborts on
// any error except a partial result, which still uploads and is reported at
// the end. An all-source run skips a missing local store as unavailable,
// defers real failures until after the upload, and never aborts (except in
// hook mode, where a failure must stop the run). A source with no provider at
// all is not implemented in this client yet: an abort for a concrete run,
// skipped for all.
//
// The returned error is the fail-fast abort.
func collectAll(ctx context.Context, options Options, env Env, stateDir, cursorScope string, stderr io.Writer) (collection, error) {
	sources := expandSources(options.Source, options.HookMode)
	all := options.Source == "all"
	// The TS collectAllSnapshots fails fast for a concrete source (and in hook
	// mode); otherwise it defers every failure to the end of the run.
	failFast := options.HookMode
	// The TS side passes TOKENBOARD_FAIL_ON_SOURCE_ERROR !== '1' for the
	// Antigravity sources, so an absent language server is only "not installed
	// here" while the operator has not asked for a hard failure.
	ignoreLanguageServerUnavailable := env("TOKENBOARD_FAIL_ON_SOURCE_ERROR") != "1"
	outcome := collection{}
	for _, source := range sources {
		provider, ok := collect.Lookup(source)
		if !ok {
			if !all {
				return collection{}, fmt.Errorf("%s is not implemented in this client yet", source)
			}
			fmt.Fprintf(stderr, "Skipping unavailable %s source: not implemented in this client yet\n", source)
			continue
		}
		var codexAcknowledgement []collect.CursorScopeFiles
		collected, err := provider.Collect(ctx, collect.Options{
			Timezone:    options.Timezone,
			Since:       options.Since,
			Until:       options.Until,
			CursorScope: cursorScope,
			StateDir:    stateDir,
			Stderr:      func(line string) { fmt.Fprintln(stderr, line) },
			Env:         env,
			HookAcknowledgement: func(scopes []collect.CursorScopeFiles) {
				codexAcknowledgement = scopes
			},
		})
		if err == nil {
			outcome.snapshots = append(outcome.snapshots, collected...)
			outcome.collectedSources = append(outcome.collectedSources, source)
			if codexAcknowledgement != nil {
				outcome.codexAcknowledgement = codexAcknowledgement
			}
			continue
		}
		message := err.Error()

		// The Antigravity GUI sources can fail after the SQLite history was
		// read: the partial error carries the snapshots, which upload, and its
		// fatal flag decides whether the run still reports a failure. The
		// partial result is handled before every abort path, so even a
		// concrete-source run uploads what it collected.
		if partial, ok := antigravityguiprovider.IsPartialUsageError(err); ok {
			outcome.snapshots = append(outcome.snapshots, partial.Snapshots...)
			outcome.collectedSources = append(outcome.collectedSources, source)
			outcome.failures = append(outcome.failures, sourceFailure{
				source:  source,
				message: sourceFailureMessage(source, "partial", message),
				fatal:   partial.Fatal,
			})
			fmt.Fprintln(stderr, formatAntigravityDiagnostic(source, "partial", message))
			continue
		}

		if all && collect.IsOptionalSourceUnavailableIgnoringLanguageServer(
			source, message, ignoreLanguageServerUnavailable) {
			fmt.Fprintln(stderr, unavailableDiagnostic(source, message))
			continue
		}

		if !all || failFast {
			// The fail-fast abort reports an Antigravity failure by its
			// category: the raw message may carry paths and conversation ids.
			if isAntigravitySource(source) {
				return collection{}, errors.New(formatAntigravityDiagnostic(source, "failed", message))
			}
			return collection{}, err
		}

		outcome.failures = append(outcome.failures, sourceFailure{
			source:  source,
			message: sourceFailureMessage(source, "failed", message),
			// The TS side passes failOnNonUnavailable to the Antigravity and
			// optional sources only; a claude-code/codex failure is recorded
			// non-fatal and reported only when the exit contract says so.
			fatal: source != contract.SourceClaudeCode && source != contract.SourceCodex,
		})
		if isAntigravitySource(source) {
			fmt.Fprintln(stderr, formatAntigravityDiagnostic(source, "failed", message))
			continue
		}
		fmt.Fprintf(stderr, "Skipping %s source: %v\n", source, err)
	}
	return outcome, nil
}

// unavailableDiagnostic is the stderr line for a source skipped as "not
// installed here": Antigravity gets the redacted diagnostic, the rest the raw
// message (their unavailable messages carry paths too, but they are short and
// the TS side prints them as-is).
func unavailableDiagnostic(source contract.Source, message string) string {
	if isAntigravitySource(source) {
		return formatAntigravityDiagnostic(source, "unavailable", message)
	}
	return fmt.Sprintf("Skipping unavailable %s source: %s", source, message)
}

func isAntigravitySource(source contract.Source) bool {
	return strings.HasPrefix(string(source), "antigravity")
}

// formatAntigravityDiagnostic is the TS formatAntigravityDiagnostic: the
// scheduled log is long-lived, so a failure is named by its category rather
// than by its raw message (which can carry paths and conversation ids).
func formatAntigravityDiagnostic(source contract.Source, status string, message string) string {
	return fmt.Sprintf("Antigravity collection: source=%s status=%s category=%s",
		source, status, antigravityErrorCategory(message))
}

// sourceFailureMessage is the TS sourceFailureMessage: what the failure report
// carries for one source — the category for Antigravity, the message for the
// rest.
func sourceFailureMessage(source contract.Source, status string, message string) string {
	if !isAntigravitySource(source) {
		return message
	}
	return fmt.Sprintf("status=%s category=%s", status, antigravityErrorCategory(message))
}

// antigravityErrorCategory is the TS antigravityErrorCategory.
func antigravityErrorCategory(message string) string {
	if strings.Contains(message, "Antigravity SQLite metadata cursor reset detected") &&
		strings.Contains(message, "rerun with --since all") {
		return "sqlite-full-baseline-required"
	}
	if strings.Contains(strings.ToLower(message), "cursor") {
		return "cursor-state-failed"
	}
	if strings.Contains(message, "Antigravity SQLite reader unavailable") {
		return "sqlite-reader-unavailable"
	}
	if strings.Contains(message, "Antigravity CLI requires --since all before a bounded scan can complete an incomplete SQLite directory scan") {
		return "sqlite-full-baseline-required"
	}
	if strings.Contains(message, "Antigravity CLI --since all requires a complete SQLite directory scan") ||
		strings.Contains(message, "Antigravity GUI --since all requires a complete SQLite directory scan") ||
		strings.Contains(message, "Antigravity CLI full history scan could not read every enumerated SQLite database") ||
		strings.Contains(message, "Antigravity GUI full history scan could not read every enumerated SQLite database") {
		return "sqlite-directory-incomplete"
	}
	if strings.Contains(message, "Antigravity conversations directory not found") ||
		strings.Contains(message, "No Antigravity conversations found") {
		return "history-unavailable"
	}
	if isAntigravityMetadataLimitMessage(message) {
		return "metadata-limit-exceeded"
	}
	if isAntigravityInvalidMetadataMessage(message) {
		return "invalid-metadata"
	}
	if strings.Contains(message, "Antigravity language server unavailable after DB history was collected") ||
		antigravitymeta.IsUnavailableLanguageServerError(errors.New(message)) {
		return "language-server-unavailable"
	}
	if strings.Contains(message, "Failed to read Antigravity SQLite metadata") {
		return "sqlite-read-failed"
	}
	if strings.Contains(message, "Failed to read Antigravity metadata") {
		return "metadata-read-failed"
	}
	return "collection-failed"
}

func isAntigravityMetadataLimitMessage(message string) bool {
	return strings.Contains(message, "Antigravity metadata response exceeded the ") ||
		strings.Contains(message, "Antigravity generator metadata response exceeded the ") ||
		strings.Contains(message, "Antigravity language server metadata exceeded the ")
}

func isAntigravityInvalidMetadataMessage(message string) bool {
	return strings.Contains(message, "Invalid Antigravity") ||
		strings.Contains(message, "Antigravity metadata request returned invalid JSON for ")
}

func expandSources(source string, hookMode bool) []contract.Source {
	if source != "all" {
		return []contract.Source{contract.Source(source)}
	}
	if hookMode {
		// Hook mode reads only the two hook-installed sources; the others
		// have no hook cursor and must not be scanned.
		return []contract.Source{contract.SourceClaudeCode, contract.SourceCodex}
	}
	return contract.AllSources()
}

// expandWarmHookSources mirrors the TS expandSources for warm-hooks: every
// concrete source is reported as warmed, including the non-hook sources
// whose warm step is currently a no-op. Only "all" narrows to the two
// hook-installed sources.
func expandWarmHookSources(source string) []string {
	if source == "all" {
		return []string{string(contract.SourceClaudeCode), string(contract.SourceCodex)}
	}
	return []string{source}
}

// cursorScopeFromEndpoint mirrors the TS cursorScopeFromEndpoint: the
// endpoint URL's origin — lowercased host, default port dropped, IPv6 hosts
// kept in brackets, port normalized — or empty when there is no endpoint. An
// endpoint that does not parse is a failure; the TS new URL() throws and
// aborts the run the same way. (The TS side would continue with the literal
// origin "null" for scheme-less or file:// endpoints; refusing is the
// fail-closed equivalent.)
func cursorScopeFromEndpoint(endpoint string) (string, error) {
	if endpoint == "" {
		return "", nil
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("Invalid endpoint URL: %s", endpoint)
	}
	host := strings.ToLower(parsed.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]" // url.Hostname strips IPv6 brackets
	}
	if port := parsed.Port(); port != "" && !isDefaultPort(parsed.Scheme, port) {
		host = host + ":" + port
	}
	return parsed.Scheme + "://" + host, nil
}

// isDefaultPort normalizes before comparing so a leading-zero port
// ("https://h:0443") is recognized as default and dropped, the way the TS
// URL parser canonicalizes it.
func isDefaultPort(scheme, port string) bool {
	normalized, err := strconv.Atoi(port)
	if err != nil {
		return false
	}
	return (scheme == "https" && normalized == 443) || (scheme == "http" && normalized == 80)
}

func requiredSyncConfig(options Options) []string {
	var missing []string
	if options.Endpoint == "" {
		missing = append(missing, "TOKENBOARD_ENDPOINT")
	}
	if options.UploadToken == "" {
		missing = append(missing, "TOKENBOARD_UPLOAD_TOKEN")
	}
	return missing
}

func parseArgs(args []string, env Env) (Options, error) {
	return parseArgsWithLookup(args, env, func(key string) (string, bool) {
		value := env(key)
		return value, value != ""
	})
}

// parseArgsWithLookup resolves the options. A flag value is used as written;
// an environment value is used only when the variable is set, because TS picks
// it with `??` — an exported-but-empty variable is a value, and the validators
// below reject it rather than silently taking the default.
func parseArgsWithLookup(args []string, env Env, lookup lookupFunc) (Options, error) {
	command := args[0]
	switch command {
	case "preview", "sync", "warm-hooks", "shadow":
	default:
		return Options{}, fmt.Errorf("Usage: %s", usageLine())
	}
	// --hook is a boolean for `shadow` only: readFlags requires a value, and
	// `--hook` is written bare. Pull it out first, then parse the rest
	// normally so an unknown or valueless flag is still a usage error.
	shadowHook := false
	rest := args[1:]
	if command == "shadow" {
		kept := make([]string, 0, len(rest))
		for _, arg := range rest {
			switch {
			case arg == "--hook":
				shadowHook = true
			case strings.HasPrefix(arg, "--hook="):
				value := strings.TrimPrefix(arg, "--hook=")
				shadowHook = value == "true" || value == "1"
			default:
				kept = append(kept, arg)
			}
		}
		rest = kept
	}
	flags, err := readFlags(rest)
	if err != nil {
		return Options{}, err
	}
	// flag, then a set environment value, then the default. readFlags never
	// stores an empty value, so a flag that is present is always meaningful;
	// an exported-but-empty TOKENBOARD_SOURCE is still a value TS rejects.
	source := flags["source"]
	if _, given := flags["source"]; !given {
		source = "all"
		if value, ok := lookup("TOKENBOARD_SOURCE"); ok {
			source = value
		}
	}
	if !isValidSource(source) {
		return Options{}, fmt.Errorf("Invalid source: %s", source)
	}
	timezone := flags["timezone"]
	if _, given := flags["timezone"]; !given {
		timezone = localTimezone()
		if value, ok := lookup("TOKENBOARD_TIMEZONE"); ok {
			timezone = value
		}
	}
	if err := assertValidTimezone(timezone); err != nil {
		return Options{}, err
	}
	// TS resolves endpoint and token with `??`: a given flag wins, and an
	// exported-but-empty variable is a value the required-config check then
	// reports missing rather than silently using what the scheduler exported.
	options := Options{
		Command:     command,
		Source:      source,
		Timezone:    strings.TrimSpace(timezone),
		Endpoint:    flagOrEnv(flags, "endpoint", lookup, "TOKENBOARD_ENDPOINT"),
		UploadToken: flagOrEnv(flags, "token", lookup, "TOKENBOARD_UPLOAD_TOKEN"),
		// TS: `flags.since ?? (env.TOKENBOARD_SINCE || env.TOKENBOARD_DEFAULT_SINCE || '')`.
		// The flag wins whenever it was given; the environment chain behind it
		// uses `||`, so empty variables fall through there.
		Since:           flagOrEnvChain(flags, "since", env, "TOKENBOARD_SINCE", "TOKENBOARD_DEFAULT_SINCE"),
		HookMode:        env("TOKENBOARD_HOOK_MODE") == "1",
		FailOnSourceErr: env("TOKENBOARD_FAIL_ON_SOURCE_ERROR") == "1",
		ShadowHook:      shadowHook,
	}
	// TS: `untilFlag ?? (supportsUntil(...) ? env.TOKENBOARD_UNTIL ?? '' : '')`.
	// readFlags rejects an empty --until, so the environment is consulted
	// exactly when the flag is absent.
	options.Until = flags["until"]
	if _, given := flags["until"]; !given && supportsUntil(options) {
		options.Until = env("TOKENBOARD_UNTIL")
	}
	if err := assertSupportedUntil(options); err != nil {
		return Options{}, err
	}
	return options, nil
}

// flagOrEnvChain is the `??` + `||` pair TS uses for --since: the flag wins
// whenever it was given; otherwise the first non-empty variable in the chain
// is used.
func flagOrEnvChain(flags map[string]string, flagName string, env Env, names ...string) string {
	if value, given := flags[flagName]; given {
		return value
	}
	values := make([]string, 0, len(names))
	for _, name := range names {
		values = append(values, env(name))
	}
	return firstNonEmpty(values...)
}

// flagOrEnv resolves a value the way TS does with `??`: the flag wins whenever
// it was given; otherwise a set variable is used.
func flagOrEnv(flags map[string]string, flagName string, lookup lookupFunc, envName string) string {
	if value, given := flags[flagName]; given {
		return value
	}
	value, _ := lookup(envName)
	return value
}

func assertSupportedUntil(options Options) error {
	if options.Until == "" {
		return nil
	}
	if options.Command == "warm-hooks" {
		return fmt.Errorf("--until is not supported for warm-hooks; the command does not collect usage")
	}
	// ShadowHook counts as hook mode here even though the run's own HookMode
	// is still false at parse time: `shadow --hook --until` would otherwise
	// pass validation and only fail later, inside the TypeScript child.
	if options.HookMode || options.ShadowHook {
		return fmt.Errorf("--until is not supported in hook mode; hook sync computes its own incremental window")
	}
	if !supportsUntil(options) {
		return fmt.Errorf("--until is only supported for Claude Code and Codex sources")
	}
	return nil
}

// supportsUntil mirrors the TS predicate. ShadowHook counts as hook mode: a
// `shadow --hook` run computes its own window from the cursors, so an ambient
// TOKENBOARD_UNTIL is ignored rather than collected and rejected.
func supportsUntil(options Options) bool {
	return options.Command != "warm-hooks" && !options.HookMode && !options.ShadowHook &&
		(options.Source == string(contract.SourceClaudeCode) || options.Source == string(contract.SourceCodex))
}

// readFlags mirrors the TS readFlags: non-flag arguments are silently
// ignored, every flag must be followed by a non-empty value, and a flag at the
// end of the line, right before another flag, or followed by "" is a usage
// error ("Missing value for --key") — a bare flag must never fall back to the
// environment default.
//
// The empty check is the TS parser's `if (!value)`: an empty string is not a
// value there, so `--until ""` fails before any `??` resolution runs. Without
// it Go accepted the empty value and each flag's own resolution decided what
// it meant, which is how an explicitly empty flag could still pick up the
// environment.
//
// `--key=value` is a deliberate Go extension the TS parser does not accept;
// it follows the same rule, so a flag value is always non-empty either way.
func readFlags(args []string) (map[string]string, error) {
	flags := map[string]string{}
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if !strings.HasPrefix(arg, "--") {
			continue
		}
		body := strings.TrimPrefix(arg, "--")
		if key, value, found := strings.Cut(body, "="); found {
			if value == "" {
				return nil, fmt.Errorf("Missing value for --%s", key)
			}
			flags[key] = value
			continue
		}
		if index+1 >= len(args) || strings.HasPrefix(args[index+1], "--") || args[index+1] == "" {
			return nil, fmt.Errorf("Missing value for --%s", body)
		}
		flags[body] = args[index+1]
		index++
	}
	return flags, nil
}

func isValidSource(source string) bool {
	return source == "all" || contract.IsValidSource(source)
}

func sourceChoices() []string {
	choices := []string{}
	for _, source := range contract.AllSources() {
		choices = append(choices, string(source))
	}
	return append(choices, "all")
}

// firstNonEmpty is the TS `a || b` chain: only the empty string is false
// there, so a whitespace-only value survives to whatever validates it. The
// self-update call sites trim their inputs first, which matches the skill's
// trimmedString(...) || default; the --since chain passes them through raw.
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// localTimezone mirrors the TS default: the machine's IANA zone (TS reads it
// from Intl, which honors TZ or the system zone). time.Local resolves TZ or
// /etc/localtime the same way but reports the literal "Local" when the zone
// has no name, so the conventional system locations are consulted directly
// before giving up — a silent UTC fallback would shift usageDate and fork the
// server's dedup key against a TS collector on the same machine.
func localTimezone() string {
	if name := strings.TrimSpace(os.Getenv("TZ")); name != "" {
		return name // validated by assertValidTimezone, like the TS path
	}
	if name := time.Local.String(); name != "" && name != "Local" && contract.IsValidTimezone(name) {
		return name
	}
	if name := systemTimezoneName(); name != "" {
		return name
	}
	return "UTC"
}

// systemTimezoneName reads the host zone name from the conventional
// locations: /etc/timezone (Debian and derivatives) and the /etc/localtime
// symlink into a zoneinfo tree (macOS, most Linux). Windows has neither, so
// it falls through to the caller's UTC fallback.
func systemTimezoneName() string {
	if data, err := os.ReadFile("/etc/timezone"); err == nil {
		if name := strings.TrimSpace(string(data)); contract.IsValidTimezone(name) {
			return name
		}
	}
	target, err := os.Readlink("/etc/localtime")
	if err != nil {
		return ""
	}
	if index := strings.LastIndex(target, "zoneinfo/"); index >= 0 {
		if name := target[index+len("zoneinfo/"):]; contract.IsValidTimezone(name) {
			return name
		}
	}
	return ""
}

// assertValidTimezone mirrors timezone.ts: trim, require non-empty, and
// require that the runtime can resolve it.
func assertValidTimezone(value string) error {
	timezone := strings.TrimSpace(value)
	if timezone == "" {
		return fmt.Errorf("Invalid timezone")
	}
	if !contract.IsValidTimezone(timezone) {
		return fmt.Errorf(
			"Invalid timezone: %s. If the zone is spelled correctly, the runtime may lack ICU timezone data; set TOKENBOARD_TIMEZONE explicitly or use a full-icu runtime",
			timezone)
	}
	return nil
}

// runSelfUpdate replaces this binary with the newest published release.
//
// The scheduled path (`--scheduled`) must not fail the run when the update
// cannot be reached: an offline machine is a normal state, and the collector
// keeps working on the version it has. A genuine update failure is reported
// on stderr and still exits 0 for the scheduled path, so the scheduler does
// not retry an upgrade it cannot influence.
func runSelfUpdate(args []string, env Env, stdout, stderr io.Writer) int {
	// --scheduled is a boolean: the scheduler writes it bare
	// (`tokenboard self-update --scheduled`), which the value-requiring flag
	// parser would reject. Pull it out first, then parse the rest normally so
	// an unknown or valueless flag is still a usage error.
	scheduled := false
	rest := make([]string, 0, len(args))
	for _, arg := range args {
		switch {
		case arg == "--scheduled":
			scheduled = true
		case strings.HasPrefix(arg, "--scheduled="):
			value := strings.TrimPrefix(arg, "--scheduled=")
			scheduled = value == "true" || value == "1"
		default:
			rest = append(rest, arg)
		}
	}
	flags, err := readFlags(rest)
	if err != nil {
		fmt.Fprintln(stderr, err.Error())
		return ExitUsage
	}
	// The flag is the operator's intent for this run and wins over the
	// environment, which is the scheduler's channel; the skill spells both the
	// same way (`flags['release-repo'] || env.TOKENBOARD_RELEASE_REPO`). A
	// pinned tag skips the release lookup and installs that version even when
	// it is not the newest, which is what `--tag` has to mean.
	selfupdate.SetCurrentVersion(Version)
	result, err := selfupdate.Run(selfupdate.Input{
		Repo: firstNonEmpty(strings.TrimSpace(flags["repo"]), strings.TrimSpace(env("TOKENBOARD_RELEASE_REPO"))),
		Tag:  firstNonEmpty(strings.TrimSpace(flags["tag"]), strings.TrimSpace(env("TOKENBOARD_RELEASE_TAG"))),
		Env:  env,
		Stderr: func(line string) {
			fmt.Fprintln(stderr, upload.RedactURLs(line))
		},
	})
	if err != nil {
		fmt.Fprintln(stderr, upload.RedactURLs(err.Error()))
		if scheduled {
			return ExitOK
		}
		return ExitFailure
	}
	payload, _ := json.MarshalIndent(map[string]any{
		"version": result.Version,
		"updated": result.Updated,
	}, "", "  ")
	fmt.Fprintln(stdout, string(payload))
	return ExitOK
}

func usageLine() string {
	return fmt.Sprintf("Usage: tokenboard <preview|sync|warm-hooks|shadow|self-update> [--source %s]",
		strings.Join(sourceChoices(), "|"))
}

func versionString() string {
	return "tokenboard (go) " + Version
}

// Version is stamped at build time via -ldflags; "dev" otherwise.
var Version = "dev"

// acknowledgeUploadCursors marks the just-uploaded snapshots as acknowledged
// in each source's cursor, so they stop being re-emitted. Only an upload that
// actually succeeded reaches here: acknowledging a failed run would silently
// drop the usage it carried.
//
// Mirrors the TS shouldAckCursor rule: the Antigravity sources always
// acknowledge (their cursors track session markers), the session-file sources
// only in hook mode (a range-mode run re-reads through ccusage anyway, and
// acknowledging would clear a pending entry a later hook still needs).
func acknowledgeUploadCursors(
	stateDir string,
	outcome collection,
	options Options,
	cursorScope string,
	env Env,
) error {
	hookMode := env("TOKENBOARD_HOOK_MODE") == "1"
	for _, source := range outcome.collectedSources {
		acknowledged := map[string]bool{}
		for _, snapshot := range outcome.snapshots {
			if snapshot.Source != source {
				continue
			}
			acknowledged[snapshot.AckGroupKey()] = true
		}
		if source == contract.SourceCodex {
			if !hookMode {
				continue
			}
			// Codex acknowledges per file per cursor scope: a hook run can
			// upload a partial (date, model) group, so the file revision is
			// the only proof of what reached the server. The scopes come from
			// the same plan the hook runs use, so a profile cursor is never
			// confused with the legacy one.
			if err := acknowledgeCodexCursors(stateDir, outcome.codexAcknowledgement, env); err != nil {
				return fmt.Errorf("%s cursor acknowledgement failed: %w", source, err)
			}
			continue
		}
		if source != contract.SourceAntigravityCLI &&
			source != contract.SourceAntigravity && source != contract.SourceAntigravityIDE {
			if !hookMode {
				continue
			}
			// Only Codex scopes its cursor by profile; the session-file sources
			// write the unscoped `claude-code-cursor.json`, and the TS side
			// passes `undefined` here for exactly that reason. Passing the
			// endpoint origin instead pointed the acknowledgement at a
			// `<base>.server-<hash>.json` file that never exists — and reading
			// a missing cursor is not an error, so the run "succeeded" while
			// no pending entry was ever cleared.
			if err := sessioncursor.AcknowledgePendingUploads(sessioncursor.AcknowledgeInput{
				StateDir:           stateDir,
				Source:             source,
				AcknowledgedGroups: acknowledged,
			}); err != nil {
				return fmt.Errorf("%s cursor acknowledgement failed: %w", source, err)
			}
			continue
		}
		// The three Antigravity sources keep separate cursor key families and
		// separate compaction rules, so each is acknowledged by its own
		// package. The CLI source owns this one; the two GUI sources own theirs.
		var ackErr error
		if source == contract.SourceAntigravityCLI {
			ackErr = antigravityprovider.AcknowledgeSourceCursor(antigravityprovider.AcknowledgeSourceInput{
				StateDir:           stateDir,
				Source:             source,
				CursorScope:        cursorScope,
				AcknowledgedGroups: acknowledged,
				Since:              options.Since,
				Timezone:           options.Timezone,
			})
		} else {
			ackErr = antigravityguiprovider.AcknowledgeSourceCursor(antigravityguiprovider.AcknowledgeSourceInput{
				StateDir:           stateDir,
				Source:             source,
				CursorScope:        cursorScope,
				AcknowledgedGroups: acknowledged,
				Since:              options.Since,
				Timezone:           options.Timezone,
			})
		}
		if ackErr != nil {
			return fmt.Errorf("%s cursor acknowledgement failed: %w", source, ackErr)
		}
	}
	return nil
}

// acknowledgeCodexCursors ports the Codex branch of ackUploadCursors: every
// cursor scope the plan names is acknowledged with the files this run
// uploaded for it. A scope the run uploaded nothing for is still visited, so
// an empty acknowledgement clears nothing rather than skipping the scope.
func acknowledgeCodexCursors(
	stateDir string,
	acknowledgement []collect.CursorScopeFiles,
	env Env,
) error {
	homes, err := codex.ResolveHomes(codex.ResolveHomesInput{
		JSONValue:   env("TOKENBOARD_CODEX_HOMES_JSON"),
		LegacyValue: env("CODEX_HOME"),
	})
	if err != nil {
		return err
	}
	plan, err := codex.ResolveHookCursorPlan(homes, stateDir)
	if err != nil {
		return err
	}
	scopes := []string{""}
	if plan.UsesProfileCursors {
		scopes = append(scopes, plan.CursorScopes...)
	}
	filesByScope := map[string][]sessioncursor.AcknowledgedFile{}
	for _, entry := range acknowledgement {
		filesByScope[entry.CursorScope] = entry.Files
	}
	for _, scope := range scopes {
		files := filesByScope[scope]
		if files == nil {
			files = []sessioncursor.AcknowledgedFile{}
		}
		if err := sessioncursor.AcknowledgePendingUploads(sessioncursor.AcknowledgeInput{
			StateDir:          stateDir,
			Source:            contract.SourceCodex,
			CursorScope:       scope,
			AcknowledgedFiles: files,
		}); err != nil {
			return err
		}
	}
	return nil
}
