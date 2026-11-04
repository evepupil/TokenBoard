package nativepricing

// The ccusage parity gate: goldens/cost-cases.json holds real cost values minted
// by ccusage 20.0.33 (see clients/go/scripts/gen-native-pricing-goldens.mjs) and
// this test requires the native engine to reproduce them bit for bit.
//
// The goldens can never be regenerated after ccusage leaves the repository, so
// two rules keep this file honest:
//
//   - every case is compared with math.Float64bits, never with an epsilon: a
//     1 ULP drift forks snapshotHash and is exactly what the parity chain
//     exists to catch;
//   - the case count is asserted non-zero and every case must be visited, so a
//     golden set that silently emptied out fails instead of passing vacuously.
//
// Where the native engine knowingly answers differently, the case is listed in
// knownDivergences with the value it must produce, the ccusage value it must
// not, and the reason. A diverging case is never deleted or skipped: if the
// merged corpus is ever restructured so the two agree, the assertion that they
// still differ fails and forces the ledger to be revisited.

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// costGoldensJSON is goldens/cost-cases.json compiled into the test binary.
//
// Embedding rather than reading the file keeps the gate independent of both the
// process's working directory and `go test -trimpath`, which rewrites the paths
// runtime.Caller reports. A missing or renamed file is a build failure instead
// of a runtime one, which is the fail-closed direction.
//
//go:embed goldens/cost-cases.json
var costGoldensJSON []byte

type costGoldens struct {
	GeneratedBy struct {
		CcusageVersion   string         `json:"ccusageVersion"`
		Command          string         `json:"command"`
		ConfigPath       string         `json:"configPath"`
		ConfigSha256     string         `json:"configSha256"`
		PricingOverrides map[string]any `json:"pricingOverrides"`
	} `json:"generatedBy"`
	Cases []costGoldenCase `json:"cases"`
}

type costGoldenCase struct {
	Name              string   `json:"name"`
	Day               string   `json:"day"`
	Model             string   `json:"model"`
	ReportedModelName string   `json:"reportedModelName"`
	InputTokens       int64    `json:"inputTokens"`
	OutputTokens      int64    `json:"outputTokens"`
	CacheCreate5m     int64    `json:"cacheCreate5m"`
	CacheCreate1h     int64    `json:"cacheCreate1h"`
	CacheRead         int64    `json:"cacheRead"`
	Fast              bool     `json:"fast"`
	ReportedCostUsd   *float64 `json:"reportedCostUsd"`
	Cost              float64  `json:"cost"`
	CalculatedCost    float64  `json:"calculatedCost"`
	MissingPricing    bool     `json:"missingPricing"`
}

// knownDivergence is one case the merged Corpus cannot answer like ccusage.
type knownDivergence struct {
	// ccusageCost is the value recorded in the goldens; the test asserts it has
	// not moved, so a regenerated golden set cannot quietly change the story.
	ccusageCost float64
	// nativeCost is what the native engine must produce instead.
	nativeCost float64
	reason     string
}

