// Package pricing ports model-pricing.ts: the collector-side model catalogue
// (network, cache, bundled static fallback), the ccusage pricing overrides it
// generates, and the dynamic ccusage config written into the state directory.
//
// Hook mode is offline: the catalogue is served from the cache or the bundled
// static file, never the network, and every diagnostic the TS side prints is
// reproduced so the scheduled log reads the same from either implementation.
package pricing

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/MisonL/TokenBoard/clients/go/internal/renameatomic"
)

// CacheSchemaVersion is the model pricing cache format version.
const CacheSchemaVersion = 1

// CacheTTL is how long a fetched catalogue is served without a network call.
const CacheTTL = 24 * time.Hour

// PageSize is the catalogue page size requested from the server.
const PageSize = 1_000

// RequestTimeout bounds one catalogue request.
const RequestTimeout = 20 * time.Second

// MaxResponseBytes bounds one catalogue response.
const MaxResponseBytes = 16 * 1024 * 1024

// CacheFileName is the pricing cache file inside the state directory.
const CacheFileName = "model-pricing-cache.json"

// DynamicConfigFileName is the generated ccusage config inside the state
// directory.
const DynamicConfigFileName = "ccusage.dynamic.json"

// bundledConfig is the ccusage config shipped with the collector. The copy
// here must stay byte-identical to packages/collector/ccusage.json;
// bundled_test.go fails the build when they drift.
//
//go:embed ccusage.json
var bundledConfig []byte

var (
	providerIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	controlCharacters = regexp.MustCompile(`[\p{Cc}\p{Cf}\p{Cs}]`)
	// modelIDLineTerminators is the set JS's `.` (with the u flag, no s flag)
	// refuses to match.
	modelIDLineTerminators = regexp.MustCompile("[\n\r\u2028\u2029]")
)

// isValidModelID ports the TS /^(?![.]{1,2}$).{1,512}$/u check: 1–512 UTF-16
// code units that are not a line terminator, and not "." or "..".
func isValidModelID(modelID string) bool {
	if modelID == "." || modelID == ".." {
		return false
	}
	if modelIDLineTerminators.MatchString(modelID) {
		return false
	}
	units := 0
	for _, r := range modelID {
		if r > 0xFFFF {
			units += 2
			continue
		}
		units++
	}
	return units >= 1 && units <= 512
}

// Model is one catalogue row.
type Model struct {
	Provider                 string
	ModelID                  string
	InputCostPerMillion      float64
	OutputCostPerMillion     float64
	CacheReadCostPerMillion  *float64
	CacheWriteCostPerMillion *float64
	ContextWindow            float64
	MaxInputTokens           *float64
	Pricing                  map[string]any
}

// Catalogue is a resolved pricing source.
type Catalogue struct {
	Models         []Model
	Source         string // "network", "cache" or "static"
	EndpointOrigin string
	FetchedAt      string
	ETag           string
	HasETag        bool
}

// LoadInput configures one catalogue resolution.
type LoadInput struct {
	Endpoint string
	StateDir string
	HookMode bool
	Now      time.Time
	// Fetcher replaces the HTTP client; tests use it to answer without network.
	Fetcher func(*http.Request) (*http.Response, error)
	Stderr  func(line string)
}

// EndpointOriginFromEndpoint mirrors endpointOriginFromEndpoint: the URL
// origin, or "" when the endpoint is absent or not http(s).
//
// The origin is the pricing cache's identity, and both clients share one
// state directory, so it must match the TS `new URL(endpoint).origin` exactly:
// lowercase host, the scheme's default port dropped, IPv6 hosts kept in
// brackets. Keeping parsed.Host verbatim would make an endpoint spelled with
// a capital letter or an explicit :443 invalidate a cache the other client
// wrote. The same normalization lives in cli.cursorScopeFromEndpoint for the
// cursor scope; the two are kept deliberately identical.
func EndpointOriginFromEndpoint(endpoint string) string {
	if strings.TrimSpace(endpoint) == "" {
		return ""
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]" // url.Hostname strips IPv6 brackets
	}
	if port := parsed.Port(); port != "" && !isDefaultPort(parsed.Scheme, port) {
		host = host + ":" + port
	}
	return parsed.Scheme + "://" + host
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

// ModelPricingURL builds one catalogue page URL.
func ModelPricingURL(endpointOrigin, cursor string) string {
	values := url.Values{}
	values.Set("limit", strconv.Itoa(PageSize))
	if cursor != "" {
		values.Set("cursor", cursor)
	}
	return endpointOrigin + "/api/v1/model-pricing?" + values.Encode()
}

