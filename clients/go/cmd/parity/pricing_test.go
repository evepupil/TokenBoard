package main

// The harness-fidelity contract: parity's ccusage side and native side must
// price from one merged config, in one state directory. Each test below fails
// on the regression it guards — a missing --config, a second state directory, a
// prepare failure swallowed into an empty that reads like a clean comparison.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/pricing"
)

// offlinePrepare is the real Prepare pinned offline: the endpoint, the explicit
// config and the fetcher are cleared, so the state directory the harness passes
// in is honoured but the bundled static catalogue is what gets merged. A test
// that never reaches a network would otherwise reach the developer's own
// TOKENBOARD_ENDPOINT.
func offlinePrepare(input pricing.PrepareInput) (pricing.PreparedConfig, error) {
	input.Endpoint = ""
	input.ExplicitConfig = ""
	input.Fetcher = nil
	return pricing.Prepare(input)
}

// offlineFetcher refuses any catalogue request and records it.
type offlineFetcher struct {
	mutex    sync.Mutex
	requests []string
	// answer, when set, answers instead of failing.
	answer func(*http.Request) (*http.Response, error)
}

func (fetcher *offlineFetcher) fetch(request *http.Request) (*http.Response, error) {
	fetcher.mutex.Lock()
	fetcher.requests = append(fetcher.requests, request.URL.String())
	fetcher.mutex.Unlock()
	if fetcher.answer != nil {
		return fetcher.answer(request)
	}
	return nil, errors.New("network access is not allowed in this test")
}

func (fetcher *offlineFetcher) count() int {
	fetcher.mutex.Lock()
	defer fetcher.mutex.Unlock()
	return len(fetcher.requests)
}

// noAmbientConfig removes the pricing variables from the environment a parity
// run reads, so the developer's own shell settings cannot leak into a test.
func noAmbientConfig(key string) string {
	switch key {
	case "TOKENBOARD_ENDPOINT", "TOKENBOARD_CCUSAGE_CONFIG", "TOKENBOARD_HOOK_MODE":
		return ""
	}
	return os.Getenv(key)
}

// TestParityPassesThePreparedConfigToCcusage drives the real execCcusage argv
// path: the ccusage request carries the config pricing.Prepare just wrote into
// the run's state directory, and ccusageReportArgs turns it into a trailing
// `--config <path>` pair on both reports, exactly where the providers append
// it.
func TestParityPassesThePreparedConfigToCcusage(t *testing.T) {
	for _, source := range []contract.Source{contract.SourceClaudeCode, contract.SourceCodex} {
		t.Run(string(source), func(t *testing.T) {
			var requests []ccusageRequest
			report, err := runParity(context.Background(), parityInput{
				Source:       source,
				Timezone:     "UTC",
				Env:          noAmbientConfig,
				LookupNative: func(contract.Source) (collect.Provider, bool) { return nil, false },
				CollectCcusage: func(_ context.Context, request ccusageRequest) ([]contract.Snapshot, error) {
					requests = append(requests, request)
					// The file has to exist while ccusage would read it: the
					// state directory is temporary and gone once the run ends.
					info, err := os.Stat(request.ConfigPath)
					if err != nil || !info.Mode().IsRegular() {
						t.Errorf("prepared config %q is not a readable file during the run: %v", request.ConfigPath, err)
					}
					return nil, nil
				},
				Now: func() time.Time { return time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC) },
			})
			if err != nil {
				t.Fatalf("runParity: %v", err)
			}
			if len(requests) != 1 {
				t.Fatalf("ccusage requests = %d, want 1", len(requests))
			}
			configPath := requests[0].ConfigPath
			if configPath == "" {
				t.Fatal("ccusage request carries no config path; the ccusage side would price from its built-in catalogue")
			}
			if report.PricingConfig != configPath {
				t.Errorf("report pricingConfig = %q, want the path handed to ccusage %q", report.PricingConfig, configPath)
			}
			// The directory is a throwaway one, removed with the run: a harness
			// must never leave the comparison's state behind.
			if _, err := os.Stat(filepath.Dir(configPath)); !errors.Is(err, os.ErrNotExist) {
				t.Errorf("state directory %s survived the run (err = %v)", filepath.Dir(configPath), err)
			}

			for _, name := range []string{"daily", "session"} {
				args, err := ccusageReportArgs(source, name, []string{"--since", "2026-11-01"}, "UTC", configPath)
				if err != nil {
					t.Fatalf("%s args: %v", name, err)
				}
				if len(args) < 2 || args[len(args)-2] != "--config" || args[len(args)-1] != configPath {
					t.Errorf("%s args = %q, want them to end with --config %s", name, args, configPath)
				}
			}
		})
	}
}