// knownDivergences is the ledger of the merged-corpus boundary.
//
// ccusage keeps two pricing maps and answers an alternate '.'/'@' spelling of
// an exact-only id from the models.dev map (ExactOnlyKeys::id_spelled_by,
// rust/crates/ccusage-core/src/pricing.rs:517-523, reached from
// find_entry_with_fallback, pricing.rs:1586-1610). Corpus (Task 1) merges both
// snapshots into one map keyed by pricing key, so for an id present in BOTH
// tables a respelled request answers from the merged entry (which carries the
// primary table's rates) while ccusage answers from its models.dev row.
//
// Only a respelling can reach the difference: a canonical request hits the
// primary exact key in both implementations. Every canonical counterpart is in
// the goldens and must match, which is what pins this ledger to the respelling
// alone.
//
// The derivation of each entry:
//
//   - family-gpt5-codex-dot: "gpt-5.codex" normalises to "gpt-5-codex", which
//     LiteLLM prices at cache_read=1.25e-7 and models.dev at 0.13/M=1.3e-7
//     (data/models-dev-pricing.json: "cache_read":0.13). ccusage answers from
//     models.dev (1.3e-7), our merged corpus from LiteLLM (1.25e-7).
//
//   - family-gpt51-codex-dot: "gpt-5.1.codex" normalises to "gpt-5.1-codex".
//     The builtin table overwrites gpt-5.1-codex with cache_create=1.25e-6
//     and cache_read=1.25e-7 (builtin.go line 102). models.dev publishes no
//     cache_write, so ccusage derives cache_create=1.25e-6*1.25=1.5625e-6.
//     LiteLLM has no cache_create, so it derives 1.25e-6*1.25=1.5625e-6 - but
//     the builtin overwrite replaces it with 1.25e-6. ccusage answers from
//     models.dev (derived 1.5625e-6), our merged corpus from the builtin
//     overwrite (1.25e-6).
//
//   - family-gpt52-dash/at and family-gpt52-codex-dot/at: "gpt-5-2",
//     "gpt-5@2", "gpt-5.2.codex", "gpt-5.2@codex" all normalise to
//     "gpt-5-2"/"gpt-5.2-codex". The builtin overwrites gpt-5.2-codex and
//     gpt-5.2 with cache_create=1.75e-6 (builtin.go lines 106/108). models.dev
//     publishes no cache_write, so ccusage derives cache_create=1.75e-6*1.25=
//     2.1875e-6. ccusage answers from models.dev (overridden via find_at's
//     override: cacheRead=1.75e-7 from override), our merged corpus from the
//     builtin (1.75e-6 cache_create).
//
//   - family-deepseek-dot/at and family-deepseek-provider-dot/at:
//     "deepseek.flash", "deepseek@flash", "deepseek/deepseek.flash",
//     "deepseek/deepseek@flash" normalise to "deepseek-flash" /
//     "deepseek-deepseek-flash". ccusage's find_at applies the shipped override
//     only to the exact key in user_overrides (which has "deepseek-flash" and
//     "deepseek/deepseek-flash" but NOT "deepseek.flash" etc.); a respelled
//     request falls through to the embedded models.dev entry without the
//     override. Corpus.WithServerOverrides writes the overridden entry into
//     the merged map under the canonical keys, and Find resolves the respelling
//     to one of those, so the override is applied regardless.
//
//   - family-gpt56-dash: "gpt-5-6" normalises to "gpt-5.6". The shipped
//     override raises gpt-5.6 to $5/$30 (from the snapshots' $4/$20), so the
//     two sides disagree the same way the deepseek family does - ccusage
//     answers the respelling from the un-overridden models.dev row, our
//     merged corpus from the overridden entry. gpt-5-6-sol (the
//     family-gpt56-sol-dash case) is the control: there the only difference is
//     a 1-ULP cache_read (4e-7 vs 0.4/M), which is invisible at the cost's
//     resolution, so both sides still agree bit for bit.
//
//   - family-gpt41-mini-dash, family-gpt41-mini-date-dash and
//     family-gpt41-nano-dash: "gpt-4-1-mini", "gpt-4-1-mini-2025-04-14" and
//     "gpt-4-1-nano" are dash spellings of the models.dev exact-only ids
//     "gpt-4.1-mini", "gpt-4.1-mini-2025-04-14" and "gpt-4.1-nano", which
//     LiteLLM also prices (input 4e-7, cache_read 1e-7 for the mini pair;
//     input 1e-7, cache_read 2.5e-8 for nano). ccusage answers the dash
//     spelling through id_spelled_by from its models.dev row, whose
//     per-million division (0.4/M, 0.1/M for mini; 0.1/M, 0.025/M for nano)
//     does not land on the same double as LiteLLM's explicit rate; the merged
//     corpus answers from the LiteLLM entry. The rates are equal in decimal
//     terms, so the divergence is exactly 1 ULP of the cost (mini:
//     0x3f54cec41dd1a21e vs ccusage's 0x3f54cec41dd1a21f; nano:
//     0x3f34cec41dd1a21e vs 0x3f34cec41dd1a21f).
//
// knownDivergences below is the complete ledger of the divergences the merged
// corpus produces on this golden set: every entry is a divergence, and the
// parity gate fails on any case NOT in the ledger whose bits differ (and on any
// ledger entry that stops diverging). The exact-only family is therefore covered
// by the cases actually present - canonical spellings, the respelled cases
// listed here, and controls such as family-gpt56-sol-dash that must still agree
// - not by an argument about which spellings can move a cost. The gpt-4.1
// entries exist because such an argument was made once and was wrong at these
// very token counts. Any further exact-only respelling that crosses a bit
// boundary and is added to the golden set surfaces as a test failure until it
// is registered here; it cannot pass silently.
var knownDivergences = map[string]knownDivergence{
	"family-gpt5-codex-dot": {
		ccusageCost: 0.0064322500000000005,
		nativeCost:  0.0064312500000000003,
		reason: "merged corpus: LiteLLM cache_read=1.25e-7; ccusage: models.dev cache_read=1.3e-7 " +
			"(models-dev-pricing.json cache_read:0.13, find_entry_with_fallback id_spelled_by)",
	},
	"family-gpt51-codex-dot": {
		ccusageCost: 0.00643125,
		nativeCost:  0.0064000000000000003,
		reason: "merged corpus: builtin-overwrite cache_create=1.25e-6; ccusage: models.dev derives " +
			"cache_create=1.25e-6*1.25=1.5625e-6 (no published cache_write in models-dev-pricing.json)",
	},
	"family-gpt51-codex-dash": {
		ccusageCost: 0.00643125,
		nativeCost:  0.0064000000000000003,
		reason:      "same as family-gpt51-codex-dot; the dash spelling normalises to the same exact-only id",
	},
	"family-gpt52-dash": {
		ccusageCost: 0.009003750000000001,
		nativeCost:  0.0089600000000000009,
		reason: "merged corpus: builtin-overwrite cache_create=1.75e-6; ccusage: models.dev derives " +
			"cache_create=1.75e-6*1.25=2.1875e-6 (no published cache_write)",
	},
	"family-gpt52-at": {
		ccusageCost: 0.009003750000000001,
		nativeCost:  0.0089600000000000009,
		reason:      "same as family-gpt52-dash; '@' normalises to '-'",
	},
	"family-gpt52-codex-dot": {
		ccusageCost: 0.009003750000000001,
		nativeCost:  0.0089600000000000009,
		reason: "merged corpus: builtin-overwrite cache_create=1.75e-6; ccusage: models.dev derives " +
			"cache_create=1.75e-6*1.25=2.1875e-6",
	},
	"family-gpt52-codex-dash": {
		ccusageCost: 0.009003750000000001,
		nativeCost:  0.0089600000000000009,
		reason:      "same as family-gpt52-codex-dot; the dash spelling normalises to the same exact-only id",
	},
	"family-gpt52-codex-at": {
		ccusageCost: 0.009003750000000001,
		nativeCost:  0.0089600000000000009,
		reason:      "same as family-gpt52-codex-dot; '@' normalises to '-'",
	},
	"family-gpt56-dash": {
		ccusageCost: 0.014580000000000001,
		nativeCost:  0.020725,
		reason: "merged corpus: the shipped override lifts gpt-5.6 from 4e-6/2e-5 to 5e-6/3e-5 " +
			"(cache_create 5e-6->6.25e-6, cache_read 4e-7->5e-7) and Find answers the respelling from " +
			"that entry; ccusage's find_at applies the override only to the exact key \"gpt-5.6\", so " +
			"\"gpt-5-6\" gets the un-overridden models.dev row",
	},
	"family-deepseek-dot": {
		ccusageCost: 0.00046935,
		nativeCost:  0.0004506,
		reason: "merged corpus: Find resolves to overridden entry (input=1.5e-7, cache_create=0 from " +
			"empty base); ccusage: find_at applies override only to exact key \"deepseek-flash\", " +
			"respelling \"deepseek.flash\" gets bare models.dev rates (cache_create=" +
			"1.5e-7*1.25=1.875e-7)",
	},
	"family-deepseek-at": {
		ccusageCost: 0.00046935,
		nativeCost:  0.0004506,
		reason:      "same as family-deepseek-dot; '@' normalises to '-'",
	},
	"family-deepseek-provider-dot": {
		ccusageCost: 0.00046935,
		nativeCost:  0.0004506,
		reason:      "same merged-corpus vs ccusage id_spelled_by difference as family-deepseek-dot",
	},
	"family-deepseek-provider-at": {
		ccusageCost: 0.00046935,
		nativeCost:  0.0004506,
		reason:      "same as family-deepseek-provider-dot; '@' normalises to '-'",
	},
	"family-gpt41-mini-dash": {
		ccusageCost: 0.00127,
		nativeCost:  0.0012699999999999999,
		reason: "merged corpus answers the dash spelling from the LiteLLM explicit rate " +
			"(input=4e-7, cache_read=1e-7); ccusage resolves it through the models.dev " +
			"exact-only id gpt-4.1-mini's id_spelled_by, whose 0.4/M and 0.1/M per-million " +
			"division differs by 1 ULP (native 0x3f54cec41dd1a21e, ccusage 0x3f54cec41dd1a21f)",
	},
	"family-gpt41-mini-date-dash": {
		ccusageCost: 0.00127,
		nativeCost:  0.0012699999999999999,
		reason: "same as family-gpt41-mini-dash; the dated models.dev id publishes the same " +
			"per-million rates with their own rounding (input 0.39999999999999997/M)",
	},
	"family-gpt41-nano-dash": {
		ccusageCost: 0.0003175,
		nativeCost:  0.00031749999999999997,
		reason: "same 1-ULP mechanism as family-gpt41-mini-dash with gpt-4.1-nano's rates " +
			"(LiteLLM input=1e-7, cache_read=2.5e-8; models.dev 0.1/M and 0.025/M): " +
			"native 0x3f34cec41dd1a21e, ccusage 0x3f34cec41dd1a21f",
	},
}

