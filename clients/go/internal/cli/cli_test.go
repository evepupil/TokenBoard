package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

func run(t *testing.T, env map[string]string, args ...string) (int, string, string) {
	t.Helper()
	if env == nil {
		env = map[string]string{}
	}
	// Every command takes the run lock in the state directory; without an
	// override that would be the real ~/.tokenboard, so tests would contend
	// with the machine's own collector and pollute its state.
	if _, ok := env["TOKENBOARD_STATE_DIR"]; !ok {
		stateDir := t.TempDir()
		_ = os.Chmod(stateDir, 0o700)
		env["TOKENBOARD_STATE_DIR"] = stateDir
	}
	lookup := func(key string) string { return env[key] }
	var stdout, stderr bytes.Buffer
	code := RunWithEnv(context.Background(), args, lookup, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

// grokHomeFixture writes a minimal Grok Build session tree and returns its
// home, so a sync/preview run has a source that actually collects. Tests that
// exercise upload, lock and pause behaviour use it instead of a source with no
// provider, which would fail fast as unimplemented.
func grokHomeFixture(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	dir := filepath.Join(home, "sessions", "enc-cwd", "session-1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	event := `{"method":"_x.ai/session/update","timestamp":1785498182,"params":{"update":{"sessionUpdate":"turn_completed","usage":{"inputTokens":1000,"outputTokens":10,"cachedReadTokens":0,"modelUsage":{"grok-4.5":{"inputTokens":1000,"outputTokens":10,"cachedReadTokens":0}}}}}}`
	if err := os.WriteFile(filepath.Join(dir, "updates.jsonl"), []byte(event+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

// dshHomeFixture writes one plain-text DSH session whose assistant/message
// carries usage, so a preview/sync run exercises the registered provider
// through the real --source resolution rather than the provider's own tests.
func dshHomeFixture(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	dir := filepath.Join(home, "sessions", "project", "session-1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	event := `{"type":"assistant/message","seq":1,"time":1786702920000,` +
		`"data":{"turn":1,"step":0,` +
		`"message":{"id":"m","role":"assistant","source":{"kind":"model","model":"deepseek-v4-pro"}},` +
		`"usage":{"inputTokens":1000,"outputTokens":10,"cacheReadTokens":0,"cacheWriteTokens":0}}}`
	if err := os.WriteFile(filepath.Join(dir, "session.jsonl"), []byte(event+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestVersionExitsOK(t *testing.T) {
	code, stdout, _ := run(t, nil, "version")
	if code != ExitOK || !strings.Contains(stdout, "tokenboard") {
		t.Errorf("code=%d stdout=%q", code, stdout)
	}
}

func TestUnknownCommandIsUsageError(t *testing.T) {
	code, stdout, stderr := run(t, nil, "nonsense")
	if code != ExitUsage {
		t.Errorf("exit = %d, want %d", code, ExitUsage)
	}
	if stdout != "" {
		t.Errorf("usage must not touch stdout: %q", stdout)
	}
	if !strings.Contains(stderr, "Usage:") {
		t.Errorf("stderr %q lacks usage", stderr)
	}
	// The usage line already starts with "Usage: "; wrapping it in another
	// prefix printed "Usage: Usage: tokenboard ..." on every unknown command.
	if strings.Contains(stderr, "Usage: Usage:") {
		t.Errorf("stderr %q repeats the Usage prefix", stderr)
	}
}

func TestNoArgsShowsUsageOnStderr(t *testing.T) {
	code, stdout, stderr := run(t, nil)
	if code != ExitUsage {
		t.Errorf("exit = %d", code)
	}
	if stdout != "" || !strings.Contains(stderr, "Usage:") {
		t.Errorf("stdout=%q stderr=%q", stdout, stderr)
	}
}

func TestInvalidSourceIsUsageError(t *testing.T) {
	// A literal that cannot become a source name; "kimi" joined the closed
	// set with the ccusage tool family.
	code, _, stderr := run(t, nil, "preview", "--source", "not-a-source")
	if code != ExitUsage || !strings.Contains(stderr, "Invalid source") {
		t.Errorf("code=%d stderr=%q", code, stderr)
	}
}

// A concrete --source whose provider is not implemented in this client fails
// fast, the way the TS CLI fails when a single source cannot be collected.
// Every contract source now has a provider, so the case is driven by removing
// one from the registry.
func TestPreviewUnimplementedConcreteSourceFailsFast(t *testing.T) {
	// Every source in the contract now has a provider, so the path is driven
	// by unregistering one: running the real Codex provider here would scan the
	// machine's own session store.
	restore := collect.Unregister(contract.SourceCodex)
	t.Cleanup(restore)
	code, _, stderr := run(t, map[string]string{"TOKENBOARD_TIMEZONE": "UTC"}, "preview", "--source", "codex")
	if code != ExitFailure || !strings.Contains(stderr, "not implemented") {
		t.Errorf("code=%d stderr=%q", code, stderr)
	}
}

// Every source the contract declares must have a registered provider, because
// the failure mode without one is silent: an all-source run skips a source
// with no provider as "not implemented in this client yet" and still exits 0.
// That is exactly how the twelve ccusage tool sources drifted out of this
// client after upstream PR #25 added them TS-side — adding a source to
// contract without a provider must fail here, not ship.
func TestEveryContractSourceHasAProvider(t *testing.T) {
	for _, source := range contract.AllSources() {
		if _, ok := collect.Lookup(source); !ok {
			t.Errorf("source %q has no registered provider", source)
		}
	}
}

// An all-source preview over a home with no sessions prints an empty array:
// every missing store is skipped as unavailable, not reported as a failure.
func TestPreviewAllSourcesWithNoSessionsPrintsEmptyArray(t *testing.T) {
	// Every provider home is pointed at an empty temp directory: a developer
	// machine that has real sessions would otherwise be read by the all-source
	// run and this would stop being a test of the empty case. Claude Code,
	// Codex and the ccusage tool family have no local directory to point at
	// (ccusage owns those scans), so their providers are stubbed instead of
	// running a real ccusage over the machine's home — the tools now include
	// widely used ones (amp, kimi, zcode) that a developer machine may well
	// have data for.
	stubSource(t, contract.SourceClaudeCode, stubProvider{})
	stubSource(t, contract.SourceCodex, stubProvider{})
	for _, source := range contract.CcusageToolSources() {
		stubSource(t, source, stubProvider{})
	}
	code, stdout, _ := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_GROK_HOME":    t.TempDir(),
		"TOKENBOARD_DSH_HOME":     t.TempDir(),
		"TOKENBOARD_PI_AGENT_DIR": t.TempDir(),
		"TOKENBOARD_OPENCODE_DB":  filepath.Join(t.TempDir(), "absent.db"),
	}, "preview")
	if code != ExitOK {
		t.Fatalf("code = %d", code)
	}
	if strings.TrimSpace(stdout) != "[]" {
		t.Errorf("preview output %q, want []", stdout)
	}
}

// The DeepSeek Harness provider is reachable through the real --source
// resolution: an installed session previews its snapshot, and with no session
// present the source is skipped rather than reported as collected with zero
// usage.
func TestPreviewDeepSeekHarnessSource(t *testing.T) {
	code, stdout, stderr := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE": "UTC",
		"TOKENBOARD_DSH_HOME": dshHomeFixture(t),
	}, "preview", "--source", "deepseek-harness")
	if code != ExitOK {
		t.Fatalf("code = %d stderr=%q", code, stderr)
	}
	var snapshots []map[string]any
	if err := json.Unmarshal([]byte(stdout), &snapshots); err != nil {
		t.Fatalf("stdout not JSON: %q", stdout)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %v, want 1", snapshots)
	}
	if snapshots[0]["source"] != "deepseek-harness" ||
		snapshots[0]["model"] != "deepseek-v4-pro" ||
		snapshots[0]["costUsd"] != float64(0) {
		t.Errorf("snapshot = %v", snapshots[0])
	}

	code, _, stderr = run(t, map[string]string{
		"TOKENBOARD_TIMEZONE": "UTC",
		"TOKENBOARD_DSH_HOME": t.TempDir(),
	}, "preview", "--source", "deepseek-harness")
	if code != ExitFailure || !strings.Contains(stderr, "No DeepSeek Harness sessions found") {
		t.Errorf("empty DSH home: code=%d stderr=%q", code, stderr)
	}
}

func TestSyncRequiresEndpointAndToken(t *testing.T) {
	code, _, stderr := run(t, map[string]string{"TOKENBOARD_TIMEZONE": "UTC"}, "sync")
	if code != ExitFailure {
		t.Errorf("code = %d", code)
	}
	if !strings.Contains(stderr, "TOKENBOARD_ENDPOINT") || !strings.Contains(stderr, "TOKENBOARD_UPLOAD_TOKEN") {
		t.Errorf("stderr %q lacks both missing names", stderr)
	}
}

func TestSyncUploadsAndReportsCounts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			_ = json.NewEncoder(w).Encode(map[string]any{"existing": []any{}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": 1})
	}))
	defer server.Close()

	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	code, stdout, stderr := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    stateDir,
		"TOKENBOARD_ENDPOINT":     server.URL,
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
		"TOKENBOARD_GROK_HOME":    grokHomeFixture(t),
	}, "sync", "--source", "grok-build")
	if code != ExitOK {
		t.Fatalf("code = %d stderr=%q", code, stderr)
	}
	var result map[string]any
	if err := json.Unmarshal([]byte(stdout), &result); err != nil {
		t.Fatalf("stdout not JSON: %q", stdout)
	}
	if _, ok := result["upserted"]; !ok {
		t.Errorf("result lacks upserted: %v", result)
	}
	// The TS collector prints per-phase timings next to the upload result and
	// the skill's notify forwards them into the coordinator run record; a Go
	// sync that printed none would silently lose the phase attribution once
	// the client switch happens.
	timings, ok := result["timings"].(map[string]any)
	if !ok {
		t.Fatalf("result lacks timings: %v", result)
	}
	for _, phase := range []string{"collect", "upload", "cursorAck"} {
		if value, ok := timings[phase].(float64); !ok || value < 0 {
			t.Errorf("timings[%s] = %v, want a non-negative number", phase, timings[phase])
		}
	}
}

func TestSyncDeepSeekHarnessUploadsAndReportsCounts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			_ = json.NewEncoder(w).Encode(map[string]any{"existing": []any{}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": 1})
	}))
	defer server.Close()

	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	code, stdout, stderr := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    stateDir,
		"TOKENBOARD_ENDPOINT":     server.URL,
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
		"TOKENBOARD_DSH_HOME":     dshHomeFixture(t),
	}, "sync", "--source", "deepseek-harness")
	if code != ExitOK {
		t.Fatalf("code = %d stderr=%q", code, stderr)
	}
	var result map[string]any
	if err := json.Unmarshal([]byte(stdout), &result); err != nil {
		t.Fatalf("stdout not JSON: %q", stdout)
	}
	if _, ok := result["upserted"]; !ok {
		t.Errorf("result lacks upserted: %v", result)
	}
}