// TestCcusageReportArgsMatchProduction adds --config to the pinned production
// flags in every other position, and proves an empty path adds no flag at all
// (ccrunner.ConfigArgs returns nil when neither config variable is set).
func TestCcusageReportArgsMatchProduction(t *testing.T) {
	rangeArgs := []string{"--since", "2026-11-01", "--until", "2026-11-03"}
	config := []string{"--config", "/state/ccusage.dynamic.json"}
	cases := []struct {
		source contract.Source
		report string
		want   []string
	}{
		{contract.SourceClaudeCode, "daily", []string{"claude", "daily", "--json", "--breakdown", "--single-thread", "--since", "2026-11-01", "--until", "2026-11-03", "--timezone", "UTC", config[0], config[1]}},
		// No --offline for claude-code: production omits it deliberately.
		{contract.SourceClaudeCode, "session", []string{"claude", "session", "--json", "--single-thread", "--since", "2026-11-01", "--until", "2026-11-03", "--timezone", "UTC", config[0], config[1]}},
		{contract.SourceCodex, "daily", []string{"codex", "daily", "--json", "--offline", "--single-thread", "--since", "2026-11-01", "--until", "2026-11-03", "--timezone", "UTC", config[0], config[1]}},
		{contract.SourceKimi, "session", []string{"kimi", "session", "--json", "--since", "2026-11-01", "--until", "2026-11-03", "--timezone", "UTC", config[0], config[1]}},
		{contract.SourceGeminiCLI, "daily", []string{"gemini", "daily", "--json", "--since", "2026-11-01", "--until", "2026-11-03", "--timezone", "UTC", config[0], config[1]}},
	}
	for _, testCase := range cases {
		args, err := ccusageReportArgs(testCase.source, testCase.report, rangeArgs, "UTC", config[1])
		if err != nil {
			t.Fatalf("%s %s: %v", testCase.source, testCase.report, err)
		}
		if !equalArgv(args, testCase.want) {
			t.Errorf("%s %s args = %q, want %q", testCase.source, testCase.report, args, testCase.want)
		}
	}

	withoutConfig, err := ccusageReportArgs(contract.SourceClaudeCode, "daily", rangeArgs, "UTC", "")
	if err != nil {
		t.Fatalf("empty config: %v", err)
	}
	for _, arg := range withoutConfig {
		if arg == "--config" {
			t.Fatalf("empty config path produced %q; production adds no flag in that case", withoutConfig)
		}
	}
}

