package nativepricing

// Package nativepricing is TokenBoard's own implementation of ccusage's model
// pricing: the frozen rate corpus and, in later files, the lookup and cost
// formula built on top of it.
//
// The corpus is frozen against ccusage v20.0.33 (commit 1308c416) so that the
// native Go client keeps producing the same costs as the ccusage/TS baseline
// it replaces. Nothing here touches the network or the user's disk: the data
// is embedded at build time from data/, which
// clients/go/scripts/fetch-native-pricing.mjs regenerates and pins by sha256.
//
// Loading follows ccusage's PricingMap::load_embedded (rust/crates/ccusage-core/src/pricing.rs):
//
//  1. LiteLLM entries become the primary models, with cache_create = cc ?? input × 1.25
//     and cache_read = cr ?? input × 0.1. `ctx` is a context window only.
//  2. The models.dev snapshot becomes the fallback models, gated by
//     models_dev_usable_cost → rules.is_token_priced so asset-priced (per
//     image/per second) entries never enter as token-priced. A models.dev key
//     that the primary table already prices is skipped, matching ccusage's
//     "primary answers first" order.
//  3. Long-context tier rates are grafted from models.dev onto entries that
//     publish no above-threshold rates of their own.
//
// Ported from ccusage (https://github.com/ryoppippi/ccusage), MIT licensed.
// See ../../THIRD_PARTY_NOTICES.md.

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"sort"
	"strings"
)

//go:embed data/litellm.json data/models-dev-pricing.json data/models-dev-catalog-rules.json data/fast-multipliers.json data/flex-multipliers.json
var embeddedCorpus embed.FS

// Corpus file names, relative to this package's directory. loadCorpus reads
// the same names out of any fs.FS so tests can substitute broken assets.
const (
	litellmDataFile      = "data/litellm.json"
	modelsDevDataFile    = "data/models-dev-pricing.json"
	catalogRulesDataFile = "data/models-dev-catalog-rules.json"
	fastMultipliersFile  = "data/fast-multipliers.json"
	flexMultipliersFile  = "data/flex-multipliers.json"
)

// Counts keys: one per embedded pricing source.
const (
	countLitellm   = "litellm"
	countModelsDev = "models-dev"
)

// CorpusModel is one billable model: per-token USD rates, the above-threshold
// bands, and the lookup flags the finder and the cost formula read.
type CorpusModel struct {
	Input, Output, CacheRead, CacheCreate float64
	// Above-threshold rates. A nil band bills that bucket at the base rate.
	InputAbove, OutputAbove          *float64
	CacheReadAbove, CacheCreateAbove *float64
	// LongContextThreshold switches the whole request to the above bands once
	// its context exceeds this many tokens. It comes only from models.dev
	// cost.tiers, never from a context window (see Corpus.ContextLimits).
	LongContextThreshold *int64
	// Service-tier multipliers; 1 means no multiplier.
	FastMultiplier, FlexMultiplier float64
	// CacheReadExplicit / CacheCreateExplicit record whether the source
	// published that cache rate or it was derived from Input. User overrides of
	// the input rate scale only the derived ones.
	CacheReadExplicit, CacheCreateExplicit bool
	// ExactOnly marks a separately priced tier that may only answer a lookup
	// naming it, never a fuzzy prefix match.
	ExactOnly bool
	// fromModelsDev records that this model came from the models.dev fallback
	// rather than the primary LiteLLM table. Two later steps need it:
	//   - fuzzy lookup: ccusage keeps the two tables apart and only consults
	//     models.dev after the primary table misses, so a primary prefix match
	//     must win over a longer models.dev one.
	//   - builtin rates (Task 3): ccusage's put_builtin_entry fills gaps in the
	//     *primary* table only, so a builtin replaces a models.dev entry but
	//     never a LiteLLM one - and the replacement must then get the
	//     long-context graft re-run over it.
	fromModelsDev bool
}

