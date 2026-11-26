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
	// Now overrides the clock used for the upload-date window. Zero means the
	// wall clock; tests set it so a fixture date stays inside the window.
	Now time.Time
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
	// RejectedUsageDates counts snapshots dropped before upload because their
	// usageDate falls outside the server's accepted window.
	RejectedUsageDates int
	// Rejected names the dropped snapshots so the CLI can report which rows
	// went missing, the way the TS uploader does.
	Rejected []RejectedSnapshot
	// Delivered is the set the server accepted or already held (the uploadable
	// rows, minus nothing). The cursor acknowledgement must use this list, not
	// the collection: a row dropped here never reached the server, and
	// acknowledging it would clear its pending entry so it is never retried.
	Delivered []contract.Snapshot
	// Blocked names rows the server rejected with a validation detail. They are
	// neither delivered nor permanently rejected: they stay pending, out of the
	// acknowledgement set, until a later run gets them through.
	Blocked []BlockedSnapshot
}

// RejectedSnapshot is one snapshot the upload path dropped because the server
// would reject any batch containing it.
type RejectedSnapshot struct {
	Snapshot contract.Snapshot
	Issue    string
}

// BlockedSnapshot is one snapshot the server rejected with a named validation
// detail (the `error.details` entries of a 400). Unlike Rejected it is not
// permanently unuploadable — the condition may clear (a clock catching up, a
// server-side fix) — so it stays pending in the cursor and must never be
// acknowledged.
type BlockedSnapshot struct {
	Snapshot contract.Snapshot
	Code     string
}

// maxIsolationRounds bounds how many times one batch is shrunk and re-sent
// after the server named rejected rows. A server that keeps naming rows must
// not be able to loop the client; after two rounds the batch fails as before.
const maxIsolationRounds = 2

// maxValidationBodyBytes mirrors the TS reader's cap. A 400 body larger than
// this is not one of ours and is treated as having no details.
const maxValidationBodyBytes = 64 * 1024

// validationIssue is one parsed `error.details` entry.
type validationIssue struct {
	Index int
	Code  string
}

// ValidationError is a 400 whose body named the rows it rejected. Callers use
// it to isolate those rows and deliver the rest of the batch.
type ValidationError struct {
	// Kind is "Upload" or "Snapshot check", keeping the pre-existing failure
	// wording: callers and tests classify failures by these strings.
	Kind      string
	Status    int
	Snapshots []validationIssue
	Keys      []validationIssue
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("%s failed with status %d", e.Kind, e.Status)
}

// parseValidationDetailPath accepts exactly the paths the server's whitelist
// emits: `<root>.<n>` or `<root>.<n>.<field>`, root being snapshots or keys.
func parseValidationDetailPath(path string) (root string, index int, ok bool) {
	parts := strings.Split(path, ".")
	if len(parts) != 2 && len(parts) != 3 {
		return "", 0, false
	}
	if parts[0] != "snapshots" && parts[0] != "keys" {
		return "", 0, false
	}
	parsed, err := strconv.Atoi(parts[1])
	if err != nil || parsed < 0 {
		return "", 0, false
	}
	return parts[0], parsed, true
}

