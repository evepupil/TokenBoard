package pricing

// Port of packages/collector/src/model-pricing.test.ts.
//
// The TS suite injects a fetcher and asserts on the catalogue it returns; this
// suite drives LoadCatalogue/Prepare the same way. Three shapes differ and are
// adapted mechanically at the call site:
//   - endpointOriginFromEndpoint returns "" instead of null,
//   - validateModelPricingResponse takes JSON bytes,
//   - url.Values.Encode sorts query keys, so the URL assertions compare parsed
//     parameters instead of the raw query strings.
//
// One assertion family is not portable: the TS result carries
// contextPricingRules built by buildCodexContextPricingRules
// (packages/collector/src/providers/codex-context-pricing.ts), which the Go
// pricing package does not port, and PreparedConfig has no such field. Those
// assertion sites are marked NOT PORTED.

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// diagnosticLog records the stderr lines a load or prepare emits, mirroring the
// string[] collectors the TS tests use.
type diagnosticLog struct {
	lines []string
}

func (log *diagnosticLog) write(line string) { log.lines = append(log.lines, line) }
func (log *diagnosticLog) text() string      { return strings.Join(log.lines, "\n") }

// perMillion is the TS `n / 1_000_000` conversion. A bare literal division in
// Go is untyped integer division and folds to 0, so every per-token expectation
// goes through this helper.
func perMillion(value float64) float64 { return value / 1_000_000 }

func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("parse time %q: %v", value, err)
	}
	return parsed
}

// jsonResponse answers a catalogue request with a JSON body, the TS
// jsonResponse helper.
func jsonResponse(t *testing.T, body any, headers map[string]string) *http.Response {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal response body: %v", err)
	}
	return rawResponse(payload, http.StatusOK, headers)
}

func rawResponse(body []byte, status int, headers map[string]string) *http.Response {
	header := http.Header{"Content-Type": {"application/json"}}
	for key, value := range headers {
		header.Set(key, value)
	}
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     header,
		Body:       io.NopCloser(bytes.NewReader(body)),
	}
}

// modelRow is the TS `model()` fixture: the catalogue row a server returns,
// with per-field overrides layered on top.
func modelRow(modelID string, overrides map[string]any) map[string]any {
	row := map[string]any{
		"provider":                 "openai",
		"modelId":                  modelID,
		"inputCostPerMillion":      5,
		"outputCostPerMillion":     30,
		"cacheReadCostPerMillion":  nil,
		"cacheWriteCostPerMillion": nil,
		"contextWindow":            1_050_000,
		"maxInputTokens":           1_050_000,
		"pricing":                  map[string]any{},
	}
	for key, value := range overrides {
		row[key] = value
	}
	return row
}

// testModel is the same fixture as a Go Model, for the override builder that
// takes []Model directly.
func testModel(modelID string, mutate func(*Model)) Model {
	contextWindow := 1_050_000.0
	model := Model{
		Provider:             "openai",
		ModelID:              modelID,
		InputCostPerMillion:  5,
		OutputCostPerMillion: 30,
		ContextWindow:        contextWindow,
		MaxInputTokens:       &contextWindow,
		Pricing:              map[string]any{},
	}
	if mutate != nil {
		mutate(&model)
	}
	return model
}

// cataloguePage wraps rows in the response envelope.
func cataloguePage(models []map[string]any, nextCursor any) map[string]any {
	rows := make([]any, 0, len(models))
	for _, model := range models {
		rows = append(rows, model)
	}
	return map[string]any{"models": rows, "nextCursor": nextCursor}
}

func mustLoadCatalogue(t *testing.T, input LoadInput) Catalogue {
	t.Helper()
	catalogue, err := LoadCatalogue(input)
	if err != nil {
		t.Fatalf("LoadCatalogue: %v", err)
	}
	return catalogue
}

func mustPrepare(t *testing.T, input PrepareInput) PreparedConfig {
	t.Helper()
	prepared, err := Prepare(input)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	return prepared
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func writeJSONFile(t *testing.T, path string, value any) {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal %s: %v", path, err)
	}
	writeFile(t, path, string(payload))
}

func readJSONFile(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var value map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return value
}

func pricingOverridesOf(t *testing.T, config map[string]any) map[string]any {
	t.Helper()
	defaults, ok := config["defaults"].(map[string]any)
	if !ok {
		t.Fatalf("config.defaults is %T, want an object", config["defaults"])
	}
	overrides, ok := defaults["pricingOverrides"].(map[string]any)
	if !ok {
		t.Fatalf("config.defaults.pricingOverrides is %T, want an object", defaults["pricingOverrides"])
	}
	return overrides
}

func overrideOf(t *testing.T, overrides map[string]any, modelID string) map[string]any {
	t.Helper()
	override, ok := overrides[modelID].(map[string]any)
	if !ok {
		t.Fatalf("pricingOverrides[%q] is %T, want an object", modelID, overrides[modelID])
	}
	return override
}

func testNumber(t *testing.T, value any) float64 {
	t.Helper()
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			t.Fatalf("parse number %q: %v", typed, err)
		}
		return parsed
	case float64:
		return typed
	case int:
		return float64(typed)
	}
	t.Fatalf("value %v (%T) is not a number", value, value)
	return 0
}

func requireNumber(t *testing.T, record map[string]any, key string, want float64) {
	t.Helper()
	value, ok := record[key]
	if !ok {
		t.Fatalf("%s is missing from %v", key, record)
	}
	if got := testNumber(t, value); got != want {
		t.Fatalf("%s = %v, want %v", key, got, want)
	}
}

func requireContains(t *testing.T, text, substring string) {
	t.Helper()
	if !strings.Contains(text, substring) {
		t.Fatalf("%q does not contain %q", text, substring)
	}
}

