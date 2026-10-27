package pricing

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/renameatomic"
)

// Port of prepareDynamicCcusageConfig: the ccusage config ccusage is pointed at
// on every invocation. It merges the bundled baseline, the catalogue-derived
// overrides and an explicit user config, with that precedence.

// PrepareInput configures one dynamic config generation.
type PrepareInput struct {
	Endpoint       string
	StateDir       string
	HookMode       bool
	ExplicitConfig string
	Now            time.Time
	Fetcher        func(request *http.Request) (*http.Response, error)
	Stderr         func(line string)
}

// PreparedConfig is the result the provider consumes.
type PreparedConfig struct {
	ConfigPath      string
	Catalogue       Catalogue
	Overrides       map[string]any
	CoveredModelIDs map[string]bool
	// ExplicitOverrideModelIDs names the models the user's own config prices.
	// The Codex context-pricing rules take these models out of the dynamic
	// rule set: an explicit config is a deliberate override and must keep
	// deciding the cost, exactly as it already wins in the merged ccusage
	// config. The TS side derives the same set with
	// `new Set(Object.keys(explicitPricingOverrides))`.
	ExplicitOverrideModelIDs map[string]bool
}

// Prepare ports prepareDynamicCcusageConfig. The returned path is always a
// real file ccusage can read; an empty path never escapes.
func Prepare(input PrepareInput) (PreparedConfig, error) {
	stderr := input.Stderr
	if stderr == nil {
		stderr = func(string) {}
	}
	catalogue, err := LoadCatalogue(LoadInput{
		Endpoint: input.Endpoint,
		StateDir: input.StateDir,
		HookMode: input.HookMode,
		Now:      input.Now,
		Fetcher:  input.Fetcher,
		Stderr:   stderr,
	})
	if err != nil {
		return PreparedConfig{}, err
	}
	staticConfig, err := readBundledConfig()
	if err != nil {
		return PreparedConfig{}, err
	}
	explicitConfig, err := readOptionalJSONConfig(input.ExplicitConfig)
	if err != nil {
		return PreparedConfig{}, err
	}

	var overrides map[string]any
	if catalogue.Source == "static" {
		overrides = readPricingOverrides(staticConfig)
	} else {
		overrides = createCcusagePricingOverrides(catalogue.Models)
	}
	merged := mergeCcusageConfig(staticConfig, overrides, explicitConfig,
		nonRepresentableContextPricingModelIDs(catalogue.Models, overrides))

	explicitOverrides := map[string]any{}
	if explicitConfig != nil {
		explicitOverrides = readPricingOverrides(explicitConfig)
	}
	covered := map[string]bool{}
	for modelID := range readPricingOverrides(staticConfig) {
		covered[modelID] = true
	}
	for modelID := range explicitOverrides {
		covered[modelID] = true
	}
	if catalogue.Source != "static" {
		for modelID := range overrides {
			covered[modelID] = true
		}
	}

	stateDir := strings.TrimSpace(input.StateDir)
	if stateDir == "" {
		stateDir = defaultStateDir()
	}
	// Static fallback already is the bundled file. Materialize the embedded
	// copy once so ccusage gets a real path without a second generated config.
	if catalogue.Source == "static" && explicitConfig == nil {
		bundledPath := filepath.Join(stateDir, "ccusage.bundled.json")
		if err := materializeBundledConfig(bundledPath); err != nil {
			// A read-only state directory must not break collection: point
			// ccusage at the explicit config when one exists, otherwise keep
			// going without a config file (ccusage falls back to its built-in
			// pricing, and the unpriced-model diagnostics still fire).
			fallback := strings.TrimSpace(input.ExplicitConfig)
			stderr(fmt.Sprintf(
				"TokenBoard model pricing: bundled ccusage config write failed (%s); using %s",
				err.Error(), describeFallback(fallback)))
			return PreparedConfig{
				ConfigPath:               fallback,
				Catalogue:                catalogue,
				Overrides:                overrides,
				CoveredModelIDs:          covered,
				ExplicitOverrideModelIDs: explicitOverrideModelIDs(explicitOverrides),
			}, nil
		}
		return PreparedConfig{
			ConfigPath:               bundledPath,
			Catalogue:                catalogue,
			Overrides:                overrides,
			CoveredModelIDs:          covered,
			ExplicitOverrideModelIDs: explicitOverrideModelIDs(explicitOverrides),
		}, nil
	}

	configPath := filepath.Join(stateDir, DynamicConfigFileName)
	if err := writeJSONAtomically(configPath, merged, 0o600); err != nil {
		fallback := strings.TrimSpace(input.ExplicitConfig)
		stderr(fmt.Sprintf(
			"TokenBoard model pricing: dynamic ccusage config write failed (%s); using %s config %s",
			err.Error(), fallbackKind(fallback), fallback))
		fallbackCovered := map[string]bool{}
		for modelID := range readPricingOverrides(staticConfig) {
			fallbackCovered[modelID] = true
		}
		for modelID := range explicitOverrides {
			fallbackCovered[modelID] = true
		}
		return PreparedConfig{
			ConfigPath:               fallback,
			Catalogue:                catalogue,
			Overrides:                overrides,
			CoveredModelIDs:          fallbackCovered,
			ExplicitOverrideModelIDs: explicitOverrideModelIDs(explicitOverrides),
		}, nil
	}
	stderr(fmt.Sprintf("TokenBoard model pricing: prepared ccusage config at %s", configPath))
	return PreparedConfig{
		ConfigPath:               configPath,
		Catalogue:                catalogue,
		Overrides:                overrides,
		CoveredModelIDs:          covered,
		ExplicitOverrideModelIDs: explicitOverrideModelIDs(explicitOverrides),
	}, nil
}