func TestSyncTransientFailureExits75(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	code, _, _ := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    stateDir,
		"TOKENBOARD_ENDPOINT":     server.URL,
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
		"TOKENBOARD_GROK_HOME":    grokHomeFixture(t),
	}, "sync", "--source", "grok-build")
	if code != ExitTransient {
		t.Errorf("transient 503 must exit %d, got %d", ExitTransient, code)
	}
}

func TestSyncHookModeTransientFailureExits1(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	code, _, _ := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    stateDir,
		"TOKENBOARD_ENDPOINT":     server.URL,
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
		"TOKENBOARD_HOOK_MODE":    "1",
		"TOKENBOARD_GROK_HOME":    grokHomeFixture(t),
	}, "sync", "--source", "grok-build")
	if code != ExitFailure {
		t.Errorf("hook mode must not defer: got %d", code)
	}
}

func TestSyncNonTransientFailureExits1AndRecordsBackoff(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	code, _, stderr := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    stateDir,
		"TOKENBOARD_ENDPOINT":     server.URL,
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
		"TOKENBOARD_GROK_HOME":    grokHomeFixture(t),
	}, "sync", "--source", "grok-build")
	if code != ExitFailure {
		t.Errorf("401 must be a plain failure, got %d", code)
	}
	if !strings.Contains(stderr, "consecutive non-transient failures") {
		t.Errorf("stderr %q lacks backoff note", stderr)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "upload-backoff.json")); err != nil {
		t.Errorf("backoff state not recorded: %v", err)
	}
}