func requireNotContains(t *testing.T, text, substring string) {
	t.Helper()
	if strings.Contains(text, substring) {
		t.Fatalf("%q contains %q", text, substring)
	}
}

func requireErrorContains(t *testing.T, err error, substring string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected an error containing %q, got nil", substring)
	}
	if !strings.Contains(err.Error(), substring) {
		t.Fatalf("error %q does not contain %q", err.Error(), substring)
	}
}

func catalogueModelIDs(models []Model) []string {
	ids := make([]string, 0, len(models))
	for _, model := range models {
		ids = append(ids, model.ModelID)
	}
	return ids
}

func hasCatalogueModel(models []Model, modelID string) bool {
	for _, model := range models {
		if model.ModelID == modelID {
			return true
		}
	}
	return false
}

func TestDerivesEndpointOriginAndBuildsCursorURLsWithoutRetainingEndpointPaths(t *testing.T) {
	if got := EndpointOriginFromEndpoint("https://tokenboard.example/api/v1/ingest"); got != "https://tokenboard.example" {
		t.Fatalf("EndpointOriginFromEndpoint = %q, want https://tokenboard.example", got)
	}
	// The TS helper returns null for an unusable endpoint; Go spells it "".
	if got := EndpointOriginFromEndpoint("not a URL"); got != "" {
		t.Fatalf("EndpointOriginFromEndpoint(\"not a URL\") = %q, want the unset value", got)
	}
	// TS returns `new URL(endpoint).origin`, which lowercases the host and
	// drops the scheme's default port. The origin is the pricing cache's
	// identity, and the two clients share one state directory, so an origin
	// spelled differently here would invalidate a cache the other side wrote.
	for endpoint, want := range map[string]string{
		"https://Example.COM:443/api/v1/ingest": "https://example.com",
		"http://Example.COM:80/x":               "http://example.com",
		"https://example.com:8443/x":            "https://example.com:8443",
		"https://[::1]:8443/x":                  "https://[::1]:8443",
		"https://[::1]/x":                       "https://[::1]",
	} {
		if got := EndpointOriginFromEndpoint(endpoint); got != want {
			t.Errorf("EndpointOriginFromEndpoint(%q) = %q, want %q", endpoint, got, want)
		}
	}

	pageURL, err := url.Parse(ModelPricingURL("https://tokenboard.example", "opaque cursor"))
	if err != nil {
		t.Fatalf("parse catalogue URL: %v", err)
	}
	if origin := pageURL.Scheme + "://" + pageURL.Host; origin != "https://tokenboard.example" {
		t.Fatalf("catalogue URL origin = %q", origin)
	}
	if pageURL.Path != "/api/v1/model-pricing" {
		t.Fatalf("catalogue URL path = %q, want /api/v1/model-pricing", pageURL.Path)
	}
	// TS pins the raw "?limit=1000&cursor=opaque+cursor"; Go's url.Values.Encode
	// sorts keys, so the port asserts the parsed parameters instead.
	query := pageURL.Query()
	if got := query.Get("limit"); got != "1000" {
		t.Fatalf("limit = %q, want 1000", got)
	}
	if got := query.Get("cursor"); got != "opaque cursor" {
		t.Fatalf("cursor = %q, want %q", got, "opaque cursor")
	}
}

func TestDistinguishesInvalidEndpointFromUnsetInFallbackDiagnostic(t *testing.T) {
	unsetLog := &diagnosticLog{}
	mustLoadCatalogue(t, LoadInput{
		StateDir: t.TempDir(),
		Now:      mustTime(t, "2026-09-10T00:00:00.000Z"),
		Stderr:   unsetLog.write,
		Fetcher: func(*http.Request) (*http.Response, error) {
			return nil, errors.New("network should not be used without an endpoint")
		},
	})
	requireContains(t, unsetLog.text(), "TOKENBOARD_ENDPOINT is not configured")

	invalidLog := &diagnosticLog{}
	mustLoadCatalogue(t, LoadInput{
		Endpoint: "not-a-url",
		StateDir: t.TempDir(),
		Now:      mustTime(t, "2026-09-10T00:00:00.000Z"),
		Stderr:   invalidLog.write,
		Fetcher: func(*http.Request) (*http.Response, error) {
			return nil, errors.New("network should not be used with an invalid endpoint")
		},
	})
	requireContains(t, invalidLog.text(), "TOKENBOARD_ENDPOINT is invalid")
	requireNotContains(t, invalidLog.text(), "is not configured")
}

func TestReadsEveryCataloguePageAndRejectsCursorLoop(t *testing.T) {
	stateDir := t.TempDir()
	var requests []*url.URL
	fetcher := func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request.URL)
		if request.URL.Query().Get("cursor") == "" {
			return jsonResponse(t, cataloguePage([]map[string]any{modelRow("gpt-6-astra", nil)}, "page-2"), nil), nil
		}
		return jsonResponse(t, cataloguePage([]map[string]any{modelRow("grok-4.6", nil)}, nil), nil), nil
	}

	result := mustLoadCatalogue(t, LoadInput{
		Endpoint: "https://tokenboard.example/api/v1/ingest",
		StateDir: stateDir,
		Now:      mustTime(t, "2026-09-10T00:00:00.000Z"),
		Fetcher:  fetcher,
	})

	if result.Source != "network" {
		t.Fatalf("source = %q, want network", result.Source)
	}
	if got, want := catalogueModelIDs(result.Models), []string{"gpt-6-astra", "grok-4.6"}; !slices.Equal(got, want) {
		t.Fatalf("model ids = %v, want %v", got, want)
	}
	if len(requests) != 2 {
		t.Fatalf("requests = %d, want 2", len(requests))
	}
	// TS pins the raw URL strings; Go sorts the query keys, so the port asserts
	// the same pages through the parsed parameters.
	first := requests[0].Query()
	if requests[0].Path != "/api/v1/model-pricing" || first.Get("limit") != "1000" || first.Get("cursor") != "" {
		t.Fatalf("first request = %s, want the uncursored first page", requests[0])
	}
	second := requests[1].Query()
	if second.Get("limit") != "1000" || second.Get("cursor") != "page-2" {
		t.Fatalf("second request = %s, want cursor page-2", requests[1])
	}

	_, err := FetchCatalogue(
		"https://loop.example",
		Catalogue{},
		false,
		mustTime(t, "2026-09-10T00:00:00.000Z"),
		func(request *http.Request) (*http.Response, error) {
			modelID := "looped"
			if request.URL.Query().Get("cursor") != "" {
				modelID = "looped-2"
			}
			return jsonResponse(t, cataloguePage([]map[string]any{modelRow(modelID, nil)}, "same"), nil), nil
		},
	)
	requireErrorContains(t, err, "cursor loop")
}