func describeFallback(fallback string) string {
	if fallback == "" {
		return "no config"
	}
	return "explicit config " + fallback
}

func fallbackKind(fallback string) string {
	if fallback == "" {
		return "bundled"
	}
	return "explicit"
}

// materializeBundledConfig writes the embedded bundled config to path when it
// is missing or differs. The bytes are shipped verbatim so ccusage sees exactly
// the baseline the TS collector would have pointed it at.
func materializeBundledConfig(path string) error {
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, bundledConfig) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp-%d-%s", path, os.Getpid(), randomSuffix())
	if err := os.WriteFile(tmp, bundledConfig, 0o600); err != nil {
		return err
	}
	if err := renameatomic.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// readOptionalJSONConfig reads the explicit config. A file whose bytes equal
// the bundled baseline is treated as absent: the standalone bin wrapper
// supplies the bundled file through TOKENBOARD_CCUSAGE_CONFIG for offline
// compatibility, and dynamic catalogue prices must still be allowed to replace
// its entries.
func readOptionalJSONConfig(path string) (map[string]any, error) {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return nil, nil
	}
	raw, err := os.ReadFile(trimmed)
	if err != nil {
		return nil, err
	}
	if bytes.Equal(raw, bundledConfig) {
		return nil, nil
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	record, ok := value.(map[string]any)
	if !ok || record == nil {
		return nil, errors.New("Model pricing explicit ccusage config must be an object")
	}
	return record, nil
}

// readPricingOverrides returns defaults.pricingOverrides.
func readPricingOverrides(config map[string]any) map[string]any {
	defaults, ok := config["defaults"].(map[string]any)
	if !ok || defaults == nil {
		return map[string]any{}
	}
	overrides, ok := defaults["pricingOverrides"].(map[string]any)
	if !ok || overrides == nil {
		return map[string]any{}
	}
	return overrides
}

