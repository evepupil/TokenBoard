// Package upload mirrors packages/collector/src/upload.ts: the ingest/check
// protocol, batch size 30, transient retry with Retry-After, response
// validation, and the consecutive-failure pause from upload-backoff.ts.
package upload

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/renameatomic"
)

const (
	snapshotBatchSize       = 30
	transientFetchAttempts  = 3
	defaultRetryDelayMs     = 250
	maxRetryDelayMs         = 5_000
	defaultRequestTimeoutMs = 30_000
	maxRequestTimeoutMs     = 120_000
)

// Config carries what upload needs from the collector configuration.
type Config struct {
	Endpoint    string
	UploadToken string
	// RetryDelayMs overrides the default backoff base (tests set 1). Zero
	// means default.
	RetryDelayMs int
	// RequestTimeoutMs overrides the per-request deadline. Zero means default.
	RequestTimeoutMs int
	// Client nil means http.DefaultClient.
	Client *http.Client
}

// ExistingSnapshotHash is one row of the /check response.
type ExistingSnapshotHash struct {
	Source       contract.Source `json:"source"`
	UsageDate    string          `json:"usageDate"`
	Model        string          `json:"model"`
	SnapshotHash string          `json:"snapshotHash"`
}

// Result reports what one UploadSnapshots call did.
type Result struct {
	Upserted int
	Skipped  int
}

// SnapshotHash is the dedup identity the server stores and compares:
// SHA-256 over Snapshot.HashPayload's exact bytes.
func SnapshotHash(snapshot contract.Snapshot) string {
	sum := sha256.Sum256([]byte(snapshot.HashPayload()))
	return hex.EncodeToString(sum[:])
}

// UploadSnapshots filters snapshots through /check (when the server supports
// it) and posts the changed ones in batches of 30. An empty input still
// posts one empty ingest batch, matching the TS collector's keep-alive
// semantics; if every batch came back unchanged, one empty batch is posted
// too.
func UploadSnapshots(ctx context.Context, config Config, snapshots []contract.Snapshot, client *http.Client) (Result, error) {
	if client == nil {
		client = config.Client
	}
	if client == nil {
		client = http.DefaultClient
	}
	if len(snapshots) == 0 {
		upserted, err := uploadBatch(ctx, config, nil, client)
		if err != nil {
			return Result{}, err
		}
		return Result{Upserted: upserted}, nil
	}

	var result Result
	uploaded := false
	for _, batch := range chunk(snapshots, snapshotBatchSize) {
		checked, err := filterChanged(ctx, config, batch, client)
		if err != nil {
			return Result{}, err
		}
		result.Skipped += checked.skipped
		if len(checked.snapshots) == 0 {
			continue
		}
		upserted, err := uploadBatch(ctx, config, checked.snapshots, client)
		if err != nil {
			return Result{}, err
		}
		result.Upserted += upserted
		uploaded = true
	}
	if !uploaded {
		upserted, err := uploadBatch(ctx, config, nil, client)
		if err != nil {
			return Result{}, err
		}
		result.Upserted += upserted
	}
	return result, nil
}

type filterResult struct {
	snapshots []contract.Snapshot
	skipped   int
}

func filterChanged(ctx context.Context, config Config, snapshots []contract.Snapshot, client *http.Client) (filterResult, error) {
	keys := make([]map[string]string, 0, len(snapshots))
	for _, snapshot := range snapshots {
		keys = append(keys, map[string]string{
			"source":    string(snapshot.Source),
			"usageDate": snapshot.UsageDate,
			"model":     snapshot.Model,
		})
	}
	existing, unsupported, err := fetchExistingHashes(ctx, config, keys, client)
	if err != nil {
		return filterResult{}, err
	}
	if unsupported {
		return filterResult{snapshots: snapshots}, nil
	}
	hashes := make(map[string]string, len(existing))
	for _, row := range existing {
		hashes[contract.SnapshotKey(row.Source, row.UsageDate, row.Model)] = row.SnapshotHash
	}
	var changed []contract.Snapshot
	result := filterResult{}
	for _, snapshot := range snapshots {
		if hashes[contract.SnapshotKey(snapshot.Source, snapshot.UsageDate, snapshot.Model)] == SnapshotHash(snapshot) {
			result.skipped++
			continue
		}
		changed = append(changed, snapshot)
	}
	result.snapshots = changed
	return result, nil
}

