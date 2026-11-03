package nativepricing

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// The vendored corpus is generated and pinned by
// clients/go/scripts/fetch-native-pricing.mjs; these numbers are the values that
// script records. A drift here means the assets changed without the generator
// (and therefore without the sha256 pins) being re-run.
const (
	wantLitellmCount        = 534
	wantModelsDevCount      = 3074
	wantMergedModelsMinimum = 3000
)

func mustLoadCorpus(t *testing.T) Corpus {
	t.Helper()
	corpus, err := LoadEmbeddedCorpus()
	if err != nil {
		t.Fatalf("LoadEmbeddedCorpus: %v", err)
	}
	return corpus
}

func approx(t *testing.T, got, want float64, what string) {
	t.Helper()
	if math.Abs(got-want) > math.Abs(want)*1e-12 {
		t.Fatalf("%s: got %v, want %v", what, got, want)
	}
}

func TestLoadEmbeddedCorpusParsesEverySnapshot(t *testing.T) {
	corpus := mustLoadCorpus(t)

	if len(corpus.Models) < wantMergedModelsMinimum {
		t.Fatalf("Models has %d entries, want at least %d", len(corpus.Models), wantMergedModelsMinimum)
	}
	if got := corpus.Counts[countLitellm]; got != wantLitellmCount {
		t.Fatalf("Counts[litellm] = %d, want %d", got, wantLitellmCount)
	}
	if got := corpus.Counts[countModelsDev]; got != wantModelsDevCount {
		t.Fatalf("Counts[models-dev] = %d, want %d", got, wantModelsDevCount)
	}

	opus, ok := corpus.Models["claude-opus-4-6"]
	if !ok {
		t.Fatal("claude-opus-4-6 is not priced")
	}
	approx(t, opus.Input, 5e-6, "claude-opus-4-6 input")
	approx(t, opus.Output, 2.5e-5, "claude-opus-4-6 output")
	approx(t, opus.CacheCreate, 6.25e-6, "claude-opus-4-6 cache create")
	approx(t, opus.CacheRead, 5e-7, "claude-opus-4-6 cache read")
	if !opus.CacheCreateExplicit || !opus.CacheReadExplicit {
		t.Fatal("claude-opus-4-6 publishes both cache rates in LiteLLM; both must be explicit")
	}
	if got := corpus.ContextLimits["claude-opus-4-6"]; got != 1_000_000 {
		t.Fatalf("ContextLimits[claude-opus-4-6] = %d, want 1000000", got)
	}
	if opus.LongContextThreshold != nil {
		t.Fatalf("claude-opus-4-6 has no models.dev tier; LongContextThreshold must stay nil, got %d", *opus.LongContextThreshold)
	}

	// A models.dev-only model must be priced from the fallback snapshot.
	gemini, ok := corpus.Models["gemini-2.5-pro"]
	if !ok {
		t.Fatal("gemini-2.5-pro (models.dev only) is not priced")
	}
	approx(t, gemini.Input, 1.25e-6, "gemini-2.5-pro input")
	approx(t, gemini.Output, 1e-5, "gemini-2.5-pro output")
	approx(t, gemini.CacheRead, 1.25e-7, "gemini-2.5-pro cache read")
	if gemini.LongContextThreshold == nil || *gemini.LongContextThreshold != 200_000 {
		t.Fatalf("gemini-2.5-pro LongContextThreshold = %v, want 200000", gemini.LongContextThreshold)
	}
	approx(t, *gemini.InputAbove, 2.5e-6, "gemini-2.5-pro above input")
	if got := corpus.ContextLimits["gemini-2.5-pro"]; got != 1_048_576 {
		t.Fatalf("ContextLimits[gemini-2.5-pro] = %d, want 1048576", got)
	}
}