// mergeCcusageConfig ports mergeCcusageConfig: bundled < dynamic < explicit,
// with the long-context keys of unrepresentable dynamic rows dropped.
func mergeCcusageConfig(
	bundled map[string]any,
	dynamicOverrides map[string]any,
	explicit map[string]any,
	nonRepresentable map[string]bool,
) map[string]any {
	bundledDefaults, _ := bundled["defaults"].(map[string]any)
	if bundledDefaults == nil {
		bundledDefaults = map[string]any{}
	}
	explicitDefaults := map[string]any{}
	if explicit != nil {
		if value, ok := explicit["defaults"].(map[string]any); ok && value != nil {
			explicitDefaults = value
		}
	}
	pricingOverrides := mergePricingOverrides(
		readPricingOverrides(bundled),
		dynamicOverrides,
		readPricingOverrides(explicit),
		nonRepresentable,
	)
	defaults := map[string]any{}
	for key, value := range bundledDefaults {
		defaults[key] = value
	}
	for key, value := range explicitDefaults {
		defaults[key] = value
	}
	defaults["pricingOverrides"] = pricingOverrides

	merged := map[string]any{}
	for key, value := range bundled {
		merged[key] = value
	}
	if explicit != nil {
		for key, value := range explicit {
			merged[key] = value
		}
	}
	merged["defaults"] = defaults
	merged["codex"] = mergeCodexSection(bundled, explicit)
	return merged
}

func mergeCodexSection(bundled, explicit map[string]any) map[string]any {
	bundledCodex, _ := bundled["codex"].(map[string]any)
	if bundledCodex == nil {
		bundledCodex = map[string]any{}
	}
	explicitCodex := map[string]any{}
	if explicit != nil {
		if value, ok := explicit["codex"].(map[string]any); ok && value != nil {
			explicitCodex = value
		}
	}
	merged := map[string]any{}
	for key, value := range bundledCodex {
		merged[key] = value
	}
	for key, value := range explicitCodex {
		merged[key] = value
	}
	bundledCodexDefaults, _ := bundledCodex["defaults"].(map[string]any)
	if bundledCodexDefaults == nil {
		bundledCodexDefaults = map[string]any{}
	}
	explicitCodexDefaults, _ := explicitCodex["defaults"].(map[string]any)
	if explicitCodexDefaults == nil {
		explicitCodexDefaults = map[string]any{}
	}
	defaults := map[string]any{}
	for key, value := range bundledCodexDefaults {
		defaults[key] = value
	}
	for key, value := range explicitCodexDefaults {
		defaults[key] = value
	}
	merged["defaults"] = defaults
	return merged
}

var longContextOverrideKeys = []string{
	"cacheCreationInputTokenCostAbove200kTokens",
	"cacheReadInputTokenCostAbove200kTokens",
	"inputCostPerTokenAbove200kTokens",
	"outputCostPerTokenAbove200kTokens",
}

// mergePricingOverrides applies bundled, then dynamic, then explicit. The
// dynamic layer drops long-context keys for models whose published tiers a
// single request-level threshold cannot represent.
func mergePricingOverrides(
	bundled map[string]any,
	dynamic map[string]any,
	explicit map[string]any,
	nonRepresentable map[string]bool,
) map[string]any {
	result := map[string]any{}
	layers := []map[string]any{bundled, dynamic, explicit}
	for layerIndex, layer := range layers {
		for modelID, value := range layer {
			previous, _ := result[modelID].(map[string]any)
			base := map[string]any{}
			for key, entry := range previous {
				base[key] = entry
			}
			if record, ok := value.(map[string]any); ok {
				if layerIndex == 1 && nonRepresentable[modelID] {
					for _, key := range longContextOverrideKeys {
						delete(base, key)
					}
				}
				for key, entry := range record {
					base[key] = entry
				}
				result[modelID] = base
				continue
			}
			// Keep invalid user-provided values visible to ccusage validation
			// rather than silently dropping them during the merge.
			result[modelID] = value
		}
	}
	return result
}

// nonRepresentableContextPricingModelIDs: models whose published tiers cannot
// be expressed by ccusage's single 200k threshold.
func nonRepresentableContextPricingModelIDs(models []Model, overrides map[string]any) map[string]bool {
	result := map[string]bool{}
	for _, model := range models {
		if _, ok := overrides[model.ModelID]; !ok {
			continue
		}
		tiers := readContextTiers(model.Pricing)
		if len(tiers) > 0 && (tiers[0].threshold != 200_000 || hasChangingLaterContextTier(tiers)) {
			result[model.ModelID] = true
		}
	}
	return result
}