// LoadCatalogue ports loadModelPricingCatalogue.
func LoadCatalogue(input LoadInput) (Catalogue, error) {
	now := input.Now
	if now.IsZero() {
		now = time.Now()
	}
	stderr := input.Stderr
	if stderr == nil {
		stderr = func(string) {}
	}
	endpointOrigin := EndpointOriginFromEndpoint(input.Endpoint)
	stateDir := strings.TrimSpace(input.StateDir)
	if stateDir == "" {
		stateDir = defaultStateDir()
	}
	cachePath := filepath.Join(stateDir, CacheFileName)
	cached, hasCached := readPricingCache(cachePath, endpointOrigin, stderr)

	if hasCached && isCacheFresh(cached, now) {
		stderr(fmt.Sprintf("TokenBoard model pricing: using cached catalogue (%d models)", len(cached.Models)))
		cached.Source = "cache"
		return cached, nil
	}

	if input.HookMode {
		if hasCached {
			stderr(fmt.Sprintf(
				"TokenBoard model pricing: hook mode is offline; using cached catalogue (%d models)", len(cached.Models)))
			cached.Source = "cache"
			return cached, nil
		}
		stderr("TokenBoard model pricing: hook mode has no usable cache; using bundled static pricing")
		return StaticCatalogue(now)
	}

	if endpointOrigin == "" {
		// Distinguish "not set" from "set but unusable": both end at the same
		// fallback, but the operator needs to know which one to fix.
		problem := "is not configured"
		if strings.TrimSpace(input.Endpoint) != "" {
			problem = "is invalid"
		}
		if hasCached {
			stderr(fmt.Sprintf(
				"TokenBoard model pricing: TOKENBOARD_ENDPOINT %s; using last successful cache (%d models)",
				problem, len(cached.Models)))
			cached.Source = "cache"
			return cached, nil
		}
		stderr(fmt.Sprintf("TokenBoard model pricing: TOKENBOARD_ENDPOINT %s; using bundled static pricing", problem))
		return StaticCatalogue(now)
	}

	fetched, err := FetchCatalogue(endpointOrigin, cached, hasCached, now, input.Fetcher)
	if err != nil {
		detail := err.Error()
		if hasCached {
			stderr(fmt.Sprintf(
				"TokenBoard model pricing: refresh failed (%s); using last successful cache (%d models)",
				detail, len(cached.Models)))
			cached.Source = "cache"
			return cached, nil
		}
		stderr(fmt.Sprintf(
			"TokenBoard model pricing: refresh failed (%s); using bundled static pricing", detail))
		return StaticCatalogue(now)
	}

	if err := writePricingCache(cachePath, fetched); err != nil {
		stderr(fmt.Sprintf(
			"TokenBoard model pricing: cache write failed (%s); using fetched catalogue (%d models)",
			err.Error(), len(fetched.Models)))
	}
	stderr(fmt.Sprintf("TokenBoard model pricing: refreshed catalogue (%d models)", len(fetched.Models)))
	fetched.Source = "network"
	return fetched, nil
}

func isCacheFresh(catalogue Catalogue, now time.Time) bool {
	fetchedAt, err := time.Parse(time.RFC3339Nano, catalogue.FetchedAt)
	if err != nil {
		return false
	}
	delta := now.Sub(fetchedAt)
	return delta >= 0 && delta <= CacheTTL
}