// fetchExistingHashes returns unsupported=true for 404/405/501, which the TS
// collector treats as "server predates /check; upload everything".
func fetchExistingHashes(ctx context.Context, config Config, keys []map[string]string, client *http.Client) ([]ExistingSnapshotHash, bool, error) {
	if len(keys) == 0 {
		return nil, false, nil
	}
	body, err := json.Marshal(map[string]any{"keys": keys})
	if err != nil {
		return nil, false, err
	}
	response, err := postWithRetries(ctx, config, config.Endpoint+"/check", body, client, parseCheckResponse)
	if err != nil {
		return nil, false, err
	}
	if response.unsupported {
		return nil, true, nil
	}
	return response.existing, false, nil
}

func uploadBatch(ctx context.Context, config Config, snapshots []contract.Snapshot, client *http.Client) (int, error) {
	// A nil slice would marshal as `null`, but the server (and the TS
	// collector) expect `[]` for the empty keep-alive batch.
	if snapshots == nil {
		snapshots = []contract.Snapshot{}
	}
	body, err := json.Marshal(map[string]any{"snapshots": snapshots})
	if err != nil {
		return 0, err
	}
	response, err := postWithRetries(ctx, config, config.Endpoint, body, client, parseUploadResponse)
	if err != nil {
		return 0, err
	}
	return response.upserted, nil
}

type parsedResponse struct {
	upserted    int
	existing    []ExistingSnapshotHash
	unsupported bool
}

type responseParser func(*http.Response) (parsedResponse, error)

func parseCheckResponse(response *http.Response) (parsedResponse, error) {
	if response.StatusCode == 404 || response.StatusCode == 405 || response.StatusCode == 501 {
		return parsedResponse{unsupported: true}, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return parsedResponse{}, fmt.Errorf("Snapshot check failed with status %d", response.StatusCode)
	}
	var payload struct {
		Existing []ExistingSnapshotHash `json:"existing"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		// The cause is preserved (%w): a body read the per-attempt deadline
		// cut short must stay recognizable as a timeout so it classifies as
		// transient instead of masquerading as a contract breakage.
		return parsedResponse{}, fmt.Errorf("Snapshot check returned invalid response: %w", err)
	}
	// The TS validator requires Array.isArray(value.existing); a missing key
	// is a contract breakage, not an empty history — treating it as empty
	// would silently re-upload everything.
	if payload.Existing == nil {
		return parsedResponse{}, fmt.Errorf("Snapshot check returned invalid response")
	}
	for _, row := range payload.Existing {
		// The bound is in UTF-16 units, like the snapshot schema and TS's
		// `value.length`; a byte count would reject a valid CJK id that is
		// inside the limit.
		if !contract.IsValidIsoDate(row.UsageDate) || row.Model == "" ||
			contract.UTF16Length(row.Model) > contract.MaxUsageModelNameLength || !snapshotHashPattern.MatchString(row.SnapshotHash) ||
			!contract.IsValidSource(string(row.Source)) {
			return parsedResponse{}, fmt.Errorf("Snapshot check returned invalid response")
		}
	}
	return parsedResponse{existing: payload.Existing}, nil
}

func parseUploadResponse(response *http.Response) (parsedResponse, error) {
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return parsedResponse{}, fmt.Errorf("Upload failed with status %d", response.StatusCode)
	}
	var payload struct {
		Upserted *int `json:"upserted"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return parsedResponse{}, fmt.Errorf("Upload returned invalid response: %w", err)
	}
	if payload.Upserted == nil || *payload.Upserted < 0 {
		return parsedResponse{}, fmt.Errorf("Upload returned invalid response")
	}
	return parsedResponse{upserted: *payload.Upserted}, nil
}

var snapshotHashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// postWithRetries mirrors fetchWithRetries: up to three attempts, retrying
// transport errors and the transient statuses (408/429/5xx), honoring
// Retry-After capped at 5s. The per-attempt deadline covers body consumption
// too, matching the TS deadline around fetch plus consumeResponse.
func postWithRetries(ctx context.Context, config Config, url string, body []byte, client *http.Client, parse responseParser) (parsedResponse, error) {
	var lastErr error
	for attempt := 0; attempt < transientFetchAttempts; attempt++ {
		response, cancel, err := postOnce(ctx, config, url, body, client)
		if err != nil {
			lastErr = err
			if attempt < transientFetchAttempts-1 {
				sleepWithContext(ctx, retryDelay(nil, attempt, config.RetryDelayMs))
			}
			continue
		}
		if isRetryableStatus(response.StatusCode) {
			drainAndClose(response)
			cancel()
			if attempt == transientFetchAttempts-1 {
				return parsedResponse{}, statusError(url, response.StatusCode)
			}
			sleepWithContext(ctx, retryDelay(response, attempt, config.RetryDelayMs))
			continue
		}
		parsed, err := consumeParsed(response, cancel, parse)
		if err != nil {
			// A body read the deadline cut short is a timeout — a transport
			// failure the TS side retries, not a contract breakage. It is
			// reported in the TS RequestTimeoutError shape so it classifies
			// as transient (exit 75).
			if timedOut := requestDeadlineExceeded(ctx, config, err); timedOut != nil {
				lastErr = timedOut
				if attempt < transientFetchAttempts-1 {
					sleepWithContext(ctx, retryDelay(nil, attempt, config.RetryDelayMs))
				}
				continue
			}
			// A well-formed response with an unexpected body is a contract
			// breakage, not a transient condition: no retry, like the TS
			// ResponseParsingError path.
			return parsedResponse{}, err
		}
		return parsed, nil
	}
	if lastErr != nil {
		return parsedResponse{}, lastErr
	}
	return parsedResponse{}, errors.New("upload: retries exhausted")
}

// consumeParsed runs the parser and drains the body inside the per-attempt
// deadline. cancel must only fire after the body is fully consumed: a cancel
// before the read would surface large or slow responses as spurious
// canceled-read parse failures instead of timeouts.
func consumeParsed(response *http.Response, cancel context.CancelFunc, parse responseParser) (parsedResponse, error) {
	defer cancel()
	parsed, err := parse(response)
	drainAndClose(response)
	return parsed, err
}

// requestDeadlineExceeded reports the TS-shaped timeout error when err was
// caused by the per-attempt deadline (and not the caller's context). The
// wording matches RequestTimeoutError so IsTransientNetworkError's
// "request timed out" pattern sees it and the scheduled runner retries.
func requestDeadlineExceeded(parent context.Context, config Config, err error) error {
	if !errors.Is(err, context.DeadlineExceeded) || parent.Err() != nil {
		return nil
	}
	return fmt.Errorf("TokenBoard request timed out after %dms", requestTimeoutMs(config))
}

func postOnce(ctx context.Context, config Config, url string, body []byte, client *http.Client) (*http.Response, context.CancelFunc, error) {
	timeoutMs := requestTimeoutMs(config)
	requestCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		cancel()
		return nil, nil, err
	}
	request.Header.Set("authorization", "Bearer "+config.UploadToken)
	request.Header.Set("content-type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		cancel()
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			return nil, nil, fmt.Errorf("TokenBoard request timed out after %dms", timeoutMs)
		}
		return nil, nil, err
	}
	return response, cancel, nil
}

// requestTimeoutMs resolves the per-request deadline: the Config override
// first, then TOKENBOARD_FETCH_TIMEOUT_MS (strictly positive digits, like
// the TS env check), capped at two minutes, else the 30s default.
var positiveDigitsPattern = regexp.MustCompile(`^[1-9]\d*$`)

// maxSafeInteger is JavaScript's Number.MAX_SAFE_INTEGER. TS rejects a larger
// timeout value outright (Number.isSafeInteger), so a value past it falls back
// to the default instead of being capped; parsing it here would silently pick
// a different deadline for the same input.
const maxSafeInteger = 1<<53 - 1