func TestUsesFreshCacheWithoutNetworkAndRefreshesExpiredCacheWithETag(t *testing.T) {
	stateDir := t.TempDir()
	var firstIfNoneMatch []string
	first := mustLoadCatalogue(t, LoadInput{
		Endpoint: "https://tokenboard.example",
		StateDir: stateDir,
		Now:      mustTime(t, "2026-09-10T00:00:00.000Z"),
		Fetcher: func(request *http.Request) (*http.Response, error) {
			firstIfNoneMatch = append(firstIfNoneMatch, request.Header.Get("if-none-match"))
			return jsonResponse(
				t,
				cataloguePage([]map[string]any{modelRow("gpt-6-astra", nil)}, nil),
				map[string]string{"ETag": `"catalogue-v1"`},
			), nil
		},
	})
	if first.Source != "network" {
		t.Fatalf("source = %q, want network", first.Source)
	}

	freshCalls := 0
	fresh := mustLoadCatalogue(t, LoadInput{
		Endpoint: "https://tokenboard.example",
		StateDir: stateDir,
		Now:      mustTime(t, "2026-09-10T12:00:00.000Z"),
		Fetcher: func(*http.Request) (*http.Response, error) {
			freshCalls++
			return nil, errors.New("network should not be used for a fresh cache")
		},
	})
	if fresh.Source != "cache" {
		t.Fatalf("source = %q, want cache", fresh.Source)
	}
	if freshCalls != 0 {
		t.Fatalf("fetcher calls = %d, want 0", freshCalls)
	}

	var expiredIfNoneMatch []string
	refreshed := mustLoadCatalogue(t, LoadInput{
		Endpoint: "https://tokenboard.example",
		StateDir: stateDir,
		Now:      mustTime(t, "2026-09-11T00:00:01.000Z"),
		Fetcher: func(request *http.Request) (*http.Response, error) {
			expiredIfNoneMatch = append(expiredIfNoneMatch, request.Header.Get("if-none-match"))
			return rawResponse(nil, http.StatusNotModified, nil), nil
		},
	})
	if refreshed.Source != "network" {
		t.Fatalf("source = %q, want network", refreshed.Source)
	}
	if refreshed.FetchedAt != "2026-09-11T00:00:01.000Z" {
		t.Fatalf("fetchedAt = %q, want 2026-09-11T00:00:01.000Z", refreshed.FetchedAt)
	}
	if len(firstIfNoneMatch) != 1 || firstIfNoneMatch[0] != "" {
		t.Fatalf("first if-none-match = %v, want one empty header", firstIfNoneMatch)
	}
	if len(expiredIfNoneMatch) != 1 || expiredIfNoneMatch[0] != `"catalogue-v1"` {
		t.Fatalf("expired if-none-match = %v, want the cached ETag", expiredIfNoneMatch)
	}
}