func TestSyncReportsActivePause(t *testing.T) {
	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	// Five consecutive failures create a pause.
	for i := 0; i < 5; i++ {
		viaUploadFailure(t, stateDir)
	}
	code, _, stderr := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    stateDir,
		"TOKENBOARD_ENDPOINT":     "http://127.0.0.1:1",
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
		"TOKENBOARD_GROK_HOME":    grokHomeFixture(t),
	}, "sync", "--source", "grok-build")
	if code != ExitOK {
		t.Errorf("paused run should not fail the sync: %d", code)
	}
	if !strings.Contains(stderr, "paused until") {
		t.Errorf("stderr %q lacks pause notice", stderr)
	}
}

func viaUploadFailure(t *testing.T, stateDir string) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()
	code, _, _ := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    stateDir,
		"TOKENBOARD_ENDPOINT":     server.URL,
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
		"TOKENBOARD_GROK_HOME":    grokHomeFixture(t),
	}, "sync", "--source", "grok-build")
	if code != ExitFailure {
		t.Fatalf("seed failure run exited %d", code)
	}
}

func TestHookModeScansOnlyHookSources(t *testing.T) {
	sources := expandSources("all", true)
	if len(sources) != 2 {
		t.Fatalf("hook mode sources %v", sources)
	}
	for _, source := range sources {
		if source != "claude-code" && source != "codex" {
			t.Errorf("hook mode must not scan %s", source)
		}
	}
}