func requestTimeoutMs(config Config) int {
	if config.RequestTimeoutMs > 0 {
		return min(config.RequestTimeoutMs, maxRequestTimeoutMs)
	}
	if raw := strings.TrimSpace(os.Getenv("TOKENBOARD_FETCH_TIMEOUT_MS")); raw != "" && positiveDigitsPattern.MatchString(raw) {
		if parsed, err := strconv.Atoi(raw); err == nil && int64(parsed) <= maxSafeInteger {
			return min(parsed, maxRequestTimeoutMs)
		}
	}
	return defaultRequestTimeoutMs
}

func isRetryableStatus(status int) bool {
	switch status {
	case http.StatusRequestTimeout, http.StatusTooManyRequests,
		http.StatusInternalServerError, http.StatusBadGateway,
		http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	}
	return false
}

func statusError(url string, status int) error {
	if strings.HasSuffix(url, "/check") {
		return fmt.Errorf("Snapshot check failed with status %d", status)
	}
	return fmt.Errorf("Upload failed with status %d", status)
}

func retryDelay(response *http.Response, attempt, configuredMs int) time.Duration {
	if response != nil {
		if header := response.Header.Get("Retry-After"); header != "" {
			// Numeric seconds are accepted the same way as TS, but a
			// non-numeric value is parsed more strictly: http.ParseTime
			// understands the three HTTP date forms while the TS side
			// falls back to Date.parse, so an unusual date the server sends
			// fails here and drops to the default backoff instead.
			if seconds, err := strconv.ParseFloat(strings.TrimSpace(header), 64); err == nil && seconds >= 0 && !math.IsInf(seconds, 0) {
				return min(time.Duration(seconds*float64(time.Second)), maxRetryDelayMs*time.Millisecond)
			}
			if until, err := http.ParseTime(header); err == nil {
				delay := time.Until(until)
				if delay < 0 {
					delay = 0
				}
				return min(delay, maxRetryDelayMs*time.Millisecond)
			}
		}
	}
	base := defaultRetryDelayMs
	if configuredMs >= 0 && configuredMs != 0 {
		base = configuredMs
	}
	if configuredMs == 0 {
		if parsed, ok := contract.ParseInt(os.Getenv("TOKENBOARD_FETCH_RETRY_DELAY_MS")); ok && parsed >= 0 {
			base = parsed
		}
	}
	// Clamp before shifting: the result is capped below anyway, and an
	// oversized base would overflow base<<attempt into a negative duration,
	// turning the backoff into an immediate retry.
	if base > maxRetryDelayMs {
		base = maxRetryDelayMs
	}
	delay := base << attempt
	return min(time.Duration(delay)*time.Millisecond, maxRetryDelayMs*time.Millisecond)
}

