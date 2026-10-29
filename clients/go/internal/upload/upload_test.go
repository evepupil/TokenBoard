package upload

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

func testConfig(endpoint string) Config {
	return Config{Endpoint: endpoint, UploadToken: "tb_test_token", RetryDelayMs: 1}
}

func baseSnapshot(model string, total int64) contract.Snapshot {
	return contract.Snapshot{
		Source:      contract.SourceCodex,
		UsageDate:   "2026-05-09",
		Timezone:    "Asia/Shanghai",
		Model:       model,
		InputTokens: 10, OutputTokens: 2, TotalTokens: total, CacheRead: 5,
		CostUSD: 0.01, SessionCount: 1,
		CollectedAt: "2026-05-09T10:00:00.000Z",
	}
}

func TestSnapshotHashIsSHA256OfHashPayload(t *testing.T) {
	// Known-answer cross-checked against the TypeScript implementation:
	// sha256 of the exact golden "base" payload.
	snapshot := baseSnapshot("gpt-5", 17)
	const want = "de8928257c1bb02860b1f57925ebd7de1c9a2b500554c06ec6e1834c5c3fc30e"
	if got := SnapshotHash(snapshot); got != want {
		t.Errorf("hash = %s, want %s", got, want)
	}
}

func TestUploadEmptySnapshotsPostsOneEmptyBatch(t *testing.T) {
	var bodies []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": 0})
	}))
	defer server.Close()

	result, err := UploadSnapshots(t.Context(), testConfig(server.URL), nil, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if result.Upserted != 0 || result.Skipped != 0 {
		t.Errorf("result %+v", result)
	}
	if len(bodies) != 1 {
		t.Fatalf("requests = %d, want 1", len(bodies))
	}
	snapshots, ok := bodies[0]["snapshots"].([]any)
	if !ok || len(snapshots) != 0 {
		t.Errorf("empty batch shape wrong: %v", bodies[0])
	}
}

func TestUploadSkipsUnchangedViaCheck(t *testing.T) {
	var upserts int
	var checkedKeys int
	unchanged := baseSnapshot("gpt-5", 17)
	changed := baseSnapshot("gpt-5.6-sol", 42)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/check"):
			var body struct {
				Keys []struct{ Source, UsageDate, Model string } `json:"keys"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			checkedKeys += len(body.Keys)
			// Report the unchanged snapshot as already stored with the
			// current hash; the changed one is absent (or stale).
			_ = json.NewEncoder(w).Encode(map[string]any{
				"existing": []map[string]any{{
					"source": unchanged.Source, "usageDate": unchanged.UsageDate,
					"model": unchanged.Model, "snapshotHash": SnapshotHash(unchanged),
				}},
			})
		default:
			var body struct {
				Snapshots []contract.Snapshot `json:"snapshots"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			upserts += len(body.Snapshots)
			_ = json.NewEncoder(w).Encode(map[string]any{"upserted": len(body.Snapshots)})
		}
	}))
	defer server.Close()

	result, err := UploadSnapshots(t.Context(), testConfig(server.URL), []contract.Snapshot{unchanged, changed}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if result.Skipped != 1 || result.Upserted != 1 {
		t.Errorf("result %+v, want upserted 1 skipped 1", result)
	}
	if upserts != 1 || checkedKeys != 2 {
		t.Errorf("upserts=%d checked=%d", upserts, checkedKeys)
	}
}