func TestFallsBackFromNetworkToStaleCacheThenBundledStaticAndKeepsHookModeOffline(t *testing.T) {
	stateDir := t.TempDir()
	mustLoadCatalogue(t, LoadInput{
		Endpoint: "https://tokenboard.example",
		StateDir: stateDir,
		Now:      mustTime(t, "2026-09-01T00:00:00.000Z"),
		Fetcher: func(*http.Request) (*http.Response, error) {
			return jsonResponse(t, cataloguePage([]map[string]any{modelRow("gpt-6-astra", nil)}, nil), nil), nil
		},
	})

	freshWithoutEndpoint := mustLoadCatalogue(t, LoadInput{
		StateDir: stateDir,
		Now:      mustTime(t, "2026-09-01T12:00:00.000Z"),
		Fetcher: func(*http.Request) (*http.Response, error) {
			return nil, errors.New("network should not be used without an endpoint")
		},
	})
	if freshWithoutEndpoint.Source != "cache" {
		t.Fatalf("source = %q, want cache", freshWithoutEndpoint.Source)
	}
	if freshWithoutEndpoint.EndpointOrigin != "https://tokenboard.example" {
		t.Fatalf("endpointOrigin = %q, want https://tokenboard.example", freshWithoutEndpoint.EndpointOrigin)
	}

	staleWithoutEndpointLog := &diagnosticLog{}
	staleWithoutEndpoint := mustLoadCatalogue(t, LoadInput{
		StateDir: stateDir,
		Now:      mustTime(t, "2026-09-03T00:00:00.000Z"),
		Stderr:   staleWithoutEndpointLog.write,
		Fetcher: func(*http.Request) (*http.Response, error) {
			return nil, errors.New("network should not be used without an endpoint")
		},
	})
	if staleWithoutEndpoint.Source != "cache" {
		t.Fatalf("source = %q, want cache", staleWithoutEndpoint.Source)
	}
	requireContains(t, staleWithoutEndpointLog.text(), "using last successful cache")

	staleLog := &diagnosticLog{}
	stale := mustLoadCatalogue(t, LoadInput{
		Endpoint: "https://tokenboard.example",
		StateDir: stateDir,
		Now:      mustTime(t, "2026-09-03T00:00:00.000Z"),
		Stderr:   staleLog.write,
		Fetcher: func(*http.Request) (*http.Response, error) {
			return nil, errors.New("offline")
		},
	})
	if stale.Source != "cache" {
		t.Fatalf("source = %q, want cache", stale.Source)
	}
	if len(stale.Models) == 0 || stale.Models[0].ModelID != "gpt-6-astra" {
		t.Fatalf("models = %v, want gpt-6-astra first", catalogueModelIDs(stale.Models))
	}
	requireContains(t, staleLog.text(), "using last successful cache")

	hookRequests := 0
	hook := mustLoadCatalogue(t, LoadInput{
		Endpoint: "https://tokenboard.example",
		StateDir: stateDir,
		HookMode: true,
		Now:      mustTime(t, "2026-09-04T00:00:00.000Z"),
		Fetcher: func(*http.Request) (*http.Response, error) {
			hookRequests++
			return nil, errors.New("hook must not reach the network")
		},
	})
	if hook.Source != "cache" {
		t.Fatalf("source = %q, want cache", hook.Source)
	}
	if hookRequests != 0 {
		t.Fatalf("hook fetcher calls = %d, want 0", hookRequests)
	}

	staticFallback := mustLoadCatalogue(t, LoadInput{
		StateDir: t.TempDir(),
		Fetcher: func(*http.Request) (*http.Response, error) {
			return nil, errors.New("endpoint is unavailable")
		},
	})
	if staticFallback.Source != "static" {
		t.Fatalf("source = %q, want static", staticFallback.Source)
	}
	if !hasCatalogueModel(staticFallback.Models, "grok-4.5") {
		t.Fatalf("static catalogue does not contain grok-4.5")
	}

	preparedDir := t.TempDir()
	preparedStatic := mustPrepare(t, PrepareInput{
		Endpoint: "https://tokenboard.example",
		StateDir: preparedDir,
		Fetcher: func(*http.Request) (*http.Response, error) {
			return nil, errors.New("offline")
		},
	})
	// TS points ccusage at packages/collector/ccusage.json here. The Go port has
	// no repo checkout, so it materializes the embedded bundled config into the
	// state directory (config.go:100-124) and returns that path instead.
	bundledPath := filepath.Join(preparedDir, "ccusage.bundled.json")
	if preparedStatic.ConfigPath != bundledPath {
		t.Fatalf("configPath = %q, want %q", preparedStatic.ConfigPath, bundledPath)
	}
	materialized, err := os.ReadFile(bundledPath)
	if err != nil {
		t.Fatalf("read materialized bundled config: %v", err)
	}
	if !bytes.Equal(materialized, bundledConfig) {
		t.Fatalf("materialized bundled config differs from the embedded copy")
	}
}

func TestFallsBackToUsableCcusageConfigWhenDynamicConfigDirectoryNotWritable(t *testing.T) {
	parent := t.TempDir()
	stateFile := filepath.Join(parent, "state-file")
	writeFile(t, stateFile, "not a directory")
	explicitPath := filepath.Join(parent, "explicit.json")
	writeJSONFile(t, explicitPath, map[string]any{
		"defaults": map[string]any{"pricingOverrides": map[string]any{
			"gpt-6-astra": map[string]any{"inputCostPerToken": 7},
		}},
	})
	log := &diagnosticLog{}

	result := mustPrepare(t, PrepareInput{
		Endpoint:       "https://tokenboard.example",
		StateDir:       stateFile,
		ExplicitConfig: explicitPath,
		Fetcher: func(*http.Request) (*http.Response, error) {
			return jsonResponse(t, cataloguePage([]map[string]any{modelRow("gpt-6-astra", nil)}, nil), nil), nil
		},
		Stderr: log.write,
	})

	if result.ConfigPath != explicitPath {
		t.Fatalf("configPath = %q, want %q", result.ConfigPath, explicitPath)
	}
	if !result.CoveredModelIDs["gpt-6-astra"] {
		t.Fatalf("coveredModelIds does not contain gpt-6-astra")
	}
	// NOT PORTED: TS asserts no context pricing rule covers gpt-6-astra
	// (result.contextPricingRules). PreparedConfig has no rules field; see the
	// file comment.
	requireContains(t, log.text(), "dynamic ccusage config write failed")
	requireContains(t, log.text(), "using explicit config "+explicitPath)
}

func TestRejectsMalformedModelRowsPricesAndContextTiers(t *testing.T) {
	validate := func(payload map[string]any) error {
		body, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal payload: %v", err)
		}
		_, err = ValidateResponse(body)
		return err
	}

	requireErrorContains(t,
		validate(cataloguePage([]map[string]any{modelRow("\x00bad", nil)}, nil)),
		"Invalid model pricing model id")
	requireErrorContains(t,
		validate(cataloguePage([]map[string]any{
			modelRow("negative", map[string]any{"inputCostPerMillion": -1}),
		}, nil)),
		"inputCostPerMillion")

	// TS passes `outputCostPerMillion: undefined`, which JSON.stringify drops.
	missingOutput := modelRow("missing-output", nil)
	delete(missingOutput, "outputCostPerMillion")
	requireErrorContains(t,
		validate(cataloguePage([]map[string]any{missingOutput}, nil)),
		"outputCostPerMillion")

	badTier := modelRow("bad-tier", map[string]any{
		"pricing": map[string]any{"tiers": []any{map[string]any{
			"tier":   map[string]any{"type": "context", "size": 272_001},
			"input":  -1,
			"output": 2,
		}}},
	})
	requireErrorContains(t,
		validate(cataloguePage([]map[string]any{badTier}, nil)),
		"context pricing input")

	requireErrorContains(t,
		validate(map[string]any{"models": []any{modelRow("bad-cursor", nil)}, "nextCursor": ""}),
		"nextCursor")

	badMultiplier := modelRow("bad-multiplier", map[string]any{
		"pricing": map[string]any{"fast_multiplier": -2},
	})
	requireErrorContains(t,
		validate(cataloguePage([]map[string]any{badMultiplier}, nil)),
		"fast_multiplier")

	body, err := json.Marshal(cataloguePage([]map[string]any{modelRow("omitted-cursor", nil)}, nil))
	if err != nil {
		t.Fatalf("marshal omitted-cursor payload: %v", err)
	}
	payload, err := ValidateResponse(body)
	if err != nil {
		t.Fatalf("ValidateResponse: %v", err)
	}
	// TS expects null; the Go payload spells an absent cursor as "".
	if payload.NextCursor != "" {
		t.Fatalf("nextCursor = %q, want the absent-cursor value", payload.NextCursor)
	}
}