// Corpus is the frozen pricing data.
type Corpus struct {
	// Models maps a pricing key (LiteLLM model id or models.dev model id) to its
	// rates. Primary entries come first; models.dev fills the gaps.
	Models map[string]CorpusModel
	// ContextLimits holds max_input_tokens (LiteLLM) / limit.context
	// (models.dev) in tokens. It is a context window, not a billing threshold.
	ContextLimits map[string]int64
	// Counts records how many models each embedded source resolved, so tests can
	// pin the snapshot contents against the generator's recorded numbers.
	Counts map[string]int
}

// LoadEmbeddedCorpus parses the corpus embedded in the binary. Every failure is
// returned as an error: a broken asset never degrades into an empty corpus,
// because an empty corpus would silently price everything at zero.
func LoadEmbeddedCorpus() (Corpus, error) {
	return loadCorpus(embeddedCorpus)
}

// loadCorpus is the test seam; it reads the corpus file names out of fsys.
func loadCorpus(fsys fs.FS) (Corpus, error) {
	rules, err := readCatalogRules(fsys)
	if err != nil {
		return Corpus{}, err
	}
	litellm, err := readLitellm(fsys)
	if err != nil {
		return Corpus{}, err
	}
	dev, err := readModelsDev(fsys, rules)
	if err != nil {
		return Corpus{}, err
	}
	fast, err := readMultiplierOverrides(fsys, fastMultipliersFile)
	if err != nil {
		return Corpus{}, err
	}
	flex, err := readMultiplierOverrides(fsys, flexMultipliersFile)
	if err != nil {
		return Corpus{}, err
	}

	models := make(map[string]CorpusModel, len(litellm)+len(dev.models))
	contextLimits := map[string]int64{}
	litellmCount := loadLitellmEntries(models, contextLimits, litellm, fast, flex)
	dev.mergeInto(models, contextLimits, fast, flex)
	applyLongContextRates(models, dev.models)

	return Corpus{
		Models:        models,
		ContextLimits: contextLimits,
		Counts: map[string]int{
			countLitellm:   litellmCount,
			countModelsDev: len(dev.models),
		},
	}, nil
}

func readCorpusFile(fsys fs.FS, name string) ([]byte, error) {
	bytes, err := fs.ReadFile(fsys, name)
	if err != nil {
		return nil, fmt.Errorf("nativepricing: read %s: %w", name, err)
	}
	if len(bytes) == 0 {
		return nil, fmt.Errorf("nativepricing: %s is empty", name)
	}
	return bytes, nil
}

func decodeCorpusFile(fsys fs.FS, name string, target any) error {
	bytes, err := readCorpusFile(fsys, name)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(bytes, target); err != nil {
		return fmt.Errorf("nativepricing: parse %s: %w", name, err)
	}
	return nil
}

// multiplierOverrides is the shape of fast-multipliers.json and
// flex-multipliers.json: exact model ids, plus suffixes matched after the model
// id's separators are normalized.
type multiplierOverrides struct {
	Exact            map[string]float64 `json:"exact"`
	NormalizedPrefix map[string]float64 `json:"normalized_prefix"`
}

func readMultiplierOverrides(fsys fs.FS, name string) (multiplierOverrides, error) {
	var overrides multiplierOverrides
	if err := decodeCorpusFile(fsys, name, &overrides); err != nil {
		return multiplierOverrides{}, err
	}
	if len(overrides.Exact)+len(overrides.NormalizedPrefix) == 0 {
		return multiplierOverrides{}, fmt.Errorf("nativepricing: %s carries no multipliers", name)
	}
	return overrides, nil
}