// CreateCcusagePricingOverrides is the exported override builder (tests and
// the Codex provider use it directly).
func CreateCcusagePricingOverrides(models []Model) map[string]any {
	return createCcusagePricingOverrides(models)
}

func createCcusagePricingOverrides(models []Model) map[string]any {
	overrides := map[string]any{}
	for _, model := range selectUnambiguousDynamicPricingModels(models) {
		override := toCcusagePricingOverride(model)
		if override != nil {
			overrides[model.ModelID] = override
		}
	}
	for modelID, override := range officialAnchorOverrides(models, overrides) {
		overrides[modelID] = override
	}
	applyCaseVariantAliases(models, overrides)
	return overrides
}

// applyCaseVariantAliases ports applyCaseVariantAliases: ccusage matches an
// override key case-sensitively, and the catalogue publishes several spellings
// of the same id, so every published spelling gets the collapsed price. Only
// ids that already have an emitted override are aliased — a group the collapse
// dropped for disagreeing rows stays dropped, and no spelling the catalogue
// never publishes is invented.
func applyCaseVariantAliases(models []Model, overrides map[string]any) {
	spellings := map[string]map[string]bool{}
	for _, model := range models {
		key := strings.ToLower(strings.TrimSpace(model.ModelID))
		set := spellings[key]
		if set == nil {
			set = map[string]bool{}
			spellings[key] = set
		}
		set[model.ModelID] = true
	}
	for key, override := range overrides {
		for spelling := range spellings[strings.ToLower(strings.TrimSpace(key))] {
			if _, exists := overrides[spelling]; !exists {
				overrides[spelling] = override
			}
		}
	}
}

// officialAnchorOverrides ports officialAnchorOverrides: ccusage matches an
// override key to the observed model name by folding provider prefixes and
// variant suffixes, so `xiaomi/mimo-v2.6-flash-uncensored` can price a plain
// `mimo-v2.6-flash` day. When the base id is unresolved its reseller rows
// disagree and that folding key is the only one left, so it wins — one machine
// billed 3.6x the official rate for mimo-v2.6-flash this way. An exact key beats
// a folding one, so the official vendor row is emitted as the base id's own key.
//
// Only an official row qualifies: falling back to a reseller row would
// re-introduce the ambiguity the unresolved id was dropped for.
func officialAnchorOverrides(models []Model, emitted map[string]any) map[string]any {
	foldBases := map[string]bool{}
	for _, model := range models {
		if base := foldToBaseModelID(model.ModelID); base != strings.ToLower(strings.TrimSpace(model.ModelID)) {
			foldBases[base] = true
		}
	}
	if len(foldBases) == 0 {
		return nil
	}

	haveExact := map[string]bool{}
	for key := range emitted {
		haveExact[strings.ToLower(strings.TrimSpace(key))] = true
	}

	rowsByID := map[string][]Model{}
	order := []string{}
	for _, model := range models {
		id := strings.ToLower(strings.TrimSpace(model.ModelID))
		if !foldBases[id] || haveExact[id] {
			continue
		}
		if _, ok := rowsByID[id]; !ok {
			order = append(order, id)
		}
		rowsByID[id] = append(rowsByID[id], model)
	}

	anchors := map[string]any{}
	for _, id := range order {
		rows := rowsByID[id]
		official := pickAnchorOfficialRow(rows)
		if official == nil {
			continue
		}
		if override := toCcusagePricingOverride(*official); override != nil {
			anchors[rows[0].ModelID] = override
		}
	}
	return anchors
}