func TestRejectsInvalidUTF8AndIgnoresCorruptedCacheBeforeStaticPricing(t *testing.T) {
	stateDir := t.TempDir()
	writeFile(t, filepath.Join(stateDir, CacheFileName), "{not-json")
	log := &diagnosticLog{}

	result := mustLoadCatalogue(t, LoadInput{
		Endpoint: "https://tokenboard.example",
		StateDir: stateDir,
		Stderr:   log.write,
		Fetcher: func(*http.Request) (*http.Response, error) {
			return rawResponse([]byte{0xff, 0xfe}, http.StatusOK, nil), nil
		},
	})

	if result.Source != "static" {
		t.Fatalf("source = %q, want static", result.Source)
	}
	requireContains(t, log.text(), "ignoring invalid cache")
	requireContains(t, log.text(), "not valid UTF-8")
}

func TestKeepsFetchedCatalogueWhenCacheCannotBeWritten(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(root, "state-file")
	writeFile(t, statePath, "state directory path is unavailable")
	log := &diagnosticLog{}

	result := mustLoadCatalogue(t, LoadInput{
		Endpoint: "https://tokenboard.example",
		StateDir: statePath,
		Now:      mustTime(t, "2026-09-10T00:00:00.000Z"),
		Stderr:   log.write,
		Fetcher: func(*http.Request) (*http.Response, error) {
			return jsonResponse(t, cataloguePage([]map[string]any{modelRow("gpt-6-astra", nil)}, nil), nil), nil
		},
	})

	if result.Source != "network" {
		t.Fatalf("source = %q, want network", result.Source)
	}
	if got, want := catalogueModelIDs(result.Models), []string{"gpt-6-astra"}; !slices.Equal(got, want) {
		t.Fatalf("model ids = %v, want %v", got, want)
	}
	requireContains(t, log.text(), "cache write failed")
}

func TestWritesCacheAtomicallyAndCreatesDynamicOverridesWithExplicitConfigPrecedence(t *testing.T) {
	stateDir := t.TempDir()
	explicitPath := filepath.Join(stateDir, "explicit.json")
	writeJSONFile(t, explicitPath, map[string]any{
		"defaults": map[string]any{"pricingOverrides": map[string]any{
			"gpt-6-astra": map[string]any{"inputCostPerToken": 99, "outputCostPerToken": 98},
		}},
	})

	result := mustPrepare(t, PrepareInput{
		Endpoint:       "https://tokenboard.example",
		StateDir:       stateDir,
		ExplicitConfig: explicitPath,
		Now:            mustTime(t, "2026-09-10T00:00:00.000Z"),
		Fetcher: func(*http.Request) (*http.Response, error) {
			return jsonResponse(t, cataloguePage([]map[string]any{
				modelRow("gpt-6-astra", map[string]any{
					"inputCostPerMillion":      1,
					"outputCostPerMillion":     2,
					"cacheReadCostPerMillion":  0.5,
					"cacheWriteCostPerMillion": 1,
					"contextWindow":            1_050_000,
					"pricing": map[string]any{
						"tiers": []any{map[string]any{
							"tier":        map[string]any{"type": "context", "size": 272_000},
							"input":       3,
							"output":      4,
							"cache_read":  0.5,
							"cache_write": 1,
						}},
						"priority_multiplier": 3,
						"context_over_200k":   map[string]any{"input": 99, "output": 99},
					},
				}),
				modelRow("grok-4.6", map[string]any{
					"inputCostPerMillion":      2,
					"outputCostPerMillion":     6,
					"cacheReadCostPerMillion":  0.6,
					"cacheWriteCostPerMillion": 0,
					"pricing": map[string]any{"tiers": []any{map[string]any{
						"tier":       map[string]any{"type": "context", "size": 200_000},
						"input":      4,
						"output":     12,
						"cache_read": 0.6,
					}}},
				}),
				modelRow("claude-fable-5-1", map[string]any{"inputCostPerMillion": 5, "outputCostPerMillion": 25}),
			}, nil), nil), nil
		},
	})

	if want := filepath.Join(stateDir, DynamicConfigFileName); result.ConfigPath != want {
		t.Fatalf("configPath = %q, want %q", result.ConfigPath, want)
	}
	overrides := pricingOverridesOf(t, readJSONFile(t, result.ConfigPath))
	gpt := overrideOf(t, overrides, "gpt-6-astra")
	requireNumber(t, gpt, "inputCostPerToken", 99)
	requireNumber(t, gpt, "outputCostPerToken", 98)
	grok := overrideOf(t, overrides, "grok-4.6")
	requireNumber(t, grok, "inputCostPerToken", perMillion(2))
	requireNumber(t, grok, "outputCostPerToken", perMillion(6))
	requireNumber(t, grok, "inputCostPerTokenAbove200kTokens", perMillion(4))
	requireNumber(t, grok, "outputCostPerTokenAbove200kTokens", perMillion(12))
	if _, ok := gpt["inputCostPerTokenAbove200kTokens"]; ok {
		t.Fatalf("gpt-6-astra carries a 200k override")
	}
	// NOT PORTED: TS also asserts result.contextPricingRules has no rule for
	// gpt-6-astra and a grok-4.6 rule with threshold 200000. PreparedConfig has
	// no rules field; see the file comment.

	entries, err := os.ReadDir(stateDir)
	if err != nil {
		t.Fatalf("read state directory: %v", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), CacheFileName+".tmp-") ||
			strings.HasPrefix(entry.Name(), DynamicConfigFileName+".tmp-") {
			t.Fatalf("temporary file left behind: %s", entry.Name())
		}
	}
}