func sleepWithContext(ctx context.Context, d time.Duration) {
	if d <= 0 {
		return
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

func chunk(snapshots []contract.Snapshot, size int) [][]contract.Snapshot {
	var batches [][]contract.Snapshot
	for start := 0; start < len(snapshots); start += size {
		end := min(start+size, len(snapshots))
		batches = append(batches, snapshots[start:end])
	}
	return batches
}

func drainAndClose(response *http.Response) {
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
}

// Backoff pause state, mirroring upload-backoff.ts.

const (
	uploadFailurePauseThreshold = 5
	uploadFailurePauseMs        = 24 * time.Hour
	backoffFileName             = "upload-backoff.json"
)

// BackoffState is the persisted consecutive-failure record.
type BackoffState struct {
	ConsecutiveFailures int    `json:"consecutiveFailures"`
	LastErrorSummary    string `json:"lastErrorSummary"`
	PausedUntil         string `json:"pausedUntil,omitempty"`
}

// LoadBackoff reads the pause state; any read or parse problem yields nil
// (absent state). Mirrors the TS loader's type gate: consecutiveFailures
// must be a number and lastErrorSummary a string, or the record is treated
// as absent rather than half-read.
func LoadBackoff(stateDir string) *BackoffState {
	data, err := os.ReadFile(filepath.Join(stateDir, backoffFileName))
	if err != nil {
		return nil
	}
	var raw struct {
		ConsecutiveFailures *float64 `json:"consecutiveFailures"`
		LastErrorSummary    *string  `json:"lastErrorSummary"`
		PausedUntil         string   `json:"pausedUntil"`
	}
	if json.Unmarshal(data, &raw) != nil || raw.ConsecutiveFailures == nil || raw.LastErrorSummary == nil {
		return nil
	}
	return &BackoffState{
		ConsecutiveFailures: int(*raw.ConsecutiveFailures),
		LastErrorSummary:    *raw.LastErrorSummary,
		PausedUntil:         raw.PausedUntil,
	}
}

// IsPaused reports an active pause window, or nil when uploads may proceed.
func IsPaused(stateDir string, now time.Time) (string, bool) {
	state := LoadBackoff(stateDir)
	if state == nil || state.PausedUntil == "" {
		return "", false
	}
	until, err := time.Parse(time.RFC3339, state.PausedUntil)
	if err != nil || !until.After(now) {
		return "", false
	}
	return state.PausedUntil, true
}

// RecordFailure counts one non-transient upload failure and pauses uploads
// for a day once five accumulate. Pending snapshots stay in the cursor, so
// pausing loses nothing. A failed write is returned, not swallowed: the caller
// reports it the way the TS collector does, and a silent failure would leave
// the run claiming a pause that was never persisted.
func RecordFailure(stateDir string, uploadErr error, now time.Time) (BackoffState, error) {
	previous := LoadBackoff(stateDir)
	state := BackoffState{
		ConsecutiveFailures: 1,
		LastErrorSummary:    Summarize(uploadErr),
	}
	if previous != nil {
		state.ConsecutiveFailures = previous.ConsecutiveFailures + 1
	}
	if state.ConsecutiveFailures >= uploadFailurePauseThreshold {
		state.PausedUntil = now.Add(uploadFailurePauseMs).UTC().Format(time.RFC3339Nano)
	}
	return state, writeBackoff(stateDir, state)
}

// RecordSuccess clears the backoff state entirely.
func RecordSuccess(stateDir string) {
	_ = os.Remove(filepath.Join(stateDir, backoffFileName))
}

func writeBackoff(stateDir string, state BackoffState) error {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(stateDir, fmt.Sprintf("%s.tmp-go-%d-%s", backoffFileName, os.Getpid(), randomHexSuffix()))
	if err := os.WriteFile(tmp, payload, 0o600); err != nil {
		return err
	}
	if err := renameatomic.Rename(tmp, filepath.Join(stateDir, backoffFileName)); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// randomHexSuffix keeps two writers' temp files apart even when a pid is
// recycled, matching the TS backoff writer's `${pid}-${hex}` temp name.
func randomHexSuffix() string {
	var buf [4]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf[:])
}

// Summarize truncates an error message to 200 characters with an ellipsis,
// the same shape the TS backoff stores. The cut counts runes, not bytes:
// slicing bytes could split a multi-byte character and store invalid UTF-8
// (the TS side slices UTF-16 units; the two differ only for astral-plane
// characters in a display-only field). URLs are reduced to their origin
// first — this string is persisted, and a transport error's full URL may
// carry query parameters that do not belong in a long-lived file.
func Summarize(uploadErr error) string {
	message := RedactURLs(uploadErr.Error())
	runes := []rune(message)
	if len(runes) > 200 {
		return string(runes[:197]) + "…"
	}
	return message
}

var urlPattern = regexp.MustCompile(`https?://[^\s"'<>]+`)

// RedactURLs rewrites every http(s) URL in the message down to its scheme,
// host and port. Credentials and query strings are dropped; anything that
// fails to parse keeps its path-free prefix rather than the raw text.
func RedactURLs(message string) string {
	return urlPattern.ReplaceAllStringFunc(message, func(raw string) string {
		// Trailing punctuation is sentence structure, not URL.
		trimmed := strings.TrimRight(raw, ".,;:!?)]}")
		trailer := raw[len(trimmed):]
		parsed, err := url.Parse(trimmed)
		if err != nil || parsed.Host == "" {
			return "https://<redacted>" + trailer
		}
		return parsed.Scheme + "://" + parsed.Host + trailer
	})
}