func TestUntilRejectedForWarmHooksAndHookMode(t *testing.T) {
	env := map[string]string{"TOKENBOARD_TIMEZONE": "UTC"}
	code, _, stderr := run(t, env, "warm-hooks", "--source", "codex", "--until", "2026-05-09")
	if code != ExitUsage || !strings.Contains(stderr, "until") {
		t.Errorf("warm-hooks --until: code=%d stderr=%q", code, stderr)
	}
	env["TOKENBOARD_HOOK_MODE"] = "1"
	code, _, stderr = run(t, env, "sync", "--source", "codex", "--until", "2026-05-09")
	if code != ExitUsage || !strings.Contains(stderr, "until") {
		t.Errorf("hook --until: code=%d stderr=%q", code, stderr)
	}
	// A non-Claude/Codex source rejects it too.
	delete(env, "TOKENBOARD_HOOK_MODE")
	code, _, stderr = run(t, env, "preview", "--source", "grok-build", "--until", "2026-05-09")
	if code != ExitUsage || !strings.Contains(stderr, "until") {
		t.Errorf("pi --until: code=%d stderr=%q", code, stderr)
	}
}

func TestInvalidTimezoneIsUsageError(t *testing.T) {
	code, _, stderr := run(t, map[string]string{"TOKENBOARD_TIMEZONE": "Mars/Olympus"}, "preview", "--source", "grok-build")
	if code != ExitUsage || !strings.Contains(stderr, "Invalid timezone") {
		t.Errorf("code=%d stderr=%q", code, stderr)
	}
}