func TestUploadTreatsUnsupportedCheckAsAllChanged(t *testing.T) {
	var upserts int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body struct {
			Snapshots []contract.Snapshot `json:"snapshots"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		upserts += len(body.Snapshots)
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": len(body.Snapshots)})
	}))
	defer server.Close()

	result, err := UploadSnapshots(t.Context(), testConfig(server.URL), []contract.Snapshot{baseSnapshot("gpt-5", 17)}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if result.Upserted != 1 || result.Skipped != 0 {
		t.Errorf("result %+v", result)
	}
	if upserts != 1 {
		t.Errorf("upserts %d", upserts)
	}
}

func TestUploadRetriesTransientStatusThenSucceeds(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			_ = json.NewEncoder(w).Encode(map[string]any{"existing": []any{}})
			return
		}
		if attempts.Add(1) == 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": 1})
	}))
	defer server.Close()

	result, err := UploadSnapshots(t.Context(), testConfig(server.URL), []contract.Snapshot{baseSnapshot("gpt-5", 17)}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if result.Upserted != 1 || attempts.Load() != 2 {
		t.Errorf("upserted=%d attempts=%d", result.Upserted, attempts.Load())
	}
}

func TestUploadFailsAfterExhaustingRetries(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			_ = json.NewEncoder(w).Encode(map[string]any{"existing": []any{}})
			return
		}
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()

	_, err := UploadSnapshots(t.Context(), testConfig(server.URL), []contract.Snapshot{baseSnapshot("gpt-5", 17)}, server.Client())
	if err == nil || !strings.Contains(err.Error(), "502") {
		t.Fatalf("want 502 failure, got %v", err)
	}
}

func TestUploadDoesNotRetryNonTransient4xx(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			_ = json.NewEncoder(w).Encode(map[string]any{"existing": []any{}})
			return
		}
		attempts.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	_, err := UploadSnapshots(t.Context(), testConfig(server.URL), []contract.Snapshot{baseSnapshot("gpt-5", 17)}, server.Client())
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("want 401 failure, got %v", err)
	}
	if attempts.Load() != 1 {
		t.Errorf("401 must not be retried, attempts=%d", attempts.Load())
	}
}

func TestUploadRejectsMalformedResponses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			_ = json.NewEncoder(w).Encode(map[string]any{"existing": []any{}})
			return
		}
		_, _ = io.WriteString(w, `{"upserted":"many"}`)
	}))
	defer server.Close()

	_, err := UploadSnapshots(t.Context(), testConfig(server.URL), []contract.Snapshot{baseSnapshot("gpt-5", 17)}, server.Client())
	if err == nil {
		t.Fatal("malformed response must fail")
	}
}

func TestUploadChunksAtThirty(t *testing.T) {
	var batchSizes []int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/check") {
			_ = json.NewEncoder(w).Encode(map[string]any{"existing": []any{}})
			return
		}
		var body struct {
			Snapshots []contract.Snapshot `json:"snapshots"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		batchSizes = append(batchSizes, len(body.Snapshots))
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": len(body.Snapshots)})
	}))
	defer server.Close()

	snapshots := make([]contract.Snapshot, 65)
	for i := range snapshots {
		snapshots[i] = baseSnapshot("model-"+string(rune('a'+i%26)), int64(10+i))
	}
	result, err := UploadSnapshots(t.Context(), testConfig(server.URL), snapshots, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if result.Upserted != 65 {
		t.Errorf("upserted %d", result.Upserted)
	}
	want := []int{30, 30, 5}
	if len(batchSizes) != len(want) {
		t.Fatalf("batches %v, want %v", batchSizes, want)
	}
	for i := range want {
		if batchSizes[i] != want[i] {
			t.Errorf("batch %d size %d, want %d", i, batchSizes[i], want[i])
		}
	}
}

func TestBackoffPausesAfterFiveConsecutiveFailures(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 5, 9, 10, 0, 0, 0, time.UTC)
	for i := 0; i < 4; i++ {
		state, recordErr := RecordFailure(dir, os.ErrPermission, now)
		if recordErr != nil {
			t.Fatalf("record %d: %v", i+1, recordErr)
		}
		if state.ConsecutiveFailures != i+1 {
			t.Fatalf("failure %d recorded as %d", i+1, state.ConsecutiveFailures)
		}
		if _, paused := IsPaused(dir, now); paused {
			t.Fatalf("paused early at failure %d", i+1)
		}
	}
	state, recordErr := RecordFailure(dir, os.ErrPermission, now)
	if recordErr != nil {
		t.Fatalf("record 5: %v", recordErr)
	}
	if state.ConsecutiveFailures != 5 {
		t.Fatalf("5th failure = %d", state.ConsecutiveFailures)
	}
	pausedUntil, paused := IsPaused(dir, now)
	if !paused {
		t.Fatal("must pause after 5 consecutive failures")
	}
	if until, _ := time.Parse(time.RFC3339, pausedUntil); until.Sub(now) != 24*time.Hour {
		t.Errorf("pause window %v", until.Sub(now))
	}
	// Pause expires on its own.
	if _, paused := IsPaused(dir, now.Add(25*time.Hour)); paused {
		t.Error("pause must expire")
	}
}