// pickAnchorOfficialRow ports pickAnchorOfficialRow: several official vendors
// can price one id differently — an international and a domestic endpoint of
// the same vendor is the common case. Taking the first match would make the
// anchor depend on the order rows arrive in, and that order comes from the
// server's ORDER BY; a change there would silently move what every collector
// bills. Sort first so the choice is a property of this function.
func pickAnchorOfficialRow(rows []Model) *Model {
	officials := make([]*Model, 0, len(rows))
	for index := range rows {
		row := &rows[index]
		if officialVendorProviderIDs[strings.ToLower(strings.TrimSpace(row.Provider))] && priceRowIsPositive(*row) {
			officials = append(officials, row)
		}
	}
	if len(officials) == 0 {
		return nil
	}
	sort.SliceStable(officials, func(left, right int) bool {
		leftProvider := strings.ToLower(strings.TrimSpace(officials[left].Provider))
		rightProvider := strings.ToLower(strings.TrimSpace(officials[right].Provider))
		if leftProvider != rightProvider {
			return leftProvider < rightProvider
		}
		return officials[left].ModelID < officials[right].ModelID
	})
	return officials[0]
}

// foldToBaseModelID ports foldToBaseModelId: the bases ccusage may fold a key
// onto — drop `:tag` segments, drop the provider prefix, then drop a fine-tune
// variant suffix. Deliberately narrow: only the folding case observed on real
// data, because over-folding would anchor ids ccusage never conflates.
func foldToBaseModelID(modelID string) string {
	trimmed := strings.ToLower(strings.TrimSpace(modelID))
	segments := strings.Split(trimmed, "/")
	base := segments[len(segments)-1]
	if index := strings.Index(base, ":"); index >= 0 {
		base = base[:index]
	}
	for _, suffix := range []string{"-uncensored", "-abliterated"} {
		base = strings.TrimSuffix(base, suffix)
	}
	return base
}

// toCcusagePricingOverride converts a catalogue row to ccusage's per-token
// override shape. Values are divided by 1e6: the catalogue publishes
// per-million prices, ccusage expects per-token.
func toCcusagePricingOverride(model Model) map[string]any {
	if !isFiniteNonNegative(model.InputCostPerMillion) || !isFiniteNonNegative(model.OutputCostPerMillion) {
		return nil
	}
	override := map[string]any{
		"inputCostPerToken":  model.InputCostPerMillion / 1_000_000,
		"outputCostPerToken": model.OutputCostPerMillion / 1_000_000,
	}
	if model.CacheReadCostPerMillion != nil {
		override["cacheReadInputTokenCost"] = *model.CacheReadCostPerMillion / 1_000_000
	}
	if model.CacheWriteCostPerMillion != nil {
		override["cacheCreationInputTokenCost"] = *model.CacheWriteCostPerMillion / 1_000_000
	}
	if model.ContextWindow > 0 {
		override["maxInputTokens"] = model.ContextWindow
	}
	tiers := readContextTiers(model.Pricing)
	if len(tiers) > 0 && tiers[0].threshold == 200_000 && !hasChangingLaterContextTier(tiers) {
		tier := tiers[0]
		override["inputCostPerTokenAbove200kTokens"] = tier.input / 1_000_000
		override["outputCostPerTokenAbove200kTokens"] = tier.output / 1_000_000
		if tier.cacheRead != nil {
			override["cacheReadInputTokenCostAbove200kTokens"] = *tier.cacheRead / 1_000_000
		}
		if tier.cacheWrite != nil {
			override["cacheCreationInputTokenCostAbove200kTokens"] = *tier.cacheWrite / 1_000_000
		}
	}
	if multiplier, ok := readMultiplier(model.Pricing); ok {
		override["fastMultiplier"] = multiplier
	}
	return override
}

type contextTier struct {
	threshold  float64
	input      float64
	output     float64
	cacheRead  *float64
	cacheWrite *float64
}

