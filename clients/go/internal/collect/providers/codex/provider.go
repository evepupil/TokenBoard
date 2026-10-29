// Package codex ports providers/codex.ts: Codex usage comes from ccusage's
// daily and session reports, reconciled against the session files for
// context-priced models, mixed-model sessions, and subagent corrections.
package codex

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/pricing"
	"github.com/MisonL/TokenBoard/clients/go/internal/state"
)

// The collection bounds, mirroring the TS constants.
const (
	DefaultBatchSize = 200
	MaxBatchSize     = 1000

	boundedCodexCollectionAttempts   = 2
	hookCodexCollectionAttempts      = 2
	unboundedCodexCollectionAttempts = 2

	// codexHomeIndexKey tags a session row with the profile it came from.
	codexHomeIndexKey = "__tokenboardCodexHomeIndex"
)

// Options configures one collection. Zero values fall back to the environment
// and the clock, like the TS provider's optional arguments.
type Options struct {
	Timezone    string
	CollectedAt string
	Since       string
	Until       string
	// CodexHomes is the explicit multi-profile list; nil consults the
	// environment.
	CodexHomes []string
	// CodexHome is the legacy single home; nil consults CODEX_HOME.
	CodexHome         *string
	CodexSymlinkRoots []string
	StateDir          string
	HomeDir           string
	Stderr            func(line string)
	Env               func(string) string
	// Runner runs ccusage; nil means ccusage.RunJSON.
	Runner ccusage.CommandRunner
	// ResolveBinary acquires ccusage; nil means ccusage.Resolve.
	ResolveBinary func(ccusage.AcquireOptions) (ccusage.Binary, error)
	// PricingFetcher replaces the catalogue HTTP client; tests use it.
	PricingFetcher func(request *http.Request) (*http.Response, error)
	// HookAcknowledgement receives the per-scope uploaded file list.
	HookAcknowledgement func([]collect.CursorScopeFiles)
	// CorrectSubagentUsage replaces the subagent correction step. The TS suite
	// mocks applyCodexSubagentUsageCorrections to drive the child-session race
	// retries; nil uses the package implementation.
	CorrectSubagentUsage func(SubagentCorrectionInput) ([]contract.Snapshot, error)
}

// Collect gathers Codex usage.
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
	// The rule set is derived from the same catalogue that priced the ccusage
	// config: the static table widened by every unambiguously priced catalogue
	// model, minus the models the user's own config overrides. TS scopes this
	// through AsyncLocalStorage for the whole collect; here the run carries it
	// explicitly. Using the static default instead would leave a model the
	// server newly prices un-repriced, which is exactly the divergence the
	// catalogue exists to avoid.
	//
	// ContextPricingModels is nil when the dynamic config could not be written and
	// ccusage fell back to the bundled or explicit file: that file carries no
	// catalogue prices, so widening the rules from the catalogue anyway would make
	// the two halves of the run disagree. TS rebuilds its rules with an empty model
	// list on the same branch.
	rules := CompileRules(BuildCodexContextPricingRules(
		prepared.ContextPricingModels,
		CodexContextPricingRules,
		pricingStderr,
		prepared.ExplicitOverrideModelIDs,
	))
	collection := providerRun{
		ctx:           ctx,
		runner:        runner,
		packageRunner: packageRunner,
		timezone:      timezone,
		collectedAt:   collectedAt,
		stateDir:      stateDir,
		env:           commandEnv,
		options:       options,
		stderr:        stderr,
		rules:         rules,
	}

	var snapshots []contract.Snapshot
	if hookMode {
		snapshots, err = collection.collectHookUsage()
	} else {
		snapshots, err = collection.collectNonHookUsage()
	}
	if err != nil {
		return nil, err
	}
	reportUnpricedCodexSnapshots(snapshots, prepared.CoveredModelIDs, stderr)
	return snapshots, nil
}

// providerRun is the per-invocation state every collection path shares.
type providerRun struct {
	ctx           context.Context
	runner        ccusage.CommandRunner
	packageRunner ccusage.PackageRunner
	timezone      string
	collectedAt   string
	stateDir      string
	env           func(string) string
	options       Options
	stderr        func(string)
	// rules is the context-pricing rule set for this run: the static table
	// widened by the models the running catalogue prices (and narrowed by the
	// user's explicit overrides), exactly as the TS provider scopes its rules
	// for the lifetime of one collect. Nothing reads DefaultRules directly on
	// this path, so a model the server newly prices is repriced here too.
	rules *Rules
}

// resolveRunner picks the ccusage invocation. Hook mode never downloads: the
// hook path must stay offline, so a machine with no usable binary reports the
// source unavailable instead of fetching a package.
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