func TestLoadEmbeddedCorpusRejectsATruncatedSnapshot(t *testing.T) {
	healthy := readEmbeddedFiles(t)
	cases := map[string]string{
		litellmDataFile:      "{\"claude-opus-4-6\": {\"i\": 5e-6, \"o\": 2.5e-",
		modelsDevDataFile:    "{\"gemini-2.5-pro\": {\"cost\": {",
		catalogRulesDataFile: "{\"owners\": [",
		fastMultipliersFile:  "{\"exact\": {",
		flexMultipliersFile:  "",
	}
	for name, broken := range cases {
		files := map[string][]byte{}
		for other, bytes := range healthy {
			files[other] = bytes
		}
		files[name] = []byte(broken)
		if _, err := loadCorpus(mapFS(files)); err == nil {
			t.Errorf("loadCorpus accepted a broken %s; it must fail closed", name)
		}
	}
}

func TestLoadEmbeddedCorpusRejectsMissingSnapshots(t *testing.T) {
	healthy := readEmbeddedFiles(t)
	for name := range healthy {
		files := map[string][]byte{}
		for other, bytes := range healthy {
			if other != name {
				files[other] = bytes
			}
		}
		if _, err := loadCorpus(mapFS(files)); err == nil {
			t.Errorf("loadCorpus accepted a corpus without %s; it must fail closed", name)
		}
	}
}

// readEmbeddedFiles copies the shipped assets into memory so a test can corrupt
// one of them.
func readEmbeddedFiles(t *testing.T) map[string][]byte {
	t.Helper()
	files := map[string][]byte{}
	for _, name := range []string{
		litellmDataFile,
		modelsDevDataFile,
		catalogRulesDataFile,
		fastMultipliersFile,
		flexMultipliersFile,
	} {
		bytes, err := embeddedCorpus.ReadFile(name)
		if err != nil {
			t.Fatalf("read embedded %s: %v", name, err)
		}
		files[name] = bytes
	}
	return files
}

func TestCatalogRulesExcludeAssetPricedModels(t *testing.T) {
	corpus := mustLoadCorpus(t)
	rules, err := readCatalogRules(embeddedCorpus)
	if err != nil {
		t.Fatalf("readCatalogRules: %v", err)
	}
	if len(rules.AssetPricedModelIDs) == 0 {
		t.Fatal("the catalog rules carry no assetPricedModelIds; the guard would be vacuous")
	}
	for _, id := range rules.AssetPricedModelIDs {
		if _, priced := corpus.Models[normalizedModelsDevModelID(id)]; priced {
			t.Errorf("asset-priced model %q entered Models as a token-priced model", id)
		}
		if _, priced := corpus.Models[id]; priced {
			t.Errorf("asset-priced model %q entered Models as a token-priced model", id)
		}
	}

	// The shipped snapshot happens to contain no asset-priced id, so the filter
	// itself is exercised against a synthetic snapshot below.
	files := readEmbeddedFiles(t)
	var dev map[string]json.RawMessage
	if err := json.Unmarshal(files[modelsDevDataFile], &dev); err != nil {
		t.Fatalf("parse models-dev-pricing.json: %v", err)
	}
	assetID := rules.AssetPricedModelIDs[0]
	dev[assetID] = json.RawMessage(`{"cost": {"input": 1, "output": 2}, "limit": {"context": 1000}}`)
	dev["plain-token-model"] = json.RawMessage(`{"cost": {"input": 1, "output": 2}, "limit": {"context": 1000}}`)
	dev["audio-out-model"] = json.RawMessage(`{"cost": {"input": 1, "output": 2}, "modalities": {"output": ["audio"]}}`)
	files[modelsDevDataFile] = mustMarshal(t, dev)
	corpus, err = loadCorpus(mapFS(files))
	if err != nil {
		t.Fatalf("loadCorpus with a synthetic asset-priced model: %v", err)
	}
	if _, priced := corpus.Models[assetID]; priced {
		t.Errorf("asset-priced model %q entered Models from the synthetic snapshot", assetID)
	}
	if _, priced := corpus.Models["plain-token-model"]; !priced {
		t.Error("plain-token-model is absent; the token-priced gate is too strict")
	}
	if _, priced := corpus.Models["audio-out-model"]; priced {
		t.Error("a model whose only output modality is audio entered Models as token-priced")
	}
}