func TestDoesNotRepriceContextModelWithExplicitCcusageOverride(t *testing.T) {
	stateDir := t.TempDir()
	explicitPath := filepath.Join(stateDir, "explicit.json")
	writeJSONFile(t, explicitPath, map[string]any{
		"defaults": map[string]any{"pricingOverrides": map[string]any{
			"gpt-6-astra": map[string]any{
				"inputCostPerToken":  perMillion(77.0),
				"outputCostPerToken": perMillion(88.0),
			},
		}},
	})

	result := mustPrepare(t, PrepareInput{
		Endpoint:       "https://tokenboard.example",
		StateDir:       stateDir,
		ExplicitConfig: explicitPath,
		Fetcher: func(*http.Request) (*http.Response, error) {
			return jsonResponse(t, cataloguePage([]map[string]any{
				modelRow("gpt-6-astra", map[string]any{
					"cacheReadCostPerMillion":  0.5,
					"cacheWriteCostPerMillion": 6,
					"pricing": map[string]any{"tiers": []any{map[string]any{
						"tier":        map[string]any{"type": "context", "size": 272_000},
						"input":       10,
						"output":      45,
						"cache_read":  1,
						"cache_write": 12,
					}}},
				}),
			}, nil), nil), nil
		},
	})

	// NOT PORTED: TS asserts result.contextPricingRules has no rule covering
	// gpt-6-astra. The Go pricing package has no rules layer, so the port asserts
	// the config-layer half of the same guarantee: the explicit per-token prices
	// survive and the dynamic row contributes no long-context keys.
	gpt := overrideOf(t, pricingOverridesOf(t, readJSONFile(t, result.ConfigPath)), "gpt-6-astra")
	requireNumber(t, gpt, "inputCostPerToken", perMillion(77))
	requireNumber(t, gpt, "outputCostPerToken", perMillion(88))
	for _, key := range longContextOverrideKeys {
		if _, ok := gpt[key]; ok {
			t.Fatalf("%s should not be set when an explicit override owns the model", key)
		}
	}
}

func TestDoesNotRepriceDatedModelAliasWithExplicitCcusageOverride(t *testing.T) {
	stateDir := t.TempDir()
	explicitPath := filepath.Join(stateDir, "explicit.json")
	writeJSONFile(t, explicitPath, map[string]any{
		"defaults": map[string]any{"pricingOverrides": map[string]any{
			"gpt-5.6-sol-20260901": map[string]any{
				"inputCostPerToken":  perMillion(77.0),
				"outputCostPerToken": perMillion(88.0),
			},
		}},
	})

	result := mustPrepare(t, PrepareInput{
		Endpoint:       "https://tokenboard.example",
		StateDir:       stateDir,
		ExplicitConfig: explicitPath,
		Fetcher: func(*http.Request) (*http.Response, error) {
			return jsonResponse(t, cataloguePage([]map[string]any{
				modelRow("gpt-5.6-sol-20260901", map[string]any{
					"cacheReadCostPerMillion":  0.5,
					"cacheWriteCostPerMillion": 6,
					"pricing": map[string]any{"tiers": []any{map[string]any{
						"tier":        map[string]any{"type": "context", "size": 272_000},
						"input":       10,
						"output":      45,
						"cache_read":  1,
						"cache_write": 12,
					}}},
				}),
			}, nil), nil), nil
		},
	})

	// NOT PORTED: TS asserts no context pricing rule carries the undated alias
	// 'gpt-5.6-sol'. The config-layer analogue is that the dated row keeps the
	// explicit prices and the bundled alias keeps its own, so the dated row's
	// tier never leaks onto the alias.
	overrides := pricingOverridesOf(t, readJSONFile(t, result.ConfigPath))
	dated := overrideOf(t, overrides, "gpt-5.6-sol-20260901")
	requireNumber(t, dated, "inputCostPerToken", perMillion(77))
	requireNumber(t, dated, "outputCostPerToken", perMillion(88))
	alias := overrideOf(t, overrides, "gpt-5.6-sol")
	requireNumber(t, alias, "inputCostPerToken", perMillion(5))
	requireNumber(t, alias, "outputCostPerToken", perMillion(30))
}

func TestTreatsBlankStateDirectoryAsUnset(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("TOKENBOARD_STATE_DIR", stateDir)
	t.Setenv("TOKENBOARD_CONFIG_DIR", "")

	result := mustPrepare(t, PrepareInput{
		Endpoint: "https://tokenboard.example",
		StateDir: "   ",
		Fetcher: func(*http.Request) (*http.Response, error) {
			return jsonResponse(t, cataloguePage([]map[string]any{modelRow("gpt-6-astra", nil)}, nil), nil), nil
		},
	})

	if want := filepath.Join(stateDir, DynamicConfigFileName); result.ConfigPath != want {
		t.Fatalf("configPath = %q, want %q", result.ConfigPath, want)
	}
}