// FetchCatalogue reads every catalogue page. The first page carries the cached
// ETag; a 304 refreshes the timestamp instead of the models.
func FetchCatalogue(
	endpointOrigin string,
	cached Catalogue,
	hasCached bool,
	now time.Time,
	fetcher func(*http.Request) (*http.Response, error),
) (Catalogue, error) {
	models := []Model{}
	seen := map[string]bool{}
	cursor := ""
	etag := cached.ETag
	hasETag := hasCached && cached.HasETag
	seenCursors := map[string]bool{}
	for page := 0; page < 100; page++ {
		requestURL := ModelPricingURL(endpointOrigin, cursor)
		request, err := http.NewRequest(http.MethodGet, requestURL, nil)
		if err != nil {
			return Catalogue{}, err
		}
		request.Header.Set("accept", "application/json")
		if page == 0 && hasETag {
			request.Header.Set("if-none-match", etag)
		}
		response, err := doRequest(fetcher, request)
		if err != nil {
			return Catalogue{}, err
		}
		body, status, responseETag, readErr := readResponse(response)
		if status == http.StatusNotModified {
			if !hasCached {
				return Catalogue{}, errors.New("Model pricing source returned 304 without a cache")
			}
			refreshed := cached
			refreshed.FetchedAt = now.UTC().Format("2006-01-02T15:04:05.000Z")
			return refreshed, nil
		}
		if readErr != nil {
			return Catalogue{}, readErr
		}
		if status >= 300 && status < 400 {
			return Catalogue{}, fmt.Errorf("Model pricing source returned an unexpected redirect HTTP %d", status)
		}
		if status < 200 || status >= 300 {
			return Catalogue{}, fmt.Errorf("Model pricing source returned HTTP %d", status)
		}
		parsed, err := ValidateResponse(body)
		if err != nil {
			return Catalogue{}, err
		}
		if page == 0 && responseETag != "" {
			etag = responseETag
			hasETag = true
		}
		for _, model := range parsed.Models {
			key := model.Provider + "\x00" + model.ModelID
			if seen[key] {
				return Catalogue{}, fmt.Errorf("Model pricing response returned duplicate model %s", key)
			}
			seen[key] = true
			models = append(models, model)
		}
		if parsed.NextCursor == "" {
			cursor = ""
			break
		}
		if seenCursors[parsed.NextCursor] {
			return Catalogue{}, errors.New("Model pricing response returned a cursor loop")
		}
		seenCursors[parsed.NextCursor] = true
		cursor = parsed.NextCursor
	}
	if cursor != "" {
		return Catalogue{}, errors.New("Model pricing response exceeded the pagination limit")
	}
	if len(models) == 0 {
		return Catalogue{}, errors.New("Model pricing response did not contain any models")
	}
	if err := assertUniqueModels(models); err != nil {
		return Catalogue{}, err
	}
	return Catalogue{
		Models:         models,
		Source:         "network",
		EndpointOrigin: endpointOrigin,
		FetchedAt:      now.UTC().Format("2006-01-02T15:04:05.000Z"),
		ETag:           etag,
		HasETag:        hasETag,
	}, nil
}

// doRequest applies the catalogue's timeout and refuses redirects: a redirect
// would carry the request to a host the operator never configured.
func doRequest(fetcher func(*http.Request) (*http.Response, error), request *http.Request) (*http.Response, error) {
	if fetcher == nil {
		client := &http.Client{
			Timeout: RequestTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
		return client.Do(request)
	}
	return fetcher(request)
}

// readResponse enforces the size cap and UTF-8 validity, then returns the body
// bytes with the status and ETag.
func readResponse(response *http.Response) ([]byte, int, string, error) {
	if response.Body != nil {
		defer response.Body.Close()
	}
	if contentLength := response.Header.Get("content-length"); contentLength != "" {
		parsed, err := strconv.Atoi(contentLength)
		if err != nil || parsed < 0 {
			return nil, response.StatusCode, "", errors.New("Model pricing response has invalid length")
		}
		if parsed > MaxResponseBytes {
			return nil, response.StatusCode, "", errors.New("Model pricing response is too large")
		}
	}
	var body []byte
	if response.Body != nil {
		limited := io.LimitReader(response.Body, MaxResponseBytes+1)
		var err error
		body, err = io.ReadAll(limited)
		if err != nil {
			return nil, response.StatusCode, "", fmt.Errorf("Model pricing request failed: %w", err)
		}
	}
	if len(body) > MaxResponseBytes {
		return nil, response.StatusCode, "", errors.New("Model pricing response is too large")
	}
	if response.StatusCode == http.StatusNotModified {
		return nil, response.StatusCode, "", nil
	}
	if !utf8.Valid(body) {
		return nil, response.StatusCode, "", errors.New("Model pricing response is not valid UTF-8")
	}
	return body, response.StatusCode, response.Header.Get("etag"), nil
}

// ResponsePayload is the validated shape of one catalogue page.
type ResponsePayload struct {
	Models     []Model
	NextCursor string
}

// ValidateResponse ports validateModelPricingResponse.
func ValidateResponse(body []byte) (ResponsePayload, error) {
	var root map[string]any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&root); err != nil {
		return ResponsePayload{}, fmt.Errorf("Model pricing response returned invalid JSON: %v", err)
	}
	if root == nil {
		return ResponsePayload{}, errors.New("Model pricing pricing response must be an object")
	}
	rawModels, ok := root["models"].([]any)
	if !ok {
		return ResponsePayload{}, errors.New("Model pricing response is missing models")
	}
	models := make([]Model, 0, len(rawModels))
	for index, value := range rawModels {
		model, err := normalizeCatalogueModel(value, fmt.Sprintf("models[%d]", index))
		if err != nil {
			return ResponsePayload{}, err
		}
		models = append(models, model)
	}
	nextCursor := ""
	if value, ok := root["nextCursor"]; ok && value != nil {
		text, ok := value.(string)
		if !ok || text == "" {
			return ResponsePayload{}, errors.New("Model pricing response returned an invalid nextCursor")
		}
		nextCursor = text
	}
	return ResponsePayload{Models: models, NextCursor: nextCursor}, nil
}