// mapFS turns a file map into the fs.FS seam loadCorpus expects.
func mapFS(files map[string][]byte) fstest.MapFS {
	filesystem := make(fstest.MapFS, len(files))
	for name, bytes := range files {
		filesystem[name] = &fstest.MapFile{Data: bytes}
	}
	return filesystem
}

func mustMarshal(t *testing.T, value any) []byte {
	t.Helper()
	bytes, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return bytes
}

func TestCorpusDerivesCacheDefaultsLikeCcusage(t *testing.T) {
	corpus := mustLoadCorpus(t)

	// anthropic.claude-v1 publishes neither cache rate, so both are derived.
	entry, ok := corpus.Models["anthropic.claude-v1"]
	if !ok {
		t.Fatal("anthropic.claude-v1 is not priced")
	}
	approx(t, entry.CacheCreate, entry.Input*1.25, "derived cache_create")
	approx(t, entry.CacheRead, entry.Input*0.1, "derived cache_read")
	if entry.CacheCreateExplicit || entry.CacheReadExplicit {
		t.Fatal("claude-v1 publishes no cache rate; both explicit flags must be false")
	}

	// A models.dev entry without cache_write derives it the same way.
	gemini := corpus.Models["gemini-2.5-pro"]
	approx(t, gemini.CacheCreate, gemini.Input*1.25, "models.dev derived cache_create")
	if gemini.CacheCreateExplicit {
		t.Fatal("gemini-2.5-pro publishes no cache_write; CacheCreateExplicit must be false")
	}
	// ... while an entry with cache_read keeps it explicit.
	approx(t, gemini.CacheRead, 1.25e-7, "models.dev cache_read")
	if !gemini.CacheReadExplicit {
		t.Fatal("gemini-2.5-pro publishes cache_read; CacheReadExplicit must be true")
	}
}

func TestCorpusScalesModelsDevRatesPerMillion(t *testing.T) {
	corpus := mustLoadCorpus(t)

	// models.dev quotes 1.25 / 10 per million; the corpus must store per token.
	gemini := corpus.Models["gemini-2.5-pro"]
	approx(t, gemini.Input, 1.25/1_000_000, "gemini-2.5-pro input")
	approx(t, gemini.Output, 10.0/1_000_000, "gemini-2.5-pro output")
	if gemini.LongContextThreshold == nil {
		t.Fatal("gemini-2.5-pro must carry a long-context threshold")
	}
	approx(t, *gemini.OutputAbove, 15.0/1_000_000, "gemini-2.5-pro above output")
}

func TestCorpusTakesTheSmallestContextTier(t *testing.T) {
	files := readEmbeddedFiles(t)
	dev := map[string]json.RawMessage{
		"two-band": json.RawMessage(`{"cost": {"input": 1, "output": 2, "tiers": [
			{"input": 5, "output": 6, "tier": {"type": "context", "size": 400000}},
			{"input": 3, "output": 4, "tier": {"type": "context", "size": 200000}},
			{"input": 9, "output": 9, "tier": {"type": "output", "size": 1000}}
		]}}`),
	}
	files[modelsDevDataFile] = mustMarshal(t, dev)
	corpus, err := loadCorpus(mapFS(files))
	if err != nil {
		t.Fatalf("loadCorpus: %v", err)
	}
	entry, ok := corpus.Models["two-band"]
	if !ok {
		t.Fatal("two-band is not priced")
	}
	if entry.LongContextThreshold == nil || *entry.LongContextThreshold != 200_000 {
		t.Fatalf("LongContextThreshold = %v, want the smallest context band (200000)", entry.LongContextThreshold)
	}
	approx(t, *entry.InputAbove, 3.0/1_000_000, "above input from the 200k band")
	if got := corpus.Counts[countModelsDev]; got != 1 {
		t.Fatalf("Counts[models-dev] = %d, want 1", got)
	}
}