func TestCostMatchesTheCcusageGoldens(t *testing.T) {
	document := loadCostGoldens(t)
	if len(document.Cases) == 0 {
		t.Fatal("goldens/cost-cases.json holds no cases — the parity gate would pass vacuously")
	}
	if document.GeneratedBy.CcusageVersion != "20.0.33" {
		t.Fatalf(
			"goldens were minted with ccusage %q, but the corpus is frozen against 20.0.33",
			document.GeneratedBy.CcusageVersion,
		)
	}
	if len(document.GeneratedBy.PricingOverrides) == 0 {
		t.Fatal("goldens carry no pricingOverrides — every overridden model would be priced from the raw corpus")
	}

	// The goldens carry their own copy of the override block so the test does
	// not silently run without it when the config file moves.
	corpus := goldensCorpus(t, document)

	names := goldenCaseNames(document.Cases)
	for name := range knownDivergences {
		if !names[name] {
			t.Errorf("knownDivergences lists %q, which is not a golden case — the ledger is stale", name)
		}
	}

	visited := 0
	diverged := 0
	for _, testCase := range document.Cases {
		testCase := testCase
		t.Run(testCase.Name, func(t *testing.T) {
			golden := requireGoldenShape(t, testCase)
			usage := Usage{
				Input:         testCase.InputTokens,
				Output:        testCase.OutputTokens,
				CacheCreate5m: testCase.CacheCreate5m,
				CacheCreate1h: testCase.CacheCreate1h,
				CacheRead:     testCase.CacheRead,
				ReportedCost:  testCase.ReportedCostUsd,
			}

			// ccusage's default mode is `auto` (claude daily --help), and
			// `calculate` is the pure formula the engine ports. Both runs were
			// recorded, so the whole CostMode matrix is checked against the
			// binary rather than against itself.
			calculated, calculatedMissing := Cost(corpus, testCase.Model, usage, golden, ModeCalculate, testCase.Fast, false)
			automatic, automaticMissing := Cost(corpus, testCase.Model, usage, golden, ModeAuto, testCase.Fast, false)
			displayed, _ := Cost(corpus, testCase.Model, usage, golden, ModeDisplay, testCase.Fast, false)

			expected := testCase.CalculatedCost
			if divergence, ok := knownDivergences[testCase.Name]; ok {
				diverged++
				if !sameFloat(divergence.ccusageCost, expected) {
					t.Errorf(
						"golden drifted: recorded ccusage cost is %v, the ledger expects %v\n"+
							"  the ledger's reason was: %s\n"+
							"  re-derive the divergence before regenerating the goldens",
						expected, divergence.ccusageCost, divergence.reason,
					)
				}
				if sameFloat(calculated, expected) {
					t.Errorf(
						"the merged corpus now matches ccusage at %v for %q, but knownDivergences still "+
							"records it as divergent:\n  %s\n  remove the ledger entry (and say so in the report)",
						calculated, testCase.Name, divergence.reason,
					)
				}
				if !sameFloat(calculated, divergence.nativeCost) {
					t.Errorf(
						"divergent case moved: got %v, ledger records %v (ccusage says %v)\n  %s",
						calculated, divergence.nativeCost, expected, divergence.reason,
					)
				}
			} else if !sameFloat(calculated, expected) {
				t.Errorf(
					"%s\n  model=%s tokens{in=%d out=%d cc5m=%d cc1h=%d cr=%d} fast=%v\n"+
						"  got      %v (%#016x)\n  ccusage  %v (%#016x)\n  delta    %v",
					"ModeCalculate cost differs from ccusage", testCase.Model,
					testCase.InputTokens, testCase.OutputTokens, testCase.CacheCreate5m,
					testCase.CacheCreate1h, testCase.CacheRead, testCase.Fast,
					calculated, math.Float64bits(calculated),
					expected, math.Float64bits(expected),
					calculated-expected,
				)
			}

			if !sameFloat(automatic, wantAuto(testCase)) {
				t.Errorf(
					"ModeAuto cost differs: got %v (%#016x), want %v (%#016x) for model=%s reportedCost=%v",
					automatic, math.Float64bits(automatic),
					wantAuto(testCase), math.Float64bits(wantAuto(testCase)),
					testCase.Model, testCase.ReportedCostUsd,
				)
			}

			wantDisplay := 0.0
			if testCase.ReportedCostUsd != nil {
				wantDisplay = *testCase.ReportedCostUsd
			}
			if !sameFloat(displayed, wantDisplay) {
				t.Errorf("ModeDisplay cost = %v, want %v (the reported cost, or zero)", displayed, wantDisplay)
			}

			if automaticMissing != testCase.MissingPricing {
				t.Errorf(
					"missingPricing (auto) = %v, ccusage reported %v for model=%s",
					automaticMissing, testCase.MissingPricing, testCase.Model,
				)
			}
			if calculatedMissing != testCase.MissingPricing {
				t.Errorf(
					"missingPricing (calculate) = %v, ccusage reported %v for model=%s",
					calculatedMissing, testCase.MissingPricing, testCase.Model,
				)
			}

			visited++
		})
	}

	if visited != len(document.Cases) {
		t.Errorf("visited %d of %d golden cases", visited, len(document.Cases))
	}
	if visited == 0 {
		t.Fatal("no golden case ran — the gate must never pass with nothing checked")
	}
	t.Logf(
		"checked %d golden cases against ccusage %s, %d of them recorded divergences",
		visited, document.GeneratedBy.CcusageVersion, diverged,
	)
}