// multiplierFor mirrors SpeedMultiplierOverrides::multiplier_for. A model that
// carries no override keeps ccusage's 1.0, i.e. "bill the base rate".
func (o multiplierOverrides) multiplierFor(model string) float64 {
	if multiplier, ok := o.Exact[model]; ok {
		return multiplier
	}
	if alias, ok := pricingAliasOf(model); ok {
		if multiplier, ok := o.Exact[alias]; ok {
			return multiplier
		}
	}
	for _, part := range modelParts(model) {
		base := baseModelWithoutDateSuffix(part)
		if multiplier, ok := o.Exact[part]; ok {
			return multiplier
		}
		if multiplier, ok := o.Exact[base]; ok {
			return multiplier
		}
		if alias, ok := pricingAliasOf(base); ok {
			if multiplier, ok := o.Exact[alias]; ok {
				return multiplier
			}
		}
		// Several prefixes can match one part; ccusage iterates a hash map, so
		// its pick is arbitrary. The longest match is the deterministic choice
		// and the shipped files have no overlapping prefixes.
		normalized := normalizePricingKey(part)
		bestBase, bestMultiplier, found := "", 0.0, false
		for prefix, multiplier := range o.NormalizedPrefix {
			if !matchesModelSuffix(normalized, prefix) {
				continue
			}
			if !found || len(prefix) > len(bestBase) {
				bestBase, bestMultiplier, found = prefix, multiplier, true
			}
		}
		if found {
			return bestMultiplier
		}
	}
	return 1
}

// modelParts splits a model id on the provider separators ccusage tries, and
// yields each dotted suffix too so a decimal version survives the split.
func modelParts(model string) []string {
	var parts []string
	for _, part := range strings.FieldsFunc(model, func(r rune) bool { return r == '/' || r == ':' }) {
		parts = append(parts, part)
		for index := strings.IndexByte(part, '.'); index >= 0; index = strings.IndexByte(part, '.') {
			part = part[index+1:]
			parts = append(parts, part)
		}
	}
	return parts
}

func matchesModelSuffix(part, base string) bool {
	index := strings.LastIndex(part, base)
	if index < 0 {
		return false
	}
	suffix := part[index:]
	return suffix == base || suffix[len(base)] == '-'
}

// litellmEntry is one record of the compacted LiteLLM snapshot. A nil pointer
// means upstream had no value (or an explicit null) for that field.
type litellmEntry struct {
	Input       *float64 `json:"i"`
	Output      *float64 `json:"o"`
	CacheCreate *float64 `json:"cc"`
	CacheRead   *float64 `json:"cr"`
	InputAbove  *float64 `json:"ia"`
	OutputAbove *float64 `json:"oa"`
	CCAbove     *float64 `json:"cca"`
	CRAbove     *float64 `json:"cra"`
	Context     *int64   `json:"ctx"`
	Fast        *float64 `json:"fast"`
	Flex        *float64 `json:"flex"`
}

func readLitellm(fsys fs.FS) (map[string]litellmEntry, error) {
	var entries map[string]litellmEntry
	if err := decodeCorpusFile(fsys, litellmDataFile, &entries); err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("nativepricing: %s holds no models", litellmDataFile)
	}
	return entries, nil
}

// loadLitellmEntries mirrors PricingMap::load_json_with_overrides for the
// compacted snapshot: an entry without both an input and an output rate is
// dropped, exactly as the Rust loader drops it.
func loadLitellmEntries(
	models map[string]CorpusModel,
	contextLimits map[string]int64,
	entries map[string]litellmEntry,
	fast, flex multiplierOverrides,
) int {
	loaded := 0
	for model, entry := range entries {
		if entry.Input == nil || entry.Output == nil {
			continue
		}
		input := *entry.Input
		models[model] = CorpusModel{
			Input:               input,
			Output:              *entry.Output,
			CacheCreate:         orElse(entry.CacheCreate, input*1.25),
			CacheRead:           orElse(entry.CacheRead, input*0.1),
			CacheCreateExplicit: entry.CacheCreate != nil,
			CacheReadExplicit:   entry.CacheRead != nil,
			InputAbove:          entry.InputAbove,
			OutputAbove:         entry.OutputAbove,
			CacheCreateAbove:    entry.CCAbove,
			CacheReadAbove:      entry.CRAbove,
			FastMultiplier:      orElse(entry.Fast, fast.multiplierFor(model)),
			FlexMultiplier:      orElse(entry.Flex, flex.multiplierFor(model)),
		}
		if entry.Context != nil {
			contextLimits[model] = *entry.Context
		}
		loaded++
	}
	return loaded
}

func orElse(explicit *float64, fallback float64) float64 {
	if explicit != nil {
		return *explicit
	}
	return fallback
}