func TestCorpusDoesNotUseTheContextWindowAsATierThreshold(t *testing.T) {
	corpus := mustLoadCorpus(t)
	// gpt-5.5 publishes no models.dev tier of its own in the LiteLLM entry, but
	// models.dev does band it; claude-opus-4-6 has a 1M window and no band at all.
	opus := corpus.Models["claude-opus-4-6"]
	if corpus.ContextLimits["claude-opus-4-6"] != 1_000_000 {
		t.Fatal("claude-opus-4-6 must keep its context window")
	}
	if opus.LongContextThreshold != nil {
		t.Fatal("a context window must never become LongContextThreshold")
	}
}

func TestCorpusGraftsLongContextRatesFromModelsDev(t *testing.T) {
	corpus := mustLoadCorpus(t)

	// LiteLLM's azure/gpt-5.5 carries no above-200k rates; models.dev bands it at
	// 272k, so the loader must graft that band on.
	entry, ok := corpus.Models["azure/gpt-5.5"]
	if !ok {
		t.Fatal("azure/gpt-5.5 is not priced")
	}
	if entry.LongContextThreshold == nil || *entry.LongContextThreshold != 272_000 {
		t.Fatalf("azure/gpt-5.5 LongContextThreshold = %v, want 272000", entry.LongContextThreshold)
	}
	approx(t, *entry.InputAbove, 10.0/1_000_000, "grafted above input")
	approx(t, *entry.OutputAbove, 45.0/1_000_000, "grafted above output")
	approx(t, *entry.CacheReadAbove, 1.0/1_000_000, "grafted above cache read")

	// A date-pinned key resolves to the same base band.
	dated, ok := corpus.Models["azure/gpt-5.5-2026-04-23"]
	if !ok {
		t.Fatal("azure/gpt-5.5-2026-04-23 is not priced")
	}
	if dated.LongContextThreshold == nil || *dated.LongContextThreshold != 272_000 {
		t.Fatalf("dated key LongContextThreshold = %v, want 272000", dated.LongContextThreshold)
	}

	// gpt-5.5 has no above-200k rates in LiteLLM either, so models.dev's 272k
	// band applies to it too even though the fallback entry itself is exactOnly.
	gpt := corpus.Models["gpt-5.5"]
	if gpt.LongContextThreshold == nil || *gpt.LongContextThreshold != 272_000 {
		t.Fatalf("gpt-5.5 LongContextThreshold = %v, want 272000", gpt.LongContextThreshold)
	}

	// An entry that publishes its own above-band rates keeps them.
	sonnet := corpus.Models["anthropic.claude-sonnet-4-20250514-v1:0"]
	approx(t, *sonnet.InputAbove, 6e-6, "LiteLLM's own above input")
	approx(t, *sonnet.OutputAbove, 2.25e-5, "LiteLLM's own above output")
	if sonnet.LongContextThreshold != nil {
		t.Fatal("a LiteLLM entry with its own above-200k rates must not gain a models.dev threshold")
	}

	// The pass also reaches models.dev fallback entries: a date-pinned spelling
	// of a model whose bare id carries the band shares it.
	datedFallback, ok := corpus.Models["anthropic/claude-sonnet-4-20250514"]
	if !ok {
		t.Fatal("anthropic/claude-sonnet-4-20250514 is not priced")
	}
	if !datedFallback.fromModelsDev || datedFallback.LongContextThreshold == nil || *datedFallback.LongContextThreshold != 200_000 {
		t.Fatalf("anthropic/claude-sonnet-4-20250514 must inherit the 200000 band of claude-sonnet-4, got %v", datedFallback.LongContextThreshold)
	}
}

