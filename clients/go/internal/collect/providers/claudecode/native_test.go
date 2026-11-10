package claudecode

// Tests for the native adapter seam (Task 7):
//
//   - the switch stays off, and while it is off Collect runs ccusage exactly
//     as before;
//   - the native provider is registered unconditionally, so a parity harness
//     can reach it without flipping the switch;
//   - nativeCollect resolves roots by the four-branch rule, prepares pricing
//     the same way the ccusage path does but never spawns anything, normalizes
//     the two reports through the same pipeline, and returns every error as-is;
//   - hook mode runs the incremental scan reconciled against an in-process
//     recompute of the reported window, with no subprocess and no network (the
//     detailed hook cases live in hook_native_test.go).
//
// The end-to-end test drives the committed fixture tree (the same one Task 6's
// goldens were minted from) and compares the native snapshots with the frozen
// ccusage reports pushed through the normalizer directly.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	ccacq "github.com/MisonL/TokenBoard/clients/go/internal/ccusage/acquire"
	ccexec "github.com/MisonL/TokenBoard/clients/go/internal/ccusage/exec"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/pricing"
)

// nativeGoldenReports is the same committed ccusage 20.0.33 output the claude
// adapter's golden tests embed. It is read from the adapter's package
// directory rather than embedded a second time, so the binary carries one copy
// and the two tests can never drift onto different revisions of the file.
var nativeGoldenReports = filepath.Join(
	"..", "..", "adapters", "claude", "goldens", "claude-reports.json")

// nativeGoldenDocument is the part of the golden file this test consumes.
type nativeGoldenDocument struct {
	Daily struct {
		Auto json.RawMessage `json:"auto"`
	} `json:"daily"`
	Sessions json.RawMessage `json:"sessions"`
}

// nativeCollectedAt pins the snapshot timestamp so the comparison is exact.
const nativeCollectedAt = "2026-11-05T00:00:00.000Z"

// loadNativeGoldens reads the golden file from the adapter package.
func loadNativeGoldens(t *testing.T) nativeGoldenDocument {
	t.Helper()
	content, err := os.ReadFile(nativeGoldenReports)
	if err != nil {
		t.Fatalf("read %s: %v", nativeGoldenReports, err)
	}
	var document nativeGoldenDocument
	if err := json.Unmarshal(content, &document); err != nil {
		t.Fatalf("decode %s: %v", nativeGoldenReports, err)
	}
	if len(document.Daily.Auto) == 0 || len(document.Sessions) == 0 {
		t.Fatalf("%s carries no daily.auto or sessions report", nativeGoldenReports)
	}
	return document
}

// fixtureTree is the committed Claude fixture, as an absolute path.
func fixtureTree(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", "adapters", "claude", "testdata", "claude-fixture"))
	if err != nil {
		t.Fatalf("resolve the fixture root: %v", err)
	}
	return root
}

// nativeTestOptions builds the provider options the native tests share: no
// endpoint (static pricing), a private state dir and an injected environment.
// The fetcher fails the test: without an endpoint the catalogue never leaves the
// static file, so any request means the code took a network path it should not
// have.
func nativeTestOptions(t *testing.T) Options {
	t.Helper()
	return Options{
		Timezone:       "UTC",
		CollectedAt:    nativeCollectedAt,
		StateDir:       t.TempDir(),
		PricingFetcher: failingFetcher(t),
	}
}

// failingFetcher fails the test on any catalogue request.
func failingFetcher(t *testing.T) func(*http.Request) (*http.Response, error) {
	t.Helper()
	return func(request *http.Request) (*http.Response, error) {
		t.Errorf("unexpected catalogue request to %s; this path must not fetch", request.URL)
		return nil, errors.New("network access is not expected in this test")
	}
}

// countingFetcher counts catalogue requests and answers with an empty
// catalogue page, so a path that does fetch completes instead of hanging.
type countingFetcher struct {
	calls int
}

func (f *countingFetcher) fetch(request *http.Request) (*http.Response, error) {
	f.calls++
	body := `{"models":[],"nextCursor":null}`
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{},
	}, nil
}

// TestRegisterNativeAlwaysInstallsTheNativeProvider pins that the native
// provider is registered from the package's init(), whatever the switch says.
// The parity harness looks it up by source and must never borrow the
// ccusage-backed provider instead: that would compare ccusage with itself.
func TestRegisterNativeAlwaysInstallsTheNativeProvider(t *testing.T) {
	provider, ok := collect.LookupNative(contract.SourceClaudeCode)
	if !ok || provider == nil {
		t.Fatalf("collect.LookupNative(%q) = (%v, %v), want the native provider", contract.SourceClaudeCode, provider, ok)
	}
	ccusageProvider, ok := collect.Lookup(contract.SourceClaudeCode)
	if !ok {
		t.Fatalf("collect.Lookup(%q) has no provider", contract.SourceClaudeCode)
	}
	if reflect.TypeOf(provider) != reflect.TypeOf(nativeProvider{}) {
		t.Fatalf("native provider is %T, want %T", provider, nativeProvider{})
	}
	if reflect.TypeOf(provider) == reflect.TypeOf(ccusageProvider) {
		t.Fatalf("native and ccusage providers share type %T; the parity side must be a distinct implementation",
			reflect.TypeOf(provider))
	}
}