// catalogRules is models-dev-catalog-rules.json: generation's verdicts about
// which models.dev entries may be priced per token.
type catalogRules struct {
	Owners              []string            `json:"owners"`
	Platforms           []string            `json:"platforms"`
	AuthoredModelIDs    []string            `json:"authoredModelIds"`
	AuthoredModes       map[string][]string `json:"authoredModes"`
	AssetPricedModelIDs []string            `json:"assetPricedModelIds"`

	authored map[string]bool
	asset    map[string]bool
}

func readCatalogRules(fsys fs.FS) (catalogRules, error) {
	var rules catalogRules
	if err := decodeCorpusFile(fsys, catalogRulesDataFile, &rules); err != nil {
		return catalogRules{}, err
	}
	if len(rules.AuthoredModelIDs) == 0 || len(rules.Owners) == 0 || len(rules.Platforms) == 0 {
		return catalogRules{}, fmt.Errorf("nativepricing: %s is missing the authored/owner/platform lists", catalogRulesDataFile)
	}
	rules.authored = make(map[string]bool, len(rules.AuthoredModelIDs))
	for _, id := range rules.AuthoredModelIDs {
		rules.authored[normalizedModelsDevModelID(id)] = true
	}
	rules.asset = make(map[string]bool, len(rules.AssetPricedModelIDs))
	for _, id := range rules.AssetPricedModelIDs {
		rules.asset[normalizedModelsDevModelID(id)] = true
	}
	return rules, nil
}

// isTokenPriced mirrors ModelsDevCatalogRules::is_token_priced: the asset list
// wins over the authored list, and an authored model is token-priced by fiat.
// An entry without modalities says nothing, so it reads as plain text rather
// than being disqualified. (Owners/platforms rank live provider catalogs, which
// S1 does not load; they are parsed so a truncated rules file still fails.)
func (r catalogRules) isTokenPriced(sourceModelID string, modalities *modelsDevModalities) bool {
	normalized := normalizedModelsDevModelID(sourceModelID)
	if r.asset[normalized] {
		return false
	}
	if r.authored[normalized] {
		return true
	}
	if modalities == nil {
		return true
	}
	textOnlyOutput := true
	if modalities.Output != nil {
		textOnlyOutput = len(*modalities.Output) == 1 && (*modalities.Output)[0] == "text"
	}
	acceptsText := true
	if modalities.Input != nil {
		acceptsText = false
		for _, modality := range *modalities.Input {
			if modality == "text" {
				acceptsText = true
				break
			}
		}
	}
	return textOnlyOutput && acceptsText
}

// normalizedModelsDevModelID mirrors normalized_models_dev_model_id: dots, the
// regional `@` suffix and case all spell the same id.
func normalizedModelsDevModelID(modelID string) string {
	return strings.ToLower(normalizePricingKey(modelID))
}

// normalizePricingKey mirrors normalized_pricing_key: only '.' and '@' become
// '-'. '/' and '_' are meaningful and stay as they are.
func normalizePricingKey(value string) string {
	replacer := strings.NewReplacer(".", "-", "@", "-")
	return replacer.Replace(value)
}

// baseModelWithoutDateSuffix mirrors model_without_date_suffix: date-pinned
// keys share their base model's rates. Kept separate from the lookup's own
// helper because only the loader needs it here.
func baseModelWithoutDateSuffix(model string) string {
	if len(model) > 11 {
		suffix := model[len(model)-11:]
		if suffix[0] == '-' && isDigits(suffix[1:5]) && suffix[5] == '-' && isDigits(suffix[6:8]) && suffix[8] == '-' && isDigits(suffix[9:]) {
			return model[:len(model)-11]
		}
	}
	if len(model) > 9 {
		suffix := model[len(model)-9:]
		if suffix[0] == '-' && isDigits(suffix[1:]) {
			return model[:len(model)-9]
		}
	}
	return model
}

func isDigits(value string) bool {
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return len(value) > 0
}

// pricingAliasOf mirrors pricing_alias: default family names bill at the
// variant they point to.
func pricingAliasOf(model string) (string, bool) {
	switch model {
	case "gpt-reserve":
		return "gpt-5.6-luna", true
	case "gpt-5.6":
		return "gpt-5.6-sol", true
	case "gpt-5.3-spark":
		return "gpt-5.3-codex-spark", true
	}
	return "", false
}