// readContextTiers ports readContextTiers: explicit `tiers` entries win, and
// a legacy `context_over_200k` object is the single-tier fallback.
func readContextTiers(pricing map[string]any) []contextTier {
	tiers := []contextTier{}
	if raw, ok := pricing["tiers"].([]any); ok {
		for _, value := range raw {
			record, ok := value.(map[string]any)
			if !ok || record == nil {
				continue
			}
			if tier, ok := parseContextTier(record); ok {
				tiers = append(tiers, tier)
			}
		}
		sortTiersByThreshold(tiers)
	}
	if len(tiers) > 0 {
		return tiers
	}
	legacy, ok := pricing["context_over_200k"].(map[string]any)
	if !ok || legacy == nil {
		return nil
	}
	withTier := map[string]any{}
	for key, value := range legacy {
		withTier[key] = value
	}
	withTier["tier"] = map[string]any{"type": "context", "size": float64(200_000)}
	tier, ok := parseContextTier(withTier)
	if !ok {
		return nil
	}
	return []contextTier{tier}
}

func parseContextTier(value map[string]any) (contextTier, bool) {
	tier, ok := value["tier"].(map[string]any)
	if !ok || tier == nil {
		return contextTier{}, false
	}
	if tierType, _ := tier["type"].(string); tierType != "context" {
		return contextTier{}, false
	}
	threshold, ok := safePositiveInteger(tier["size"])
	if !ok {
		return contextTier{}, false
	}
	input, inputOK := finiteNonNegative(value["input"])
	output, outputOK := finiteNonNegative(value["output"])
	if !inputOK || !outputOK {
		return contextTier{}, false
	}
	result := contextTier{threshold: threshold, input: input, output: output}
	if cacheRead, ok := nullableFiniteNonNegative(value["cache_read"]); ok {
		result.cacheRead = &cacheRead
	}
	if cacheWrite, ok := nullableFiniteNonNegative(value["cache_write"]); ok {
		result.cacheWrite = &cacheWrite
	}
	return result, true
}

func hasChangingLaterContextTier(tiers []contextTier) bool {
	if len(tiers) == 0 {
		return false
	}
	first := tiers[0]
	for _, tier := range tiers[1:] {
		if tier.input != first.input || tier.output != first.output ||
			!sameOptional(tier.cacheRead, first.cacheRead) || !sameOptional(tier.cacheWrite, first.cacheWrite) {
			return true
		}
	}
	return false
}