// TestParityGivesBothSidesOneStateDirectory pins the shared directory: the
// config ccusage is pointed at lives inside the state directory the native
// provider is handed. Two directories would each prepare their own config —
// the same content today, but nothing would keep them together once a side
// starts writing state.
func TestParityGivesBothSidesOneStateDirectory(t *testing.T) {
	native := &stateDirRecordingProvider{}
	var ccusageConfig string
	_, err := runParity(context.Background(), parityInput{
		Source:       contract.SourceClaudeCode,
		Timezone:     "UTC",
		Env:          noAmbientConfig,
		LookupNative: func(contract.Source) (collect.Provider, bool) { return native, true },
		CollectCcusage: func(_ context.Context, request ccusageRequest) ([]contract.Snapshot, error) {
			ccusageConfig = request.ConfigPath
			return nil, nil
		},
		Now: func() time.Time { return time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("runParity: %v", err)
	}
	if native.calls != 1 {
		t.Fatalf("native provider ran %d time(s), want 1", native.calls)
	}
	if ccusageConfig == "" || native.stateDir == "" {
		t.Fatalf("config path = %q, native state dir = %q; both must be set", ccusageConfig, native.stateDir)
	}
	if got := filepath.Dir(ccusageConfig); got != native.stateDir {
		t.Fatalf("ccusage config lives in %q but the native side ran in %q; both sides must share one state directory",
			got, native.stateDir)
	}
}

// TestParityFailsWhenThePricingConfigCannotBePrepared proves a broken explicit
// config is an error, not a comparison. Either side silently pricing without
// it (or with nothing) would produce a number an operator could read as
// evidence.
func TestParityFailsWhenThePricingConfigCannotBePrepared(t *testing.T) {
	t.Run("malformed explicit config", func(t *testing.T) {
		explicit := filepath.Join(t.TempDir(), "broken.json")
		if err := os.WriteFile(explicit, []byte("{not json"), 0o600); err != nil {
			t.Fatalf("write explicit config: %v", err)
		}
		ran := false
		_, err := runParity(context.Background(), parityInput{
			Source:   contract.SourceClaudeCode,
			Timezone: "UTC",
			Env: func(key string) string {
				if key == "TOKENBOARD_CCUSAGE_CONFIG" {
					return explicit
				}
				return noAmbientConfig(key)
			},
			LookupNative: func(contract.Source) (collect.Provider, bool) { return &paritySeamStub{}, true },
			CollectCcusage: func(context.Context, ccusageRequest) ([]contract.Snapshot, error) {
				ran = true
				return nil, nil
			},
		})
		if err == nil {
			t.Fatal("runParity with a malformed explicit config = nil error, want the prepare failure")
		}
		if !strings.Contains(err.Error(), "pricing config") {
			t.Errorf("error = %v, want it to name the pricing config", err)
		}
		if ran {
			t.Error("the ccusage side ran without the merged config; a run under a different pricing is not evidence")
		}
	})

	t.Run("prepare failure seam", func(t *testing.T) {
		sentinel := errors.New("catalogue is unreachable")
		_, err := runParity(context.Background(), parityInput{
			Source:       contract.SourceClaudeCode,
			Timezone:     "UTC",
			Env:          noAmbientConfig,
			LookupNative: func(contract.Source) (collect.Provider, bool) { return nil, false },
			Prepare: func(pricing.PrepareInput) (pricing.PreparedConfig, error) {
				return pricing.PreparedConfig{}, sentinel
			},
			CollectCcusage: func(context.Context, ccusageRequest) ([]contract.Snapshot, error) {
				t.Fatal("the ccusage side ran after a prepare failure")
				return nil, nil
			},
		})
		if !errors.Is(err, sentinel) {
			t.Fatalf("error = %v, want the prepare failure to surface verbatim", err)
		}
	})
}

// TestParityEmptyExplicitConfigStillWritesAConfig pins the case where no
// explicit config is configured at all: with TOKENBOARD_CCUSAGE_CONFIG empty (or
// blank) and no endpoint, Prepare materializes the bundled config, so ccusage is
// still pointed at a real, readable file rather than falling back to its
// built-in prices.
func TestParityEmptyExplicitConfigStillWritesAConfig(t *testing.T) {
	for _, explicit := range []string{"", "   "} {
		t.Run("explicit="+explicit, func(t *testing.T) {
			var configPath string
			_, err := runParity(context.Background(), parityInput{
				Source:   contract.SourceClaudeCode,
				Timezone: "UTC",
				Env: func(key string) string {
					if key == "TOKENBOARD_CCUSAGE_CONFIG" {
						return explicit
					}
					return noAmbientConfig(key)
				},
				LookupNative: func(contract.Source) (collect.Provider, bool) { return nil, false },
				CollectCcusage: func(_ context.Context, request ccusageRequest) ([]contract.Snapshot, error) {
					configPath = request.ConfigPath
					info, err := os.Stat(configPath)
					if err != nil || !info.Mode().IsRegular() {
						t.Fatalf("prepared config %q is not a readable file: %v", configPath, err)
					}
					return nil, nil
				},
			})
			if err != nil {
				t.Fatalf("runParity: %v", err)
			}
			if configPath == "" {
				t.Fatal("empty explicit config produced no --config path")
			}
		})
	}
}

// TestParityRecordsTheCatalogueSource proves the report names where the
// TokenBoard catalogue came from and that a configured endpoint makes the run
// fetch it — through the injected fetcher, asserting the request rather than
// letting it reach the network.
func TestParityRecordsTheCatalogueSource(t *testing.T) {
	t.Run("no endpoint uses the bundled catalogue without a request", func(t *testing.T) {
		fetcher := &offlineFetcher{}
		report, err := runParity(context.Background(), parityInput{
			Source:         contract.SourceClaudeCode,
			Timezone:       "UTC",
			Env:            noAmbientConfig,
			PricingFetcher: fetcher.fetch,
			LookupNative:   func(contract.Source) (collect.Provider, bool) { return nil, false },
			CollectCcusage: func(context.Context, ccusageRequest) ([]contract.Snapshot, error) { return nil, nil },
		})
		if err != nil {
			t.Fatalf("runParity: %v", err)
		}
		if report.PricingSource != "static" {
			t.Errorf("pricingSource = %q, want static", report.PricingSource)
		}
		if fetcher.count() != 0 {
			t.Errorf("fetcher called %d time(s) with no endpoint: %v", fetcher.count(), fetcher.requests)
		}
	})

	t.Run("endpoint fetches the catalogue", func(t *testing.T) {
		fetcher := &offlineFetcher{answer: func(*http.Request) (*http.Response, error) {
			body, err := json.Marshal(map[string]any{
				"models": []any{map[string]any{
					"provider":                 "openai",
					"modelId":                  "gpt-parity",
					"inputCostPerMillion":      5,
					"outputCostPerMillion":     30,
					"contextWindow":            400_000,
					"maxInputTokens":           400_000,
					"pricing":                  map[string]any{},
					"cacheReadCostPerMillion":  nil,
					"cacheWriteCostPerMillion": nil,
				}},
				"nextCursor": nil,
			})
			if err != nil {
				return nil, err
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": {"application/json"}},
				Body:       io.NopCloser(bytes.NewReader(body)),
			}, nil
		}}
		report, err := runParity(context.Background(), parityInput{
			Source:   contract.SourceClaudeCode,
			Timezone: "UTC",
			Env: func(key string) string {
				if key == "TOKENBOARD_ENDPOINT" {
					return "https://parity.example.test"
				}
				return noAmbientConfig(key)
			},
			PricingFetcher: fetcher.fetch,
			LookupNative:   func(contract.Source) (collect.Provider, bool) { return nil, false },
			CollectCcusage: func(_ context.Context, request ccusageRequest) ([]contract.Snapshot, error) {
				// The catalogue cache this run just wrote lives next to the
				// config. The native provider prepares from the same directory,
				// so it reads that fresh cache instead of fetching a second
				// time — the two sides price from one catalogue, not two.
				if _, err := os.Stat(filepath.Join(filepath.Dir(request.ConfigPath), pricing.CacheFileName)); err != nil {
					t.Errorf("catalogue cache missing from the shared state directory: %v", err)
				}
				return nil, nil
			},
		})
		if err != nil {
			t.Fatalf("runParity: %v", err)
		}
		if report.PricingSource != "network" {
			t.Errorf("pricingSource = %q, want network", report.PricingSource)
		}
		if fetcher.count() != 1 || !strings.HasPrefix(fetcher.requests[0], "https://parity.example.test/api/v1/model-pricing?") {
			t.Errorf("fetcher requests = %v, want one catalogue request for the configured endpoint", fetcher.requests)
		}
	})
}

// TestPricingPrepareIsOfflineInTests keeps offlinePrepare honest: every test
// here injects the run's own fetcher or an endpoint-free environment.
func TestPricingPrepareIsOfflineInTests(t *testing.T) {
	prepared, err := offlinePrepare(pricing.PrepareInput{StateDir: t.TempDir()})
	if err != nil {
		t.Fatalf("offlinePrepare: %v", err)
	}
	if prepared.ConfigPath == "" {
		t.Fatal("offlinePrepare produced no config path")
	}
}

// stateDirRecordingProvider records the state directory and environment the
// native side ran with.
type stateDirRecordingProvider struct {
	calls    int
	stateDir string
	env      func(string) string
}

func (p *stateDirRecordingProvider) Collect(_ context.Context, options collect.Options) ([]contract.Snapshot, error) {
	p.calls++
	p.stateDir = options.StateDir
	p.env = options.Env
	return nil, nil
}

func equalArgv(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