// normalizeCachedCatalogue validates a cache file.
func normalizeCachedCatalogue(value any, endpointOrigin string) (Catalogue, error) {
	root, ok := value.(map[string]any)
	if !ok || root == nil {
		return Catalogue{}, errors.New("Model pricing model pricing cache must be an object")
	}
	if schemaVersion, _ := asNumber(root["schemaVersion"]); schemaVersion != CacheSchemaVersion {
		return Catalogue{}, errors.New("Unsupported model pricing cache version")
	}
	cachedOrigin, ok := root["endpointOrigin"].(string)
	if !ok || cachedOrigin == "" {
		return Catalogue{}, errors.New("Model pricing cache endpointOrigin must be a string")
	}
	if EndpointOriginFromEndpoint(cachedOrigin) != cachedOrigin {
		return Catalogue{}, errors.New("Model pricing cache endpoint is invalid")
	}
	if endpointOrigin != "" && cachedOrigin != endpointOrigin {
		return Catalogue{}, errors.New("Model pricing cache endpoint does not match")
	}
	fetchedAt, ok := root["fetchedAt"].(string)
	if !ok || fetchedAt == "" {
		return Catalogue{}, errors.New("Model pricing cache fetchedAt must be a string")
	}
	if _, err := time.Parse(time.RFC3339Nano, fetchedAt); err != nil {
		return Catalogue{}, errors.New("Model pricing cache fetchedAt must be an ISO timestamp")
	}
	etag := ""
	hasETag := false
	if value, ok := root["etag"]; ok && value != nil {
		text, ok := value.(string)
		if !ok || text == "" {
			return Catalogue{}, errors.New("Model pricing cache etag must be a string")
		}
		etag = text
		hasETag = true
	}
	rawModels, ok := root["models"].([]any)
	if !ok {
		return Catalogue{}, errors.New("Model pricing cache is missing models")
	}
	models := make([]Model, 0, len(rawModels))
	for index, value := range rawModels {
		model, err := normalizeCatalogueModel(value, fmt.Sprintf("cache.models[%d]", index))
		if err != nil {
			return Catalogue{}, err
		}
		models = append(models, model)
	}
	if len(models) == 0 {
		return Catalogue{}, errors.New("Model pricing cache did not contain any models")
	}
	if err := assertUniqueModels(models); err != nil {
		return Catalogue{}, err
	}
	return Catalogue{
		Models:         models,
		Source:         "cache",
		EndpointOrigin: cachedOrigin,
		FetchedAt:      fetchedAt,
		ETag:           etag,
		HasETag:        hasETag,
	}, nil
}

func readPricingCache(path, endpointOrigin string, stderr func(string)) (Catalogue, bool) {
	if _, err := os.Stat(path); err != nil {
		return Catalogue{}, false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		stderr(fmt.Sprintf("TokenBoard model pricing: ignoring invalid cache (%s)", err.Error()))
		return Catalogue{}, false
	}
	var decoded any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&decoded); err != nil {
		stderr(fmt.Sprintf("TokenBoard model pricing: ignoring invalid cache (%s)", err.Error()))
		return Catalogue{}, false
	}
	catalogue, err := normalizeCachedCatalogue(decoded, endpointOrigin)
	if err != nil {
		stderr(fmt.Sprintf("TokenBoard model pricing: ignoring invalid cache (%s)", err.Error()))
		return Catalogue{}, false
	}
	return catalogue, true
}