// TestSwitchSelectsTheNativePath pins both halves of the switch: the constant
// is true (S5, 2026-11-10), and asking for the ccusage path by name really
// runs ccusage (a stub runner sees the daily and session invocations).
func TestSwitchSelectsTheNativePath(t *testing.T) {
	if !useNativeClaude {
		t.Fatal("useNativeClaude is false; the native path regressed to ccusage")
	}
	stateDir := newStateDir(t)
	runner := &stubRunner{responses: dailyAndSession("claude-sonnet-4-5", 1, 2)}
	snapshots, err := Collect(context.Background(), Options{
		Timezone:    "UTC",
		CollectedAt: nativeCollectedAt,
		StateDir:    stateDir,
		Env:         testEnv(forceRunnerEnv(nil)),
		Runner:      runner.run,
		ccusagePath: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 2 || !contains(runner.calls[0], "daily") || !contains(runner.calls[1], "session") {
		t.Fatalf("calls = %v, want a daily and a session ccusage invocation", runner.calls)
	}
	if len(snapshots) != 1 || snapshots[0].Model != "claude-sonnet-4-5" {
		t.Fatalf("snapshots = %+v", snapshots)
	}
}

// TestNativeNeverFallsBackToCcusage pins that a native failure is returned
// as-is. A fallback would turn a parity comparison into "ccusage against
// ccusage" and pass silently.
func TestNativeNeverFallsBackToCcusage(t *testing.T) {
	options := nativeTestOptions(t)
	options.Env = testEnv(map[string]string{"CLAUDE_CONFIG_DIR": filepath.Join(t.TempDir(), "does-not-exist")})
	options.Runner = func(context.Context, string, []string, ccexec.CommandOptions) (any, error) {
		t.Error("native failure must not fall back to ccusage")
		return nil, errors.New("ccusage must not run")
	}
	options.ResolveBinary = func(ccacq.AcquireOptions) (ccacq.Binary, error) {
		t.Error("native failure must not resolve a ccusage binary")
		return ccacq.Binary{}, errors.New("ccusage must not run")
	}
	_, err := nativeCollect(context.Background(), nativeInput{
		options:     options,
		env:         options.Env,
		timezone:    options.Timezone,
		collectedAt: options.CollectedAt,
	})
	if err == nil {
		t.Fatal("a CLAUDE_CONFIG_DIR that names no config directory must fail")
	}
	if !strings.Contains(err.Error(), "No valid Claude data directories found in CLAUDE_CONFIG_DIR") {
		t.Fatalf("err = %v, want the ResolveRoots error verbatim", err)
	}
}

// TestNativePricingPrepareErrorIsReturned pins the second failure the native
// path must not swallow: a broken pricing configuration.
func TestNativePricingPrepareErrorIsReturned(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "absent-pricing.json")
	options := nativeTestOptions(t)
	options.Env = testEnv(map[string]string{
		"CLAUDE_CONFIG_DIR":         fixtureTree(t),
		"TOKENBOARD_CCUSAGE_CONFIG": missing,
	})
	_, err := nativeCollect(context.Background(), nativeInput{
		options:     options,
		env:         options.Env,
		timezone:    options.Timezone,
		collectedAt: options.CollectedAt,
	})
	if err == nil {
		t.Fatal("a missing explicit pricing config must fail closed")
	}
	if !strings.Contains(err.Error(), "absent-pricing.json") {
		t.Fatalf("err = %v, want the explicit config path in it", err)
	}
}

// TestNativeCollectPropagatesOverridesAndFailsClosedOnBadConfig pins the
// pricing hand-off at the Prepare boundary:
//
//   - the explicit config reaches pricing.Prepare and is merged into the config
//     file this path writes (the merged file is observable in the state dir), so
//     the input set matches the ccusage path's;
//   - a config that does not parse fails the collection instead of being
//     ignored.
//
// The priced amount is asserted separately, by
// TestNativeExplicitPricingConfigPricesInProcess: since MergedPricingOverrides
// is what prices this path, an explicit rate IS what the native pass bills, and
// that test pins the number.
func TestNativeCollectPropagatesOverridesAndFailsClosedOnBadConfig(t *testing.T) {
	root := t.TempDir()
	claudeHome := filepath.Join(root, "claude")
	writeNativeSession(t, claudeHome,
		`{"type":"assistant","timestamp":"2026-03-02T10:00:00.000Z",`+
			`"message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":100,"output_tokens":1}}}`)

	goodConfig := filepath.Join(root, "good-pricing.json")
	if err := os.WriteFile(goodConfig, []byte(`{
		"defaults": {"pricingOverrides": {"claude-test-only-model": {"inputCostPerToken": 0.001}}}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	stateDir := t.TempDir()
	if _, err := nativeCollect(context.Background(), nativeInput{
		options: Options{
			Timezone:       "UTC",
			CollectedAt:    nativeCollectedAt,
			StateDir:       stateDir,
			PricingFetcher: failingFetcher(t),
		},
		env: testEnv(forceRunnerEnv(map[string]string{
			"CLAUDE_CONFIG_DIR":         claudeHome,
			"TOKENBOARD_CCUSAGE_CONFIG": goodConfig,
		})),
		timezone:    "UTC",
		collectedAt: nativeCollectedAt,
	}); err != nil {
		t.Fatal(err)
	}
	merged, err := os.ReadFile(filepath.Join(stateDir, pricing.DynamicConfigFileName))
	if err != nil {
		t.Fatalf("read the merged pricing config: %v", err)
	}
	if !strings.Contains(string(merged), "claude-test-only-model") {
		t.Fatalf("the merged config does not carry the explicit override:\n%s", merged)
	}

	badConfig := filepath.Join(root, "bad-pricing.json")
	if err := os.WriteFile(badConfig, []byte(`{"defaults": {"pricingOverrides": {`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = nativeCollect(context.Background(), nativeInput{
		options: Options{Timezone: "UTC", CollectedAt: nativeCollectedAt, StateDir: t.TempDir()},
		env: testEnv(forceRunnerEnv(map[string]string{
			"CLAUDE_CONFIG_DIR":         claudeHome,
			"TOKENBOARD_CCUSAGE_CONFIG": badConfig,
		})),
		timezone:    "UTC",
		collectedAt: nativeCollectedAt,
	})
	if err == nil {
		t.Fatal("a pricing config that does not parse must fail the collection")
	}
	if !strings.Contains(err.Error(), "bad-pricing.json") {
		t.Fatalf("err = %v, want the explicit config path in it", err)
	}
}

// TestNativeCollectRootResolution pins the four-branch root switch. Each case
// lays down temp trees holding projects/<project>/sess.jsonl with DIFFERENT
// token counts, so reading the wrong tree changes the row instead of merely
// finding one too.
func TestNativeCollectRootResolution(t *testing.T) {
	t.Run("CLAUDE_CONFIG_DIR wins", func(t *testing.T) {
		root := t.TempDir()
		configDir := filepath.Join(root, "config-dir")
		writeNativeSession(t, configDir, nativeRow(11))
		// The other two locations hold different data: a branch that let either
		// win would report its token count instead of 11.
		writeNativeSession(t, filepath.Join(root, "decoy", "claude-home"), nativeRow(23))
		writeNativeSession(t, filepath.Join(root, "decoy", "home", ".claude"), nativeRow(37))
		snapshots := runNative(t, Options{
			HomeDir: filepath.Join(root, "decoy", "home"),
		}, map[string]string{
			"CLAUDE_CONFIG_DIR": configDir,
			"CLAUDE_HOME":       filepath.Join(root, "decoy", "claude-home"),
			"HOME":              filepath.Join(root, "decoy", "home"),
		})
		assertNativeRows(t, snapshots, 1, 11)
	})

	t.Run("CLAUDE_HOME when no config dir", func(t *testing.T) {
		root := t.TempDir()
		claudeHome := filepath.Join(root, "claude-home")
		writeNativeSession(t, claudeHome, nativeRow(41))
		writeNativeSession(t, filepath.Join(root, "decoy", "home", ".claude"), nativeRow(43))
		snapshots := runNative(t, Options{
			HomeDir: filepath.Join(root, "decoy", "home"),
		}, map[string]string{
			"CLAUDE_HOME": claudeHome,
			"HOME":        filepath.Join(root, "decoy", "home"),
		})
		assertNativeRows(t, snapshots, 1, 41)
	})

	t.Run("Options.HomeDir builds <home>/.claude", func(t *testing.T) {
		root := t.TempDir()
		home := filepath.Join(root, "home")
		writeNativeSession(t, filepath.Join(home, ".claude"), nativeRow(47))
		// A different tree behind the process HOME: falling through to the
		// default branch would report 53 instead.
		writeNativeSession(t, filepath.Join(root, "process-home", ".claude"), nativeRow(53))
		snapshots := runNative(t, Options{HomeDir: home}, map[string]string{
			"HOME": filepath.Join(root, "process-home"),
		})
		assertNativeRows(t, snapshots, 1, 47)
	})

	t.Run("default branch reads the ccusage roots", func(t *testing.T) {
		root := t.TempDir()
		// Claude configured through XDG: the default branch must go through
		// ResolveRoots, which knows $XDG_CONFIG_HOME, instead of only
		// ~/.claude (which readClaudeHome knows). The HOME tree has an empty
		// projects directory so ResolveRoots finds both roots, and the
		// dedupe across roots means the XDG tree's row is the one that
		// survives in the report (first root scanned wins on a full tie).
		writeNativeSession(t, filepath.Join(root, "xdg", "claude"), nativeRow(59))
		// An empty projects/ under HOME/.claude is valid and creates a second
		// root, but produces no transcripts.
		homeDir := filepath.Join(root, "home")
		if err := os.MkdirAll(filepath.Join(homeDir, ".claude", "projects"), 0o700); err != nil {
			t.Fatal(err)
		}
		snapshots := runNative(t, Options{}, map[string]string{
			"HOME":            homeDir,
			"XDG_CONFIG_HOME": filepath.Join(root, "xdg"),
		})
		assertNativeRows(t, snapshots, 1, 59)
	})

	t.Run("CLAUDE_CONFIG_DIR naming nothing is an error", func(t *testing.T) {
		missing := filepath.Join(t.TempDir(), "missing")
		options := Options{Timezone: "UTC", CollectedAt: nativeCollectedAt, StateDir: t.TempDir()}
		env := testEnv(map[string]string{"CLAUDE_CONFIG_DIR": missing, "HOME": t.TempDir()})
		snapshots, err := nativeCollect(context.Background(), nativeInput{
			options:     options,
			env:         env,
			timezone:    options.Timezone,
			collectedAt: options.CollectedAt,
		})
		if err == nil {
			t.Fatalf("snapshots = %+v, want an error for a CLAUDE_CONFIG_DIR with no projects/", snapshots)
		}
		if !strings.Contains(err.Error(), "No valid Claude data directories found in CLAUDE_CONFIG_DIR") {
			t.Fatalf("err = %v", err)
		}
	})
}

// TestNativeCollectPassesEmptyHomeDirWhenConfigDirIsSet names the rule the
// four-branch table above also covers: with CLAUDE_CONFIG_DIR set the provider
// hands ResolveRoots an empty home so the library itself applies ccusage's
// comma splitting, trimming and hard error. The two observable consequences are
// pinned here - a decoy CLAUDE_HOME does not win, and a config dir that names
// nothing usable is an error rather than an empty result.
func TestNativeCollectPassesEmptyHomeDirWhenConfigDirIsSet(t *testing.T) {
	root := t.TempDir()
	configDir := filepath.Join(root, "config-dir")
	writeNativeSession(t, configDir, nativeRow(71))
	writeNativeSession(t, filepath.Join(root, "claude-home"), nativeRow(73))
	snapshots := runNative(t, Options{}, map[string]string{
		"CLAUDE_CONFIG_DIR": configDir,
		"CLAUDE_HOME":       filepath.Join(root, "claude-home"),
	})
	assertNativeRows(t, snapshots, 1, 71)

	missing := filepath.Join(root, "missing")
	options := Options{Timezone: "UTC", CollectedAt: nativeCollectedAt, StateDir: t.TempDir()}
	snapshots, err := nativeCollect(context.Background(), nativeInput{
		options:     options,
		env:         testEnv(map[string]string{"CLAUDE_CONFIG_DIR": missing}),
		timezone:    options.Timezone,
		collectedAt: options.CollectedAt,
	})
	if err == nil {
		t.Fatalf("snapshots = %+v, want an error for a CLAUDE_CONFIG_DIR naming no usable directory", snapshots)
	}
}

// nativeRow builds one assistant line whose input token count names the tree it
// was written to. output_tokens is required: the adapter's usage parser drops a
// row whose usage object lacks it.
func nativeRow(inputTokens int) string {
	return fmt.Sprintf(`{"type":"assistant","timestamp":"2026-03-02T10:00:00.000Z",`+
		`"message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":%d,"output_tokens":1}}}`,
		inputTokens)
}

// TestNativeHookModeMakesNoNetworkCall pins that hook mode keeps the ccusage
// path's offline rule: pricing is read from the cache/static config and the
// catalogue is never fetched, even when an endpoint is configured.
func TestNativeHookModeMakesNoNetworkCall(t *testing.T) {
	configDir := t.TempDir()
	writeNativeSession(t, configDir,
		`{"type":"assistant","timestamp":"2026-03-02T10:00:00.000Z",`+
			`"message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":5,"output_tokens":1}}}`)
	fetcher := &countingFetcher{}
	options := Options{
		Timezone:       "UTC",
		CollectedAt:    nativeCollectedAt,
		StateDir:       t.TempDir(),
		PricingFetcher: fetcher.fetch,
	}
	env := testEnv(map[string]string{
		"CLAUDE_CONFIG_DIR":    configDir,
		"TOKENBOARD_ENDPOINT":  "https://tokenboard.example/api/v1/ingest",
		"TOKENBOARD_HOOK_MODE": "1",
	})
	_, err := nativeCollect(context.Background(), nativeInput{
		options:     options,
		env:         env,
		timezone:    options.Timezone,
		collectedAt: options.CollectedAt,
	})
	if err != nil {
		t.Fatalf("hook-mode native collection: %v", err)
	}
	if fetcher.calls != 0 {
		t.Fatalf("hook mode made %d catalogue request(s), want none", fetcher.calls)
	}

	// Control: the same setup outside hook mode does fetch, which proves the
	// counter can see a request at all.
	outsideHook := testEnv(map[string]string{
		"CLAUDE_CONFIG_DIR":    configDir,
		"TOKENBOARD_ENDPOINT":  "https://tokenboard.example/api/v1/ingest",
		"TOKENBOARD_HOOK_MODE": "",
	})
	_, err = nativeCollect(context.Background(), nativeInput{
		options:     options,
		env:         outsideHook,
		timezone:    options.Timezone,
		collectedAt: options.CollectedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	if fetcher.calls == 0 {
		t.Fatal("outside hook mode the configured endpoint must be used")
	}
}

// TestNativeHookModeRunsTheReconciledPath pins the replacement of the old
// not-wired refusal: with hook mode on, the native branch (the code
// useNativeClaude == true dispatches to) and the registry's native provider
// (which the parity harness calls regardless of the switch) both run the
// in-process reconciliation - incremental scan, bounded-window recompute,
// assertion - and neither spawns ccusage.
func TestNativeHookModeRunsTheReconciledPath(t *testing.T) {
	configDir := t.TempDir()
	writeNativeSession(t, configDir,
		`{"type":"assistant","timestamp":"2026-05-22T02:00:00.000Z",`+
			`"message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":5,"output_tokens":1}}}`)
	env := testEnv(map[string]string{
		"CLAUDE_CONFIG_DIR":    configDir,
		"TOKENBOARD_HOOK_MODE": "1",
	})

	// neverRuns builds options whose ccusage seams fail the test if consulted.
	neverRuns := func(t *testing.T) Options {
		t.Helper()
		return Options{
			Timezone:       "UTC",
			CollectedAt:    nativeCollectedAt,
			StateDir:       t.TempDir(),
			PricingFetcher: failingFetcher(t),
			Runner: func(context.Context, string, []string, ccexec.CommandOptions) (any, error) {
				t.Error("native hook mode must not run ccusage")
				return nil, errors.New("ccusage must not run")
			},
			ResolveBinary: func(ccacq.AcquireOptions) (ccacq.Binary, error) {
				t.Error("native hook mode must not resolve a ccusage binary")
				return ccacq.Binary{}, errors.New("ccusage must not run")
			},
		}
	}

	runs := map[string]func(t *testing.T) ([]contract.Snapshot, error){
		"native branch": func(t *testing.T) ([]contract.Snapshot, error) {
			options := neverRuns(t)
			return nativeCollect(context.Background(), nativeInput{
				options:     options,
				env:         env,
				timezone:    options.Timezone,
				collectedAt: options.CollectedAt,
			})
		},
		"registry provider": func(t *testing.T) ([]contract.Snapshot, error) {
			provider, ok := collect.LookupNative(contract.SourceClaudeCode)
			if !ok || provider == nil {
				t.Fatalf("collect.LookupNative(%q) has no provider", contract.SourceClaudeCode)
			}
			// nativeProvider does not accept a runner: it has no ccusage seam
			// to reach, which is exactly the property under test.
			return provider.Collect(context.Background(), collect.Options{
				Timezone: "UTC",
				StateDir: t.TempDir(),
				Env:      env,
			})
		},
	}
	for name, run := range runs {
		t.Run(name, func(t *testing.T) {
			snapshots, err := run(t)
			if err != nil {
				t.Fatalf("hook-mode native collection: %v", err)
			}
			if len(snapshots) != 1 {
				t.Fatalf("snapshots = %+v, want the recompute's row", snapshots)
			}
			snapshot := snapshots[0]
			// SessionCount is built by the adapter's session report, so a
			// non-zero value proves the in-process recompute ran rather than a
			// cached row being echoed back.
			if snapshot.UsageDate != "2026-05-22" || snapshot.Model != "claude-sonnet-4-20250514" ||
				snapshot.InputTokens != 5 || snapshot.TotalTokens != 6 || snapshot.SessionCount != 1 {
				t.Fatalf("snapshot = %+v, want the 2026-05-22 recompute row", snapshot)
			}
		})
	}
}

// TestNativeCollectMatchesNormalizePipeline is the end-to-end parity check:
// the native adapter over the committed fixture tree, normalized the native
// way, must equal the frozen ccusage reports normalized directly.
func TestNativeCollectMatchesNormalizePipeline(t *testing.T) {
	document := loadNativeGoldens(t)
	root := fixtureTree(t)
	// The report layer reads CCUSAGE_MODEL_ALIASES through os.Getenv; the
	// goldens were minted with it empty (TestClaude* in the claude package do
	// the same).
	t.Setenv(modelAliasesEnv, "")

	snapshots := runNative(t, Options{Since: "20260225", Until: "20260331"}, map[string]string{
		"CLAUDE_CONFIG_DIR": root,
	})
	if len(snapshots) == 0 {
		t.Fatal("nativeCollect returned no snapshots for the fixture tree")
	}

	daily, err := ccusage.DecodeJSON(document.Daily.Auto)
	if err != nil {
		t.Fatalf("DecodeJSON(daily.auto): %v", err)
	}
	sessions, err := ccusage.DecodeJSON(document.Sessions)
	if err != nil {
		t.Fatalf("DecodeJSON(sessions): %v", err)
	}
	want, err := ccusage.NormalizeCcusageDailyJSON(daily, ccusage.NormalizeOptions{
		Source:      contract.SourceClaudeCode,
		Timezone:    "UTC",
		CollectedAt: nativeCollectedAt,
		Sessions:    sessions,
		HasSessions: true,
	})
	if err != nil {
		t.Fatalf("Normalize(goldens): %v", err)
	}

	got := sortedSnapshots(snapshots)
	want = sortedSnapshots(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("native snapshots differ from the golden normalize pipeline:\n%s",
			describeSnapshotDiff(got, want))
	}
}

// TestNativeEmptyWindowIsAnEmptyResult pins that a tree with no transcripts
// normalizes to an empty slice rather than an error.
func TestNativeEmptyWindowIsAnEmptyResult(t *testing.T) {
	configDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(configDir, "projects"), 0o700); err != nil {
		t.Fatal(err)
	}
	snapshots := runNative(t, Options{}, map[string]string{"CLAUDE_CONFIG_DIR": configDir})
	// The normalizer always starts from an empty, non-nil slice, so the native
	// path returns that even with nothing to report.
	if len(snapshots) != 0 {
		t.Fatalf("snapshots = %+v, want none", snapshots)
	}
}

// TestNativeRejectsUnloadableTimezone pins the fail-closed rule for a
// timezone the adapter cannot load: reporting dates in a different zone from
// the one the snapshots carry is a silent re-attribution, not a fallback.
func TestNativeRejectsUnloadableTimezone(t *testing.T) {
	configDir := t.TempDir()
	writeNativeSession(t, configDir,
		`{"type":"assistant","timestamp":"2026-03-02T10:00:00.000Z",`+
			`"message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":5,"output_tokens":1}}}`)
	_, err := nativeCollect(context.Background(), nativeInput{
		options:     Options{Timezone: "Mars/Olympus_Mons", StateDir: t.TempDir()},
		env:         testEnv(forceRunnerEnv(map[string]string{"CLAUDE_CONFIG_DIR": configDir})),
		timezone:    "Mars/Olympus_Mons",
		collectedAt: nativeCollectedAt,
	})
	if err == nil || !strings.Contains(err.Error(), "native timezone") {
		t.Fatalf("err = %v, want the unloadable-timezone error", err)
	}
}

// runNative drives nativeCollect with the current hook mode off and returns
// its snapshots, failing the test on error.
func runNative(t *testing.T, options Options, env map[string]string) []contract.Snapshot {
	t.Helper()
	options.Env = testEnv(forceRunnerEnv(env))
	// The helper deliberately does NOT resolve TOKENBOARD_SINCE/UNTIL: that
	// fallback is the provider's job, and a helper that applied it would hide a
	// provider that forgot (TestNativeAppliesTheProviderWindowEnvironment).
	if options.Timezone == "" {
		// Pin the zone: the golden report was minted with -z UTC, and the
		// machine's own zone must not change which day a row lands on.
		options.Timezone = "UTC"
	}
	options.PricingFetcher = failingFetcher(t)
	if options.CollectedAt == "" {
		options.CollectedAt = nativeCollectedAt
	}
	if options.StateDir == "" {
		options.StateDir = t.TempDir()
	}
	snapshots, err := nativeCollect(context.Background(), nativeInput{
		options:     options,
		env:         options.Env,
		timezone:    options.Timezone,
		collectedAt: options.CollectedAt,
	})
	if err != nil {
		t.Fatalf("nativeCollect: %v", err)
	}
	return snapshots
}

// writeNativeSession writes projects/project-a/sess.jsonl below configDir.
func writeNativeSession(t *testing.T, configDir string, rows ...string) {
	t.Helper()
	path := filepath.Join(configDir, "projects", "project-a", "sess.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	content := strings.Join(rows, "\n") + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// assertNativeRows checks that exactly one snapshot came back with the given
// input tokens, which proves which tree was read.
func assertNativeRows(t *testing.T, snapshots []contract.Snapshot, wantRows int, wantInput int64) {
	t.Helper()
	if len(snapshots) != wantRows {
		t.Fatalf("snapshots = %+v, want %d rows", snapshots, wantRows)
	}
	if snapshots[0].InputTokens != wantInput {
		t.Fatalf("inputTokens = %d, want %d (the wrong tree was read)", snapshots[0].InputTokens, wantInput)
	}
}

// sortedSnapshots orders snapshots by their full identity so two collections
// built in different orders compare equal.
func sortedSnapshots(snapshots []contract.Snapshot) []contract.Snapshot {
	sorted := append([]contract.Snapshot{}, snapshots...)
	sort.Slice(sorted, func(left, right int) bool {
		a, b := sorted[left], sorted[right]
		if a.UsageDate != b.UsageDate {
			return a.UsageDate < b.UsageDate
		}
		return a.Model < b.Model
	})
	return sorted
}

// describeSnapshotDiff renders the row-by-row difference, so a failure names
// the fields that moved instead of dumping two long JSON documents.
func describeSnapshotDiff(got, want []contract.Snapshot) string {
	var message strings.Builder
	fmt.Fprintf(&message, "got %d rows, want %d\n", len(got), len(want))
	for index := 0; index < len(got) || index < len(want); index++ {
		if index >= len(got) {
			fmt.Fprintf(&message, "  [%d] missing: %s\n", index, renderSnapshot(want[index]))
			continue
		}
		if index >= len(want) {
			fmt.Fprintf(&message, "  [%d] unexpected: %s\n", index, renderSnapshot(got[index]))
			continue
		}
		if !reflect.DeepEqual(got[index], want[index]) {
			fmt.Fprintf(&message, "  [%d] got:  %s\n  [%d] want: %s\n",
				index, renderSnapshot(got[index]), index, renderSnapshot(want[index]))
		}
	}
	return message.String()
}

func renderSnapshot(snapshot contract.Snapshot) string {
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		return "<unprintable>"
	}
	return string(encoded)
}

// modelAliasesEnv is the variable the claude report layer reads with
// os.Getenv; the goldens were minted with it empty.
const modelAliasesEnv = "CCUSAGE_MODEL_ALIASES"

// TestNativeExplicitPricingConfigPricesInProcess pins the part of the pricing
// hand-off that only becomes visible once the in-process adapter prices:
//
//   - with TOKENBOARD_CCUSAGE_CONFIG naming a rate for the fixture's model, the
//     native costUSD reflects THAT rate (the explicit config is merged into the
//     override block the config file carries, and the native pass must read the
//     same block);
//   - with no explicit config the same row falls back to the built-in rate.
//
// Before MergedPricingOverrides existed, nativeCollect passed
// prepared.Overrides, which only holds the bundled/catalogue layer: the
// explicit rate reached ccusage through the merged file and nothing else, so
// the two paths priced the same row differently the moment the switch flipped.
func TestNativeExplicitPricingConfigPricesInProcess(t *testing.T) {
	root := t.TempDir()
	claudeHome := filepath.Join(root, "claude")
	// One row of 1,000,000 input tokens with one output token.
	//
	// Built-in: claude-sonnet-4-20250514 is $3/M input up to 200k and $6/M
	// above it, so 200,000x3e-6 + 800,000x6e-6 + 1x15e-6 = 5.400015.
	//
	// Explicit: the override prices the model at $11/M input and output, and an
	// override entry replaces the whole model, so the above-threshold band does
	// not apply: 1,000,000x11e-6 + 1x11e-6 = 11.000011.
	//
	// Both numbers are written out literally rather than derived from each
	// other: a test that only compared the two runs would still pass if the
	// override were applied to neither.
	writeNativeSession(t, claudeHome,
		`{"type":"assistant","timestamp":"2026-03-02T10:00:00.000Z",`+
			`"message":{"model":"claude-sonnet-4-20250514",`+
			`"usage":{"input_tokens":1000000,"output_tokens":1}}}`)

	explicit := filepath.Join(root, "explicit-pricing.json")
	if err := os.WriteFile(explicit, []byte(`{
		"defaults": {"pricingOverrides": {
			"claude-sonnet-4-20250514": {
				"inputCostPerToken": 0.000011,
				"outputCostPerToken": 0.000011,
				"cacheReadInputTokenCost": 0,
				"cacheCreationInputTokenCost": 0
			}
		}}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}

	collect := func(extra map[string]string) contract.Snapshot {
		t.Helper()
		env := map[string]string{"CLAUDE_CONFIG_DIR": claudeHome}
		for key, value := range extra {
			env[key] = value
		}
		snapshots := runNative(t, Options{}, env)
		if len(snapshots) != 1 {
			t.Fatalf("snapshots = %+v, want one row", snapshots)
		}
		return snapshots[0]
	}

	builtin := collect(nil)
	if builtin.InputTokens != 1_000_000 {
		t.Fatalf("inputTokens = %d, want 1000000", builtin.InputTokens)
	}
	if builtin.CostUSD != 5.400015 {
		t.Fatalf("built-in cost = %v, want 5.400015 (200k at $3/M, 800k at $6/M, one output token at $15/M)",
			builtin.CostUSD)
	}

	explicitPriced := collect(map[string]string{"TOKENBOARD_CCUSAGE_CONFIG": explicit})
	if explicitPriced.CostUSD != 11.000011 {
		t.Fatalf("explicit-config cost = %v, want 11.000011 (the explicit $11/M must price the row)",
			explicitPriced.CostUSD)
	}
}