func TestWarmHooksReportsPlannedSources(t *testing.T) {
	code, stdout, _ := run(t, map[string]string{"TOKENBOARD_TIMEZONE": "UTC"}, "warm-hooks")
	if code != ExitOK {
		t.Fatalf("code=%d", code)
	}
	if !strings.Contains(stdout, "claude-code") || !strings.Contains(stdout, "codex") {
		t.Errorf("warm-hooks output %q", stdout)
	}
}

// A request deadline must defer (75), not count as a plain failure: the
// scheduled runner retries transient exits on its next tick.
func TestSyncRequestTimeoutExits75(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(400 * time.Millisecond)
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": 0})
	}))
	defer server.Close()

	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	t.Setenv("TOKENBOARD_FETCH_TIMEOUT_MS", "80")
	code, _, stderr := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    stateDir,
		"TOKENBOARD_ENDPOINT":     server.URL,
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
		"TOKENBOARD_GROK_HOME":    grokHomeFixture(t),
	}, "sync", "--source", "grok-build")
	if code != ExitTransient {
		t.Errorf("timeout must exit %d, got %d (stderr %q)", ExitTransient, code, stderr)
	}
	if !strings.Contains(stderr, "request timed out") {
		t.Errorf("stderr must name the timeout: %q", stderr)
	}
}

// warm-hooks reports every concrete source as warmed, matching the TS
// expandSources — including non-hook sources whose warm step is a no-op.
func TestWarmHooksReportsConcreteNonHookSource(t *testing.T) {
	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	code, stdout, _ := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":  "UTC",
		"TOKENBOARD_STATE_DIR": stateDir,
	}, "warm-hooks", "--source", "grok-build")
	if code != ExitOK {
		t.Fatalf("code=%d", code)
	}
	if !strings.Contains(stdout, `"grok-build"`) || strings.Contains(stdout, "null") {
		t.Errorf("warm-hooks output %q", stdout)
	}
}

// A bare flag with no value must be a usage error, never a silent fallback
// to the environment default.
func TestBareFlagIsMissingValueError(t *testing.T) {
	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	code, _, stderr := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":  "UTC",
		"TOKENBOARD_STATE_DIR": stateDir,
		"TOKENBOARD_SOURCE":    "pi",
	}, "preview", "--source")
	if code != ExitUsage || !strings.Contains(stderr, "Missing value for --source") {
		t.Errorf("code=%d stderr=%q", code, stderr)
	}
}

// cursorScopeFromEndpoint mirrors the TS new URL(endpoint).origin: lowercased
// host, default port dropped, path/query stripped; empty for no endpoint.
func TestCursorScopeFromEndpoint(t *testing.T) {
	cases := []struct {
		endpoint string
		want     string
		wantErr  bool
	}{
		{"https://TB.Example/a/b?x=1", "https://tb.example", false},
		{"https://tokenboard.example", "https://tokenboard.example", false},
		{"https://h.example:8443/x", "https://h.example:8443", false},
		{"http://h.example:80/x", "http://h.example", false},
		{"https://h.example:443", "https://h.example", false},
		{"", "", false},
		{"not a url", "", true},
		{"/only/a/path", "", true},
	}
	for _, tc := range cases {
		got, err := cursorScopeFromEndpoint(tc.endpoint)
		if (err != nil) != tc.wantErr {
			t.Errorf("%q: err=%v wantErr=%v", tc.endpoint, err, tc.wantErr)
			continue
		}
		if !tc.wantErr && got != tc.want {
			t.Errorf("%q: got %q want %q", tc.endpoint, got, tc.want)
		}
	}
}