// parseValidationError reads a bounded 400 body and turns it into a
// ValidationError, or returns the plain status error when the body carries no
// usable details (an old server, a proxy, a non-JSON body).
func parseValidationError(response *http.Response, kind string) error {
	plain := fmt.Errorf("%s failed with status %d", kind, response.StatusCode)
	body, err := io.ReadAll(io.LimitReader(response.Body, maxValidationBodyBytes+1))
	if err != nil || len(body) > maxValidationBodyBytes {
		return plain
	}
	var payload struct {
		Error struct {
			Details []struct {
				Path string `json:"path"`
				Code string `json:"code"`
			} `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return plain
	}
	validation := &ValidationError{Kind: kind, Status: response.StatusCode}
	seenSnapshots := map[int]bool{}
	seenKeys := map[int]bool{}
	for _, detail := range payload.Error.Details {
		root, index, ok := parseValidationDetailPath(detail.Path)
		if !ok {
			continue
		}
		code := detail.Code
		if code == "" {
			code = "invalid-value"
		}
		switch root {
		case "snapshots":
			if seenSnapshots[index] {
				continue
			}
			seenSnapshots[index] = true
			validation.Snapshots = append(validation.Snapshots, validationIssue{Index: index, Code: code})
		case "keys":
			if seenKeys[index] {
				continue
			}
			seenKeys[index] = true
			validation.Keys = append(validation.Keys, validationIssue{Index: index, Code: code})
		}
	}
	if len(validation.Snapshots) == 0 && len(validation.Keys) == 0 {
		return plain
	}
	return validation
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

	// The server rejects a whole batch when any snapshot's usageDate falls outside
	// [MinUploadIsoDate, today+1], and the client cannot retry its way out of that: the
	// date is a property of the row, not of the request. Left in, one such row fails the
	// batch it lands in on every run, and five consecutive non-transient failures pause
	// uploads for 24 hours — a single bad date taking the whole machine offline.
	//
	// Dropping it here is not a silent downgrade: the count comes back on Result, and a
	// snapshot the server can never accept is not data this run could have delivered.
	now := config.Now
	if now.IsZero() {
		now = time.Now()
	}
	uploadable := make([]contract.Snapshot, 0, len(snapshots))
	rejected := 0
	rejectedDetails := make([]RejectedSnapshot, 0)
	for _, snapshot := range snapshots {
		if issue := contract.UploadIsoDateIssue(snapshot.UsageDate, now); issue != "" {
			rejected++
			rejectedDetails = append(rejectedDetails, RejectedSnapshot{Snapshot: snapshot, Issue: issue})
			continue
		}
		uploadable = append(uploadable, snapshot)
	}

	var result Result
	result.RejectedUsageDates = rejected
	result.Rejected = rejectedDetails
	if len(uploadable) == 0 {
		// Nothing left to send. The empty batch is not posted: unlike the no-snapshots
		// case above, this run did have rows and the server has nothing to say about
		// them that the count does not already.
		result.Delivered = uploadable
		return result, nil
	}

	blocked := make(map[contract.Snapshot]bool)
	uploaded := false
	for _, batch := range chunk(uploadable, snapshotBatchSize) {
		checked, err := filterChanged(ctx, config, batch, client)
		if err != nil {
			return Result{}, err
		}
		result.Skipped += checked.skipped
		if len(checked.snapshots) == 0 {
			continue
		}
		upserted, blockedRows, err := uploadBatchWithIsolation(ctx, config, checked.snapshots, client)
		if err != nil {
			return Result{}, err
		}
		result.Upserted += upserted
		for _, row := range blockedRows {
			blocked[row.Snapshot] = true
			result.Blocked = append(result.Blocked, row)
		}
		uploaded = true
	}
	if !uploaded {
		upserted, err := uploadBatch(ctx, config, nil, client)
		if err != nil {
			return Result{}, err
		}
		result.Upserted += upserted
	}
	// Every uploadable row reached the server or already sat there — except the
	// ones the server named as rejected, which stay pending and unacknowledged.
	result.Delivered = make([]contract.Snapshot, 0, len(uploadable))
	for _, snapshot := range uploadable {
		if blocked[snapshot] {
			continue
		}
		result.Delivered = append(result.Delivered, snapshot)
	}
	return result, nil
}

// uploadBatchWithIsolation posts one batch, and on a 400 that names rows,
// removes exactly those rows and re-sends the rest — at most
// maxIsolationRounds times. Rows the server named come back as Blocked; any
// other error (no usable details, a non-validation failure, rounds exhausted)
// fails the upload as it would have before.
func uploadBatchWithIsolation(ctx context.Context, config Config, snapshots []contract.Snapshot, client *http.Client) (int, []BlockedSnapshot, error) {
	send := snapshots
	blocked := make([]BlockedSnapshot, 0)
	for round := 0; ; round++ {
		upserted, err := uploadBatch(ctx, config, send, client)
		if err == nil {
			return upserted, blocked, nil
		}
		var validation *ValidationError
		if !errors.As(err, &validation) || round == maxIsolationRounds {
			return 0, blocked, err
		}
		removed := map[int]bool{}
		for _, issue := range validation.Snapshots {
			if issue.Index < len(send) {
				removed[issue.Index] = true
				blocked = append(blocked, BlockedSnapshot{Snapshot: send[issue.Index], Code: issue.Code})
			}
		}
		if len(removed) == 0 {
			return 0, blocked, err
		}
		kept := make([]contract.Snapshot, 0, len(send)-len(removed))
		for index, snapshot := range send {
			if !removed[index] {
				kept = append(kept, snapshot)
			}
		}
		if len(kept) == 0 {
			return 0, blocked, nil
		}
		send = kept
	}
}

type filterResult struct {
	snapshots []contract.Snapshot
	skipped   int
}

func filterChanged(ctx context.Context, config Config, snapshots []contract.Snapshot, client *http.Client) (filterResult, error) {
	// The check keys are parallel to the snapshots; when the server rejects a
	// key, only that key is dropped and re-checked around. A dropped key simply
	// does not appear in `existing`, so its snapshot stays in the changed set —
	// the ingest isolation decides whether it is blocked.
	keys := make([]map[string]string, 0, len(snapshots))
	for _, snapshot := range snapshots {
		keys = append(keys, map[string]string{
			"source":    string(snapshot.Source),
			"usageDate": snapshot.UsageDate,
			"model":     snapshot.Model,
		})
	}
	var existing []ExistingSnapshotHash
	for round := 0; ; round++ {
		var unsupported bool
		var err error
		existing, unsupported, err = fetchExistingHashes(ctx, config, keys, client)
		if err == nil {
			if unsupported {
				return filterResult{snapshots: snapshots}, nil
			}
			break
		}
		var validation *ValidationError
		if !errors.As(err, &validation) || round == maxIsolationRounds {
			return filterResult{}, err
		}
		removed := map[int]bool{}
		for _, issue := range validation.Keys {
			if issue.Index < len(keys) {
				removed[issue.Index] = true
			}
		}
		if len(removed) == 0 {
			return filterResult{}, err
		}
		kept := make([]map[string]string, 0, len(keys)-len(removed))
		for index, key := range keys {
			if !removed[index] {
				kept = append(kept, key)
			}
		}
		keys = kept
		if len(keys) == 0 {
			return filterResult{snapshots: snapshots}, nil
		}
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

// decodeExactlyOne decodes a single JSON value and requires the body to end
// there. json.Decoder.Decode stops after the first value and reports success
// with anything trailing it, so `{"upserted":1}garbage` would pass here while
// the TS side's JSON.parse rejects it — a body the server never produced, or a
// proxy injecting one, would be booked as a successful upload. The token after
// the value must be io.EOF for the body to count as one document.
func decodeExactlyOne(decoder *json.Decoder, payload any) error {
	if err := decoder.Decode(payload); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("unexpected trailing content after the JSON response")
		}
		return err
	}
	return nil
}

func parseCheckResponse(response *http.Response) (parsedResponse, error) {
	if response.StatusCode == 404 || response.StatusCode == 405 || response.StatusCode == 501 {
		return parsedResponse{unsupported: true}, nil
	}
	if response.StatusCode == http.StatusBadRequest {
		return parsedResponse{}, parseValidationError(response, "Snapshot check")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return parsedResponse{}, fmt.Errorf("Snapshot check failed with status %d", response.StatusCode)
	}
	var payload struct {
		Existing []ExistingSnapshotHash `json:"existing"`
	}
	if err := decodeExactlyOne(json.NewDecoder(response.Body), &payload); err != nil {
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
	if response.StatusCode == http.StatusBadRequest {
		// A validation 400 names the rejected rows; the caller isolates them and
		// re-sends the rest instead of failing the whole batch.
		return parsedResponse{}, parseValidationError(response, "Upload")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return parsedResponse{}, fmt.Errorf("Upload failed with status %d", response.StatusCode)
	}
	var payload struct {
		Upserted *int `json:"upserted"`
	}
	if err := decodeExactlyOne(json.NewDecoder(response.Body), &payload); err != nil {
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
	// The upload carries the bearer token, and Go's redirect policy only drops the
	// Authorization header when the *host* changes — a same-host redirect to another port
	// keeps it, which hands the credential to whatever is listening there. The pricing
	// fetcher already refuses redirects outright; upload does the same. The client is
	// cloned so a caller's own transport and settings survive.
	redirectClient := *client
	redirectClient.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	response, err := redirectClient.Do(request)
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
				// Clamp the seconds before converting: `seconds * 1e9` as a
				// float past ~9.2e9 seconds overflows time.Duration's int64 and
				// wraps negative, and the min() below would then sleep for an
				// already-negative duration — an immediate retry on the one
				// header value that asked for the longest wait. The cap is 5s,
				// so anything at or past it takes the cap verbatim.
				if maxSeconds := float64(maxRetryDelayMs) / 1000; seconds >= maxSeconds {
					return maxRetryDelayMs * time.Millisecond
				}
				return time.Duration(seconds * float64(time.Second))
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

// BackoffState is one source's persisted consecutive-failure record (a v2
// `sources.<name>` entry).
type BackoffState struct {
	ConsecutiveFailures int    `json:"consecutiveFailures"`
	LastErrorSummary    string `json:"lastErrorSummary"`
	PausedUntil         string `json:"pausedUntil,omitempty"`
}

// backoffFile is the on-disk shape: versioned per-source entries, plus the
// pre-v2 flat fields that are still honoured until their pause expires.
type backoffFile struct {
	Version int                     `json:"version,omitempty"`
	Sources map[string]backoffEntry `json:"sources,omitempty"`
	// Legacy v1 fields. They carry no source attribution, so they are never
	// migrated onto a source: they keep pausing every source until their
	// pause expires, then a later write drops them.
	LegacyFailures *float64 `json:"consecutiveFailures,omitempty"`
	LegacySummary  *string  `json:"lastErrorSummary,omitempty"`
	LegacyPaused   string   `json:"pausedUntil,omitempty"`
}

// backoffEntry mirrors BackoffState with the loader's float gate so a
// hostile `consecutiveFailures` cannot wrap negative through int conversion.
type backoffEntry struct {
	ConsecutiveFailures *float64 `json:"consecutiveFailures"`
	LastErrorSummary    *string  `json:"lastErrorSummary"`
	PausedUntil         string   `json:"pausedUntil"`
}

func (entry backoffEntry) state() BackoffState {
	state := BackoffState{LastErrorSummary: "", PausedUntil: entry.PausedUntil}
	if entry.LastErrorSummary != nil {
		state.LastErrorSummary = *entry.LastErrorSummary
	}
	if entry.ConsecutiveFailures != nil {
		state.ConsecutiveFailures = clampFailureCount(*entry.ConsecutiveFailures)
	}
	return state
}

// clampFailureCount guards the int conversion: int(1e30) is
// implementation-defined and wraps to a negative on amd64/arm64, which would
// silently stop the pause from ever engaging again. Every value at or past
// the threshold pauses alike, so the exact count beyond it does not matter.
func clampFailureCount(failures float64) int {
	if failures < 0 || math.IsNaN(failures) {
		return 0
	}
	if failures > uploadFailurePauseThreshold {
		return uploadFailurePauseThreshold
	}
	return int(failures)
}

// loadBackoffFile reads the state file; any read or parse problem yields nil
// (absent state), matching the TS loader's fail-open behaviour.
func loadBackoffFile(stateDir string) *backoffFile {
	data, err := os.ReadFile(filepath.Join(stateDir, backoffFileName))
	if err != nil {
		return nil
	}
	var file backoffFile
	if json.Unmarshal(data, &file) != nil {
		return nil
	}
	return &file
}

func parsePausedUntil(value string, now time.Time) (string, bool) {
	if value == "" {
		return "", false
	}
	until, err := time.Parse(time.RFC3339, value)
	if err != nil || !until.After(now) {
		return "", false
	}
	return value, true
}

// pauseLaterThan compares two valid pause timestamps. String order is not
// enough: Go writes RFC3339Nano (fractional part variable-length) and the TS
// collector writes toISOString (always .000Z), so equal instants can spell
// differently and mixed files must still order correctly.
func pauseLaterThan(left, right string) bool {
	leftTime, leftErr := time.Parse(time.RFC3339, left)
	rightTime, rightErr := time.Parse(time.RFC3339, right)
	if leftErr != nil {
		return false
	}
	if rightErr != nil {
		return true
	}
	return leftTime.After(rightTime)
}

// LoadBackoff reads the legacy (pre-v2) flat pause record; nil when the file
// has no complete flat record. Kept for the v1 compatibility tests and the
// status surface; per-source state goes through IsPaused.
func LoadBackoff(stateDir string) *BackoffState {
	file := loadBackoffFile(stateDir)
	if file == nil || file.LegacyFailures == nil || file.LegacySummary == nil {
		return nil
	}
	return &BackoffState{
		ConsecutiveFailures: clampFailureCount(*file.LegacyFailures),
		LastErrorSummary:    *file.LegacySummary,
		PausedUntil:         file.LegacyPaused,
	}
}

// IsPaused reports an active pause window for the source, or false when
// uploads may proceed. A legacy flat pause still covers every source (that is
// what it did before the split); a v2 pause covers only its own source.
func IsPaused(stateDir string, source string, now time.Time) (string, bool) {
	file := loadBackoffFile(stateDir)
	if file == nil {
		return "", false
	}
	pausedUntil, paused := "", false
	if entry, exists := file.Sources[source]; exists {
		pausedUntil, paused = parsePausedUntil(entry.PausedUntil, now)
	}
	if legacy, ok := parsePausedUntil(file.LegacyPaused, now); ok {
		if !paused || pauseLaterThan(legacy, pausedUntil) {
			pausedUntil, paused = legacy, true
		}
	}
	return pausedUntil, paused
}

// RecordFailure counts one non-transient upload failure for the source and
// pauses that source for a day once five accumulate. Pending snapshots stay in
// the cursor, so pausing loses nothing. A failed write is returned, not
// swallowed: the caller reports it the way the TS collector does, and a silent
// failure would leave the run claiming a pause that was never persisted.
func RecordFailure(stateDir string, source string, uploadErr error, now time.Time) (BackoffState, error) {
	file := loadBackoffFile(stateDir)
	if file == nil {
		file = &backoffFile{}
	}
	if file.Sources == nil {
		file.Sources = map[string]backoffEntry{}
	}
	previous := 0
	if entry, exists := file.Sources[source]; exists {
		// A v2 entry is the only thing that carries over. The legacy count is
		// deliberately not inherited: it cannot be attributed to this source,
		// and inheriting it could pause a healthy source on its first failure.
		previous = clampFailureCount(valueOrZero(entry.ConsecutiveFailures))
	}
	state := BackoffState{
		ConsecutiveFailures: previous + 1,
		LastErrorSummary:    Summarize(uploadErr),
	}
	if state.ConsecutiveFailures >= uploadFailurePauseThreshold {
		state.PausedUntil = now.Add(uploadFailurePauseMs).UTC().Format(time.RFC3339Nano)
	}
	file.Sources[source] = backoffEntry{
		ConsecutiveFailures: float64Ptr(float64(state.ConsecutiveFailures)),
		LastErrorSummary:    &state.LastErrorSummary,
		PausedUntil:         state.PausedUntil,
	}
	file.Version = 2
	dropExpiredLegacy(file, now)
	return state, writeBackoffFile(stateDir, file)
}

// RecordSuccess clears the source's entry. The legacy flat fields go only once
// their pause has expired; while it is active they still pause every source,
// and dropping them early would lift a machine-wide pause nobody asked to lift.
func RecordSuccess(stateDir string, source string) {
	file := loadBackoffFile(stateDir)
	if file == nil {
		return
	}
	delete(file.Sources, source)
	dropExpiredLegacy(file, time.Now())
	if len(file.Sources) == 0 && file.LegacyFailures == nil && file.LegacySummary == nil {
		_ = os.Remove(filepath.Join(stateDir, backoffFileName))
		return
	}
	file.Version = 2
	_ = writeBackoffFile(stateDir, file)
}

func dropExpiredLegacy(file *backoffFile, now time.Time) {
	if file.LegacyPaused != "" {
		if _, active := parsePausedUntil(file.LegacyPaused, now); active {
			return
		}
	}
	file.LegacyFailures = nil
	file.LegacySummary = nil
	file.LegacyPaused = ""
}

func valueOrZero(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}

func float64Ptr(value float64) *float64 { return &value }

func writeBackoffFile(stateDir string, file *backoffFile) error {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(file, "", "  ")
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