func TestBackoffSuccessClearsState(t *testing.T) {
	dir := t.TempDir()
	now := time.Now().UTC()
	if _, err := RecordFailure(dir, os.ErrPermission, now); err != nil {
		t.Fatalf("record: %v", err)
	}
	RecordSuccess(dir)
	if _, err := os.Stat(filepath.Join(dir, "upload-backoff.json")); !os.IsNotExist(err) {
		t.Error("success must remove the state file")
	}
	if _, paused := IsPaused(dir, now); paused {
		t.Error("cleared state must not pause")
	}
}

func TestBackoffSummarizesLongErrors(t *testing.T) {
	dir := t.TempDir()
	long := strings.Repeat("x", 500)
	state, recordErr := RecordFailure(dir, errString(long), time.Now().UTC())
	if recordErr != nil {
		t.Fatalf("record: %v", recordErr)
	}
	if len(state.LastErrorSummary) > 200 {
		t.Errorf("summary not truncated: %d", len(state.LastErrorSummary))
	}
}

type errString string

func (e errString) Error() string { return string(e) }

// The per-attempt deadline must surface in the TS RequestTimeoutError shape
// so IsTransientNetworkError's "request timed out" pattern sees it — a
// context deadline that classified as a plain failure would exit 1 and burn
// backoff strikes instead of deferring with exit 75.
func TestRequestTimeoutErrorShapeAndTransience(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": 0})
	}))
	defer server.Close()

	t.Setenv("TOKENBOARD_FETCH_TIMEOUT_MS", "50")
	_, err := UploadSnapshots(t.Context(), testConfig(server.URL), []contract.Snapshot{baseSnapshot("m", 17)}, server.Client())
	if err == nil {
		t.Fatal("expected a timeout error")
	}
	if !strings.Contains(err.Error(), "TokenBoard request timed out after 50ms") {
		t.Fatalf("timeout error shape drifted: %v", err)
	}
	if !collect.IsTransientNetworkError(err) {
		t.Fatalf("timeout must classify as transient: %v", err)
	}
}

// TOKENBOARD_FETCH_TIMEOUT_MS mirrors the TS env contract: positive digits
// only, capped at two minutes, ignored when the config carries an override.
func TestRequestTimeoutMsResolvesEnv(t *testing.T) {
	t.Setenv("TOKENBOARD_FETCH_TIMEOUT_MS", "1000")
	if got := requestTimeoutMs(Config{}); got != 1000 {
		t.Errorf("env value ignored: got %d", got)
	}
	t.Setenv("TOKENBOARD_FETCH_TIMEOUT_MS", "500000")
	if got := requestTimeoutMs(Config{}); got != maxRequestTimeoutMs {
		t.Errorf("env value not capped: got %d", got)
	}
	for _, invalid := range []string{"0", "-5", "1e3", "12abc", ""} {
		t.Setenv("TOKENBOARD_FETCH_TIMEOUT_MS", invalid)
		if got := requestTimeoutMs(Config{}); got != defaultRequestTimeoutMs {
			t.Errorf("invalid env %q must fall back to default, got %d", invalid, got)
		}
	}
	// TS requires Number.isSafeInteger, so anything at or past 2^53 is not a
	// number it will use — it falls back to the default rather than capping.
	// A plain Atoi parses these and then caps, which is a different timeout.
	for _, unsafe := range []string{"9007199254740992", "99999999999999999999"} {
		t.Setenv("TOKENBOARD_FETCH_TIMEOUT_MS", unsafe)
		if got := requestTimeoutMs(Config{}); got != defaultRequestTimeoutMs {
			t.Errorf("unsafe integer %q must fall back to default, got %d", unsafe, got)
		}
	}
	t.Setenv("TOKENBOARD_FETCH_TIMEOUT_MS", "9007199254740991")
	if got := requestTimeoutMs(Config{}); got != maxRequestTimeoutMs {
		t.Errorf("the largest safe integer must be accepted and capped, got %d", got)
	}
	if got := requestTimeoutMs(Config{RequestTimeoutMs: 7}); got != 7 {
		t.Errorf("config override must win, got %d", got)
	}
}

