package cli

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	antigravityguiprovider "github.com/MisonL/TokenBoard/clients/go/internal/collect/providers/antigravitygui"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// The CLI's source-failure contract, mirroring the TS collectOptionalSource and
// the collectionFailed computation: which failures abort, which are deferred to
// the end of the run, which still upload, and what the exit code is.

// stubProvider returns a fixed result, so the CLI's failure handling can be
// exercised without touching a local store.
type stubProvider struct {
	snapshots []contract.Snapshot
	err       error
}

func (p stubProvider) Collect(context.Context, collect.Options) ([]contract.Snapshot, error) {
	return p.snapshots, p.err
}

// stubSource replaces a source's provider for one test.
func stubSource(t *testing.T, source contract.Source, provider collect.Provider) {
	t.Helper()
	restore := collect.OverrideProvider(source, provider)
	t.Cleanup(restore)
}

func guiSnapshot(source contract.Source) contract.Snapshot {
	return contract.Snapshot{
		Source:       source,
		UsageDate:    "2026-06-24",
		Timezone:     "UTC",
		Model:        "Gemini 3.5 Flash (Medium)",
		InputTokens:  40,
		OutputTokens: 4,
		TotalTokens:  44,
		CollectedAt:  "2026-06-24T02:00:00.000Z",
	}
}

// emptyProviderHomes points every other source at an empty store, so an
// all-source run cannot read the developer machine's real sessions. Claude
// Code has no local directory to point at — its provider shells out to
// ccusage, which may probe PATH or download — so it is stubbed out instead.
// stubCcusageBackedSources replaces every source whose scan belongs to
// ccusage. Those providers have no local directory to point at, so leaving one
// unstubbed runs a real scan over the machine's own stores — and the tool
// family now includes widely used tools (amp, kimi, zcode) a developer machine
// can genuinely have data for.
func stubCcusageBackedSources(t *testing.T) {
	t.Helper()
	stubSource(t, contract.SourceClaudeCode, stubProvider{})
	stubSource(t, contract.SourceCodex, stubProvider{})
	for _, source := range contract.CcusageToolSources() {
		stubSource(t, source, stubProvider{})
	}
}

func emptyProviderHomes(t *testing.T) map[string]string {
	t.Helper()
	stubCcusageBackedSources(t)
	return map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_GROK_HOME":    t.TempDir(),
		"TOKENBOARD_DSH_HOME":     t.TempDir(),
		"TOKENBOARD_PI_AGENT_DIR": t.TempDir(),
		"TOKENBOARD_OPENCODE_DB":  filepath.Join(t.TempDir(), "absent.db"),
	}
}

// partialError is the Antigravity cargo-culted partial result: snapshots that
// upload plus the failure that still has to be reported.
func partialError(snapshots []contract.Snapshot, fatal bool, message string) error {
	return &antigravityguiprovider.PartialUsageError{
		Message:   message,
		Snapshots: snapshots,
		Fatal:     fatal,
	}
}

func TestPreviewConcreteSourcePartialSnapshotsCountAsCollectedAndFail(t *testing.T) {
	// A concrete --source run still uploads what the partial result carried,
	// and because the run named that one source its failure fails the run.
	source := contract.SourceAntigravity
	stubSource(t, source, stubProvider{
		snapshots: []contract.Snapshot{guiSnapshot(source)},
		err: partialError([]contract.Snapshot{guiSnapshot(source)}, false,
			"Antigravity language server collection failed after DB history was collected: "+
				"Antigravity metadata request returned invalid JSON for antigravity"),
	})

	code, stdout, stderr := run(t, map[string]string{"TOKENBOARD_TIMEZONE": "UTC"},
		"preview", "--source", "antigravity")
	if code != ExitFailure {
		t.Fatalf("code = %d, want failure; stderr=%q", code, stderr)
	}
	// The snapshots were printed before the failure was reported.
	if !strings.Contains(stdout, "Gemini 3.5 Flash (Medium)") {
		t.Fatalf("stdout = %q, want the partial snapshots", stdout)
	}
	if !strings.Contains(stderr, "status=partial category=invalid-metadata") {
		t.Fatalf("stderr = %q, want the redacted partial failure", stderr)
	}
}