func writePricingCache(path string, catalogue Catalogue) error {
	models := make([]any, 0, len(catalogue.Models))
	for _, model := range catalogue.Models {
		models = append(models, modelToJSON(model))
	}
	document := map[string]any{
		"schemaVersion":  CacheSchemaVersion,
		"endpointOrigin": catalogue.EndpointOrigin,
		"fetchedAt":      catalogue.FetchedAt,
		"etag":           nil,
		"models":         models,
	}
	if catalogue.HasETag {
		document["etag"] = catalogue.ETag
	}
	return writeJSONAtomically(path, document, 0o600)
}

// StaticCatalogue ports staticModelPricingCatalogue: the bundled overrides
// become the catalogue rows when no network or cache source is usable.
func StaticCatalogue(now time.Time) (Catalogue, error) {
	if now.IsZero() {
		now = time.Now()
	}
	bundled, err := readBundledConfig()
	if err != nil {
		return Catalogue{Source: "static", FetchedAt: now.UTC().Format("2006-01-02T15:04:05.000Z")}, nil
	}
	overrides := readPricingOverrides(bundled)
	models := []Model{}
	for modelID, value := range overrides {
		override, ok := value.(map[string]any)
		if !ok {
			continue
		}
		input, inputOK := finiteNonNegative(override["inputCostPerToken"])
		output, outputOK := finiteNonNegative(override["outputCostPerToken"])
		if !inputOK || !outputOK {
			continue
		}
		cacheRead, hasCacheRead := nullableFiniteNonNegative(override["cacheReadInputTokenCost"])
		cacheWrite, hasCacheWrite := nullableFiniteNonNegative(override["cacheCreationInputTokenCost"])
		contextWindow := 0.0
		if value, ok := safeNonNegativeInteger(override["maxInputTokens"]); ok {
			contextWindow = value
		}
		model := Model{
			Provider:             "static",
			ModelID:              modelID,
			InputCostPerMillion:  input * 1_000_000,
			OutputCostPerMillion: output * 1_000_000,
			ContextWindow:        contextWindow,
			Pricing:              override,
		}
		if hasCacheRead {
			scaled := cacheRead * 1_000_000
			model.CacheReadCostPerMillion = &scaled
		}
		if hasCacheWrite {
			scaled := cacheWrite * 1_000_000
			model.CacheWriteCostPerMillion = &scaled
		}
		if contextWindow > 0 {
			model.MaxInputTokens = &contextWindow
		}
		models = append(models, model)
	}
	return Catalogue{
		Models:    models,
		Source:    "static",
		FetchedAt: now.UTC().Format("2006-01-02T15:04:05.000Z"),
	}, nil
}

func normalizeCatalogueModel(value any, path string) (Model, error) {
	row, ok := value.(map[string]any)
	if !ok || row == nil {
		return Model{}, fmt.Errorf("Model pricing %s must be an object", path)
	}
	provider, ok := row["provider"].(string)
	if !ok || provider == "" {
		return Model{}, fmt.Errorf("Model pricing %s.provider must be a string", path)
	}
	if !providerIDPattern.MatchString(provider) {
		return Model{}, fmt.Errorf("Invalid model pricing provider: %s", provider)
	}
	modelID, ok := row["modelId"].(string)
	if !ok || modelID == "" {
		return Model{}, fmt.Errorf("Model pricing %s.modelId must be a string", path)
	}
	if !isValidModelID(modelID) || controlCharacters.MatchString(modelID) {
		return Model{}, fmt.Errorf("Invalid model pricing model id: %s", strconv.Quote(modelID))
	}
	inputCost, ok := finiteNonNegative(row["inputCostPerMillion"])
	if !ok {
		return Model{}, fmt.Errorf("Model pricing %s.inputCostPerMillion must be a finite non-negative number", path)
	}
	outputCost, ok := finiteNonNegative(row["outputCostPerMillion"])
	if !ok {
		return Model{}, fmt.Errorf("Model pricing %s.outputCostPerMillion must be a finite non-negative number", path)
	}
	cacheRead, hasCacheRead := nullableFiniteNonNegative(row["cacheReadCostPerMillion"])
	if !hasCacheRead && row["cacheReadCostPerMillion"] != nil {
		return Model{}, fmt.Errorf("Model pricing %s.cacheReadCostPerMillion must be a finite non-negative number", path)
	}
	cacheWrite, hasCacheWrite := nullableFiniteNonNegative(row["cacheWriteCostPerMillion"])
	if !hasCacheWrite && row["cacheWriteCostPerMillion"] != nil {
		return Model{}, fmt.Errorf("Model pricing %s.cacheWriteCostPerMillion must be a finite non-negative number", path)
	}
	contextWindow, ok := safeNonNegativeInteger(row["contextWindow"])
	if !ok {
		return Model{}, fmt.Errorf("Model pricing %s.contextWindow must be a non-negative integer", path)
	}
	maxInputTokens, hasMaxInput := nullableSafeNonNegativeInteger(row["maxInputTokens"])
	if !hasMaxInput && row["maxInputTokens"] != nil {
		return Model{}, fmt.Errorf("Model pricing %s.maxInputTokens must be a non-negative integer", path)
	}
	pricingValue := row["pricing"]
	if pricingValue == nil {
		if text, ok := row["pricingJson"].(string); ok {
			var decoded any
			decoder := json.NewDecoder(strings.NewReader(text))
			decoder.UseNumber()
			if err := decoder.Decode(&decoded); err != nil {
				return Model{}, fmt.Errorf("Invalid model pricing pricingJson for %s/%s", provider, modelID)
			}
			pricingValue = decoded
		}
	}
	pricing, ok := pricingValue.(map[string]any)
	if !ok || pricing == nil {
		return Model{}, fmt.Errorf("Missing model pricing object for %s/%s", provider, modelID)
	}
	if err := validateContextPricing(pricing, provider+"/"+modelID); err != nil {
		return Model{}, err
	}
	model := Model{
		Provider:             provider,
		ModelID:              modelID,
		InputCostPerMillion:  inputCost,
		OutputCostPerMillion: outputCost,
		ContextWindow:        contextWindow,
		Pricing:              pricing,
	}
	if hasCacheRead {
		model.CacheReadCostPerMillion = &cacheRead
	}
	if hasCacheWrite {
		model.CacheWriteCostPerMillion = &cacheWrite
	}
	if hasMaxInput {
		model.MaxInputTokens = &maxInputTokens
	}
	return model, nil
}