// wantAuto is the value ModeAuto must produce. Without a reported cost, Auto is
// intentionally identical to Calculate — Cost prices the request and only the
// recorded divergence (if any) applies; with one, Auto trusts the stored cost
// and the golden records exactly that.
func wantAuto(testCase costGoldenCase) float64 {
	if testCase.ReportedCostUsd != nil {
		return *testCase.ReportedCostUsd
	}
	if divergence, ok := knownDivergences[testCase.Name]; ok {
		return divergence.nativeCost
	}
	return testCase.Cost
}

// TestGoldens_applyTheShippedOverrides is the explicit check that the override
// wiring in goldensCorpus is load-bearing rather than decorative.
//
// The goldens were minted under `--config packages/collector/ccusage.json`, so a
// run without the override block would test a different pricing universe. Two
// cases prove the block is applied: both are ids that exist only in models.dev,
// whose overrides start from an empty primary base (pricing.rs:1822-1826), so
// dropping the overrides changes their cache-creation rate visibly.
func TestGoldens_applyTheShippedOverrides(t *testing.T) {
	document := loadCostGoldens(t)
	raw, err := LoadEmbeddedCorpus()
	if err != nil {
		t.Fatalf("LoadEmbeddedCorpus: %v", err)
	}
	overridden := goldensCorpus(t, document)

	differing := 0
	changed := map[string]bool{}
	for _, testCase := range document.Cases {
		usage := Usage{
			Input:         testCase.InputTokens,
			Output:        testCase.OutputTokens,
			CacheCreate5m: testCase.CacheCreate5m,
			CacheCreate1h: testCase.CacheCreate1h,
			CacheRead:     testCase.CacheRead,
			ReportedCost:  testCase.ReportedCostUsd,
		}
		rawCost, _ := Cost(raw, testCase.Model, usage, time.Unix(0, 0), ModeCalculate, testCase.Fast, false)
		overriddenCost, _ := Cost(overridden, testCase.Model, usage, time.Unix(0, 0), ModeCalculate, testCase.Fast, false)
		if !sameFloat(rawCost, overriddenCost) {
			differing++
			changed[testCase.Name] = true
		}
	}
	if differing == 0 {
		t.Fatal(
			"no golden case changed when the shipped pricingOverrides were dropped — " +
				"goldensCorpus is not applying them, so the gate would run against the wrong corpus",
		)
	}
	// These two are the cases whose override starts from an empty primary base
	// (both ids are models.dev-only). If they did not change, the override block
	// is being applied to the wrong stage.
	for _, name := range []string{"override-grok-4.5", "family-deepseek-canonical"} {
		if !changed[name] {
			t.Errorf(
				"%q is priced identically with and without the shipped overrides, but its override "+
					"must rebuild it from an empty primary base (pricing.rs:1822-1826)",
				name,
			)
		}
	}
	t.Logf("%d of %d golden cases changed when the shipped overrides were dropped", differing, len(document.Cases))
}