func sameOptional(left, right *float64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func sortTiersByThreshold(tiers []contextTier) {
	for i := 1; i < len(tiers); i++ {
		for j := i; j > 0 && tiers[j].threshold < tiers[j-1].threshold; j-- {
			tiers[j], tiers[j-1] = tiers[j-1], tiers[j]
		}
	}
}

func validateContextPricing(pricing map[string]any, modelLabel string) error {
	if value, ok := pricing["tiers"]; ok {
		tiers, ok := value.([]any)
		if !ok {
			return fmt.Errorf("Invalid context pricing tiers for %s", modelLabel)
		}
		for index, entry := range tiers {
			record, ok := entry.(map[string]any)
			if !ok || record == nil {
				return fmt.Errorf("Invalid context pricing tier %s[%d]", modelLabel, index)
			}
			tierValue, hasTier := record["tier"]
			if !hasTier || tierValue == nil {
				continue
			}
			tier, ok := tierValue.(map[string]any)
			if !ok || tier == nil {
				return fmt.Errorf("Invalid context pricing tier %s[%d]", modelLabel, index)
			}
			if tierType, _ := tier["type"].(string); tierType != "context" {
				continue
			}
			if _, ok := safePositiveInteger(tier["size"]); !ok {
				return fmt.Errorf("Invalid context pricing threshold for %s[%d]", modelLabel, index)
			}
			for _, key := range []string{"input", "output"} {
				if _, ok := finiteNonNegative(record[key]); !ok {
					return fmt.Errorf("Invalid context pricing %s for %s[%d]", key, modelLabel, index)
				}
			}
			for _, key := range []string{"cache_read", "cache_write"} {
				value, present := record[key]
				if !present || value == nil {
					continue
				}
				if _, ok := finiteNonNegative(value); !ok {
					return fmt.Errorf("Invalid context pricing %s for %s[%d]", key, modelLabel, index)
				}
			}
		}
	}
	if value, ok := pricing["context_over_200k"]; ok {
		record, ok := value.(map[string]any)
		if !ok || record == nil {
			return fmt.Errorf("Invalid context_over_200k pricing for %s", modelLabel)
		}
		for _, key := range []string{"input", "output"} {
			if _, ok := finiteNonNegative(record[key]); !ok {
				return fmt.Errorf("Invalid context_over_200k %s pricing for %s", key, modelLabel)
			}
		}
		for _, key := range []string{"cache_read", "cache_write"} {
			value, present := record[key]
			if !present || value == nil {
				continue
			}
			if _, ok := finiteNonNegative(value); !ok {
				return fmt.Errorf("Invalid context_over_200k %s pricing for %s", key, modelLabel)
			}
		}
	}
	for _, key := range []string{"fastMultiplier", "fast_multiplier", "priorityMultiplier", "priority_multiplier"} {
		value, present := pricing[key]
		if !present || value == nil {
			continue
		}
		if _, ok := finitePositive(value); !ok {
			return fmt.Errorf("Invalid %s pricing for %s", key, modelLabel)
		}
	}
	return nil
}

func readMultiplier(pricing map[string]any) (float64, bool) {
	for _, key := range []string{"fastMultiplier", "fast_multiplier"} {
		if value, ok := finitePositive(pricing[key]); ok {
			return value, true
		}
	}
	return 0, false
}

// selectUnambiguousDynamicPricingModels ports
// selectUnambiguousDynamicPricingModels: a model id carried by rows whose
// prices disagree cannot be priced by one override, so it keeps the static
// fallback. Rows that agree collapse to one representative, preferring an
// official vendor row; all-zero rows only collapse with other all-zero rows.
func selectUnambiguousDynamicPricingModels(models []Model) []Model {
	byModelID := map[string][]Model{}
	order := []string{}
	for _, model := range models {
		key := strings.ToLower(strings.TrimSpace(model.ModelID))
		if _, ok := byModelID[key]; !ok {
			order = append(order, key)
		}
		byModelID[key] = append(byModelID[key], model)
	}
	selected := map[string]int{}
	for _, key := range order {
		entries := byModelID[key]
		if len(entries) == 1 {
			selected[key] = 0
			continue
		}
		if !dynamicPriceRowsAgree(entries) {
			continue
		}
		selected[key] = pickCollapsedRepresentative(dynamicPriceAgreementGroup(entries), entries)
	}
	result := []Model{}
	for _, model := range models {
		key := strings.ToLower(strings.TrimSpace(model.ModelID))
		index, ok := selected[key]
		if !ok {
			continue
		}
		if sameModelIdentity(model, byModelID[key][index]) {
			result = append(result, model)
		}
	}
	return result
}

func sameModelIdentity(left, right Model) bool {
	return left.Provider == right.Provider && left.ModelID == right.ModelID &&
		left.InputCostPerMillion == right.InputCostPerMillion &&
		left.OutputCostPerMillion == right.OutputCostPerMillion &&
		sameOptional(left.CacheReadCostPerMillion, right.CacheReadCostPerMillion) &&
		sameOptional(left.CacheWriteCostPerMillion, right.CacheWriteCostPerMillion)
}

func dynamicPriceRowsAgree(entries []Model) bool {
	group := dynamicPriceAgreementGroup(entries)
	signature := priceRowSignature(group[0])
	for _, entry := range group[1:] {
		if priceRowSignature(entry) != signature {
			return false
		}
	}
	return true
}

// dynamicPriceAgreementGroup drops zero-priced rows when any row carries a real
// price: an official vendor's $0 placeholder must never price a model as free.
func dynamicPriceAgreementGroup(entries []Model) []Model {
	priced := []Model{}
	for _, entry := range entries {
		if priceRowIsPositive(entry) {
			priced = append(priced, entry)
		}
	}
	if len(priced) > 0 {
		return priced
	}
	return entries
}

func priceRowIsPositive(entry Model) bool {
	return entry.InputCostPerMillion > 0 || entry.OutputCostPerMillion > 0
}

func priceRowSignature(entry Model) string {
	pricing, _ := json.Marshal(entry.Pricing)
	return fmt.Sprintf("%v|%v|%v|%v|%s",
		entry.InputCostPerMillion, entry.OutputCostPerMillion,
		optionalValue(entry.CacheReadCostPerMillion), optionalValue(entry.CacheWriteCostPerMillion),
		pricing)
}

func optionalValue(value *float64) string {
	if value == nil {
		return "null"
	}
	return fmt.Sprintf("%v", *value)
}

var officialVendorProviderIDs = map[string]bool{
	"openai": true, "anthropic": true, "google": true, "deepseek": true,
	"moonshotai": true, "zhipuai": true, "zai": true, "xiaomi": true,
	"alibaba": true, "xai": true, "minimax": true, "nvidia": true, "longcat": true,
}

// pickCollapsedRepresentative ports pickCollapsedRepresentative: prefer the
// official vendor row, then the alphabetically first provider. It walks the
// group the agreement check compared, never the full entry list — an official
// vendor's $0 placeholder row lives outside that group and would otherwise win
// the pick and silently price the model as free.
//
// The tie-break is explicit rather than "whatever came first": rows that agree
// on price can disagree on context window, the representative carries its own
// into maxInputTokens, and arrival order is the catalogue's ORDER BY.
func pickCollapsedRepresentative(group []Model, entries []Model) int {
	candidates := make([]Model, len(group))
	copy(candidates, group)
	sort.SliceStable(candidates, func(left, right int) bool {
		leftOfficial := officialVendorProviderIDs[strings.ToLower(strings.TrimSpace(candidates[left].Provider))]
		rightOfficial := officialVendorProviderIDs[strings.ToLower(strings.TrimSpace(candidates[right].Provider))]
		if leftOfficial != rightOfficial {
			return leftOfficial
		}
		leftProvider := strings.ToLower(strings.TrimSpace(candidates[left].Provider))
		rightProvider := strings.ToLower(strings.TrimSpace(candidates[right].Provider))
		if leftProvider != rightProvider {
			return leftProvider < rightProvider
		}
		return candidates[left].ModelID < candidates[right].ModelID
	})
	chosen := candidates[0]
	for index, entry := range entries {
		if sameModelIdentity(entry, chosen) {
			return index
		}
	}
	return 0
}

func finiteNonNegative(value any) (float64, bool) {
	number, ok := asNumber(value)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
		return 0, false
	}
	return number, true
}