func TestTrimsBlankStateAndConfigDirectoryEnvironmentValues(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("TOKENBOARD_STATE_DIR", "   ")
	t.Setenv("TOKENBOARD_CONFIG_DIR", stateDir)

	result := mustPrepare(t, PrepareInput{
		Endpoint: "https://tokenboard.example",
		Fetcher: func(*http.Request) (*http.Response, error) {
			return jsonResponse(t, cataloguePage([]map[string]any{modelRow("gpt-6-astra", nil)}, nil), nil), nil
		},
	})

	if want := filepath.Join(stateDir, DynamicConfigFileName); result.ConfigPath != want {
		t.Fatalf("configPath = %q, want %q", result.ConfigPath, want)
	}
}

func TestDoesNotMergePricesFromDifferentProvidersForSameModelID(t *testing.T) {
	shared := func(provider string, inputCostPerMillion float64) Model {
		model := testModel("provider-collision", nil)
		model.Provider = provider
		model.InputCostPerMillion = inputCostPerMillion
		model.Pricing = map[string]any{"tiers": []any{map[string]any{
			"tier":   map[string]any{"type": "context", "size": float64(200_000)},
			"input":  inputCostPerMillion,
			"output": float64(2),
		}}}
		return model
	}
	overrides := CreateCcusagePricingOverrides([]Model{
		shared("openai", 1),
		shared("azure", 99),
		testModel("provider-unique", func(model *Model) {
			model.Provider = "openai"
			model.InputCostPerMillion = 7
		}),
	})

	if _, ok := overrides["provider-collision"]; ok {
		t.Fatalf("provider-collision should not be priced from disagreeing provider rows")
	}
	requireNumber(t, overrideOf(t, overrides, "provider-unique"), "inputCostPerToken", perMillion(7))

	sharedRow := func(provider string, inputCostPerMillion float64) map[string]any {
		return modelRow("provider-collision", map[string]any{
			"provider":            provider,
			"inputCostPerMillion": inputCostPerMillion,
			"pricing": map[string]any{"tiers": []any{map[string]any{
				"tier":   map[string]any{"type": "context", "size": 200_000},
				"input":  inputCostPerMillion,
				"output": 2,
			}}},
		})
	}
	result := mustPrepare(t, PrepareInput{
		Endpoint: "https://tokenboard.example",
		StateDir: t.TempDir(),
		Fetcher: func(*http.Request) (*http.Response, error) {
			return jsonResponse(t, cataloguePage([]map[string]any{
				sharedRow("openai", 1),
				sharedRow("azure", 99),
				modelRow("provider-unique", nil),
			}, nil), nil), nil
		},
	})
	if result.CoveredModelIDs["provider-collision"] {
		t.Fatalf("coveredModelIds contains provider-collision")
	}
	// NOT PORTED: TS also asserts no context pricing rule covers
	// provider-collision. PreparedConfig has no rules field; see the file comment.
}

func TestTreatsBundledConfigAsBaselineSoDynamicPricesOverrideIt(t *testing.T) {
	stateDir := t.TempDir()
	explicitPath := filepath.Join(stateDir, "explicit.json")
	if err := os.WriteFile(explicitPath, bundledConfig, 0o600); err != nil {
		t.Fatalf("write bundled explicit config: %v", err)
	}

	result := mustPrepare(t, PrepareInput{
		Endpoint:       "https://tokenboard.example",
		StateDir:       stateDir,
		ExplicitConfig: explicitPath,
		Fetcher: func(*http.Request) (*http.Response, error) {
			return jsonResponse(t, cataloguePage([]map[string]any{
				modelRow("gpt-5.6-luna", map[string]any{
					"inputCostPerMillion":      11,
					"outputCostPerMillion":     33,
					"cacheReadCostPerMillion":  2,
					"cacheWriteCostPerMillion": 7,
				}),
			}, nil), nil), nil
		},
	})

	luna := overrideOf(t, pricingOverridesOf(t, readJSONFile(t, result.ConfigPath)), "gpt-5.6-luna")
	requireNumber(t, luna, "inputCostPerToken", perMillion(11))
	requireNumber(t, luna, "outputCostPerToken", perMillion(33))
	requireNumber(t, luna, "cacheReadInputTokenCost", perMillion(2))
	requireNumber(t, luna, "cacheCreationInputTokenCost", perMillion(7))
}

func TestRetainsBundledCachePricesWhenDynamicRowOmitsThem(t *testing.T) {
	stateDir := t.TempDir()
	result := mustPrepare(t, PrepareInput{
		Endpoint: "https://tokenboard.example",
		StateDir: stateDir,
		Fetcher: func(*http.Request) (*http.Response, error) {
			return jsonResponse(t, cataloguePage([]map[string]any{
				modelRow("gpt-5.6-luna", map[string]any{
					"inputCostPerMillion":      11,
					"outputCostPerMillion":     33,
					"cacheReadCostPerMillion":  nil,
					"cacheWriteCostPerMillion": nil,
				}),
			}, nil), nil), nil
		},
	})

	luna := overrideOf(t, pricingOverridesOf(t, readJSONFile(t, result.ConfigPath)), "gpt-5.6-luna")
	requireNumber(t, luna, "inputCostPerToken", perMillion(11))
	requireNumber(t, luna, "outputCostPerToken", perMillion(33))
	requireNumber(t, luna, "cacheReadInputTokenCost", perMillion(0.02))
	requireNumber(t, luna, "cacheCreationInputTokenCost", perMillion(0.25))
}