// An unparseable endpoint aborts the sync rather than silently unscooping the
// cursor, matching the TS new URL() throw.
func TestSyncRejectsInvalidEndpoint(t *testing.T) {
	stateDir := t.TempDir()
	_ = os.Chmod(stateDir, 0o700)
	code, _, stderr := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":     "UTC",
		"TOKENBOARD_STATE_DIR":    stateDir,
		"TOKENBOARD_ENDPOINT":     "not a url",
		"TOKENBOARD_UPLOAD_TOKEN": "tb_x",
	}, "sync", "--source", "grok-build")
	if code != ExitFailure || !strings.Contains(stderr, "Invalid endpoint URL") {
		t.Errorf("code=%d stderr=%q", code, stderr)
	}
}

// The endpoint origin keeps IPv6 brackets and normalizes default ports the
// way new URL().origin does; both feed the cursor-filename scope hash, so a
// mismatch would fork cursor files across implementations.
func TestCursorScopeFromEndpointEdgeForms(t *testing.T) {
	cases := []struct {
		endpoint string
		want     string
	}{
		{"https://[2001:db8::1]:8443/x", "https://[2001:db8::1]:8443"},
		{"https://[2001:db8::1]/x", "https://[2001:db8::1]"},
		{"https://h.example:0443/x", "https://h.example"},
		{"http://h.example:0080", "http://h.example"},
		{"https://h.example:443", "https://h.example"},
		{"https://user:pw@H.example:8443/x?q=1", "https://h.example:8443"},
	}
	for _, tc := range cases {
		got, err := cursorScopeFromEndpoint(tc.endpoint)
		if err != nil {
			t.Errorf("%q: unexpected error %v", tc.endpoint, err)
			continue
		}
		if got != tc.want {
			t.Errorf("%q: got %q want %q", tc.endpoint, got, tc.want)
		}
	}
}

// systemTimezoneName resolves the conventional locations; the test only
// asserts the shape (empty or a valid IANA name) so it holds on hosts
// without either file.
func TestSystemTimezoneNameResolvesValidOrEmpty(t *testing.T) {
	name := systemTimezoneName()
	if name != "" && !contract.IsValidTimezone(name) {
		t.Fatalf("systemTimezoneName returned an invalid zone %q", name)
	}
	if name == "Local" || name == "Factory" {
		t.Fatalf("systemTimezoneName must not return %q", name)
	}
}

// The CLI validates the timezone before any provider runs, so an offset zone
// Intl accepts has to survive that gate and actually shift the calendar day.
// The fixture's event is at 2026-07-31T20:00:00Z, which is 2026-08-01 in
// +08:00 and still 2026-07-31 in UTC — so a UTC fallback would fail this.
func TestPreviewAcceptsAnOffsetTimezone(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "sessions", "enc-cwd", "session-1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	crossing := `{"method":"_x.ai/session/update","timestamp":1785528000,"params":{"update":{"sessionUpdate":"turn_completed","usage":{"inputTokens":1000,"outputTokens":10,"cachedReadTokens":0,"modelUsage":{"grok-4.5":{"inputTokens":1000,"outputTokens":10,"cachedReadTokens":0}}}}}}`
	if err := os.WriteFile(filepath.Join(dir, "updates.jsonl"), []byte(crossing+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	code, stdout, stderr := run(t, map[string]string{
		"TOKENBOARD_TIMEZONE":  "+08:00",
		"TOKENBOARD_GROK_HOME": home,
	}, "preview", "--source", "grok-build")
	if code != ExitOK {
		t.Fatalf("code = %d, stderr = %s", code, stderr)
	}
	var snapshots []contract.Snapshot
	if err := json.Unmarshal([]byte(stdout), &snapshots); err != nil {
		t.Fatalf("decode %q: %v", stdout, err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %d, want 1", len(snapshots))
	}
	if snapshots[0].Timezone != "+08:00" {
		t.Errorf("timezone = %q, want the offset as given", snapshots[0].Timezone)
	}
	if snapshots[0].UsageDate != "2026-08-01" {
		t.Errorf("usageDate = %q, want 2026-08-01 (the next day in +08:00)", snapshots[0].UsageDate)
	}
	if err := snapshots[0].Validate(); err != nil {
		t.Errorf("snapshot fails the upload contract: %v", err)
	}
}