func TestCorpusPrefersThePrimaryTableOnCollisions(t *testing.T) {
	corpus := mustLoadCorpus(t)

	// 190 keys exist in both snapshots. ccusage consults the LiteLLM table first,
	// so the primary rates win and the model is not counted twice.
	entry, ok := corpus.Models["claude-sonnet-5"]
	if !ok {
		t.Fatal("claude-sonnet-5 is not priced")
	}
	approx(t, entry.Input, 2e-6, "claude-sonnet-5 input (LiteLLM)")
	approx(t, entry.Output, 1e-5, "claude-sonnet-5 output (LiteLLM)")
	if entry.fromModelsDev {
		t.Fatal("claude-sonnet-5 exists in LiteLLM; the entry must come from the primary table")
	}
	if got, want := corpus.Counts[countLitellm], wantLitellmCount; got != want {
		t.Fatalf("Counts[litellm] = %d, want %d", got, want)
	}
}

func TestCorpusMarksModelsDevExactOnlyEntries(t *testing.T) {
	corpus := mustLoadCorpus(t)

	// A models.dev-only tier flagged exactOnly must keep the flag; a plain
	// fallback model must not.
	exact, ok := corpus.Models["GLM-4.6-Derestricted-v5"]
	if !ok {
		t.Fatal("GLM-4.6-Derestricted-v5 is not priced")
	}
	if !exact.ExactOnly {
		t.Fatal("GLM-4.6-Derestricted-v5 is exactOnly in models.dev")
	}
	if !exact.fromModelsDev {
		t.Fatal("GLM-4.6-Derestricted-v5 is a models.dev fallback entry")
	}
	if plain := corpus.Models["@cf/aisingapore/gemma-sea-lion-v4-27b-it"]; plain.ExactOnly {
		t.Fatal("a models.dev entry without exactOnly must not be marked ExactOnly")
	}
}

func TestCorpusResolvesServiceTierMultipliers(t *testing.T) {
	corpus := mustLoadCorpus(t)

	// claude-opus-4-8 publishes provider_specific_entry.fast = 2 in LiteLLM.
	approx(t, corpus.Models["claude-opus-4-8"].FastMultiplier, 2, "claude-opus-4-8 fast")
	// claude-opus-4-6 has no provider entry; fast-multipliers.json's
	// normalized_prefix gives it 6.
	approx(t, corpus.Models["claude-opus-4-6"].FastMultiplier, 6, "claude-opus-4-6 fast override")
	// gpt-5.5 is exact-matched in both override files.
	approx(t, corpus.Models["gpt-5.5"].FastMultiplier, 2.5, "gpt-5.5 fast override")
	approx(t, corpus.Models["gpt-5.5"].FlexMultiplier, 0.5, "gpt-5.5 flex override")
	// Everything else bills at the base rate.
	approx(t, corpus.Models["claude-opus-4-6"].FlexMultiplier, 1, "claude-opus-4-6 flex")
	// A models.dev fallback entry resolves its multiplier too: dots normalize to
	// dashes inside the prefix part, so the opus 4.6 thinking variants get 6x.
	approx(t, corpus.Models["claude-sonnet-4"].FastMultiplier, 1, "claude-sonnet-4 fast (no override)")
	approx(t, corpus.Models["anthropic/claude-opus-4.6:thinking"].FastMultiplier, 6, "dotted fast prefix override")
	approx(t, corpus.Models["anthropic/claude-opus-4.6:thinking"].FlexMultiplier, 1, "dotted flex (no override)")
}

func TestMultiplierForResolvesExactAliasAndNormalizedPrefix(t *testing.T) {
	overrides := multiplierOverrides{
		Exact:            map[string]float64{"gpt-5.6-sol": 2.5, "claude-opus-4-6": 4},
		NormalizedPrefix: map[string]float64{"claude-opus-4-6": 6, "claude-opus-4": 2},
	}
	cases := map[string]float64{
		"gpt-5.6":                   2.5, // hardcoded alias → gpt-5.6-sol
		"claude-opus-4-6":           4,   // exact beats the prefix table
		"claude-opus-4-6-20260101":  4,   // date suffix stripped → the same exact key
		"claude-opus-4-6-thinking":  6,   // no exact key: the longest prefix wins
		"anthropic/claude-opus-4-6": 4,   // the bare part matches exactly
		"claude-opus-4-turbo":       2,   // shorter prefix
		"unknown-model":             1,
	}
	for model, want := range cases {
		if got := overrides.multiplierFor(model); got != want {
			t.Errorf("multiplierFor(%q) = %v, want %v", model, got, want)
		}
	}
}