// TestGoldens_overridesMatchTheShippedConfig catches the one drift the parity
// gate cannot see on its own: editing packages/collector/ccusage.json without
// re-minting the goldens. The goldens carry a copy of the override block on
// purpose, so a silent change there would make the gate compare against rates
// the shipped configuration no longer produces.
func TestGoldens_overridesMatchTheShippedConfig(t *testing.T) {
	document := loadCostGoldens(t)
	configPath := findShippedConfig(t)
	contents, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read %s: %v", configPath, err)
	}
	sum := sha256.Sum256(contents)
	if got := hex.EncodeToString(sum[:]); got != document.GeneratedBy.ConfigSha256 {
		t.Fatalf(
			"%s changed since the goldens were minted (sha256 %s, goldens record %s).\n"+
				"  Re-run clients/go/scripts/gen-native-pricing-goldens.mjs and review the diff.",
			document.GeneratedBy.ConfigPath, got, document.GeneratedBy.ConfigSha256,
		)
	}
}

// findShippedConfig walks up from this package to the repository's shipped
// ccusage config. It fails (rather than skipping) because a checkout without
// the config is not a checkout this gate can validate.
func findShippedConfig(t *testing.T) string {
	t.Helper()
	directory := packageDir(t)
	for depth := 0; depth < 8; depth++ {
		candidate := filepath.Join(directory, "packages", "collector", "ccusage.json")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			break
		}
		directory = parent
	}
	t.Fatalf("could not find packages/collector/ccusage.json above %s", packageDir(t))
	return ""
}