// modelsDevModalities mirrors ModelsDevModalities. A nil list is "absent"; a
// pointer to an empty slice is "explicitly empty", which is not text.
type modelsDevModalities struct {
	Input  *[]string `json:"input"`
	Output *[]string `json:"output"`
}

// modelsDevEntry is one record of models-dev-pricing.json. models.dev quotes
// rates per million tokens; every rate read here is divided by 1e6, as
// ModelsDevCost::long_context_tier and load_models_dev_models do.
type modelsDevEntry struct {
	ID         string               `json:"id"`
	ExactOnly  *bool                `json:"exactOnly"`
	Cost       *modelsDevCost       `json:"cost"`
	Limit      *modelsDevLimit      `json:"limit"`
	Modalities *modelsDevModalities `json:"modalities"`
}

type modelsDevCost struct {
	Input      *float64        `json:"input"`
	Output     *float64        `json:"output"`
	CacheRead  *float64        `json:"cache_read"`
	CacheWrite *float64        `json:"cache_write"`
	Tiers      []modelsDevTier `json:"tiers"`
}

type modelsDevTier struct {
	Input      *float64        `json:"input"`
	Output     *float64        `json:"output"`
	CacheRead  *float64        `json:"cache_read"`
	CacheWrite *float64        `json:"cache_write"`
	Tier       *modelsDevBound `json:"tier"`
}

type modelsDevBound struct {
	Type string `json:"type"`
	Size *int64 `json:"size"`
}

type modelsDevLimit struct {
	Context *int64 `json:"context"`
}

// longContextRates is the above-base band a request crosses first.
type longContextRates struct {
	Threshold              int64
	Input, Output          *float64
	CacheCreate, CacheRead *float64
}

// longContextTier mirrors ModelsDevCost::long_context_tier: only bands keyed by
// context count, and the lowest threshold wins so everything between two bands
// is not billed at the base rate.
func (c *modelsDevCost) longContextTier() *longContextRates {
	if c == nil || len(c.Tiers) == 0 {
		return nil
	}
	var best *longContextRates
	for _, tier := range c.Tiers {
		if tier.Tier == nil || tier.Tier.Type != "context" || tier.Tier.Size == nil || *tier.Tier.Size <= 0 {
			continue
		}
		rates := longContextRates{
			Threshold:   *tier.Tier.Size,
			Input:       perToken(tier.Input),
			Output:      perToken(tier.Output),
			CacheCreate: perToken(tier.CacheWrite),
			CacheRead:   perToken(tier.CacheRead),
		}
		if best == nil || rates.Threshold < best.Threshold {
			copied := rates
			best = &copied
		}
	}
	return best
}

// perToken converts a per-million-token rate to a per-token one.
func perToken(perMillion *float64) *float64 {
	if perMillion == nil {
		return nil
	}
	value := *perMillion / 1_000_000
	return &value
}

// modelsDevSnapshot is the parsed models.dev asset after the token-priced and
// usable-cost gates, keyed by the id a lookup asks for.
type modelsDevSnapshot struct {
	models map[string]CorpusModel
	limits map[string]int64
	// order keeps the merge independent of hash iteration order.
	order []string
}

func readModelsDev(fsys fs.FS, rules catalogRules) (modelsDevSnapshot, error) {
	var raw map[string]modelsDevEntry
	if err := decodeCorpusFile(fsys, modelsDevDataFile, &raw); err != nil {
		return modelsDevSnapshot{}, err
	}
	if len(raw) == 0 {
		return modelsDevSnapshot{}, fmt.Errorf("nativepricing: %s holds no models", modelsDevDataFile)
	}
	snapshot := modelsDevSnapshot{models: make(map[string]CorpusModel, len(raw)), limits: map[string]int64{}}
	keys := make([]string, 0, len(raw))
	for key := range raw {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		entry := raw[key]
		// models_dev_usable_cost asks the catalog rules about the source key,
		// before the record's own id resolves it away.
		if !rules.isTokenPriced(key, entry.Modalities) {
			continue
		}
		modelID := entry.ID
		if modelID == "" {
			modelID = key
		}
		if _, taken := snapshot.models[modelID]; taken {
			continue
		}
		pricing, ok := entry.pricing()
		if !ok {
			continue
		}
		snapshot.models[modelID] = pricing
		snapshot.order = append(snapshot.order, modelID)
		if entry.Limit != nil && entry.Limit.Context != nil {
			snapshot.limits[modelID] = *entry.Limit.Context
		}
	}
	return snapshot, nil
}