func TestBaseModelWithoutDateSuffix(t *testing.T) {
	cases := map[string]string{
		"claude-3-5-haiku-20241022": "claude-3-5-haiku",
		"gpt-5.5-2026-04-23":        "gpt-5.5",
		"gpt-5.5":                   "gpt-5.5",
		"claude-opus-4-6-v1:0":      "claude-opus-4-6-v1:0",
		"claude-opus-4-20250514":    "claude-opus-4",
	}
	for model, want := range cases {
		if got := baseModelWithoutDateSuffix(model); got != want {
			t.Errorf("baseModelWithoutDateSuffix(%q) = %q, want %q", model, got, want)
		}
	}
}

func TestNormalizePricingKeyTouchesOnlyDotsAndAt(t *testing.T) {
	cases := map[string]string{
		"claude-opus-4.6":     "claude-opus-4-6",
		"claude-opus-5@eu":    "claude-opus-5-eu",
		"openai/gpt-5":        "openai/gpt-5",
		"openai_gpt_5":        "openai_gpt_5",
		"anthropic.claude-v2": "anthropic-claude-v2",
	}
	for input, want := range cases {
		if got := normalizePricingKey(input); got != want {
			t.Errorf("normalizePricingKey(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestCorpusSizesArePinned(t *testing.T) {
	corpus := mustLoadCorpus(t)
	// The merged table is the LiteLLM table plus the models.dev keys it does not
	// already price. Both numbers are frozen: a change means the vendored corpus
	// moved.
	if got, want := len(corpus.Models), 3418; got != want {
		t.Fatalf("len(Models) = %d, want %d", got, want)
	}
	// 483 LiteLLM context windows plus the 2884 models.dev-only models, all of
	// which publish a limit.context.
	if got, want := len(corpus.ContextLimits), 3367; got != want {
		t.Fatalf("len(ContextLimits) = %d, want %d", got, want)
	}
}

func TestCorpusModelsHoldsOnlyPricedModels(t *testing.T) {
	corpus := mustLoadCorpus(t)
	// Two z.ai flash models are genuinely free (0/0) in LiteLLM; ccusage keeps
	// them, and the cost formula must tell them apart from unknown models.
	free := map[string]bool{"zai/glm-4.5-flash": true, "zai/glm-4.7-flash": true}
	for model, entry := range corpus.Models {
		if entry.Input == 0 && entry.Output == 0 && !free[model] {
			t.Errorf("%q has no input and no output rate", model)
		}
		if entry.CacheRead < 0 || entry.CacheCreate < 0 {
			t.Errorf("%q has a negative cache rate", model)
		}
		if entry.FastMultiplier <= 0 || entry.FlexMultiplier <= 0 {
			t.Errorf("%q has a non-positive service-tier multiplier", model)
		}
	}
}

// TestCorpusDataFilesAreTracked guards the vendored assets: a missing file would
// fail the build through //go:embed, but an accidentally ignored one would not.
func TestCorpusDataFilesAreTracked(t *testing.T) {
	for _, name := range []string{
		litellmDataFile,
		modelsDevDataFile,
		catalogRulesDataFile,
		fastMultipliersFile,
		flexMultipliersFile,
	} {
		path := filepath.Join(".", filepath.FromSlash(name))
		info, err := os.Stat(path)
		if err != nil {
			t.Errorf("stat %s: %v", path, err)
			continue
		}
		if info.Size() == 0 {
			t.Errorf("%s is empty", path)
		}
	}
}