func TestPreviewConcreteSourcePartialFailureNeverPrintsTheRawMessage(t *testing.T) {
	// The scheduled log is long-lived: the raw message (paths, conversation
	// ids) must not reach it, only the category.
	raw := "Antigravity SQLite metadata query failed: /Users/someone/secret/" +
		"11111111-1111-1111-1111-111111111111.db"
	source := contract.SourceAntigravity
	stubSource(t, source, stubProvider{err: errors.New(raw)})

	code, _, stderr := run(t, map[string]string{"TOKENBOARD_TIMEZONE": "UTC"},
		"preview", "--source", "antigravity")
	if code != ExitFailure {
		t.Fatalf("code = %d, want failure", code)
	}
	if strings.Contains(stderr, "11111111-1111-1111-1111-111111111111") ||
		strings.Contains(stderr, "/Users/someone/secret") {
		t.Fatalf("stderr = %q, want the raw message redacted", stderr)
	}
	if !strings.Contains(stderr, "Antigravity collection: source=antigravity status=failed category=") {
		t.Fatalf("stderr = %q, want the diagnostic line", stderr)
	}
}

func TestPreviewAllSourceNonFatalPartialKeepsTheRunGreen(t *testing.T) {
	// In an all-source run a non-fatal partial result is recorded but does not
	// fail the run unless TOKENBOARD_FAIL_ON_SOURCE_ERROR asks for it.
	env := emptyProviderHomes(t)
	stubSource(t, contract.SourceAntigravity, stubProvider{
		err: partialError(nil, false,
			"Antigravity language server unavailable after DB history was collected: "+
				"spawn /opt/Antigravity.app/language_server ENOENT"),
	})

	code, _, stderr := run(t, env, "preview")
	if code != ExitOK {
		t.Fatalf("code = %d, want success; stderr=%q", code, stderr)
	}
	if strings.Contains(stderr, "One or more sources failed") {
		t.Fatalf("stderr = %q, want no failure report", stderr)
	}
}

func TestPartialErrorWithNoSnapshotsStillCountsTheSourceCollected(t *testing.T) {
	// The TS partial branch pushes the snapshots (possibly none) and the source
	// before it returns, so a source whose only failure was a partial result is
	// still collected — it must not be reclassified as unavailable and skipped.
	env := emptyProviderHomes(t)
	stubSource(t, contract.SourceAntigravity, stubProvider{
		err: partialError(nil, true, "Antigravity metadata request timed out for antigravity"),
	})

	code, _, stderr := run(t, env, "preview")
	if code != ExitFailure {
		t.Fatalf("code = %d, want the fatal partial to fail the run; stderr=%q", code, stderr)
	}
	if strings.Contains(stderr, "Skipping unavailable antigravity source") {
		t.Fatalf("stderr = %q, the partial result must not be skipped as unavailable", stderr)
	}
	if !strings.Contains(stderr, "status=partial category=language-server-unavailable") {
		t.Fatalf("stderr = %q, want the partial diagnostic", stderr)
	}
}

func TestPreviewAllSourceFailsWhenATimeoutMakesTheSourceFail(t *testing.T) {
	// A metadata timeout is an unavailable language server, which an all-source
	// run normally skips — but with TOKENBOARD_FAIL_ON_SOURCE_ERROR=1 the
	// operator asked for a hard failure, and it must be reported.
	env := emptyProviderHomes(t)
	env["TOKENBOARD_FAIL_ON_SOURCE_ERROR"] = "1"
	stubSource(t, contract.SourceAntigravity, stubProvider{
		err: errors.New("Antigravity metadata request timed out for antigravity"),
	})

	code, _, stderr := run(t, env, "preview")
	if code != ExitFailure {
		t.Fatalf("code = %d, want failure; stderr=%q", code, stderr)
	}
	if !strings.Contains(stderr, "One or more sources failed: antigravity: status=failed") {
		t.Fatalf("stderr = %q, want the recorded failure", stderr)
	}
}