func TestRemovesBundled200kFieldsWhenDynamicTierIs272k(t *testing.T) {
	stateDir := t.TempDir()
	result := mustPrepare(t, PrepareInput{
		Endpoint: "https://tokenboard.example",
		StateDir: stateDir,
		Fetcher: func(*http.Request) (*http.Response, error) {
			return jsonResponse(t, cataloguePage([]map[string]any{
				modelRow("grok-4.5", map[string]any{
					"inputCostPerMillion":      7,
					"outputCostPerMillion":     21,
					"cacheReadCostPerMillion":  nil,
					"cacheWriteCostPerMillion": nil,
					"pricing": map[string]any{"tiers": []any{map[string]any{
						"tier":   map[string]any{"type": "context", "size": 272_000},
						"input":  14,
						"output": 42,
					}}},
				}),
			}, nil), nil), nil
		},
	})

	grok := overrideOf(t, pricingOverridesOf(t, readJSONFile(t, result.ConfigPath)), "grok-4.5")
	for _, key := range []string{"inputCostPerTokenAbove200kTokens", "outputCostPerTokenAbove200kTokens"} {
		if _, ok := grok[key]; ok {
			t.Fatalf("%s should be removed for a 272k tier", key)
		}
	}
}

func TestDoesNotMapChangingLaterContextTierToCcusage200kPricing(t *testing.T) {
	stateDir := t.TempDir()
	result := mustPrepare(t, PrepareInput{
		Endpoint: "https://tokenboard.example",
		StateDir: stateDir,
		Fetcher: func(*http.Request) (*http.Response, error) {
			return jsonResponse(t, cataloguePage([]map[string]any{
				modelRow("grok-4.5", map[string]any{
					"inputCostPerMillion":      2,
					"outputCostPerMillion":     6,
					"cacheReadCostPerMillion":  0.3,
					"cacheWriteCostPerMillion": nil,
					"pricing": map[string]any{"tiers": []any{
						map[string]any{
							"tier":       map[string]any{"type": "context", "size": 200_000},
							"input":      4,
							"output":     12,
							"cache_read": 0.6,
						},
						map[string]any{
							"tier":       map[string]any{"type": "context", "size": 1_000_000},
							"input":      8,
							"output":     24,
							"cache_read": 1.2,
						},
					}},
				}),
			}, nil), nil), nil
		},
	})

	grok := overrideOf(t, pricingOverridesOf(t, readJSONFile(t, result.ConfigPath)), "grok-4.5")
	requireNumber(t, grok, "inputCostPerToken", perMillion(2))
	requireNumber(t, grok, "outputCostPerToken", perMillion(6))
	_, hasInput := grok["inputCostPerTokenAbove200kTokens"]
	_, hasOutput := grok["outputCostPerTokenAbove200kTokens"]
	if hasInput && hasOutput {
		t.Fatalf("changing later tiers were mapped to 200k pricing: %v", grok)
	}
}

func TestPreservesBundledLongContextFieldsWhenStaticFallbackWritesMergedConfig(t *testing.T) {
	stateDir := t.TempDir()
	explicitPath := filepath.Join(stateDir, "explicit.json")
	writeJSONFile(t, explicitPath, map[string]any{
		"defaults": map[string]any{"pricingOverrides": map[string]any{}},
	})

	result := mustPrepare(t, PrepareInput{
		Endpoint:       "https://tokenboard.example",
		StateDir:       stateDir,
		ExplicitConfig: explicitPath,
		Fetcher: func(*http.Request) (*http.Response, error) {
			return nil, errors.New("offline")
		},
	})

	grok := overrideOf(t, pricingOverridesOf(t, readJSONFile(t, result.ConfigPath)), "grok-4.5")
	requireNumber(t, grok, "inputCostPerTokenAbove200kTokens", perMillion(4))
	requireNumber(t, grok, "outputCostPerTokenAbove200kTokens", perMillion(12))
	requireNumber(t, grok, "cacheReadInputTokenCostAbove200kTokens", perMillion(0.6))
}

// The agreement check compares only positive-priced rows, so the representative
// must come from that same group. When an official vendor row is a $0
// placeholder and a reseller row carries the real price, picking the
// representative from all rows silently prices the model as free — the exact
// failure mode the zero-row isolation exists to prevent. The TypeScript side
// fixed this in d15b5fa; this is the Go port of that fix, pinned by the same
// shape of test.
func TestZeroPricedOfficialRowDoesNotRepresentAPricedGroup(t *testing.T) {
	models := []Model{
		testModel("step-5-preview", func(model *Model) {
			model.Provider = "nvidia"
			model.InputCostPerMillion = 0
			model.OutputCostPerMillion = 0
		}),
		testModel("step-5-preview", func(model *Model) {
			model.Provider = "reseller"
			model.InputCostPerMillion = 1
			model.OutputCostPerMillion = 2.7
		}),
	}

	selected := selectUnambiguousDynamicPricingModels(models)
	if len(selected) != 1 {
		t.Fatalf("selectUnambiguousDynamicPricingModels returned %d rows, want 1", len(selected))
	}
	if selected[0].Provider != "reseller" {
		t.Fatalf("collapsed representative provider = %q, want %q", selected[0].Provider, "reseller")
	}
	overrides := CreateCcusagePricingOverrides(models)
	requireNumber(t, overrideOf(t, overrides, "step-5-preview"), "inputCostPerToken", perMillion(1))
}

// The official vendor row still wins when it carries the real price: the fix
// only drops $0 placeholders from the pick, it does not stop preferring the
// vendor.
func TestOfficialVendorRowStillRepresentsAnAgreeingGroup(t *testing.T) {
	models := []Model{
		testModel("gpt", func(model *Model) {
			model.Provider = "reseller"
			model.InputCostPerMillion = 2
			model.OutputCostPerMillion = 8
		}),
		testModel("gpt", func(model *Model) {
			model.Provider = "openai"
			model.InputCostPerMillion = 2
			model.OutputCostPerMillion = 8
		}),
	}
	selected := selectUnambiguousDynamicPricingModels(models)
	if len(selected) != 1 || selected[0].Provider != "openai" {
		t.Fatalf("collapsed representative = %+v, want the openai row", selected)
	}
}