// pricing applies models_dev_usable_cost (both rates present, not both zero)
// and maps the record onto CorpusModel. The token-priced gate ran when the
// snapshot was read.
func (e modelsDevEntry) pricing() (CorpusModel, bool) {
	cost := e.Cost
	if cost == nil || cost.Input == nil || cost.Output == nil {
		return CorpusModel{}, false
	}
	if *cost.Input == 0 && *cost.Output == 0 {
		return CorpusModel{}, false
	}
	input := *cost.Input / 1_000_000
	output := *cost.Output / 1_000_000
	longContext := cost.longContextTier()
	pricing := CorpusModel{
		Input:               input,
		Output:              output,
		CacheCreate:         orElse(perToken(cost.CacheWrite), input*1.25),
		CacheRead:           orElse(perToken(cost.CacheRead), input*0.1),
		CacheCreateExplicit: cost.CacheWrite != nil,
		CacheReadExplicit:   cost.CacheRead != nil,
		ExactOnly:           e.ExactOnly != nil && *e.ExactOnly,
	}
	if longContext != nil {
		pricing.InputAbove = longContext.Input
		pricing.OutputAbove = longContext.Output
		pricing.CacheCreateAbove = longContext.CacheCreate
		pricing.CacheReadAbove = longContext.CacheRead
		threshold := longContext.Threshold
		pricing.LongContextThreshold = &threshold
	}
	return pricing, true
}

// mergeInto adds the fallback models the primary table does not already price. ccusage keeps models.dev in its own
// map and consults it only after the primary map misses, so a key both tables
// know must keep the primary rate. Context windows follow the same order: the
// merged map only gains a limit for a model that has no primary one.
func (s modelsDevSnapshot) mergeInto(
	models map[string]CorpusModel,
	contextLimits map[string]int64,
	fast, flex multiplierOverrides,
) {
	for _, model := range s.order {
		entry := s.models[model]
		if _, primary := models[model]; primary {
			continue
		}
		entry.FastMultiplier = fast.multiplierFor(model)
		entry.FlexMultiplier = flex.multiplierFor(model)
		entry.fromModelsDev = true
		models[model] = entry
		if limit, ok := s.limits[model]; ok {
			if _, primary := contextLimits[model]; !primary {
				contextLimits[model] = limit
			}
		}
	}
}

// applyLongContextRates mirrors fill_long_context_rates_from_models_dev: an
// entry that publishes no above-threshold rate of its own takes models.dev's
// band, resolved by date suffix and hardcoded alias only - a fuzzy match here
// would graft one model's tier onto another's base rates. ccusage looks the
// resolved id up first and only then the base id, and requires the source to
// actually carry a threshold.
func applyLongContextRates(models map[string]CorpusModel, dev map[string]CorpusModel) {
	for model, pricing := range models {
		if pricing.InputAbove != nil || pricing.OutputAbove != nil || pricing.CacheCreateAbove != nil || pricing.CacheReadAbove != nil {
			continue
		}
		base := baseModelWithoutDateSuffix(model)
		resolved := base
		if alias, ok := pricingAliasOf(base); ok {
			resolved = alias
		}
		source, ok := dev[resolved]
		if !ok {
			source, ok = dev[base]
		}
		if !ok || source.LongContextThreshold == nil {
			continue
		}
		pricing.InputAbove = source.InputAbove
		pricing.OutputAbove = source.OutputAbove
		pricing.CacheCreateAbove = source.CacheCreateAbove
		pricing.CacheReadAbove = source.CacheReadAbove
		pricing.LongContextThreshold = source.LongContextThreshold
		models[model] = pricing
	}
}