// requireGoldenShape pins the fixture's own sanity: a fast case must have been
// renamed by ccusage, and every other case must keep its spelling. Without this
// a fixture that forgot `speed: "fast"` would still "pass" while testing
// nothing about the multiplier.
func requireGoldenShape(t *testing.T, testCase costGoldenCase) time.Time {
	t.Helper()
	if testCase.Model == "" {
		t.Fatal("golden case has an empty model")
	}
	if testCase.Fast {
		if testCase.ReportedModelName != testCase.Model+"-fast" {
			t.Fatalf(
				"fast case %q was reported as %q; ccusage suffixes the breakdown with -fast (daily.rs:338-346)",
				testCase.Model, testCase.ReportedModelName,
			)
		}
	} else if testCase.ReportedModelName != testCase.Model {
		t.Fatalf(
			"case %q was reported as %q; only a fast request is renamed",
			testCase.Model, testCase.ReportedModelName,
		)
	}
	at, err := time.Parse("2006-01-02", testCase.Day)
	if err != nil {
		t.Fatalf("golden day %q: %v", testCase.Day, err)
	}
	return at
}

// goldensCorpus loads the embedded corpus and applies the override block the
// goldens were minted under.
func goldensCorpus(t *testing.T, document costGoldens) Corpus {
	t.Helper()
	corpus, err := LoadEmbeddedCorpus()
	if err != nil {
		t.Fatalf("LoadEmbeddedCorpus: %v", err)
	}
	// The envelope shape is one WithServerOverrides accepts; serializing the
	// recorded block through it also proves the goldens' JSON survives the
	// round trip into the override layer unchanged.
	raw, err := json.Marshal(struct {
		PricingOverrides map[string]any `json:"pricingOverrides"`
	}{PricingOverrides: document.GeneratedBy.PricingOverrides})
	if err != nil {
		t.Fatalf("marshal recorded overrides: %v", err)
	}
	corpus, err = corpus.WithServerOverrides(raw)
	if err != nil {
		t.Fatalf("WithServerOverrides: %v", err)
	}
	return corpus
}