func homeDir(options Options) string {
	if options.HomeDir != "" {
		return options.HomeDir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// collectNonHookUsage ports the non-hook branch of collectCodexUsage: an
// all-history or comma-home run uses the frozen scoped scan, a bounded window
// uses the bounded scan, and an unbounded range with no window reads the
// inventory directly.
func (run *providerRun) collectNonHookUsage() ([]contract.Snapshot, error) {
	requestedSince := run.options.Since
	if requestedSince == "" {
		requestedSince = readSince(run.env)
	}
	since := requestedSince
	if isAllDateFilter(since) {
		since = "all"
	}
	until := run.options.Until
	if until == "" {
		until = run.env("TOKENBOARD_UNTIL")
	}
	// Provider-level fallback for callers that do not resolve the window
	// themselves. The CLI always passes a resolved string, so this only fires
	// for a direct Options{} caller. It cannot distinguish "the flag was given
	// empty" from "nothing was configured"; the CLI distinguishes them before
	// it gets here (flagOrEnvChain / the `??` rule in parseArgsWithLookup).
	rangeArgs, err := buildRangeArgs(since, until)
	if err != nil {
		return nil, err
	}
	codexHomes, err := resolveHomesFromOptions(run.options, run.env)
	if err != nil {
		return nil, err
	}
	codexSymlinkRoots, err := resolveSymlinkRootsFromOptions(run.options, run.env)
	if err != nil {
		return nil, err
	}
	requiresCommaSafeScope := since == "" && until == "" && containsCommaHome(codexHomes)
	usesScopedScan := (isAllDateFilter(since) && until == "") || requiresCommaSafeScope
	if usesScopedScan {
		scopedSince := since
		if requiresCommaSafeScope {
			scopedSince = "all"
		}
		return run.collectScopedUsageWithRetry(scopedRunInput{
			rangeArgs:         rangeArgs,
			since:             scopedSince,
			until:             until,
			codexHomes:        codexHomes,
			codexSymlinkRoots: codexSymlinkRoots,
			requireScope:      false,
		})
	}
	if len(rangeArgs) > 0 {
		return run.collectBoundedUsage(boundedRunInput{
			rangeArgs:         rangeArgs,
			since:             since,
			until:             until,
			codexHomes:        codexHomes,
			codexSymlinkRoots: codexSymlinkRoots,
		})
	}
	return run.collectUnboundedUsage(unboundedRunInput{
		rangeArgs:         rangeArgs,
		since:             since,
		until:             until,
		codexHomes:        codexHomes,
		codexSymlinkRoots: codexSymlinkRoots,
	})
}

func containsCommaHome(homes []string) bool {
	for _, home := range homes {
		if strings.Contains(home, ",") {
			return true
		}
	}
	return false
}

// readSince ports readSince.
func readSince(env func(string) string) string {
	if value := env("TOKENBOARD_SINCE"); value != "" {
		return value
	}
	return env("TOKENBOARD_DEFAULT_SINCE")
}

// buildRangeArgs ports buildRangeArgs: the validated compact date window.
// A reversed window is refused with the shared range message
// (iso-calendar-date.ts), not the context-pricing module's own wording.
func buildRangeArgs(since, until string) ([]string, error) {
	normalizedSince, err := normalizeDateFilter(since, "Codex since date")
	if err != nil {
		return nil, err
	}
	normalizedUntil, err := normalizeDateFilter(until, "Codex until date")
	if err != nil {
		return nil, err
	}
	if normalizedSince != "" && normalizedUntil != "" && normalizedSince > normalizedUntil {
		return nil, fmt.Errorf(
			"Invalid Codex since date/Codex until date: since date must not be after until date.")
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

// resolveHomesFromOptions ports resolveCodexHomesFromOptions.
func resolveHomesFromOptions(options Options, env func(string) string) ([]string, error) {
	hasExplicit := options.CodexHomes != nil || options.CodexHome != nil
	input := ResolveHomesInput{ExplicitHomes: options.CodexHomes, HomeDir: options.HomeDir}
	if options.CodexHome != nil {
		input.LegacyValue = *options.CodexHome
	} else if options.CodexHomes == nil {
		input.LegacyValue = env("CODEX_HOME")
	}
	if !hasExplicit {
		input.JSONValue = env("TOKENBOARD_CODEX_HOMES_JSON")
	}
	return ResolveHomes(input)
}

// resolveSymlinkRootsFromOptions ports resolveCodexSymlinkRootsFromOptions.
func resolveSymlinkRootsFromOptions(options Options, env func(string) string) ([]string, error) {
	if options.CodexSymlinkRoots != nil {
		return NormalizeSymlinkRoots(options.CodexSymlinkRoots)
	}
	configured := env("TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON")
	if strings.TrimSpace(configured) == "" {
		return nil, nil
	}
	return ParseSymlinkRootsJSON(configured)
}

// readBatchSize ports readBatchSize. TS uses Number(value), not parseInt, so
// decimals, exponents and 0x/0o/0b prefixes are all accepted; a value that is
// not a number at all falls back, and a fractional one is floored.
func readBatchSize(env func(string) string) int {
	value, ok := contract.ParseNumber(env("TOKENBOARD_CODEX_BATCH_SIZE"))
	if !ok || math.IsNaN(value) || value < 1 {
		return DefaultBatchSize
	}
	if value >= MaxBatchSize {
		return MaxBatchSize
	}
	return int(math.Floor(value))
}

// scopedRunInput is the scoped (frozen-copy) collection input.
type scopedRunInput struct {
	rangeArgs         []string
	since             string
	until             string
	codexHomes        []string
	codexSymlinkRoots []string
	requireScope      bool
}

// collectScopedUsageWithRetry ports collectScopedCodexUsageWithRetry.
func (run *providerRun) collectScopedUsageWithRetry(input scopedRunInput) ([]contract.Snapshot, error) {
	var lastErr error
	for attempt := 0; attempt < boundedCodexCollectionAttempts; attempt++ {
		snapshots, err := run.collectScopedUsage(input)
		if err == nil {
			return snapshots, nil
		}
		lastErr = err
		if attempt+1 < boundedCodexCollectionAttempts && isCodexReconciliationChange(err) {
			run.stderr("Codex context pricing reconciliation changed; retrying the scoped collection once")
			continue
		}
		return nil, err
	}
	return nil, lastErr
}

// collectScopedUsage ports collectScopedCodexUsage.
func (run *providerRun) collectScopedUsage(input scopedRunInput) ([]contract.Snapshot, error) {
	snapshots := []contract.Snapshot{}
	contextPricingUsages := []CodexContextPricingUsage{}
	collectedScopes := 0
	err := CreateCodexSessionScopeBatches(SessionScopeOptions{
		CodexHomes:        input.codexHomes,
		CodexSymlinkRoots: input.codexSymlinkRoots,
		Since:             input.since,
		Until:             input.until,
		BatchSize:         readBatchSize(run.env),
		Env:               run.env,
		HomeDir:           run.options.HomeDir,
		OnMissingSessionFile: func(sessionPath string) {
			run.stderr("Skipping Codex session file that disappeared before copy: " + sessionPath)
		},
		OnCopyFallback:         run.stderr,
		OnProjectionDiagnostic: run.stderr,
	}, func(scope *SessionScope) error {
		collectedScopes++
		defer func() { _ = scope.Cleanup() }()
		batch, err := run.collectScopedBatch(scope, input.rangeArgs, input.since, input.until, input.codexSymlinkRoots)
		if err != nil {
			return err
		}
		snapshots = append(snapshots, batch.snapshots...)
		contextPricingUsages = append(contextPricingUsages, batch.contextPricingUsages...)
		if err := run.warmCanonicalAttributionsFromScope(scope, batch.sessions, nil); err != nil {
			return err
		}
		return assertCodexScopeSourcesUnchanged(scope)
	})
	if err != nil {
		return nil, err
	}
	if input.requireScope && collectedScopes == 0 {
		return nil, fmt.Errorf("Codex bounded collection cannot obtain a frozen local session scope; retry the sync")
	}
	projected, err := ProjectCodexDailyCosts(sessioncursor.MergeSnapshots(snapshots))
	if err != nil {
		return nil, err
	}
	return applyCollectedCodexContextPricing(struct {
		Snapshots   []contract.Snapshot
		Usages      []CodexContextPricingUsage
		Stderr      func(string)
		Timezone    string
		CollectedAt string
		Rules       *Rules
	}{
		Snapshots:   projected,
		Usages:      run.rules.MergeContextPricingUsages(contextPricingUsages),
		Stderr:      run.stderr,
		Timezone:    run.timezone,
		CollectedAt: run.collectedAt,
		Rules:       run.rules,
	})
}

// scopedBatch is one scope's contribution.
type scopedBatch struct {
	snapshots            []contract.Snapshot
	sessions             any
	contextPricingUsages []CodexContextPricingUsage
}

// collectScopedBatch ports collectScopedBatch.
func (run *providerRun) collectScopedBatch(
	scope *SessionScope,
	rangeArgs []string,
	since, until string,
	symlinkRoots []string,
) (scopedBatch, error) {
	scopeEnv := envWith(run.env, "CODEX_HOME", scope.CodexHome)
	args, err := run.runnerArgs(scopeEnv, CommandArgs("daily", rangeArgs, true, run.options.Timezone))
	if err != nil {
		return scopedBatch{}, err
	}
	daily, err := run.runner(run.ctx, run.packageRunner.Command, args,
		PackageCommandOptions(environOf(scopeEnv), ReadDailyTimeoutMs(run.env), run.stderr))
	if err != nil {
		return scopedBatch{}, err
	}
	sessions, err := run.collectSessionCounts(scopeEnv, rangeArgs, true, false)
	if err != nil {
		return scopedBatch{}, err
	}
	snapshots, err := run.normalizeAndCorrect(normalizeInput{
		daily:              daily,
		sessions:           sessions,
		correctionSessions: sessions,
		codexHomes:         scope.CodexHomes,
		codexSymlinkRoots:  symlinkRoots,
		includeSessionOnly: false,
		subagentCacheFiles: cacheFilesForScope(scope),
	})
	if err != nil {
		return scopedBatch{}, err
	}
	usages, err := run.rules.CollectCodexContextPricingUsagesFromFiles(CollectFilesInput{
		FilePaths:             mapKeys(scope.SourceFiles),
		CanonicalModelsByDate: run.rules.ContextPricingModelHints(snapshots),
		CanonicalModelsByFile: canonicalModelsByScopedFileFromSessionRows(sessions, scope, run.timezone),
		Timezone:              run.timezone,
		Since:                 since,
		Until:                 until,
		Stderr:                run.stderr,
	})
	if err != nil {
		return scopedBatch{}, err
	}
	return scopedBatch{snapshots: snapshots, sessions: sessions, contextPricingUsages: usages}, nil
}

// normalizeInput is one daily+session pair to normalize and correct.
type normalizeInput struct {
	daily              any
	sessions           any
	correctionSessions any
	codexHomes         []string
	codexSymlinkRoots  []string
	includeSessionOnly bool
	subagentCacheFiles map[string]CodexSubagentUsageCacheFile
}

// normalizeAndCorrect ports normalizeAndCorrectCodexSnapshots.
func (run *providerRun) normalizeAndCorrect(input normalizeInput) ([]contract.Snapshot, error) {
	snapshots, err := ccusage.NormalizeCcusageDailyJSON(input.daily, ccusage.NormalizeOptions{
		Source:                      contract.SourceCodex,
		Timezone:                    run.timezone,
		CollectedAt:                 run.collectedAt,
		Sessions:                    input.sessions,
		HasSessions:                 true,
		IncludeSessionOnlySnapshots: input.includeSessionOnly,
	})
	if err != nil {
		return nil, err
	}
	correct := run.options.CorrectSubagentUsage
	if correct == nil {
		correct = ApplyCodexSubagentUsageCorrections
	}
	return correct(SubagentCorrectionInput{
		Snapshots:         snapshots,
		Sessions:          input.correctionSessions,
		CodexHomes:        input.codexHomes,
		CodexSymlinkRoots: input.codexSymlinkRoots,
		Timezone:          run.timezone,
		Stderr:            run.stderr,
		StateDir:          run.stateDir,
		CacheFiles:        input.subagentCacheFiles,
	})
}

// collectSessionCounts ports collectSessionCounts: the session report is
// optional on the unbounded path (its failure degrades sessionCount to zero)
// and required wherever a count feeds an attribution.
func (run *providerRun) collectSessionCounts(
	env func(string) string,
	rangeArgs []string,
	singleThread bool,
	required bool,
) (any, error) {
	args, err := run.runnerArgs(env, CommandArgs("session", rangeArgs, singleThread, run.options.Timezone))
	if err != nil {
		if required {
			return nil, err
		}
		run.stderr("Codex daily tokens collected, but session counts are unavailable; continuing with sessionCount=0: " + err.Error())
		return map[string]any{"data": []any{}}, nil
	}
	result, err := run.runner(run.ctx, run.packageRunner.Command, args,
		PackageCommandOptions(environOf(env), ReadSessionTimeoutMs(run.env), run.stderr))
	if err != nil {
		if required {
			return nil, err
		}
		run.stderr("Codex daily tokens collected, but session counts are unavailable; continuing with sessionCount=0: " + err.Error())
		return map[string]any{"data": []any{}}, nil
	}
	return result, nil
}

// boundedRunInput is the bounded-window collection input.
type boundedRunInput struct {
	rangeArgs         []string
	since             string
	until             string
	codexHomes        []string
	codexSymlinkRoots []string
}

// collectBoundedUsage ports collectBoundedCodexUsage.
func (run *providerRun) collectBoundedUsage(input boundedRunInput) ([]contract.Snapshot, error) {
	var lastErr error
	for attempt := 0; attempt < boundedCodexCollectionAttempts; attempt++ {
		snapshots, err := run.collectBoundedUsageAttempt(input)
		if err == nil {
			return snapshots, nil
		}
		lastErr = err
		if attempt+1 < boundedCodexCollectionAttempts && isCodexReconciliationChange(err) {
			run.stderr("Codex canonical attribution changed; retrying the bounded collection once")
			continue
		}
		return nil, err
	}
	return nil, lastErr
}

// collectBoundedUsageAttempt ports collectBoundedCodexUsageAttempt.
func (run *providerRun) collectBoundedUsageAttempt(input boundedRunInput) ([]contract.Snapshot, error) {
	snapshots := []contract.Snapshot{}
	contextPricingUsages := []CodexContextPricingUsage{}
	collectedScopes := 0
	missingSessionFiles := 0
	err := CreateCodexSessionScopeBatches(SessionScopeOptions{
		CodexHomes:        input.codexHomes,
		CodexSymlinkRoots: input.codexSymlinkRoots,
		Since:             input.since,
		Until:             input.until,
		BatchSize:         readBatchSize(run.env),
		Env:               run.env,
		HomeDir:           run.options.HomeDir,
		OnMissingSessionFile: func(sessionPath string) {
			missingSessionFiles++
			run.stderr("Skipping Codex session file that disappeared before bounded copy: " + sessionPath)
		},
		OnCopyFallback:         run.stderr,
		OnProjectionDiagnostic: run.stderr,
	}, func(scope *SessionScope) error {
		collectedScopes++
		defer func() { _ = scope.Cleanup() }()
		cached, err := run.readCachedCanonicalAttributions(scope)
		if err != nil {
			return err
		}
		reportCodexDiagnostics(run.env, run.stderr, fmt.Sprintf(
			"Codex canonical attribution cache: hits=%d misses=%d", len(cached.attributions), len(cached.missingSourceFiles)))
		batch, err := run.collectFrozenBoundedBatch(scope, input, cached)
		if err != nil {
			return err
		}
		snapshots = append(snapshots, batch.snapshots...)
		contextPricingUsages = append(contextPricingUsages, batch.contextPricingUsages...)
		if err := run.warmCanonicalAttributionsFromScope(scope, nil, batch.canonicalAttributions); err != nil {
			return err
		}
		return assertCodexScopeSourcesUnchanged(scope)
	})
	if err != nil {
		return nil, err
	}
	if collectedScopes == 0 && missingSessionFiles > 0 {
		return nil, fmt.Errorf("Codex bounded collection cannot obtain a frozen local session scope; retry the sync")
	}
	projected, err := ProjectCodexDailyCosts(sessioncursor.MergeSnapshots(snapshots))
	if err != nil {
		return nil, err
	}
	return applyCollectedCodexContextPricing(struct {
		Snapshots   []contract.Snapshot
		Usages      []CodexContextPricingUsage
		Stderr      func(string)
		Timezone    string
		CollectedAt string
		Rules       *Rules
	}{
		Snapshots:   projected,
		Usages:      run.rules.MergeContextPricingUsages(contextPricingUsages),
		Stderr:      run.stderr,
		Timezone:    run.timezone,
		CollectedAt: run.collectedAt,
		Rules:       run.rules,
	})
}

// cachedAttributions is what the attribution cache already knows about a
// scope.
type cachedAttributions struct {
	attributions       map[string]CodexSessionAttribution
	missingSourceFiles []string
}

// readCachedCanonicalAttributions ports readCachedCanonicalAttributions.
func (run *providerRun) readCachedCanonicalAttributions(scope *SessionScope) (cachedAttributions, error) {
	sourceFiles := mapKeys(scope.SourceFileFingerprints)
	sort.Strings(sourceFiles)
	if run.stateDir == "" || len(sourceFiles) == 0 {
		return cachedAttributions{attributions: map[string]CodexSessionAttribution{}, missingSourceFiles: sourceFiles}, nil
	}
	attributions := map[string]CodexSessionAttribution{}
	err := WithCodexSessionAttributionCache(AttributionCacheInput{
		StateDir: run.stateDir,
		Timezone: run.timezone,
		Callback: func(cache *CodexSessionAttributionCache) error {
			for _, sourceFile := range sourceFiles {
				if scope.ProjectedSourceFiles[sourceFile] {
					continue
				}
				fingerprint, ok := scope.SourceFileFingerprints[sourceFile]
				if !ok {
					continue
				}
				attribution := cache.LookupByFingerprint(sourceFile, fingerprint)
				if attribution != nil {
					attributions[sourceFile] = *attribution
				}
			}
			return nil
		},
	})
	if err != nil {
		return cachedAttributions{}, err
	}
	missing := []string{}
	for _, sourceFile := range sourceFiles {
		if _, ok := attributions[sourceFile]; !ok {
			missing = append(missing, sourceFile)
		}
	}
	return cachedAttributions{attributions: attributions, missingSourceFiles: missing}, nil
}

// frozenBoundedBatch is one bounded scope's contribution.
type frozenBoundedBatch struct {
	snapshots             []contract.Snapshot
	contextPricingUsages  []CodexContextPricingUsage
	canonicalAttributions map[string]CodexSessionAttribution
}

// collectFrozenBoundedBatch ports collectFrozenBoundedCodexBatch.
func (run *providerRun) collectFrozenBoundedBatch(
	scope *SessionScope,
	input boundedRunInput,
	cached cachedAttributions,
) (frozenBoundedBatch, error) {
	scopeEnv := envWith(run.env, "CODEX_HOME", scope.CodexHome)
	args, err := run.runnerArgs(scopeEnv, CommandArgs("daily", input.rangeArgs, true, run.options.Timezone))
	if err != nil {
		return frozenBoundedBatch{}, err
	}
	daily, err := run.runner(run.ctx, run.packageRunner.Command, args,
		PackageCommandOptions(environOf(scopeEnv), ReadDailyTimeoutMs(run.env), run.stderr))
	if err != nil {
		return frozenBoundedBatch{}, err
	}
	var boundedSessions any
	if hasDuplicateScopedSessionRelativePaths(scope) {
		boundedSessions, err = run.collectScopedSessionCountsByHome(scope, input.rangeArgs)
	} else {
		boundedSessions, err = run.collectSessionCounts(scopeEnv, input.rangeArgs, true, true)
	}
	if err != nil {
		return frozenBoundedBatch{}, err
	}
	canonical, err := run.collectCanonicalAttributionsForMissingFiles(scope, cached.missingSourceFiles, input.codexSymlinkRoots)
	if err != nil {
		return frozenBoundedBatch{}, err
	}
	combined := map[string]CodexSessionAttribution{}
	for key, value := range cached.attributions {
		combined[key] = value
	}
	for key, value := range canonical {
		combined[key] = value
	}
	sessions, err := replaceScopedSessionAttributions(replaceInput{
		boundedSessions:       boundedSessions,
		canonicalAttributions: combined,
		scope:                 scope,
		since:                 input.since,
		until:                 input.until,
	})
	if err != nil {
		return frozenBoundedBatch{}, err
	}
	snapshots, err := run.normalizeAndCorrect(normalizeInput{
		daily:              daily,
		sessions:           sessions,
		correctionSessions: boundedSessions,
		codexHomes:         scope.CodexHomes,
		codexSymlinkRoots:  input.codexSymlinkRoots,
		includeSessionOnly: true,
		subagentCacheFiles: cacheFilesForScope(scope),
	})
	if err != nil {
		return frozenBoundedBatch{}, err
	}
	usages, err := run.rules.CollectCodexContextPricingUsagesFromFiles(CollectFilesInput{
		FilePaths:             mapKeys(scope.SourceFiles),
		CanonicalModelsByDate: run.rules.ContextPricingModelHints(snapshots),
		CanonicalModelsByFile: canonicalModelsByScopedFile(scope, combined),
		Timezone:              run.timezone,
		Since:                 input.since,
		Until:                 input.until,
		Stderr:                run.stderr,
	})
	if err != nil {
		return frozenBoundedBatch{}, err
	}
	return frozenBoundedBatch{
		snapshots:             snapshots,
		contextPricingUsages:  usages,
		canonicalAttributions: canonical,
	}, nil
}

// collectScopedSessionCountsByHome ports collectScopedSessionCountsByHome.
func (run *providerRun) collectScopedSessionCountsByHome(scope *SessionScope, rangeArgs []string) (any, error) {
	rows := []any{}
	for _, homeIndex := range scopedSessionHomeIndexes(scope) {
		homeEnv := envWith(run.env, "CODEX_HOME", scope.CodexHomes[homeIndex])
		sessions, err := run.collectSessionCounts(homeEnv, rangeArgs, true, true)
		if err != nil {
			return nil, err
		}
		for _, row := range ccusage.SessionRows(sessions) {
			rows = append(rows, tagSessionRow(row, homeIndex))
		}
	}
	return map[string]any{"sessions": rows}, nil
}

// collectCanonicalAttributionsForMissingFiles ports
// collectCanonicalAttributionsForMissingFiles.
func (run *providerRun) collectCanonicalAttributionsForMissingFiles(
	scope *SessionScope,
	sourceFiles []string,
	symlinkRoots []string,
) (map[string]CodexSessionAttribution, error) {
	attributions := map[string]CodexSessionAttribution{}
	if len(sourceFiles) == 0 {
		return attributions, nil
	}
	frozenFileToSourceFile := map[string]string{}
	groups := make([]SessionScopeFileGroup, 0, len(sourceFiles))
	for _, sourceFile := range sourceFiles {
		homeIndex, ok := scope.SourceFileHomeIndexes[sourceFile]
		if !ok {
			return nil, fmt.Errorf("Codex canonical attribution lost its source profile mapping")
		}
		codexHome := scope.CodexHomes[homeIndex]
		frozenFile, ok := scopedFileForSourceFile(sourceFile, scope.SourceFiles)
		if !ok || codexHome == "" {
			return nil, fmt.Errorf("Codex canonical attribution lost its source profile mapping")
		}
		frozenFileToSourceFile[frozenFile] = sourceFile
		groups = append(groups, SessionScopeFileGroup{
			Files: []SessionScopeFile{{CodexHome: codexHome, FilePath: frozenFile}},
		})
	}
	reportCodexDiagnostics(run.env, run.stderr, fmt.Sprintf(
		"Codex canonical attribution scan: files=%d", len(sourceFiles)))
	if len(sourceFiles) == len(scope.SourceFileFingerprints) {
		return run.collectCanonicalAttributionsFromScope(scope, symlinkRoots)
	}
	err := CreateCodexSessionScopeBatchesForFiles(SessionScopeFilesInput{
		Options: SessionScopeOptions{
			CodexHomes:        scope.CodexHomes,
			CodexSymlinkRoots: symlinkRoots,
			BatchSize:         readBatchSize(run.env),
			Env:               run.env,
			HomeDir:           run.options.HomeDir,
			OnMissingSessionFile: func(sessionPath string) {
				run.stderr("Skipping Codex session file that disappeared before canonical attribution: " + sessionPath)
			},
			OnCopyFallback:         run.stderr,
			OnProjectionDiagnostic: run.stderr,
		},
		Groups: groups,
	}, func(frozenScope *SessionScope) error {
		defer func() { _ = frozenScope.Cleanup() }()
		scoped, err := run.collectCanonicalAttributionsFromScope(frozenScope, symlinkRoots)
		if err != nil {
			return err
		}
		if err := assertCodexScopeSourcesUnchanged(frozenScope); err != nil {
			return err
		}
		for frozenFile, attribution := range scoped {
			sourceFile, ok := frozenFileToSourceFile[frozenFile]
			if !ok {
				return fmt.Errorf("Codex canonical attribution lost its frozen source-file mapping")
			}
			attributions[sourceFile] = attribution
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return attributions, nil
}

// collectCanonicalAttributionsFromScope ports
// collectCanonicalAttributionsFromScope.
func (run *providerRun) collectCanonicalAttributionsFromScope(
	scope *SessionScope,
	symlinkRoots []string,
) (map[string]CodexSessionAttribution, error) {
	attributions := map[string]CodexSessionAttribution{}
	activeHomeIndexes := scopedSessionHomeIndexes(scope)
	var homeIndexes []int
	if hasDuplicateScopedSessionRelativePaths(scope) || len(activeHomeIndexes) < len(scope.CodexHomes) {
		homeIndexes = activeHomeIndexes
	} else {
		homeIndexes = []int{-1}
	}
	for _, homeIndex := range homeIndexes {
		codexHome := scope.CodexHome
		if homeIndex >= 0 {
			codexHome = scope.CodexHomes[homeIndex]
		}
		homeEnv := envWith(run.env, "CODEX_HOME", codexHome)
		sessions, err := run.collectSessionCounts(homeEnv, nil, true, true)
		if err != nil {
			return nil, err
		}
		for _, row := range ccusage.SessionRows(sessions) {
			sourceFile, ok := resolveScopedSessionSourceFile(row, scope, homeIndex)
			if !ok {
				continue
			}
			attribution, found, err := ccusage.ReadCcusageSessionAttribution(row, run.timezone, contract.SourceCodex)
			if err != nil {
				return nil, err
			}
			if found {
				attributions[sourceFile] = CodexSessionAttribution{UsageDate: attribution.UsageDate, Model: attribution.Model}
			}
		}
	}
	return attributions, nil
}

// warmCanonicalAttributionsFromScope ports
// warmCanonicalAttributionsFromScope.
func (run *providerRun) warmCanonicalAttributionsFromScope(
	scope *SessionScope,
	sessions any,
	attributions map[string]CodexSessionAttribution,
) error {
	if run.stateDir == "" {
		return nil
	}
	warm := map[string]CodexSessionAttribution{}
	for key, value := range attributions {
		warm[key] = value
	}
	if attributions == nil {
		for _, row := range ccusage.SessionRows(sessions) {
			sourceFile, ok := resolveScopedSessionSourceFile(row, scope, -1)
			if !ok {
				continue
			}
			attribution, found, err := ccusage.ReadCcusageSessionAttribution(row, run.timezone, contract.SourceCodex)
			if err != nil {
				return err
			}
			if found {
				warm[sourceFile] = CodexSessionAttribution{UsageDate: attribution.UsageDate, Model: attribution.Model}
			}
		}
	}
	if len(warm) == 0 {
		return nil
	}
	return WithCodexSessionAttributionCache(AttributionCacheInput{
		StateDir: run.stateDir,
		Timezone: run.timezone,
		Callback: func(cache *CodexSessionAttributionCache) error {
			for sourceFile, attribution := range warm {
				scopedFile, ok := scopedFileForSourceFile(sourceFile, scope.SourceFiles)
				if !ok {
					return fmt.Errorf("Codex scoped session attribution lost its source-file mapping")
				}
				expected, ok := scope.SourceFileFingerprints[sourceFile]
				if !ok {
					return fmt.Errorf("Codex scoped session attribution lost its source-file fingerprint")
				}
				if scope.ProjectedSourceFiles[sourceFile] {
					prefix, ok := scope.ProjectedSourceFilePrefixes[sourceFile]
					if !ok {
						return fmt.Errorf("Codex projected session scope lost its source-file prefix fingerprint")
					}
					current, err := fingerprintProjectedSourceFile(sourceFile, prefix)
					if err != nil {
						return err
					}
					if current.CapturedSize < prefix.CapturedSize ||
						!SameCodexSessionFilePrefixFingerprint(current, prefix) {
						return fmt.Errorf("Codex session changed during scoped collection; retry the sync")
					}
					continue
				}
				copied, err := FingerprintCodexSessionFile(scopedFile)
				if err != nil {
					return err
				}
				if copied.Size != expected.Size || copied.TailSHA256 != expected.TailSHA256 {
					return fmt.Errorf("Codex scoped session attribution changed unexpectedly")
				}
				stored, err := cache.StoreIfUnchanged(sourceFile, expected, attribution)
				if err != nil {
					return err
				}
				if !stored {
					run.stderr("Skipping stale Codex canonical attribution cache write for a session that changed after copy")
				}
			}
			return nil
		},
	})
}

// unboundedRunInput is the inventory-driven collection input.
type unboundedRunInput struct {
	rangeArgs         []string
	since             string
	until             string
	codexHomes        []string
	codexSymlinkRoots []string
}

// collectUnboundedUsage ports collectCodexCcusageRange.
func (run *providerRun) collectUnboundedUsage(input unboundedRunInput) ([]contract.Snapshot, error) {
	var lastErr error
	for attempt := 0; attempt < unboundedCodexCollectionAttempts; attempt++ {
		snapshots, err := run.collectUnboundedUsageAttempt(input)
		if err == nil {
			return snapshots, nil
		}
		lastErr = err
		if attempt+1 < unboundedCodexCollectionAttempts && isCodexReconciliationChange(err) {
			run.stderr("Codex session files changed during unbounded collection; retrying once")
			continue
		}
		return nil, err
	}
	return nil, lastErr
}

// collectUnboundedUsageAttempt ports collectCodexCcusageRangeAttempt.
func (run *providerRun) collectUnboundedUsageAttempt(input unboundedRunInput) ([]contract.Snapshot, error) {
	memo := CreateCodexSessionFingerprintMemo()
	discover := func() (CodexContextPricingFileInventory, error) {
		return run.rules.DiscoverCodexContextPricingFiles(DiscoverInput{
			CodexHomes:          input.codexHomes,
			CodexSymlinkRoots:   input.codexSymlinkRoots,
			CaptureFingerprints: true,
			AllowFileOverflow:   true,
			FingerprintMemo:     memo,
		})
	}
	inventory, inventoryErr := discover()
	if inventoryErr != nil && !isRejectedSessionRootSymlink(inventoryErr) {
		return nil, inventoryErr
	}

	collectionEnv := envWith(run.env, "CODEX_HOME", strings.Join(input.codexHomes, ","))
	args, err := run.runnerArgs(collectionEnv, CommandArgs("daily", input.rangeArgs, false, run.options.Timezone))
	if err != nil {
		return nil, err
	}
	daily, err := run.runner(run.ctx, run.packageRunner.Command, args,
		PackageCommandOptions(environOf(collectionEnv), ReadDailyTimeoutMs(run.env), run.stderr))
	if err != nil {
		return nil, err
	}
	sessions, err := run.collectSessionCounts(collectionEnv, input.rangeArgs, false, false)
	if err != nil {
		return nil, err
	}
	normalized, err := run.normalizeAndCorrect(normalizeInput{
		daily:              daily,
		sessions:           sessions,
		correctionSessions: sessions,
		codexHomes:         input.codexHomes,
		codexSymlinkRoots:  input.codexSymlinkRoots,
		includeSessionOnly: false,
	})
	if err != nil {
		return nil, err
	}
	projected, err := ProjectCodexDailyCosts(normalized)
	if err != nil {
		return nil, err
	}
	needsPricing := func() bool {
		for _, snapshot := range projected {
			if run.rules.IsCodexContextPricingModel(snapshot.Model) && snapshot.TotalTokens > 0 {
				return true
			}
		}
		return false
	}
	if inventoryErr != nil {
		if !needsPricing() {
			return projected, nil
		}
		return nil, inventoryErr
	}
	if inventory.Overflow {
		if !needsPricing() {
			return projected, nil
		}
		return nil, fmt.Errorf("Codex context pricing scan exceeds %d session files", MaxCodexContextPricingFiles)
	}
	canonicalSessions := sessions
	if hasDuplicateCodexInventoryPaths(input.codexHomes, inventory) {
		canonicalSessions, err = run.collectCanonicalSessionRowsByHome(input.codexHomes)
		if err != nil {
			return nil, err
		}
	}
	after, err := discover()
	if err != nil {
		return nil, err
	}
	if err := assertCodexContextPricingInventoryStable(inventory, after); err != nil {
		return nil, err
	}
	usages, err := run.rules.CollectCodexContextPricingUsagesFromFiles(CollectFilesInput{
		FilePaths:             inventory.FilePaths,
		IdentityPaths:         inventory.IdentityPaths,
		CanonicalModelsByDate: run.rules.ContextPricingModelHints(projected),
		CanonicalModelsByFile: canonicalModelsByInventoryFiles(
			canonicalSessions, input.codexHomes, inventory, run.timezone),
		Timezone: run.timezone,
		Since:    input.since,
		Until:    input.until,
		Stderr:   run.stderr,
	})
	if err != nil {
		return nil, err
	}
	after, err = discover()
	if err != nil {
		return nil, err
	}
	if err := assertCodexContextPricingInventoryStable(inventory, after); err != nil {
		return nil, err
	}
	return applyCollectedCodexContextPricing(struct {
		Snapshots   []contract.Snapshot
		Usages      []CodexContextPricingUsage
		Stderr      func(string)
		Timezone    string
		CollectedAt string
		Rules       *Rules
	}{
		Snapshots:   projected,
		Usages:      usages,
		Stderr:      run.stderr,
		Timezone:    run.timezone,
		CollectedAt: run.collectedAt,
		Rules:       run.rules,
	})
}

// collectCanonicalSessionRowsByHome ports collectCanonicalSessionRowsByHome.
func (run *providerRun) collectCanonicalSessionRowsByHome(codexHomes []string) (any, error) {
	rows := []any{}
	for homeIndex, codexHome := range codexHomes {
		homeEnv := envWith(run.env, "CODEX_HOME", codexHome)
		sessions, err := run.collectSessionCounts(homeEnv, nil, false, true)
		if err != nil {
			return nil, err
		}
		for _, row := range ccusage.SessionRows(sessions) {
			rows = append(rows, tagSessionRow(row, homeIndex))
		}
	}
	return map[string]any{"sessions": rows}, nil
}

// hookDateBounds ports hookDateBounds.
func hookDateBounds(dates []string) (string, string, error) {
	if len(dates) == 0 {
		return "", "", fmt.Errorf("Codex hook reconciliation is missing changed usage dates")
	}
	return strings.ReplaceAll(dates[0], "-", ""), strings.ReplaceAll(dates[len(dates)-1], "-", ""), nil
}

func reportCodexDiagnostics(env func(string) string, stderr func(string), line string) {
	if env("TOKENBOARD_COLLECTOR_DIAGNOSTICS") == "1" {
		emitStderr(stderr, line)
	}
}

func mapKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// envWith returns env with one key overridden.
func envWith(env func(string) string, key, value string) func(string) string {
	return func(name string) string {
		if name == key {
			return value
		}
		return env(name)
	}
}

// runnerArgs splices the provider arguments into the runner and appends the
// ccusage config pair. The TS side does the same inside its runPackageArgs, so
// every codex call carries `--config`; omitting it makes ccusage fall back to
// its own price table and every cost diverges.
func (run *providerRun) runnerArgs(env func(string) string, packageArgs []string) ([]string, error) {
	return run.packageRunner.Args(packageArgs, env, nil)
}

// codexCommandEnvKeys are the variables the provider overrides for a ccusage
// run. The TS side passes `{ ...process.env, CODEX_HOME }`, so everything else
// the child needs (PATH for the npx shim, HOME, TMPDIR) is inherited.
var codexCommandEnvKeys = []string{
	"CODEX_HOME", "TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG", "TOKENBOARD_CCUSAGE_CONFIG",
	"TOKENBOARD_PACKAGE_MANAGER", "TOKENBOARD_STATE_DIR", "TOKENBOARD_ENDPOINT",
}

// environOf materializes the child environment for a ccusage run: the process
// environment with the provider's overrides applied last, so a frozen
// CODEX_HOME always wins over the inherited one. Passing only the overrides
// strips PATH, and the package runner's npx shim then cannot find node.
func environOf(env func(string) string) []string {
	overrides := make(map[string]string, len(codexCommandEnvKeys))
	for _, key := range codexCommandEnvKeys {
		overrides[key] = env(key)
	}
	inherited := os.Environ()
	out := make([]string, 0, len(inherited)+len(overrides))
	for _, entry := range inherited {
		name, _, _ := strings.Cut(entry, "=")
		if _, overridden := overrides[name]; overridden {
			continue
		}
		out = append(out, entry)
	}
	for _, key := range codexCommandEnvKeys {
		if value := overrides[key]; value != "" {
			out = append(out, key+"="+value)
		}
	}
	return out
}

// filepathIsInside reports whether child is inside parent. It mirrors the TS
// isPathInside used by the session-row resolver.
func filepathIsInside(parent, child string) bool {
	relative, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return !filepath.IsAbs(relative) && relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