func TestPreviewAllSourceSkipsAnUnavailableLanguageServerByDefault(t *testing.T) {
	// Without the override, the same timeout is "the language server is not
	// installed here" and the run stays green.
	env := emptyProviderHomes(t)
	stubSource(t, contract.SourceAntigravity, stubProvider{
		err: errors.New("Antigravity metadata request timed out for antigravity"),
	})

	code, _, stderr := run(t, env, "preview")
	if code != ExitOK {
		t.Fatalf("code = %d, want success; stderr=%q", code, stderr)
	}
	if strings.Contains(stderr, "One or more sources failed") {
		t.Fatalf("stderr = %q, want no failure report", stderr)
	}
}

func TestSyncFatalPartialUploadsBeforeReportingFailure(t *testing.T) {
	// A fatal partial result is not an abort: the snapshots upload, and only
	// then does the run report the failure.
	var ingested atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			_ = json.NewEncoder(w).Encode(map[string]any{"existing": []any{}})
			return
		}
		ingested.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": 1})
	}))
	defer server.Close()

	source := contract.SourceAntigravity
	env := map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    t.TempDir(),
		"TOKENBOARD_ENDPOINT":     server.URL,
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
	}
	if err := os.Chmod(env["TOKENBOARD_STATE_DIR"], 0o700); err != nil {
		t.Fatal(err)
	}
	stubSource(t, source, stubProvider{
		snapshots: []contract.Snapshot{guiSnapshot(source)},
		err: partialError([]contract.Snapshot{guiSnapshot(source)}, true,
			"Antigravity language server collection failed after DB history was collected: "+
				"Antigravity metadata response exceeded the 8388608-byte limit for antigravity"),
	})

	code, stdout, stderr := run(t, env, "sync", "--source", "antigravity")
	if ingested.Load() == 0 {
		t.Fatal("the partial snapshots were not uploaded")
	}
	if code != ExitFailure {
		t.Fatalf("code = %d, want failure after the upload; stderr=%q", code, stderr)
	}
	if !strings.Contains(stdout, "upserted") {
		t.Fatalf("stdout = %q, want the upload result", stdout)
	}
	if !strings.Contains(stderr, "One or more sources failed: antigravity: status=partial category=metadata-limit-exceeded") {
		t.Fatalf("stderr = %q, want the redacted failure report", stderr)
	}
}

func TestPreviewAllSourceDefersAFatalFailureUntilTheEnd(t *testing.T) {
	// A fatal source failure in an all-source run does not abort the other
	// sources: they still collect, and the run reports the failure at the end.
	env := emptyProviderHomes(t)
	stubSource(t, contract.SourceGrokBuild, stubProvider{
		err: errors.New("Failed to read Grok Build sessions: permission denied"),
	})
	stubSource(t, contract.SourceAntigravity, stubProvider{
		snapshots: []contract.Snapshot{guiSnapshot(contract.SourceAntigravity)},
	})

	code, stdout, stderr := run(t, env, "preview")
	if code != ExitFailure {
		t.Fatalf("code = %d, want failure; stderr=%q", code, stderr)
	}
	if !strings.Contains(stdout, "Gemini 3.5 Flash (Medium)") {
		t.Fatalf("stdout = %q, the other source should still have collected", stdout)
	}
	if !strings.Contains(stderr, "One or more sources failed: grok-build: Failed to read Grok Build sessions") {
		t.Fatalf("stderr = %q, want the recorded failure", stderr)
	}
}