// TestNativeAppliesScopedPricingConfigAndMode pins the two config layers the
// native path used to drop: scoped pricingOverrides (claude.defaults, not just
// root defaults) and the cost mode. ccusage resolves both from `option_maps`
// for `ccusage claude daily` (ccusage-config/src/config.rs:92-137); billing
// from the root block alone gave a different price on any machine that scopes
// its config, and the hardcoded ModeAuto ignored `defaults.mode`.
func TestNativeAppliesScopedPricingConfigAndMode(t *testing.T) {
	root := t.TempDir()
	claudeHome := filepath.Join(root, "claude")
	// 1,000,000 input tokens at the built-in $3/M-then-$6/M ladder with one
	// $15/M output token: 200,000x3e-6 + 800,000x6e-6 + 1x15e-6 = 5.400015. The
	// line also reports costUSD 0.5, which ModeAuto uses as-is.
	writeNativeSession(t, claudeHome,
		`{"type":"assistant","timestamp":"2026-03-02T10:00:00.000Z","costUSD":0.5,`+
			`"message":{"model":"claude-sonnet-4-20250514",`+
			`"usage":{"input_tokens":1000000,"output_tokens":1}}}`)

	writeConfig := func(name, body string) string {
		t.Helper()
		path := filepath.Join(root, name)
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	// $11/M replaces the whole entry, so the above-200k band does not apply:
	// 1,000,000x11e-6 + 1x11e-6 = 11.000011. ModeCalculate keeps the reported
	// 0.5 from masking the scoped rate.
	scoped := writeConfig("scoped-pricing.json", `{
		"defaults": {"mode": "calculate"},
		"claude": {"defaults": {"pricingOverrides": {"claude-sonnet-4-20250514": {
			"inputCostPerToken": 0.000011,
			"outputCostPerToken": 0.000011,
			"cacheReadInputTokenCost": 0,
			"cacheCreationInputTokenCost": 0
		}}}}
	}`)
	calculate := writeConfig("calculate.json", `{"defaults": {"mode": "calculate"}}`)

	collect := func(config string) contract.Snapshot {
		t.Helper()
		env := map[string]string{"CLAUDE_CONFIG_DIR": claudeHome}
		if config != "" {
			env["TOKENBOARD_CCUSAGE_CONFIG"] = config
		}
		snapshots := runNative(t, Options{}, env)
		if len(snapshots) != 1 {
			t.Fatalf("snapshots = %+v, want one row", snapshots)
		}
		return snapshots[0]
	}

	if got := collect(""); got.CostUSD != 0.5 {
		t.Fatalf("no-config cost = %v, want the reported 0.5 (ModeAuto prefers costUSD)", got.CostUSD)
	}
	if got := collect(scoped); got.CostUSD != 11.000011 {
		t.Fatalf("scoped-config cost = %v, want 11.000011 (claude.defaults.pricingOverrides must price the row)",
			got.CostUSD)
	}
	if got := collect(calculate); got.CostUSD != 5.400015 {
		t.Fatalf("calculate-mode cost = %v, want 5.400015 (defaults.mode=calculate must ignore the reported cost)",
			got.CostUSD)
	}
}

// apply the same TOKENBOARD_SINCE / TOKENBOARD_DEFAULT_SINCE / TOKENBOARD_UNTIL
// fallbacks the ccusage path applies in buildRangeArgs. Without them a caller
// that reaches the provider without the CLI's own resolution would scan a wider
// window than the ccusage path records -- a silent difference in what gets
// uploaded.
//
// The window is enforced here through the transcript mtime, which is what the
// adapter prunes on: the out-of-window file is written with a January mtime, so
// its 2026-01-01 row only shows up when no --since reached the adapter.
func TestNativeAppliesTheProviderWindowEnvironment(t *testing.T) {
	root := t.TempDir()
	claudeHome := filepath.Join(root, "claude")
	inWindow := filepath.Join(claudeHome, "projects", "project-a", "new.jsonl")
	outOfWindow := filepath.Join(claudeHome, "projects", "project-b", "old.jsonl")
	for path, row := range map[string]string{
		inWindow:    nativeRowAt(101, "2026-05-22T02:00:00.000Z"),
		outOfWindow: nativeRowAt(202, "2026-01-01T02:00:00.000Z"),
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(row+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	january := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	if err := os.Chtimes(outOfWindow, january, january); err != nil {
		t.Fatal(err)
	}

	env := map[string]string{
		"CLAUDE_CONFIG_DIR": claudeHome,
		"TOKENBOARD_SINCE":  "20260501",
	}
	snapshots := runNative(t, Options{}, env)
	if len(snapshots) != 1 || snapshots[0].UsageDate != "2026-05-22" || snapshots[0].InputTokens != 101 {
		t.Fatalf("snapshots = %+v, want only the in-window 2026-05-22 row: TOKENBOARD_SINCE must reach the adapter",
			snapshots)
	}

	// The ccusage side resolves the same window; its argv is the evidence.
	runner := &stubRunner{responses: func([]string) any { return map[string]any{"data": []any{}} }}
	if _, err := Collect(context.Background(), Options{
		Timezone:    "UTC",
		CollectedAt: nativeCollectedAt,
		StateDir:    t.TempDir(),
		Env:         testEnv(forceRunnerEnv(env)),
		Runner:      runner.run,
		ccusagePath: true,
	}); err != nil {
		t.Fatalf("ccusage path: %v", err)
	}
	if len(runner.calls) == 0 || !contains(runner.calls[0], "--since") || !contains(runner.calls[0], "20260501") {
		t.Fatalf("ccusage args = %v, want --since 20260501", runner.calls)
	}

	// Control: without the variable the same tree yields both rows, so the
	// single row above is the window and not a scan failure.
	unbounded := runNative(t, Options{}, map[string]string{"CLAUDE_CONFIG_DIR": claudeHome})
	if len(unbounded) != 2 {
		t.Fatalf("snapshots = %+v, want both rows without TOKENBOARD_SINCE", unbounded)
	}
}

// nativeRowAt is nativeRow with an explicit timestamp.
func nativeRowAt(inputTokens int, timestamp string) string {
	return fmt.Sprintf(`{"type":"assistant","timestamp":%q,`+
		`"message":{"model":"claude-sonnet-4-20250514","usage":{"input_tokens":%d,"output_tokens":1}}}`,
		timestamp, inputTokens)
}