func nullableFiniteNonNegative(value any) (float64, bool) {
	if value == nil {
		return 0, false
	}
	return finiteNonNegative(value)
}

func finitePositive(value any) (float64, bool) {
	number, ok := asNumber(value)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number <= 0 {
		return 0, false
	}
	return number, true
}

func isFiniteNonNegative(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0
}

func safeNonNegativeInteger(value any) (float64, bool) {
	number, ok := asNumber(value)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number != math.Trunc(number) || number < 0 {
		return 0, false
	}
	if number > 1<<53-1 {
		return 0, false
	}
	return number, true
}

func nullableSafeNonNegativeInteger(value any) (float64, bool) {
	if value == nil {
		return 0, false
	}
	return safeNonNegativeInteger(value)
}

func safePositiveInteger(value any) (float64, bool) {
	number, ok := safeNonNegativeInteger(value)
	if !ok || number <= 0 {
		return 0, false
	}
	return number, true
}

func asNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return 0, false
		}
		return parsed, true
	}
	return 0, false
}

func randomSuffix() string {
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buffer)
}

// explicitOverrideModelIDs is the key set of the user's own pricing overrides.
func explicitOverrideModelIDs(overrides map[string]any) map[string]bool {
	ids := make(map[string]bool, len(overrides))
	for modelID := range overrides {
		ids[modelID] = true
	}
	return ids
}