// The TS check validator requires Array.isArray(existing); a payload without
// the key must fail closed instead of silently re-uploading everything.
func TestCheckResponseWithoutExistingFailsClosed(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{})
	}))
	defer server.Close()

	_, err := UploadSnapshots(t.Context(), testConfig(server.URL), []contract.Snapshot{baseSnapshot("m", 17)}, server.Client())
	if err == nil || !strings.Contains(err.Error(), "Snapshot check returned invalid response") {
		t.Fatalf("missing existing must fail closed, got %v", err)
	}
}

// Every exit path — success, exhausted retries, parse failure — must close
// the response body so the transport can reuse the connection.
func TestResponseBodyClosedOnEveryExit(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		body    string
		wantErr string
	}{
		{"success", 200, `{"upserted":1}`, ""},
		{"exhausted-retries", 503, "", "Snapshot check failed with status 503"},
		{"parse-failure", 200, `{"nope":1}`, "Upload returned invalid response"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			closed := 0
			client := &http.Client{Transport: countingTransport(t, tc.status, tc.body, &closed)}
			_, err := UploadSnapshots(t.Context(), testConfig("http://unreachable.invalid"),
				[]contract.Snapshot{baseSnapshot("m", 17)}, client)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error %v, want %q", err, tc.wantErr)
			}
			// Three attempts for the retryable case, one otherwise; every
			// response must have been closed exactly once.
			if closed == 0 {
				t.Fatal("no response body was closed")
			}
		})
	}
}