func assertUniqueModels(models []Model) error {
	seen := map[string]bool{}
	for _, model := range models {
		key := model.Provider + "\x00" + model.ModelID
		if seen[key] {
			return fmt.Errorf("Duplicate model pricing row: %s", key)
		}
		seen[key] = true
	}
	return nil
}

func defaultStateDir() string {
	if dir := strings.TrimSpace(os.Getenv("TOKENBOARD_STATE_DIR")); dir != "" {
		return dir
	}
	if dir := strings.TrimSpace(os.Getenv("TOKENBOARD_CONFIG_DIR")); dir != "" {
		return dir
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".tokenboard")
	}
	return ".tokenboard"
}

func readBundledConfig() (map[string]any, error) {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(bundledConfig))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	record, ok := value.(map[string]any)
	if !ok || record == nil {
		return nil, errors.New("Model pricing bundled ccusage config must be an object")
	}
	return record, nil
}

// writeJSONAtomically writes compact JSON plus a newline through a temp file
// and an atomic rename, the TS writeJsonAtomically shape.
func writeJSONAtomically(path string, value any, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	// The generated config is a pure function of the catalogue, so an unchanged
	// catalogue produces byte-identical output. Rewriting it anyway costs a write plus
	// a rename on every hook run (this file is ~450 KB) and makes the mtime useless as
	// a "did the catalogue move" signal. Skip the write when the bytes already match.
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, append(payload, '\n')) {
		return nil
	}
	tmp := fmt.Sprintf("%s.tmp-%d-%s", path, os.Getpid(), randomSuffix())
	if err := os.WriteFile(tmp, append(payload, '\n'), mode); err != nil {
		return err
	}
	if err := renameatomic.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func modelToJSON(model Model) map[string]any {
	document := map[string]any{
		"provider":                 model.Provider,
		"modelId":                  model.ModelID,
		"inputCostPerMillion":      model.InputCostPerMillion,
		"outputCostPerMillion":     model.OutputCostPerMillion,
		"cacheReadCostPerMillion":  nil,
		"cacheWriteCostPerMillion": nil,
		"contextWindow":            model.ContextWindow,
		"maxInputTokens":           nil,
		"pricing":                  model.Pricing,
	}
	if model.CacheReadCostPerMillion != nil {
		document["cacheReadCostPerMillion"] = *model.CacheReadCostPerMillion
	}
	if model.CacheWriteCostPerMillion != nil {
		document["cacheWriteCostPerMillion"] = *model.CacheWriteCostPerMillion
	}
	if model.MaxInputTokens != nil {
		document["maxInputTokens"] = *model.MaxInputTokens
	}
	return document
}