func loadCostGoldens(t *testing.T) costGoldens {
	t.Helper()
	var document costGoldens
	if err := json.Unmarshal(costGoldensJSON, &document); err != nil {
		t.Fatalf("parse the embedded goldens/cost-cases.json: %v", err)
	}
	return document
}

// packageDir resolves the package directory from the process's working
// directory. `go test` always runs the test binary with cwd set to the package's
// source directory, and unlike runtime.Caller this is unaffected by -trimpath
// (which rewrites the compiled file paths to module-relative ones). The walk
// only needs the repo root, which this cwd is a stable descendant of.
func packageDir(t *testing.T) string {
	t.Helper()
	directory, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd: %v", err)
	}
	return directory
}

// sameFloat compares two costs bit for bit. Every parity assertion goes through
// it: an epsilon would hide the 1 ULP drift that forks snapshotHash.
func sameFloat(left, right float64) bool {
	return math.Float64bits(left) == math.Float64bits(right)
}

// goldenCaseNames is a lookup of every case in the committed golden set, so the
// ledger-staleness check is O(1) per knownDivergences entry.
func goldenCaseNames(cases []costGoldenCase) map[string]bool {
	names := make(map[string]bool, len(cases))
	for _, testCase := range cases {
		names[testCase.Name] = true
	}
	return names
}