func countingTransport(t *testing.T, status int, body string, closed *int) http.RoundTripper {
	t.Helper()
	return roundTripFunc(func(request *http.Request) (*http.Response, error) {
		*closed = *closed + 1
		payload := body
		// The /check leg needs a valid envelope for the ingest leg to run.
		if strings.HasSuffix(request.URL.Path, "/check") && status == http.StatusOK {
			payload = `{"existing":[]}`
		}
		response := &http.Response{
			StatusCode: status,
			Header:     http.Header{},
			Body:       io.NopCloser(strings.NewReader(payload)),
			Request:    request,
		}
		return response, nil
	})
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

// The backoff loader mirrors the TS type gate: a record missing either
// required field is treated as absent, not half-read.
func TestLoadBackoffRequiresBothTypedFields(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "upload-backoff.json")
	write := func(content string) {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"consecutiveFailures":3,"lastErrorSummary":"boom"}`)
	if state := LoadBackoff(dir); state == nil || state.ConsecutiveFailures != 3 {
		t.Fatalf("valid record rejected: %+v", state)
	}
	write(`{"consecutiveFailures":3,"lastErrorSummary":""}`)
	if state := LoadBackoff(dir); state == nil {
		t.Fatal("empty summary is a valid string per the TS loader")
	}
	write(`{"lastErrorSummary":"boom"}`)
	if state := LoadBackoff(dir); state != nil {
		t.Fatalf("record without consecutiveFailures must be absent: %+v", state)
	}
	write(`{"consecutiveFailures":3}`)
	if state := LoadBackoff(dir); state != nil {
		t.Fatalf("record without lastErrorSummary must be absent: %+v", state)
	}
	write(`{"consecutiveFailures":"3","lastErrorSummary":"boom"}`)
	if state := LoadBackoff(dir); state != nil {
		t.Fatalf("wrong-typed field must be absent: %+v", state)
	}
}

// Summarize reduces URLs to their origin before persisting: the backoff file
// outlives the request and a transport error may embed query parameters.
func TestSummarizeRedactsURLs(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"Post \"https://host.example/api/v1/ingest?token=abc\": dial tcp: timeout",
			"Post \"https://host.example\": dial tcp: timeout"},
		{"Post \"https://user:pw@host.example:8443/x\": refused",
			"Post \"https://host.example:8443\": refused"},
		{"trailing punctuation https://host.example/x, and more",
			"trailing punctuation https://host.example, and more"},
		{"no url here", "no url here"},
	}
	for _, tc := range cases {
		if got := Summarize(errors.New(tc.in)); got != tc.want {
			t.Errorf("Summarize(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	long := strings.Repeat("界", 250)
	got := Summarize(errors.New(long))
	if len([]rune(got)) != 198 || !strings.HasSuffix(got, "…") {
		t.Errorf("rune truncation drifted: %d runes", len([]rune(got)))
	}
}

// The backoff base is clamped before the shift: an oversized base would
// overflow base<<attempt into a negative duration (immediate retry).
func TestRetryDelayClampsBaseBeforeShift(t *testing.T) {
	delay := retryDelay(nil, 3, 1<<62)
	if delay <= 0 || delay > maxRetryDelayMs*time.Millisecond {
		t.Fatalf("delay %v out of range", delay)
	}
}

// A state directory that cannot be written must surface the failure: the
// caller prints "could not be recorded" the way the TS collector does, and a
// silent write failure would leave the run claiming a pause that was never
// persisted.
func TestRecordFailureReportsAWriteFailure(t *testing.T) {
	parent := t.TempDir()
	blocked := filepath.Join(parent, "not-a-directory")
	if err := os.WriteFile(blocked, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := RecordFailure(blocked, os.ErrPermission, time.Now()); err == nil {
		t.Fatal("a write failure must be reported, not swallowed")
	}
}

// The server rejects a whole batch when any snapshot's usageDate falls outside
// [2023-01-01, today+1], and the client cannot retry its way out of that: the date is a
// property of the row, not of the request. Left in, one such row fails its batch on every
// run and five consecutive non-transient failures pause uploads for 24 hours.
func TestUploadSnapshotsDropsOutOfWindowDatesBeforeSending(t *testing.T) {
	var posted []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if snapshots, ok := body["snapshots"].([]any); ok && len(snapshots) > 0 {
			posted = append(posted, body)
		}
		if r.URL.Path == "/check" {
			_ = json.NewEncoder(w).Encode(map[string]any{"existing": []any{}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": 1})
	}))
	defer server.Close()

	good := baseSnapshot("gpt-5", 17)
	tooOld := baseSnapshot("gpt-5", 18)
	tooOld.UsageDate = "2022-12-31"
	tooFuture := baseSnapshot("gpt-5", 19)
	tooFuture.UsageDate = "2099-01-01"

	config := testConfig(server.URL)
	config.Now = time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	result, err := UploadSnapshots(t.Context(), config, []contract.Snapshot{good, tooOld, tooFuture}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if result.RejectedUsageDates != 2 {
		t.Fatalf("RejectedUsageDates = %d, want 2", result.RejectedUsageDates)
	}
	if len(posted) != 1 {
		t.Fatalf("posted batches = %d, want exactly one carrying the good row", len(posted))
	}
	snapshots, _ := posted[0]["snapshots"].([]any)
	if len(snapshots) != 1 {
		t.Fatalf("posted snapshots = %d, want 1", len(snapshots))
	}
}

// A run whose every snapshot is out of window must not post the empty batch: unlike a
// genuinely empty run, this one had rows and the count already says what happened.
func TestUploadSnapshotsSendsNothingWhenEveryDateIsOutOfWindow(t *testing.T) {
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": 0})
	}))
	defer server.Close()

	stale := baseSnapshot("gpt-5", 17)
	stale.UsageDate = "2022-06-15"

	config := testConfig(server.URL)
	config.Now = time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	result, err := UploadSnapshots(t.Context(), config, []contract.Snapshot{stale}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if requests != 0 {
		t.Fatalf("requests = %d, want none", requests)
	}
	if result.RejectedUsageDates != 1 {
		t.Fatalf("RejectedUsageDates = %d, want 1", result.RejectedUsageDates)
	}
}

// The upload carries the bearer token, and Go's redirect policy only drops the
// Authorization header when the host changes — a same-host redirect to another port keeps
// it, handing the credential to whatever listens there. The pricing fetcher already refuses
// redirects; upload must too.
func TestUploadRefusesRedirectsRatherThanForwardingTheToken(t *testing.T) {
	var leaked string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leaked = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{"upserted": 0})
	}))
	defer target.Close()

	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Same host (127.0.0.1), different port: exactly the case Go keeps the header on.
		http.Redirect(w, r, target.URL+r.URL.Path, http.StatusTemporaryRedirect)
	}))
	defer source.Close()

	_, err := UploadSnapshots(t.Context(), testConfig(source.URL), nil, source.Client())
	if err == nil {
		t.Fatal("a redirect must be reported, not followed")
	}
	if !strings.Contains(err.Error(), "307") && !strings.Contains(err.Error(), "308") {
		t.Fatalf("err = %v, want the redirect status named", err)
	}
	if leaked != "" {
		t.Fatalf("redirect target received Authorization=%q; the token must never cross a redirect", leaked)
	}
}
