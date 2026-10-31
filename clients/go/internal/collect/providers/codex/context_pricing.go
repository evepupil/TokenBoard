package codex

// Port of codex-context-pricing.ts: the request-level context-tier pricing the
// Codex provider applies after ccusage has already attributed usage to a
// model. Codex session files carry per-request `last_token_usage` rows and
// cumulative `total_token_usage` rows; the request that crosses a model's
// context threshold is priced at that model's long-context rates, so the cost
// cannot be derived from the day's aggregate. This module re-reads the session
// JSONL, reconstructs each request, prices it at the tier it ran at, and
// reconciles the result against the daily snapshots ccusage produced.
//
// Everything here is fail-closed: a raw cost without a matching snapshot, a
// snapshot without an unambiguous raw cost, a malformed token field, or a cost
// outside the snapshot contract aborts the collect instead of uploading a
// number the server would reject far from the cause.

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/codexusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionwalk"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/pricing"
)

// MaxCodexContextPricingFiles bounds one context pricing scan. The bound is
// checked before any file is opened so an unbounded full-history scan fails
// fast instead of walking the user's tree.
const MaxCodexContextPricingFiles = 100_000

// defaultLongContextThreshold is the request-level switch shared by the rules
// that publish a single 200k tier.
const defaultLongContextThreshold = 200_000

// codexAutoReviewFallbackModels mirrors ccusage's mapping of the synthetic
// auto-review model to the latest model released on the token event date.
var codexAutoReviewFallbackModels = []struct {
	releasedOn string
	model      string
}{
	{"2026-04-23", "gpt-5.5"},
	{"2026-03-05", "gpt-5.4"},
	{"2026-02-05", "gpt-5.3-codex"},
	{"2025-12-11", "gpt-5.2-codex"},
	{"2025-11-13", "gpt-5.1-codex"},
	{"2025-09-15", "gpt-5-codex"},
	{"2025-08-07", "gpt-5"},
}

// PricingRates is one tier's per-token rates in USD.
type PricingRates struct {
	Input         float64
	Output        float64
	CacheRead     float64
	CacheCreation float64
}

// CodexContextPricingRule is one model family's request-level pricing. The
// threshold is a request-level switch, not the model context window and not a
// marginal above-threshold bucket.
type CodexContextPricingRule struct {
	ModelIDs           []string
	Threshold          float64
	Standard           PricingRates
	LongContext        PricingRates
	FastMultiplier     *float64
	PriorityMultiplier *float64
}

// CodexContextPricingCost is one priced (date, model) pair.
type CodexContextPricingCost struct {
	UsageDate string
	Model     string
	CostUSD   float64
}

// CodexServiceTier is the request's service tier. The empty string is the TS
// module's null (no tier announced yet).
type CodexServiceTier string

const (
	ServiceTierStandard CodexServiceTier = "standard"
	ServiceTierFast     CodexServiceTier = "fast"
	ServiceTierPriority CodexServiceTier = "priority"
)

// Context tiers a request can run at.
const (
	contextTierStandard = "standard"
	contextTierLong     = "long"
)

// CodexContextPricingUsage is one aggregated (date, model, tier) usage bucket.
type CodexContextPricingUsage struct {
	UsageDate string
	Model     string
	// AttributedModel is the canonical non-context model ccusage used for a
	// mixed-model file, when one applied.
	AttributedModel     *string
	InputTokens         float64
	UncachedInputTokens float64
	OutputTokens        float64
	CacheReadTokens     float64
	CacheCreationTokens float64
	TotalTokens         *float64
	ServiceTier         CodexServiceTier
	ContextTier         string
}

// CodexContextPricingModelHints maps a usage date to the set of models
// ccusage attributed that day's usage to.
type CodexContextPricingModelHints map[string]map[string]bool

// CodexContextPricingFileModelHints maps an absolute session path to the
// canonical model ccusage attributed the whole file to.
type CodexContextPricingFileModelHints map[string]string

// CodexContextPricingRules is the static rule set: the provider-published
// per-token rates represented in the server catalogue.
//
// The divisor must be a runtime division, not a constant-folded one, so Go's
// double arithmetic matches the JS collector exactly (0.4/1e6 etc.). This is
// critical for gpt-5.6-sol, gpt-5.6-terra and gpt-5.6-luna: their static rows are
// used when the catalogue has no price agreement, and even a 1 ULP difference
// changes snapshotHash() and breaks shadow/diff tests across clients.
//
// A `var` rather than a `const` is load-bearing: Go evaluates an untyped constant
// expression in exact rational arithmetic and rounds once, while JS rounds the
// double operand and then rounds again after the division. The two disagree by
// 1 ULP for 0.2, 0.4, 0.8 and 1.8, which is precisely the set of fractional
// rows these rules carry.
var codexDivisor = 1_000_000.0

var CodexContextPricingRules = []CodexContextPricingRule{
	{
		ModelIDs:  []string{"gpt-5.6-sol", "gpt-5.6"},
		Threshold: 272_000,
		Standard: PricingRates{
			Input: 4.0 / codexDivisor, Output: 20.0 / codexDivisor,
			CacheRead: 0.4 / codexDivisor, CacheCreation: 5.0 / codexDivisor,
		},
		LongContext: PricingRates{
			Input: 8.0 / codexDivisor, Output: 30.0 / codexDivisor,
			CacheRead: 0.8 / codexDivisor, CacheCreation: 10.0 / codexDivisor,
		},
		FastMultiplier: float64Pointer(2),
	},
	{
		ModelIDs:  []string{"gpt-5.6-terra"},
		Threshold: 272_000,
		Standard: PricingRates{
			Input: 2.0 / codexDivisor, Output: 12.0 / codexDivisor,
			CacheRead: 0.2 / codexDivisor, CacheCreation: 2.5 / codexDivisor,
		},
		LongContext: PricingRates{
			Input: 4.0 / codexDivisor, Output: 18.0 / codexDivisor,
			CacheRead: 0.4 / codexDivisor, CacheCreation: 5.0 / codexDivisor,
		},
		FastMultiplier: float64Pointer(2),
	},
	{
		ModelIDs:  []string{"gpt-5.6-luna"},
		Threshold: 272_000,
		Standard: PricingRates{
			Input: 0.2 / codexDivisor, Output: 1.2 / codexDivisor,
			CacheRead: 0.02 / codexDivisor, CacheCreation: 0.25 / codexDivisor,
		},
		LongContext: PricingRates{
			Input: 0.4 / codexDivisor, Output: 1.8 / codexDivisor,
			CacheRead: 0.04 / codexDivisor, CacheCreation: 0.5 / codexDivisor,
		},
		FastMultiplier: float64Pointer(2),
	},
	{
		ModelIDs:  []string{"gpt-5.5"},
		Threshold: 272_000,
		Standard: PricingRates{
			Input: 5.0 / codexDivisor, Output: 30.0 / codexDivisor,
			CacheRead: 0.5 / codexDivisor, CacheCreation: 0,
		},
		LongContext: PricingRates{
			Input: 10.0 / codexDivisor, Output: 45.0 / codexDivisor,
			CacheRead: 1.0 / codexDivisor, CacheCreation: 0,
		},
		FastMultiplier: float64Pointer(2.5),
	},
	{
		ModelIDs:  []string{"gpt-5.5-pro"},
		Threshold: 272_000,
		Standard: PricingRates{
			Input: 30.0 / codexDivisor, Output: 180.0 / codexDivisor,
			CacheRead: 0, CacheCreation: 0,
		},
		LongContext: PricingRates{
			Input: 60.0 / codexDivisor, Output: 270.0 / codexDivisor,
			CacheRead: 0, CacheCreation: 0,
		},
	},
	{
		ModelIDs:  []string{"gpt-5.4"},
		Threshold: 272_000,
		Standard: PricingRates{
			Input: 2.5 / codexDivisor, Output: 15.0 / codexDivisor,
			CacheRead: 0.25 / codexDivisor, CacheCreation: 0,
		},
		LongContext: PricingRates{
			Input: 5.0 / codexDivisor, Output: 22.5 / codexDivisor,
			CacheRead: 0.5 / codexDivisor, CacheCreation: 0,
		},
		FastMultiplier: float64Pointer(2),
	},
	{
		ModelIDs:  []string{"gpt-5.4-pro"},
		Threshold: 272_000,
		Standard: PricingRates{
			Input: 30.0 / codexDivisor, Output: 180.0 / codexDivisor,
			CacheRead: 0, CacheCreation: 0,
		},
		LongContext: PricingRates{
			Input: 60.0 / codexDivisor, Output: 270.0 / codexDivisor,
			CacheRead: 0, CacheCreation: 0,
		},
	},
	{
		ModelIDs:  []string{"grok-4.5"},
		Threshold: defaultLongContextThreshold,
		Standard: PricingRates{
			Input: 2.0 / codexDivisor, Output: 6.0 / codexDivisor,
			CacheRead: 0.3 / codexDivisor, CacheCreation: 0,
		},
		LongContext: PricingRates{
			Input: 4.0 / codexDivisor, Output: 12.0 / codexDivisor,
			CacheRead: 0.6 / codexDivisor, CacheCreation: 0,
		},
	},
}

// Rules is a compiled rule set: the model-id indexes the pricing decisions are
// made against. The TS module keeps this in an AsyncLocalStorage so one
// collect can price with catalogue-derived rules without disturbing a
// concurrent one; Go has no goroutine-local storage, so the scope is an
// explicit receiver. The package-level functions use DefaultRules.
type Rules struct {
	knownModelBases       map[string]bool
	ruleByModel           map[string]*CodexContextPricingRule
	canonicalModelByAlias map[string]string
}

var (
	defaultRulesOnce sync.Once
	defaultRules     *Rules
)

// DefaultRules returns the compiled static rule set.
func DefaultRules() *Rules {
	defaultRulesOnce.Do(func() {
		defaultRules = CompileRules(CodexContextPricingRules)
	})
	return defaultRules
}

// CompileRules builds the model-id indexes for a rule list.
func CompileRules(rules []CodexContextPricingRule) *Rules {
	knownModelBases := map[string]bool{}
	for _, rule := range rules {
		for _, modelID := range rule.ModelIDs {
			knownModelBases[strings.ToLower(strings.TrimSpace(modelID))] = true
		}
	}
	ruleByModel := map[string]*CodexContextPricingRule{}
	for index := range rules {
		rule := &rules[index]
		for _, modelID := range rule.ModelIDs {
			ruleByModel[normalizeModelIDWithBases(modelID, knownModelBases)] = rule
		}
	}
	canonicalModelByAlias := map[string]string{}
	for index := range rules {
		rule := &rules[index]
		canonical := ""
		if len(rule.ModelIDs) > 0 {
			canonical = normalizeModelIDWithBases(rule.ModelIDs[0], knownModelBases)
		}
		for _, modelID := range rule.ModelIDs {
			canonicalModelByAlias[normalizeModelIDWithBases(modelID, knownModelBases)] = canonical
		}
	}
	return &Rules{
		knownModelBases:       knownModelBases,
		ruleByModel:           ruleByModel,
		canonicalModelByAlias: canonicalModelByAlias,
	}
}

// WithCodexContextPricingRules compiles rules and runs fn with them. It is the
// Go shape of the TS AsyncLocalStorage scope: the callback receives the
// compiled rules instead of reading them from ambient storage.
func WithCodexContextPricingRules(rules []CodexContextPricingRule, fn func(*Rules) error) error {
	return fn(CompileRules(rules))
}

// NormalizeModelID ports normalizeModelId: trim, lowercase, and collapse a
// dated alias onto its base only when that base is a known priced model. This
// prevents a future model such as gpt-5-20241201 from being misread as gpt-5.
func (r *Rules) NormalizeModelID(value string) string {
	return normalizeModelIDWithBases(value, r.knownModelBases)
}

// NormalizeModelID ports normalizeModelId against the default rule set.
func NormalizeModelID(value string) string {
	return DefaultRules().NormalizeModelID(value)
}

// IsCodexContextPricingModel reports whether the model has a pricing rule.
func (r *Rules) IsCodexContextPricingModel(model string) bool {
	_, ok := r.ruleByModel[r.NormalizeModelID(model)]
	return ok
}

// IsCodexContextPricingModel reports whether the model has a pricing rule in
// the default rule set.
func IsCodexContextPricingModel(model string) bool {
	return DefaultRules().IsCodexContextPricingModel(model)
}

// IsCodexContextPricingCostGuaranteedZero reports whether every published
// rate for the model is zero, so a non-zero cost proves the snapshot was never
// repriced.
func (r *Rules) IsCodexContextPricingCostGuaranteedZero(model string) bool {
	rule, ok := r.ruleByModel[r.NormalizeModelID(model)]
	if !ok {
		return false
	}
	return ratesAreZero(rule.Standard) && ratesAreZero(rule.LongContext)
}

// IsCodexContextPricingCostGuaranteedZero is the default-rule form.
func IsCodexContextPricingCostGuaranteedZero(model string) bool {
	return DefaultRules().IsCodexContextPricingCostGuaranteedZero(model)
}

func ratesAreZero(rates PricingRates) bool {
	return rates.Input == 0 && rates.Output == 0 && rates.CacheRead == 0 && rates.CacheCreation == 0
}

// CostSnapshot is the snapshot shape the context pricing matcher needs. Token
// components are optional because the TS module distinguishes an absent field
// from a zero one when deciding whether a snapshot is billable.
type CostSnapshot struct {
	Source              string
	UsageDate           string
	Model               string
	CostUSD             float64
	TotalTokens         *float64
	InputTokens         *float64
	OutputTokens        *float64
	CacheReadTokens     *float64
	CacheCreationTokens *float64
}

// CostSnapshotFromContract adapts a normalized usage snapshot. Every token
// field is present on a contract snapshot, which is what the TS matcher sees
// in production; the optional fields exist for the unit-level shapes the TS
// suite exercises.
func CostSnapshotFromContract(snapshot contract.Snapshot) CostSnapshot {
	total := float64(snapshot.TotalTokens)
	input := float64(snapshot.InputTokens)
	output := float64(snapshot.OutputTokens)
	cacheRead := float64(snapshot.CacheRead)
	cacheCreation := float64(snapshot.CacheCreation)
	return CostSnapshot{
		Source:              string(snapshot.Source),
		UsageDate:           snapshot.UsageDate,
		Model:               snapshot.Model,
		CostUSD:             snapshot.CostUSD,
		TotalTokens:         &total,
		InputTokens:         &input,
		OutputTokens:        &output,
		CacheReadTokens:     &cacheRead,
		CacheCreationTokens: &cacheCreation,
	}
}

// ApplyToContract writes the matcher's cost back onto a normalized snapshot.
func (s CostSnapshot) ApplyToContract(snapshot contract.Snapshot) contract.Snapshot {
	snapshot.CostUSD = s.CostUSD
	return snapshot
}

// IsUnresolvedCodexContextPricingSnapshot reports whether a snapshot still
// carries a cost the context pricing pass must replace. A zero-cost model is
// resolved once its cost is zero; every other priced model stays unresolved
// until the pass has written a cost, whatever value it currently holds.
func (r *Rules) IsUnresolvedCodexContextPricingSnapshot(snapshot CostSnapshot) bool {
	if snapshot.Source != string(contract.SourceCodex) || !r.IsCodexContextPricingModel(snapshot.Model) {
		return false
	}
	// An absent total is "not <= 0" in JS, so only a present zero total
	// resolves the snapshot.
	if snapshot.TotalTokens != nil && *snapshot.TotalTokens <= 0 {
		return false
	}
	if !hasBillableCodexTokens(snapshot) {
		return false
	}
	if r.IsCodexContextPricingCostGuaranteedZero(snapshot.Model) {
		return snapshot.CostUSD != 0
	}
	return true
}

// IsUnresolvedCodexContextPricingSnapshot is the default-rule form.
func IsUnresolvedCodexContextPricingSnapshot(snapshot CostSnapshot) bool {
	return DefaultRules().IsUnresolvedCodexContextPricingSnapshot(snapshot)
}

// PriceRequestInput is one request to price.
type PriceRequestInput struct {
	Model               string
	InputTokens         float64
	UncachedInputTokens *float64
	OutputTokens        float64
	CacheReadTokens     float64
	CacheCreationTokens float64
	ServiceTier         CodexServiceTier
}

// PriceCodexRequest prices one request at the tier its full context crossed.
// A model without a rule yields nil.
func (r *Rules) PriceCodexRequest(input PriceRequestInput) *float64 {
	rule, ok := r.ruleByModel[r.NormalizeModelID(input.Model)]
	if !ok {
		return nil
	}
	requestContextTokens := input.InputTokens + input.CacheCreationTokens
	rates := rule.Standard
	if requestContextTokens > rule.Threshold {
		rates = rule.LongContext
	}
	multiplier := serviceTierMultiplier(rule, input.ServiceTier)
	uncachedInputTokens := math.Max(0, input.InputTokens-input.CacheReadTokens)
	if input.UncachedInputTokens != nil {
		uncachedInputTokens = *input.UncachedInputTokens
	}
	cost := multiplier * (uncachedInputTokens*rates.Input +
		input.OutputTokens*rates.Output +
		input.CacheReadTokens*rates.CacheRead +
		input.CacheCreationTokens*rates.CacheCreation)
	return &cost
}

// PriceCodexRequest is the default-rule form.
func PriceCodexRequest(input PriceRequestInput) *float64 {
	return DefaultRules().PriceCodexRequest(input)
}

func (r *Rules) priceCodexUsageAtTier(usage CodexContextPricingUsage) *float64 {
	rule, ok := r.ruleByModel[r.NormalizeModelID(usage.Model)]
	if !ok {
		return nil
	}
	rates := rule.Standard
	if usage.ContextTier == contextTierLong {
		rates = rule.LongContext
	}
	multiplier := serviceTierMultiplier(rule, usage.ServiceTier)
	cost := multiplier * (usage.UncachedInputTokens*rates.Input +
		usage.OutputTokens*rates.Output +
		usage.CacheReadTokens*rates.CacheRead +
		usage.CacheCreationTokens*rates.CacheCreation)
	return &cost
}

// PriceCodexContextPricingUsages prices aggregated usages. The request-level
// tier observed while scanning is kept: recomputing it from a date/model
// aggregate would reprice every standard request as long-context once the
// daily total crossed the threshold.
func (r *Rules) PriceCodexContextPricingUsages(usages []CodexContextPricingUsage) []CodexContextPricingCost {
	totals := newCostTotals()
	for _, usage := range usages {
		model := r.NormalizeModelID(usage.Model)
		priced := usage
		priced.Model = model
		cost := r.priceCodexUsageAtTier(priced)
		if cost == nil {
			continue
		}
		key := contextPricingKey(r, usage.UsageDate, model)
		totals.add(key, CodexContextPricingCost{UsageDate: usage.UsageDate, Model: model, CostUSD: *cost})
	}
	return totals.list()
}

// PriceCodexContextPricingUsages is the default-rule form.
func PriceCodexContextPricingUsages(usages []CodexContextPricingUsage) []CodexContextPricingCost {
	return DefaultRules().PriceCodexContextPricingUsages(usages)
}

// ApplyCodexContextPricingUsageModelHints rewrites each usage's model onto the
// canonical model for its date before pricing.
func (r *Rules) ApplyCodexContextPricingUsageModelHints(
	usages []CodexContextPricingUsage,
	canonicalModelsByDate CodexContextPricingModelHints,
) []CodexContextPricingUsage {
	totals := newOrderedUsages()
	for _, usage := range usages {
		model := r.resolveCanonicalContextPricingModel(
			r.NormalizeModelID(usage.Model),
			usage.UsageDate,
			canonicalModelsByDate,
		)
		if !r.IsCodexContextPricingModel(model) {
			continue
		}
		key := contextUsageKey(r, usage.UsageDate, model, usage.ServiceTier, usage.ContextTier) + "\x00" +
			attributedModelKey(r, usage.AttributedModel)
		current := totals.values[key]
		if current != nil {
			currentTotal := codexContextUsageTotal(*current)
			usageTotal := codexContextUsageTotal(usage)
			current.InputTokens += usage.InputTokens
			current.UncachedInputTokens += usage.UncachedInputTokens
			current.OutputTokens += usage.OutputTokens
			current.CacheReadTokens += usage.CacheReadTokens
			current.CacheCreationTokens += usage.CacheCreationTokens
			total := currentTotal + usageTotal
			current.TotalTokens = &total
			if !sameAttributedModel(current.AttributedModel, usage.AttributedModel) {
				current.AttributedModel = nil
			}
			continue
		}
		merged := usage
		merged.Model = model
		totals.set(key, &merged)
	}
	return totals.list()
}

// ApplyCodexContextPricingUsageModelHints is the default-rule form.
func ApplyCodexContextPricingUsageModelHints(
	usages []CodexContextPricingUsage,
	canonicalModelsByDate CodexContextPricingModelHints,
) []CodexContextPricingUsage {
	return DefaultRules().ApplyCodexContextPricingUsageModelHints(usages, canonicalModelsByDate)
}

func attributedModelKey(r *Rules, value *string) string {
	if value == nil || *value == "" {
		return ""
	}
	return r.NormalizeModelID(*value)
}

func sameAttributedModel(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func codexContextUsageTotal(usage CodexContextPricingUsage) float64 {
	if usage.TotalTokens != nil {
		return *usage.TotalTokens
	}
	return usage.InputTokens + usage.OutputTokens + usage.CacheCreationTokens
}

func serviceTierMultiplier(rule *CodexContextPricingRule, serviceTier CodexServiceTier) float64 {
	if serviceTier == ServiceTierFast {
		if rule.FastMultiplier != nil {
			return *rule.FastMultiplier
		}
		return 1
	}
	if serviceTier == ServiceTierPriority {
		if rule.PriorityMultiplier != nil {
			return *rule.PriorityMultiplier
		}
		if rule.FastMultiplier != nil {
			return *rule.FastMultiplier
		}
		return 1
	}
	return 1
}

// ApplyCodexContextPricingCosts rewrites each snapshot's cost from the matched
// raw cost, failing closed when the two sides cannot be paired.
func (r *Rules) ApplyCodexContextPricingCosts(
	snapshots []CostSnapshot,
	costs []CodexContextPricingCost,
	stderr func(string),
) ([]CostSnapshot, error) {
	costsByKey := newOrderedCosts()
	for _, cost := range costs {
		costsByKey.add(contextPricingKey(r, cost.UsageDate, cost.Model), cost)
	}

	matches := map[int]float64{}
	unmatchedCostKeys := newOrderedKeySet()
	for _, key := range costsByKey.order {
		unmatchedCostKeys.add(key)
	}
	unmatchedSnapshotsByFamily := newOrderedIndexes()
	requiredSnapshotIndexesByKey := newOrderedIndexes()
	for index, snapshot := range snapshots {
		if !r.requiresContextPricingCost(snapshot) {
			continue
		}
		key := contextPricingKey(r, snapshot.UsageDate, snapshot.Model)
		requiredSnapshotIndexesByKey.append(key, index)
		exactCost, ok := costsByKey.values[key]
		if ok {
			matches[index] = exactCost
			unmatchedCostKeys.remove(key)
			continue
		}
		familyKey := contextPricingFamilyKey(r, snapshot.UsageDate, snapshot.Model)
		unmatchedSnapshotsByFamily.append(familyKey, index)
	}

	for _, key := range requiredSnapshotIndexesByKey.order {
		snapshotIndexes := requiredSnapshotIndexesByKey.values[key]
		if len(snapshotIndexes) < 2 {
			continue
		}
		if _, ok := costsByKey.values[key]; !ok {
			continue
		}
		usageDate, model, err := splitContextPricingKey(key)
		if err != nil {
			return nil, err
		}
		emitStderr(stderr, fmt.Sprintf(
			"Codex context pricing found duplicate daily snapshots for %s/%s", usageDate, model))
		return nil, fmt.Errorf(
			"Codex context pricing cannot match duplicate daily snapshots for %s/%s", usageDate, model)
	}

	unresolvedSnapshots := []int{}
	for _, familyKey := range unmatchedSnapshotsByFamily.order {
		snapshotIndexes := unmatchedSnapshotsByFamily.values[familyKey]
		compatibleCostKeys := []string{}
		for _, key := range unmatchedCostKeys.order() {
			usageDate, model, err := splitContextPricingKey(key)
			if err != nil {
				return nil, err
			}
			if contextPricingFamilyKey(r, usageDate, model) == familyKey {
				compatibleCostKeys = append(compatibleCostKeys, key)
			}
		}
		if len(snapshotIndexes) == 1 && len(compatibleCostKeys) == 1 {
			costKey := compatibleCostKeys[0]
			cost, ok := costsByKey.values[costKey]
			if !ok {
				return nil, errors.New("Codex context pricing matching lost a raw cost")
			}
			matches[snapshotIndexes[0]] = cost
			unmatchedCostKeys.remove(costKey)
			continue
		}
		unresolvedSnapshots = append(unresolvedSnapshots, snapshotIndexes...)
	}

	for _, key := range unmatchedCostKeys.order() {
		if _, ok := costsByKey.values[key]; !ok {
			return nil, errors.New("Codex context pricing matching lost a raw cost")
		}
		usageDate, model, err := splitContextPricingKey(key)
		if err != nil {
			return nil, err
		}
		emitStderr(stderr, fmt.Sprintf(
			"Codex context pricing found %s usage without a matching daily snapshot for %s", model, usageDate))
		return nil, fmt.Errorf(
			"Codex context pricing cannot match daily snapshot for %s/%s", usageDate, model)
	}

	if len(unresolvedSnapshots) > 0 {
		snapshot := snapshots[unresolvedSnapshots[0]]
		emitStderr(stderr, fmt.Sprintf(
			"Codex context pricing found %s daily usage without an unambiguous raw cost for %s",
			snapshot.Model, snapshot.UsageDate))
		return nil, fmt.Errorf(
			"Codex context pricing cannot match raw cost for %s/%s", snapshot.UsageDate, snapshot.Model)
	}

	out := make([]CostSnapshot, len(snapshots))
	copy(out, snapshots)
	for index, snapshot := range out {
		cost, ok := matches[index]
		if !ok {
			continue
		}
		// The rates come from a dynamic catalogue and the tokens from a user's
		// own session files, so neither is bounded here. The shared snapshot
		// schema validated the snapshot before this pass rewrote its cost, and
		// this is the only place that writes one afterwards. A non-finite,
		// negative, or above-limit product must fail beside the cause.
		if math.IsNaN(cost) || math.IsInf(cost, 0) || cost < 0 || cost > contract.MaxSnapshotCostUSD {
			return nil, fmt.Errorf(
				"Codex context pricing produced an invalid cost for %s/%s", snapshot.UsageDate, snapshot.Model)
		}
		out[index].CostUSD = cost
	}
	return out, nil
}

// ApplyCodexContextPricingCosts is the default-rule form.
func ApplyCodexContextPricingCosts(
	snapshots []CostSnapshot,
	costs []CodexContextPricingCost,
	stderr func(string),
) ([]CostSnapshot, error) {
	return DefaultRules().ApplyCodexContextPricingCosts(snapshots, costs, stderr)
}

func (r *Rules) requiresContextPricingCost(snapshot CostSnapshot) bool {
	if !r.IsCodexContextPricingModel(snapshot.Model) {
		return false
	}
	if snapshot.TotalTokens != nil && *snapshot.TotalTokens == 0 {
		return false
	}
	return hasBillableCodexTokens(snapshot)
}

func hasBillableCodexTokens(snapshot CostSnapshot) bool {
	components := []*float64{
		snapshot.InputTokens,
		snapshot.OutputTokens,
		snapshot.CacheReadTokens,
		snapshot.CacheCreationTokens,
	}
	allAbsent := true
	for _, value := range components {
		if value != nil {
			allAbsent = false
		}
	}
	if allAbsent {
		return true
	}
	for _, value := range components {
		if value != nil && *value > 0 {
			return true
		}
	}
	return false
}

// CollectFilesInput configures one context pricing file scan.
type CollectFilesInput struct {
	FilePaths             []string
	IdentityPaths         map[string]string
	CanonicalModelsByDate CodexContextPricingModelHints
	CanonicalModelsByFile CodexContextPricingFileModelHints
	Timezone              string
	Since                 string
	Until                 string
	Stderr                func(string)
}

// CollectHomesInput configures one context pricing home scan.
type CollectHomesInput struct {
	CodexHomes            []string
	CanonicalModelsByDate CodexContextPricingModelHints
	CanonicalModelsByFile CodexContextPricingFileModelHints
	Timezone              string
	Since                 string
	Until                 string
	Stderr                func(string)
	CodexSymlinkRoots     []string
}

// CollectCodexContextPricingCostsFromFiles ports
// collectCodexContextPricingCostsFromFiles.
func (r *Rules) CollectCodexContextPricingCostsFromFiles(input CollectFilesInput) ([]CodexContextPricingCost, error) {
	usages, err := r.CollectCodexContextPricingUsagesFromFiles(input)
	if err != nil {
		return nil, err
	}
	return r.PriceCodexContextPricingUsages(
		r.ApplyCodexContextPricingUsageModelHints(usages, input.CanonicalModelsByDate)), nil
}

// CollectCodexContextPricingCostsFromFiles is the default-rule form.
func CollectCodexContextPricingCostsFromFiles(input CollectFilesInput) ([]CodexContextPricingCost, error) {
	return DefaultRules().CollectCodexContextPricingCostsFromFiles(input)
}

// CollectCodexContextPricingUsagesFromFiles ports
// collectCodexContextPricingUsagesFromFiles.
func (r *Rules) CollectCodexContextPricingUsagesFromFiles(input CollectFilesInput) ([]CodexContextPricingUsage, error) {
	since, err := normalizeDateFilter(input.Since, "Codex context pricing since date")
	if err != nil {
		return nil, err
	}
	until, err := normalizeDateFilter(input.Until, "Codex context pricing until date")
	if err != nil {
		return nil, err
	}
	if err := assertDateRange(since, until); err != nil {
		return nil, err
	}
	if len(input.FilePaths) > MaxCodexContextPricingFiles {
		return nil, fmt.Errorf(
			"Codex context pricing scan exceeds %d session files", MaxCodexContextPricingFiles)
	}

	totals := newOrderedUsages()
	seen := map[string]bool{}
	sessionIdentitiesByAlias := map[string]string{}
	oversizedDiagnostics := oversizedContextPricingRowSummary{}
	for _, filePath := range input.FilePaths {
		diagnostics := []string{}
		absolutePath := resolvePath(filePath)
		identityPath := absolutePath
		if mapped, ok := input.IdentityPaths[absolutePath]; ok {
			identityPath = mapped
		}
		canonicalModel := ""
		if mapped, ok := input.CanonicalModelsByFile[absolutePath]; ok {
			canonicalModel = mapped
		}
		allowMixedModelPricing := false
		if canonicalModel != "" && !r.IsCodexContextPricingModel(canonicalModel) {
			mixed, err := r.hasMixedCodexContextPricingModels(filePath, input.Timezone, canonicalModel)
			if err != nil {
				return nil, err
			}
			allowMixedModelPricing = mixed
		}
		// ccusage has already attributed this file to a non-context-priced
		// model. Most such files have no context-priced event and can be
		// skipped after a bounded model scan. A session can switch models
		// within one JSONL file, so retain files that contain both model
		// classes for event-level parsing.
		if canonicalModel != "" && !r.IsCodexContextPricingModel(canonicalModel) && !allowMixedModelPricing {
			continue
		}
		scan := scanFileInput{
			filePath:                 filePath,
			identityPath:             identityPath,
			timezone:                 input.Timezone,
			since:                    since,
			until:                    until,
			stderr:                   func(line string) { diagnostics = append(diagnostics, line) },
			totals:                   totals,
			seen:                     seen,
			sessionIdentitiesByAlias: sessionIdentitiesByAlias,
			canonicalModel:           canonicalModel,
			allowMixedModelPricing:   allowMixedModelPricing,
		}
		if !allowMixedModelPricing {
			scan.canonicalModelsByDate = input.CanonicalModelsByDate
		}
		relevant, err := r.scanFile(scan)
		if err != nil {
			return nil, err
		}
		if !relevant {
			continue
		}
		for _, line := range diagnostics {
			summary, ok := parseOversizedContextPricingRowSummary(line)
			if ok {
				oversizedDiagnostics.rows += summary.rows
				oversizedDiagnostics.scans++
				if summary.largestBytes > oversizedDiagnostics.largestBytes {
					oversizedDiagnostics.largestBytes = summary.largestBytes
				}
				continue
			}
			emitStderr(input.Stderr, line)
		}
	}
	if oversizedDiagnostics.rows > 0 {
		rowLabel := "rows"
		if oversizedDiagnostics.rows == 1 {
			rowLabel = "row"
		}
		scanLabel := "scans"
		if oversizedDiagnostics.scans == 1 {
			scanLabel = "scan"
		}
		emitStderr(input.Stderr, fmt.Sprintf(
			"Skipped %d oversized Codex context pricing JSONL %s without usage or subagent metadata across %d %s (largest %d bytes)",
			oversizedDiagnostics.rows, rowLabel, oversizedDiagnostics.scans, scanLabel, oversizedDiagnostics.largestBytes))
	}
	return totals.list(), nil
}

// CollectCodexContextPricingUsagesFromFiles is the default-rule form.
func CollectCodexContextPricingUsagesFromFiles(input CollectFilesInput) ([]CodexContextPricingUsage, error) {
	return DefaultRules().CollectCodexContextPricingUsagesFromFiles(input)
}

// oversizedContextPricingRowSummary accumulates the reader's per-scan skip
// diagnostic so one line reports the whole collect.
type oversizedContextPricingRowSummary struct {
	rows         int64
	scans        int64
	largestBytes int64
}

var oversizedContextPricingRowPattern = regexp.MustCompile(
	`^Skipped ([1-9][0-9]*) oversized Codex context pricing JSONL rows? without usage or subagent metadata \(largest ([1-9][0-9]*) bytes\)$`)

func parseOversizedContextPricingRowSummary(line string) (oversizedContextPricingRowSummary, bool) {
	match := oversizedContextPricingRowPattern.FindStringSubmatch(line)
	if match == nil {
		return oversizedContextPricingRowSummary{}, false
	}
	rows, err := strconv.ParseInt(match[1], 10, 64)
	if err != nil {
		return oversizedContextPricingRowSummary{}, false
	}
	largest, err := strconv.ParseInt(match[2], 10, 64)
	if err != nil {
		return oversizedContextPricingRowSummary{}, false
	}
	return oversizedContextPricingRowSummary{rows: rows, largestBytes: largest}, true
}

// CollectCodexContextPricingCostsFromHomes ports
// collectCodexContextPricingCostsFromHomes.
func (r *Rules) CollectCodexContextPricingCostsFromHomes(input CollectHomesInput) ([]CodexContextPricingCost, error) {
	usages, err := r.CollectCodexContextPricingUsagesFromHomes(input)
	if err != nil {
		return nil, err
	}
	return r.PriceCodexContextPricingUsages(
		r.ApplyCodexContextPricingUsageModelHints(usages, input.CanonicalModelsByDate)), nil
}

// CollectCodexContextPricingCostsFromHomes is the default-rule form.
func CollectCodexContextPricingCostsFromHomes(input CollectHomesInput) ([]CodexContextPricingCost, error) {
	return DefaultRules().CollectCodexContextPricingCostsFromHomes(input)
}

// CollectCodexContextPricingUsagesFromHomes ports
// collectCodexContextPricingUsagesFromHomes.
func (r *Rules) CollectCodexContextPricingUsagesFromHomes(input CollectHomesInput) ([]CodexContextPricingUsage, error) {
	inventory, err := r.DiscoverCodexContextPricingFiles(DiscoverInput{
		CodexHomes:        input.CodexHomes,
		CodexSymlinkRoots: input.CodexSymlinkRoots,
	})
	if err != nil {
		return nil, err
	}
	return r.CollectCodexContextPricingUsagesFromFiles(CollectFilesInput{
		FilePaths:             inventory.FilePaths,
		IdentityPaths:         inventory.IdentityPaths,
		CanonicalModelsByDate: input.CanonicalModelsByDate,
		CanonicalModelsByFile: input.CanonicalModelsByFile,
		Timezone:              input.Timezone,
		Since:                 input.Since,
		Until:                 input.Until,
		Stderr:                input.Stderr,
	})
}

// CollectCodexContextPricingUsagesFromHomes is the default-rule form.
func CollectCodexContextPricingUsagesFromHomes(input CollectHomesInput) ([]CodexContextPricingUsage, error) {
	return DefaultRules().CollectCodexContextPricingUsagesFromHomes(input)
}

// DiscoverInput configures one bounded file discovery.
type DiscoverInput struct {
	CodexHomes          []string
	CodexSymlinkRoots   []string
	CaptureFingerprints bool
	AllowFileOverflow   bool
	FingerprintMemo     *CodexSessionFingerprintMemo
}

// CodexContextPricingFileInventory is the discovered file set.
type CodexContextPricingFileInventory struct {
	FilePaths     []string
	IdentityPaths map[string]string
	Fingerprints  map[string]CodexSessionFileFingerprint
	Overflow      bool
}

type fileCandidate struct {
	filePath     string
	identityPath string
	rootPriority int
}

// DiscoverCodexContextPricingFiles ports discoverCodexContextPricingFiles. The
// walk is bounded by MaxCodexContextPricingFiles; with AllowFileOverflow the
// bound degrades to an overflow flag instead of failing the collect.
func (r *Rules) DiscoverCodexContextPricingFiles(input DiscoverInput) (CodexContextPricingFileInventory, error) {
	order := []string{}
	candidates := map[string]fileCandidate{}
	identityPaths := map[string]string{}
	discoveredFiles := 0
	overflow := false
	rootNames := []string{"sessions", "archived_sessions"}
	for homeIndex, codexHome := range input.CodexHomes {
		for rootPriority, rootName := range rootNames {
			rootPath := filepath.Join(codexHome, rootName)
			root, ok, err := sessionwalk.Resolve(rootPath, sessionwalk.Options{
				RejectRootSymlink:   true,
				RootBoundary:        codexHome,
				AllowedRootSymlinks: input.CodexSymlinkRoots,
				// This scan carries its own total-file budget and an
				// AllowFileOverflow degrade; the walker's default per-directory
				// cap is far below it and would throw first, turning the
				// degrade into a hard failure. The walker's depth cap still
				// applies.
				MaxEntries: MaxCodexContextPricingFiles,
			})
			if err != nil {
				return CodexContextPricingFileInventory{}, err
			}
			if !ok {
				continue
			}
			for _, relativePath := range root.Paths {
				physicalPath := filepath.Join(root.RootDir, relativePath)
				identityPath := resolvePath(filepath.Join(rootPath, relativePath))
				alias := archiveSessionAlias(identityPath)
				if alias == "" {
					alias = identityPath
				}
				logicalPath := fmt.Sprintf("%d\x00%s", homeIndex, alias)
				existing, seen := candidates[logicalPath]
				if seen && existing.rootPriority <= rootPriority {
					continue
				}
				if !seen {
					discoveredFiles++
					if discoveredFiles > MaxCodexContextPricingFiles {
						if input.AllowFileOverflow {
							overflow = true
							break
						}
						return CodexContextPricingFileInventory{}, fmt.Errorf(
							"Codex context pricing scan exceeds %d session files", MaxCodexContextPricingFiles)
					}
					order = append(order, logicalPath)
				}
				candidates[logicalPath] = fileCandidate{
					filePath:     physicalPath,
					identityPath: identityPath,
					rootPriority: rootPriority,
				}
			}
			if overflow {
				break
			}
		}
		if overflow {
			break
		}
	}
	filePaths := make([]string, 0, len(order))
	for _, logicalPath := range order {
		filePaths = append(filePaths, candidates[logicalPath].filePath)
	}
	fingerprints := map[string]CodexSessionFileFingerprint{}
	if input.CaptureFingerprints && !overflow {
		for _, filePath := range filePaths {
			key := resolvePath(filePath)
			fingerprint, err := fingerprintForDiscovery(key, input.FingerprintMemo)
			if err != nil {
				return CodexContextPricingFileInventory{}, err
			}
			fingerprints[key] = fingerprint
		}
	}
	for _, logicalPath := range order {
		candidate := candidates[logicalPath]
		identityPaths[resolvePath(candidate.filePath)] = candidate.identityPath
	}
	return CodexContextPricingFileInventory{
		FilePaths:     filePaths,
		IdentityPaths: identityPaths,
		Fingerprints:  fingerprints,
		Overflow:      overflow,
	}, nil
}

// DiscoverCodexContextPricingFiles is the default-rule form.
func DiscoverCodexContextPricingFiles(input DiscoverInput) (CodexContextPricingFileInventory, error) {
	return DefaultRules().DiscoverCodexContextPricingFiles(input)
}

func normalizeDateFilter(value, field string) (string, error) {
	if value == "" || isAllDateFilter(value) {
		return "", nil
	}
	trimmed, err := assertValidDateFilter(value, field)
	if err != nil {
		return "", err
	}
	return strings.ReplaceAll(trimmed, "-", ""), nil
}

func isAllDateFilter(value string) bool {
	return strings.TrimSpace(value) == "all"
}

var (
	compactDatePattern = regexp.MustCompile(`^\d{8}$`)
	dashedDatePattern  = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	dateOnlyPattern    = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

func assertValidDateFilter(value, field string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if !compactDatePattern.MatchString(trimmed) && !dashedDatePattern.MatchString(trimmed) {
		return "", fmt.Errorf("Invalid %s: %s. Expected YYYYMMDD or YYYY-MM-DD.", field, value)
	}
	compact := strings.ReplaceAll(trimmed, "-", "")
	if !validCalendarDate(compact) {
		return "", fmt.Errorf("Invalid %s: %s. Expected YYYYMMDD or YYYY-MM-DD.", field, value)
	}
	return trimmed, nil
}

// validCalendarDate reports whether YYYYMMDD names a real calendar date.
// Years below 100 fail the same way JS Date.UTC(year, ...) does: it maps them
// to 1900+year, so the round trip never matches.
func validCalendarDate(compact string) bool {
	year, err := strconv.Atoi(compact[0:4])
	if err != nil || year < 100 {
		return false
	}
	month, err := strconv.Atoi(compact[4:6])
	if err != nil {
		return false
	}
	day, err := strconv.Atoi(compact[6:8])
	if err != nil {
		return false
	}
	date := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	return date.Year() == year && int(date.Month()) == month && date.Day() == day
}

func assertDateRange(since, until string) error {
	if since != "" && until != "" && since > until {
		return fmt.Errorf("Codex context pricing date range is reversed: %s > %s", since, until)
	}
	return nil
}

func isDateInBounds(date, since, until string) bool {
	normalizedSince := since
	if isAllDateFilter(normalizedSince) {
		normalizedSince = ""
	}
	normalizedUntil := until
	if isAllDateFilter(normalizedUntil) {
		normalizedUntil = ""
	}
	compactDate := strings.ReplaceAll(date, "-", "")
	if normalizedSince != "" && compactDate < strings.ReplaceAll(normalizedSince, "-", "") {
		return false
	}
	if normalizedUntil != "" && compactDate > strings.ReplaceAll(normalizedUntil, "-", "") {
		return false
	}
	return true
}

func contextPricingKey(r *Rules, usageDate, model string) string {
	return usageDate + "\x00" + r.NormalizeModelID(model)
}

func contextPricingFamilyKey(r *Rules, usageDate, model string) string {
	return usageDate + "\x00" + r.canonicalModelID(model)
}

func splitContextPricingKey(key string) (string, string, error) {
	separator := strings.IndexByte(key, 0)
	if separator == -1 {
		return "", "", errors.New("Codex context pricing key is malformed")
	}
	return key[:separator], key[separator+1:], nil
}

func (r *Rules) canonicalModelID(value string) string {
	normalized := r.NormalizeModelID(value)
	if canonical, ok := r.canonicalModelByAlias[normalized]; ok {
		return canonical
	}
	return normalized
}

func contextUsageKey(r *Rules, usageDate, model string, serviceTier CodexServiceTier, contextTier string) string {
	tier := string(serviceTier)
	if tier == "" {
		tier = string(ServiceTierStandard)
	}
	return usageDate + "\x00" + r.NormalizeModelID(model) + "\x00" + tier + "\x00" + contextTier
}

func (r *Rules) resolveCanonicalContextPricingModel(
	rawModel string,
	usageDate string,
	canonicalModelsByDate CodexContextPricingModelHints,
) string {
	candidates, ok := canonicalModelsByDate[usageDate]
	if !ok || len(candidates) == 0 || candidates[rawModel] {
		return rawModel
	}
	familyMatches := []string{}
	for candidate := range candidates {
		if r.IsCodexContextPricingModel(candidate) && r.canonicalModelID(candidate) == r.canonicalModelID(rawModel) {
			familyMatches = append(familyMatches, candidate)
		}
	}
	if len(familyMatches) == 1 {
		return familyMatches[0]
	}
	billableCandidates := []string{}
	for candidate := range candidates {
		if r.IsCodexContextPricingModel(candidate) {
			billableCandidates = append(billableCandidates, candidate)
		}
	}
	if len(billableCandidates) == 1 {
		return billableCandidates[0]
	}
	return rawModel
}

func (r *Rules) resolveCodexContextPricingModel(model, timestamp, timezone string) (string, error) {
	normalizedModel := r.NormalizeModelID(model)
	if normalizedModel != "codex-auto-review" {
		return normalizedModel, nil
	}
	eventDate, err := formatUsageDate(timestamp, timezone)
	if err != nil {
		return "", err
	}
	if !dateOnlyPattern.MatchString(eventDate) {
		return "gpt-5", nil
	}
	for _, fallback := range codexAutoReviewFallbackModels {
		if eventDate >= fallback.releasedOn {
			return fallback.model, nil
		}
	}
	return "gpt-5", nil
}

// resolveFileCanonicalContextPricingModel decides which model a file's events
// belong to when ccusage attributed the file to a canonical model.
func (r *Rules) resolveFileCanonicalContextPricingModel(
	rawModel string,
	canonicalModel string,
	usageDate string,
	canonicalModelsByDate CodexContextPricingModelHints,
) string {
	if canonicalModel == "" {
		candidates, ok := canonicalModelsByDate[usageDate]
		if ok && len(candidates) > 0 {
			normalizedRawModel := r.NormalizeModelID(rawModel)
			if candidates[normalizedRawModel] {
				return rawModel
			}
			billableCandidates := []string{}
			for candidate := range candidates {
				if r.IsCodexContextPricingModel(candidate) {
					billableCandidates = append(billableCandidates, candidate)
				}
			}
			if len(billableCandidates) == 1 {
				return billableCandidates[0]
			}
			return ""
		}
		return rawModel
	}
	normalizedCanonicalModel := r.NormalizeModelID(canonicalModel)
	if !r.IsCodexContextPricingModel(rawModel) {
		return rawModel
	}
	if !r.IsCodexContextPricingModel(normalizedCanonicalModel) {
		return ""
	}
	if canonicalModelsByDate == nil {
		return normalizedCanonicalModel
	}
	candidates, ok := canonicalModelsByDate[usageDate]
	if !ok || len(candidates) == 0 || candidates[r.NormalizeModelID(rawModel)] {
		return rawModel
	}
	if candidates[normalizedCanonicalModel] {
		return normalizedCanonicalModel
	}
	return rawModel
}

type scanFileInput struct {
	filePath                 string
	identityPath             string
	timezone                 string
	since                    string
	until                    string
	stderr                   func(string)
	totals                   *orderedUsages
	seen                     map[string]bool
	sessionIdentitiesByAlias map[string]string
	canonicalModel           string
	allowMixedModelPricing   bool
	canonicalModelsByDate    CodexContextPricingModelHints
}

func (r *Rules) scanFile(input scanFileInput) (bool, error) {
	currentModel := ""
	serviceTier := CodexServiceTier("")
	archiveAlias := archiveSessionAlias(input.identityPath)
	fallbackIdentity := ""
	if archiveAlias != "" {
		fallbackIdentity = "path:" + archiveAlias
	} else {
		fallbackIdentity = anonymousSessionIdentity(input.identityPath)
	}
	sessionIdentity := ""
	if archiveAlias != "" {
		sessionIdentity = input.sessionIdentitiesByAlias[archiveAlias]
	}
	isSubagentSession := false
	previousTotals := map[string]*usageValues{}
	occurrences := map[string]int{}
	hasRelevantModel := false
	reportedScopeModelMismatches := map[string]bool{}
	readErr := ReadJSONLRecords(input.filePath, input.stderr, contextPricingReadLimits(), func(record UnknownRecord) error {
		recordType := ReadString(record, []string{"type"})
		switch recordType {
		case "session_meta":
			identity := readSessionIdentity(record)
			if identity != "" && sessionIdentity == "" {
				sessionIdentity = scopedSessionIdentity(identity, input.identityPath)
				if archiveAlias != "" {
					if previous, ok := input.sessionIdentitiesByAlias[archiveAlias]; ok && previous != sessionIdentity {
						return fmt.Errorf(
							"Codex context pricing found conflicting session identities for %s", archiveAlias)
					}
					input.sessionIdentitiesByAlias[archiveAlias] = sessionIdentity
				}
			} else if identity != "" && sessionIdentity != "" && archiveAlias != "" {
				observedIdentity := scopedSessionIdentity(identity, input.identityPath)
				if observedIdentity != sessionIdentity {
					return fmt.Errorf(
						"Codex context pricing found conflicting session identities for %s", archiveAlias)
				}
			}
			payload := ReadRecord(record["payload"])
			source := ReadRecord(payload["source"])
			subagent := ReadRecord(source["subagent"])
			// The parent thread id is optional in newer child-session metadata.
			// The presence of the subagent envelope is the stable child-session
			// signal.
			isSubagentSession = subagent != nil
			return nil
		case "turn_context":
			payload := ReadRecord(record["payload"])
			if model := ReadString(payload, []string{"model"}); model != "" {
				currentModel = model
			}
			return nil
		case "event_msg":
		default:
			return nil
		}
		payload := ReadRecord(record["payload"])
		if ReadString(payload, []string{"type"}) == "thread_settings_applied" {
			settings := ReadRecord(payload["thread_settings"])
			if settings != nil && cpHasOwn(settings, "service_tier") {
				serviceTier = readServiceTier(ReadString(settings, []string{"service_tier"}))
			}
			return nil
		}
		if ReadString(payload, []string{"type"}) != "token_count" {
			return nil
		}
		timestamp := ReadString(record, []string{"timestamp"})
		if timestamp == "" {
			return nil
		}
		info, rawModel := readTokenCountModel(payload, currentModel)
		modelKey := ""
		if rawModel != "" {
			modelKey = r.NormalizeModelID(rawModel)
		}
		rawPricingModel := ""
		if rawModel != "" {
			resolved, err := r.resolveCodexContextPricingModel(rawModel, timestamp, input.timezone)
			if err != nil {
				return err
			}
			rawPricingModel = resolved
		}
		date, err := formatUsageDate(timestamp, input.timezone)
		if err != nil {
			return err
		}
		if rawPricingModel != "" && r.IsCodexContextPricingModel(rawPricingModel) {
			hasRelevantModel = true
		}
		model := ""
		if rawPricingModel != "" {
			canonicalModel := input.canonicalModel
			if input.allowMixedModelPricing {
				canonicalModel = ""
			}
			model = r.resolveFileCanonicalContextPricingModel(
				rawPricingModel, canonicalModel, date, input.canonicalModelsByDate)
		}
		hasModel := model != ""
		normalizedModel := ""
		if hasModel {
			normalizedModel = r.NormalizeModelID(model)
		}
		total, err := readUsage(cpNullish(info, "total_token_usage", payload["total_token_usage"]), input.filePath)
		if err != nil {
			return err
		}
		last, err := readUsage(cpNullish(info, "last_token_usage", payload["usage"]), input.filePath)
		if err != nil {
			return err
		}
		if total == nil && last == nil {
			return nil
		}

		// A file attributed by ccusage to a non-context model can still contain
		// a context-priced turn. In that mixed case total_token_usage remains a
		// session-wide cumulative counter across model switches, so every model
		// in the file must share one baseline stream.
		usageStreamModel := ""
		if input.allowMixedModelPricing {
			usageStreamModel = "__mixed-codex-session__"
		} else if modelKey == "codex-auto-review" {
			usageStreamModel = modelKey
		} else if input.canonicalModel != "" {
			// normalizedModel ?? normalizeModelId(rawPricingModel ?? modelKey ?? ''):
			// nullish coalescing only, so an empty normalized model (a model id
			// that normalizes away) stays empty instead of falling back.
			if hasModel {
				usageStreamModel = normalizedModel
			} else {
				usageStreamModel = r.NormalizeModelID(rawPricingModel)
			}
		} else {
			usageStreamModel = modelKey
		}
		if usageStreamModel == "" {
			return nil
		}
		usageStreamKey := fallbackIdentity + "\x00" + r.canonicalModelID(usageStreamModel)
		previousTotal := previousTotals[usageStreamKey]
		if total != nil && previousTotal != nil && usageEquals(*total, *previousTotal) {
			return nil
		}
		// A cumulative-only first row is a baseline. Codex child sessions can
		// start with inherited parent context in total_token_usage; charging
		// that first cumulative value would bill the parent context twice.
		if isSubagentSession && total != nil && last == nil && previousTotal == nil {
			previousTotals[usageStreamKey] = total
			return nil
		}
		var usage *usageValues
		if last != nil {
			usage = last
		} else if total != nil {
			usage = subtractUsage(total, previousTotal)
		}
		if total != nil {
			previousTotals[usageStreamKey] = total
		}
		if usage == nil || isEmptyUsage(*usage) {
			return nil
		}

		if normalizedModel == "" || modelKey == "" || !r.IsCodexContextPricingModel(normalizedModel) {
			if rawPricingModel != "" && r.IsCodexContextPricingModel(rawPricingModel) && input.canonicalModel == "" {
				candidates, ok := input.canonicalModelsByDate[date]
				normalizedRawModel := r.NormalizeModelID(rawPricingModel)
				mismatchKey := date + "\x00" + normalizedRawModel
				if ok && len(candidates) > 0 && !candidates[normalizedRawModel] && !reportedScopeModelMismatches[mismatchKey] {
					reportedScopeModelMismatches[mismatchKey] = true
					emitStderr(input.stderr, fmt.Sprintf(
						"Codex context pricing skipped %s usage outside the ccusage daily model scope for %s",
						normalizedRawModel, date))
				}
			}
			return nil
		}
		if !isDateInBounds(date, input.since, input.until) {
			return nil
		}
		rule, ok := r.ruleByModel[normalizedModel]
		if !ok {
			return nil
		}
		eventContentKey := strings.Join([]string{
			timestamp,
			r.canonicalModelID(normalizedModel),
			serviceTierKey(serviceTier),
			formatJSNumber(usage.InputTokens),
			formatJSNumber(usage.UncachedInputTokens),
			formatJSNumber(usage.CacheReadTokens),
			formatJSNumber(usage.CacheCreationTokens),
			formatJSNumber(usage.OutputTokens),
			formatJSNumber(usage.TotalTokens),
		}, "\x00")
		eventBaseKey := fallbackIdentity + "\x00" + eventContentKey
		occurrences[eventBaseKey]++
		occurrence := occurrences[eventBaseKey]
		identityEventKeys := []string{
			eventBaseKey + "\x00" + strconv.Itoa(occurrence),
		}
		if sessionIdentity != "" && sessionIdentity != fallbackIdentity {
			identityEventKeys = append(identityEventKeys,
				sessionIdentity+"\x00"+eventContentKey+"\x00"+strconv.Itoa(occurrence))
		}
		for _, key := range identityEventKeys {
			if input.seen[key] {
				return nil
			}
		}
		for _, key := range identityEventKeys {
			input.seen[key] = true
		}
		requestContextTokens := usage.InputTokens + usage.CacheCreationTokens
		contextTier := contextTierStandard
		if requestContextTokens > rule.Threshold {
			contextTier = contextTierLong
		}
		attributed := ""
		if input.allowMixedModelPricing {
			attributed = r.NormalizeModelID(input.canonicalModel)
		}
		key := contextUsageKey(r, date, normalizedModel, serviceTier, contextTier) + "\x00" + attributed
		current := input.totals.values[key]
		if current != nil {
			currentTotal := codexContextUsageTotal(*current)
			usageTotal := usageValuesTotal(*usage)
			current.InputTokens += usage.InputTokens
			current.UncachedInputTokens += usage.UncachedInputTokens
			current.OutputTokens += usage.OutputTokens
			current.CacheReadTokens += usage.CacheReadTokens
			current.CacheCreationTokens += usage.CacheCreationTokens
			totalTokens := currentTotal + usageTotal
			current.TotalTokens = &totalTokens
			return nil
		}
		entry := CodexContextPricingUsage{
			UsageDate:           date,
			Model:               normalizedModel,
			InputTokens:         usage.InputTokens,
			UncachedInputTokens: usage.UncachedInputTokens,
			OutputTokens:        usage.OutputTokens,
			CacheReadTokens:     usage.CacheReadTokens,
			CacheCreationTokens: usage.CacheCreationTokens,
			TotalTokens:         &usage.TotalTokens,
			ServiceTier:         serviceTier,
			ContextTier:         contextTier,
		}
		if input.canonicalModel != "" && !r.IsCodexContextPricingModel(input.canonicalModel) {
			attributedModel := r.NormalizeModelID(input.canonicalModel)
			entry.AttributedModel = &attributedModel
		}
		input.totals.set(key, &entry)
		return nil
	})
	if readErr != nil {
		return false, readErr
	}
	return hasRelevantModel, nil
}

func serviceTierKey(tier CodexServiceTier) string {
	if tier == "" {
		return string(ServiceTierStandard)
	}
	return string(tier)
}

// hasMixedCodexContextPricingModels reports whether a file ccusage attributed
// to a non-context model also contains a context-priced event.
func (r *Rules) hasMixedCodexContextPricingModels(filePath, timezone, canonicalModel string) (bool, error) {
	currentModel := ""
	hasContextModel := false
	hasOtherModel := false
	result := false
	err := ReadJSONLRecords(filePath, nil, contextPricingReadLimits(), func(record UnknownRecord) error {
		recordType := ReadString(record, []string{"type"})
		if recordType == "turn_context" {
			payload := ReadRecord(record["payload"])
			if model := ReadString(payload, []string{"model"}); model != "" {
				currentModel = model
				if r.NormalizeModelID(model) == "codex-auto-review" {
					// ccusage can attribute a file to a non-context model while
					// the synthetic auto-review stream resolves to a billable
					// context model. Keep the synthetic stream as a distinct
					// model class so the file is retained for event-level
					// parsing below.
					hasOtherModel = true
				} else if r.IsCodexContextPricingModel(model) {
					hasContextModel = true
				} else {
					hasOtherModel = true
				}
			}
		} else if recordType == "event_msg" {
			payload := ReadRecord(record["payload"])
			if ReadString(payload, []string{"type"}) != "token_count" {
				return nil
			}
			timestamp := ReadString(record, []string{"timestamp"})
			if timestamp == "" {
				return nil
			}
			info, rawModel := readTokenCountModel(payload, currentModel)
			if rawModel == "" {
				return nil
			}
			model, err := r.resolveCodexContextPricingModel(rawModel, timestamp, timezone)
			if err != nil {
				return err
			}
			if r.IsCodexContextPricingModel(model) {
				hasContextModel = true
			} else {
				hasOtherModel = true
			}
			// A file-level non-context attribution is useful evidence only
			// when the token row explicitly names a context model. A context
			// model inherited solely from an older turn_context row is
			// historical metadata and must remain bound to the canonical
			// non-context attribution.
			explicitModel := ReadString(info, []string{"model"})
			if explicitModel == "" {
				explicitModel = ReadString(ReadRecord(cpNullish(info, "total_token_usage", payload["total_token_usage"])), []string{"model"})
			}
			if explicitModel == "" {
				explicitModel = ReadString(ReadRecord(cpNullish(info, "last_token_usage", payload["usage"])), []string{"model"})
			}
			if explicitModel != "" && canonicalModel != "" &&
				!r.IsCodexContextPricingModel(canonicalModel) && r.IsCodexContextPricingModel(model) {
				hasOtherModel = true
			}
			if r.NormalizeModelID(rawModel) == "codex-auto-review" {
				hasOtherModel = true
			}
		}
		if hasContextModel && hasOtherModel {
			// The TS loop returns as soon as both classes are seen; stop the
			// read the same way so a later malformed row cannot fail a file
			// whose classification is already decided.
			result = true
			return ErrStopJSONL
		}
		return nil
	})
	if err != nil && !errors.Is(err, ErrStopJSONL) {
		return false, err
	}
	return result, nil
}

func readTokenCountModel(payload UnknownRecord, currentModel string) (UnknownRecord, string) {
	info := ReadRecord(payload["info"])
	rawModel := ReadString(info, []string{"model"})
	if rawModel == "" {
		rawModel = ReadString(ReadRecord(cpNullish(info, "total_token_usage", payload["total_token_usage"])), []string{"model"})
	}
	if rawModel == "" {
		rawModel = ReadString(ReadRecord(cpNullish(info, "last_token_usage", payload["usage"])), []string{"model"})
	}
	if rawModel == "" {
		rawModel = currentModel
	}
	return info, rawModel
}

// usageValues is one Codex row's resolved token components.
type usageValues struct {
	raw                 UnknownRecord
	InputTokens         float64
	UncachedInputTokens float64
	OutputTokens        float64
	CacheReadTokens     float64
	CacheCreationTokens float64
	TotalTokens         float64
}

func readUsage(value any, filePath string) (*usageValues, error) {
	raw := ReadRecord(value)
	if raw == nil {
		return nil, nil
	}
	// Usage metadata can contain total-only bookkeeping rows. They do not carry
	// enough information to price a request, so ignore them instead of failing
	// the whole file before model/date filtering gets a chance to discard them.
	if !cpHasAnyField(raw, "input_tokens", "inputTokens") {
		return nil, nil
	}
	reportedInputTokens, err := readTokenNumber(raw, []string{"input_tokens", "inputTokens"}, "input_tokens", filePath)
	if err != nil {
		return nil, err
	}
	outputTokens, err := readTokenNumber(raw, []string{"output_tokens", "outputTokens"}, "output_tokens", filePath)
	if err != nil {
		return nil, err
	}
	cacheReadTokens, err := readTokenNumber(raw, []string{
		"cached_input_tokens", "cache_read_input_tokens", "cacheReadInputTokens", "cacheReadTokens",
	}, "cached_input_tokens", filePath)
	if err != nil {
		return nil, err
	}
	cacheCreationTokens, err := readTokenNumber(raw, []string{
		"cache_creation_input_tokens", "cache_write_input_tokens", "cacheCreationInputTokens",
		"cacheWriteInputTokens", "cache_write_tokens", "cacheCreationTokens",
	}, "cache_creation_input_tokens", filePath)
	if err != nil {
		return nil, err
	}
	explicitTotal, err := readTokenNumber(raw, []string{"total_tokens", "totalTokens"}, "total_tokens", filePath)
	if err != nil {
		return nil, err
	}
	// A zero total is emitted by incomplete and synthetic rows. It cannot tell
	// whether cached input is already included, so keep the legacy-compatible
	// input interpretation used by the rest of the Codex parser.
	var explicitTotalPointer *float64
	if cpHasAnyField(raw, "total_tokens", "totalTokens") && explicitTotal > 0 {
		explicitTotalPointer = &explicitTotal
	}
	// codexusage owns the legacy/additive decision and the matching total, so
	// this path and the hook parser cannot drift apart on how a raw Codex row
	// is read.
	resolved := codexusage.ResolveRawUsage(codexusage.Totals{
		InputTokens:         reportedInputTokens,
		OutputTokens:        outputTokens,
		CacheCreationTokens: cacheCreationTokens,
		CacheReadTokens:     cacheReadTokens,
		ExplicitTotal:       explicitTotalPointer,
	})
	cacheReadIsIncludedInInput := resolved.CacheReadIncludedInInput
	inputTokens := reportedInputTokens
	if !cacheReadIsIncludedInInput {
		inputTokens = reportedInputTokens + cacheReadTokens
	}
	uncachedInputTokens := reportedInputTokens
	if cacheReadIsIncludedInInput {
		uncachedInputTokens = cpSubtractNonNegative(reportedInputTokens, cacheReadTokens)
	}
	return &usageValues{
		raw:                 raw,
		InputTokens:         inputTokens,
		UncachedInputTokens: uncachedInputTokens,
		OutputTokens:        outputTokens,
		CacheReadTokens:     cacheReadTokens,
		CacheCreationTokens: cacheCreationTokens,
		TotalTokens:         resolved.TotalTokens,
	}, nil
}

const maxSafeIntegerFloat = 1<<53 - 1

func readTokenNumber(
	record UnknownRecord,
	keys []string,
	label string,
	filePath string,
) (float64, error) {
	for _, key := range keys {
		if !cpHasOwn(record, key) {
			continue
		}
		value, ok := safeNonNegativeInteger(record[key])
		if !ok {
			return 0, fmt.Errorf("Invalid Codex token usage field %s in %s", label, filePath)
		}
		return value, nil
	}
	return 0, nil
}

func safeNonNegativeInteger(value any) (float64, bool) {
	number, ok := jsonNumberValue(value)
	if !ok {
		return 0, false
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || number < 0 || number > maxSafeIntegerFloat {
		return 0, false
	}
	if number != math.Trunc(number) {
		return 0, false
	}
	return number, true
}

func jsonNumberValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return 0, false
		}
		return parsed, true
	case float64:
		return typed, true
	case int64:
		return float64(typed), true
	case int:
		return float64(typed), true
	}
	return 0, false
}

func cpHasAnyField(record UnknownRecord, keys ...string) bool {
	for _, key := range keys {
		if cpHasOwn(record, key) {
			return true
		}
	}
	return false
}

func subtractUsage(current *usageValues, previous *usageValues) *usageValues {
	if previous == nil {
		return current
	}
	return &usageValues{
		raw:                 current.raw,
		InputTokens:         cpSubtractNonNegative(current.InputTokens, previous.InputTokens),
		UncachedInputTokens: cpSubtractNonNegative(current.UncachedInputTokens, previous.UncachedInputTokens),
		OutputTokens:        cpSubtractNonNegative(current.OutputTokens, previous.OutputTokens),
		CacheReadTokens:     cpSubtractNonNegative(current.CacheReadTokens, previous.CacheReadTokens),
		CacheCreationTokens: cpSubtractNonNegative(current.CacheCreationTokens, previous.CacheCreationTokens),
		TotalTokens:         cpSubtractNonNegative(current.TotalTokens, previous.TotalTokens),
	}
}

func cpSubtractNonNegative(current, previous float64) float64 {
	if current >= previous {
		return current - previous
	}
	return 0
}

func isEmptyUsage(usage usageValues) bool {
	return usage.InputTokens == 0 &&
		usage.OutputTokens == 0 &&
		usage.CacheReadTokens == 0 &&
		usage.CacheCreationTokens == 0
}

func usageValuesTotal(usage usageValues) float64 {
	return usage.TotalTokens
}

func usageEquals(left, right usageValues) bool {
	return left.InputTokens == right.InputTokens &&
		left.UncachedInputTokens == right.UncachedInputTokens &&
		left.OutputTokens == right.OutputTokens &&
		left.CacheReadTokens == right.CacheReadTokens &&
		left.CacheCreationTokens == right.CacheCreationTokens &&
		left.TotalTokens == right.TotalTokens
}

func readServiceTier(value string) CodexServiceTier {
	switch value {
	case "default", "standard":
		return ServiceTierStandard
	case "fast":
		return ServiceTierFast
	case "priority":
		return ServiceTierPriority
	}
	return ""
}

// usageDateFormatters caches one *time.Location per timezone, the TS module's
// Intl.DateTimeFormat cache.
var usageDateFormatters sync.Map

func formatUsageDate(timestamp, timezone string) (string, error) {
	date, ok := parseTimestamp(timestamp)
	if !ok {
		return "", fmt.Errorf("Invalid Codex token usage timestamp: %s", timestamp)
	}
	var location *time.Location
	if cached, ok := usageDateFormatters.Load(timezone); ok {
		location = cached.(*time.Location)
	} else {
		loaded, err := contract.LoadLocation(timezone)
		if err != nil {
			return "", fmt.Errorf("Invalid timezone for Codex context pricing usage date: %s", timezone)
		}
		usageDateFormatters.Store(timezone, loaded)
		location = loaded
	}
	return date.In(location).Format("2006-01-02"), nil
}

var (
	// isoDateTimeWithZone covers RFC 3339 with an explicit offset or Z.
	isoDateTimeWithZone = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$`)
	// isoDateTimeWithoutZone is the form JS parses in the local zone.
	isoDateTimeWithoutZone = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$`)
	isoDateOnly            = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// parseTimestamp mirrors `new Date(value)`: an explicit offset is honoured, a
// bare date is UTC, and a date-time without an offset is the local zone.
func parseTimestamp(value string) (time.Time, bool) {
	switch {
	case isoDateOnly.MatchString(value):
		parsed, err := time.Parse("2006-01-02", value)
		return parsed, err == nil
	case isoDateTimeWithZone.MatchString(value):
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05.999999999Z07:00", "2006-01-02 15:04:05Z07:00"} {
			if parsed, err := time.Parse(layout, value); err == nil {
				return parsed, true
			}
		}
		return time.Time{}, false
	case isoDateTimeWithoutZone.MatchString(value):
		for _, layout := range []string{"2006-01-02T15:04:05.999999999", "2006-01-02T15:04:05", "2006-01-02 15:04:05.999999999", "2006-01-02 15:04:05"} {
			if parsed, err := time.ParseInLocation(layout, value, time.Local); err == nil {
				return parsed, true
			}
		}
		return time.Time{}, false
	}
	return time.Time{}, false
}

func readSessionIdentity(record UnknownRecord) string {
	identity := ReadString(record,
		[]string{"session_id", "sessionId", "thread_id", "threadId", "id"})
	if identity != "" {
		return identity
	}
	return ReadString(ReadRecord(record["payload"]),
		[]string{"session_id", "sessionId", "thread_id", "threadId", "id"})
}

var (
	archiveSessionPattern = regexp.MustCompile(`^(.*)/(?:sessions|archived_sessions)/(.+)$`)
	sessionRootPattern    = regexp.MustCompile(`^(.*)/(?:sessions|archived_sessions)/.+$`)
)

func archiveSessionAlias(filePath string) string {
	normalizedPath := strings.ReplaceAll(resolvePath(filePath), "\\", "/")
	match := archiveSessionPattern.FindStringSubmatch(normalizedPath)
	if match == nil {
		return ""
	}
	return match[1] + ":" + match[2]
}

func scopedSessionIdentity(identity, filePath string) string {
	profileRoot := sessionProfileRoot(filePath)
	if profileRoot == "" {
		return identity
	}
	return "session:" + profileRoot + ":\x00" + identity
}

func sessionProfileRoot(filePath string) string {
	normalizedPath := strings.ReplaceAll(resolvePath(filePath), "\\", "/")
	match := sessionRootPattern.FindStringSubmatch(normalizedPath)
	if match == nil {
		return ""
	}
	return match[1]
}

// anonymousSessionIdentity keeps the session path even when a damaged or
// truncated file no longer contains a usable session_meta identity. The
// profile root is part of the identity so equal filenames from independent
// CODEX_HOME profiles remain independent.
func anonymousSessionIdentity(filePath string) string {
	absolutePath := resolvePath(filePath)
	normalizedPath := strings.ReplaceAll(absolutePath, "\\", "/")
	match := archiveSessionPattern.FindStringSubmatch(normalizedPath)
	if match != nil {
		return "anonymous:" + match[1] + ":" + match[2]
	}
	fallbackDirectory := strings.ReplaceAll(filepath.Dir(absolutePath), string(filepath.Separator), "/")
	return "anonymous:" + fallbackDirectory + ":" + filepath.Base(absolutePath)
}

func normalizeModelIDWithBases(value string, knownModelBases map[string]bool) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	datedModel := datedModelPattern.FindStringSubmatch(normalized)
	if datedModel == nil {
		return normalized
	}
	year, err := strconv.Atoi(datedModel[2])
	if err != nil {
		return normalized
	}
	month, err := strconv.Atoi(datedModel[3])
	if err != nil {
		return normalized
	}
	day, err := strconv.Atoi(datedModel[4])
	if err != nil {
		return normalized
	}
	// Date.UTC maps years below 100 to 1900+year, so the round trip never
	// matches for them.
	if year < 100 {
		return normalized
	}
	date := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	if date.Year() != year || int(date.Month()) != month || date.Day() != day {
		return normalized
	}
	base := datedModel[1]
	if knownModelBases[base] {
		return base
	}
	return normalized
}

var datedModelPattern = regexp.MustCompile(`^(.+)-(\d{4})(\d{2})(\d{2})$`)

// BuildCodexContextPricingRules ports buildCodexContextPricingRules: the
// static rules minus explicitly excluded models, plus one dynamic rule per
// unambiguously priced catalogue model.
func BuildCodexContextPricingRules(
	models []pricing.Model,
	baseRules []CodexContextPricingRule,
	stderr func(string),
	excludedModelIDs map[string]bool,
) []CodexContextPricingRule {
	if baseRules == nil {
		baseRules = CodexContextPricingRules
	}
	knownBaseIDs := map[string]bool{}
	for _, rule := range baseRules {
		for _, modelID := range rule.ModelIDs {
			knownBaseIDs[strings.ToLower(strings.TrimSpace(modelID))] = true
		}
	}
	excluded := map[string]bool{}
	for modelID := range excludedModelIDs {
		normalized := strings.ToLower(strings.TrimSpace(modelID))
		excluded[normalized] = true
		excluded[normalizeModelIDWithBases(normalized, knownBaseIDs)] = true
	}
	rules := []*CodexContextPricingRule{}
	for index := range baseRules {
		rule := baseRules[index]
		modelIDs := []string{}
		for _, modelID := range rule.ModelIDs {
			normalized := strings.ToLower(strings.TrimSpace(modelID))
			if excluded[normalized] || excluded[normalizeModelIDWithBases(normalized, knownBaseIDs)] {
				continue
			}
			modelIDs = append(modelIDs, modelID)
		}
		if len(modelIDs) == 0 {
			continue
		}
		rules = append(rules, &CodexContextPricingRule{
			ModelIDs:           modelIDs,
			Threshold:          rule.Threshold,
			Standard:           rule.Standard,
			LongContext:        rule.LongContext,
			FastMultiplier:     rule.FastMultiplier,
			PriorityMultiplier: rule.PriorityMultiplier,
		})
	}
	ruleByID := map[string]*CodexContextPricingRule{}
	baseModelBases := map[string]bool{}
	for _, rule := range rules {
		for _, model := range rule.ModelIDs {
			baseModelBases[strings.ToLower(strings.TrimSpace(model))] = true
		}
	}
	for _, rule := range rules {
		for _, modelID := range rule.ModelIDs {
			ruleByID[normalizeModelIDWithBases(modelID, baseModelBases)] = rule
		}
	}

	for _, model := range SelectUnambiguousDynamicPricingModels(models) {
		normalizedModelID := normalizeModelIDWithBases(model.ModelID, baseModelBases)
		if excluded[strings.ToLower(strings.TrimSpace(model.ModelID))] || excluded[normalizedModelID] {
			continue
		}
		tier := readDynamicContextTier(model.Pricing)
		existing := ruleByID[normalizedModelID]
		if tier == nil {
			// A single threshold rule cannot safely represent changing prices
			// across multiple published context tiers. Remove only this model
			// from a shared static rule instead of silently repricing it with
			// stale rates.
			if hasChangingDynamicContextTiers(model.Pricing) {
				removeContextPricingRuleForModel(&rules, ruleByID, normalizedModelID, baseModelBases)
				emitStderr(stderr, fmt.Sprintf(
					"TokenBoard model pricing: skipping dynamic Codex context rule for %s; multiple changing context tiers cannot be represented by the request-level rule",
					model.ModelID))
			}
			continue
		}
		var fallbackStandard *PricingRates
		var fallbackLongContext *PricingRates
		if existing != nil {
			fallbackStandard = &existing.Standard
			fallbackLongContext = &existing.LongContext
		}
		standard := dynamicRates(model, fallbackStandard)
		longContext := dynamicLongContextRates(model, *tier, fallbackLongContext)
		if standard == nil || longContext == nil {
			// The TS diagnostic names a cache price as missing when either tier
			// could not resolve it; a nil tier cannot supply either one.
			missingCachePrices := []string{}
			standardCacheReadMissing := standard == nil
			standardCacheCreationMissing := standard == nil
			if standard != nil {
				standardCacheReadMissing = model.CacheReadCostPerMillion == nil && fallbackStandard == nil
				standardCacheCreationMissing = model.CacheWriteCostPerMillion == nil && fallbackStandard == nil
			}
			longCacheReadMissing := longContext == nil
			longCacheCreationMissing := longContext == nil
			if longContext != nil {
				longCacheReadMissing = tier.cacheRead == nil && model.CacheReadCostPerMillion == nil && fallbackLongContext == nil
				longCacheCreationMissing = tier.cacheWrite == nil && model.CacheWriteCostPerMillion == nil && fallbackLongContext == nil
			}
			if standardCacheReadMissing || longCacheReadMissing {
				missingCachePrices = append(missingCachePrices, "cache-read")
			}
			if standardCacheCreationMissing || longCacheCreationMissing {
				missingCachePrices = append(missingCachePrices, "cache-write")
			}
			emitStderr(stderr, fmt.Sprintf(
				"TokenBoard model pricing: skipping dynamic Codex context rule for %s; cache pricing is incomplete (%s)",
				model.ModelID, strings.Join(missingCachePrices, ", ")))
			continue
		}
		if existing != nil {
			removeContextPricingRuleForModel(&rules, ruleByID, normalizedModelID, baseModelBases)
		}
		dynamicRule := &CodexContextPricingRule{
			ModelIDs:           uniqueStrings(model.ModelID, normalizedModelID),
			Threshold:          tier.threshold,
			Standard:           *standard,
			LongContext:        *longContext,
			FastMultiplier:     readDynamicMultiplier(model.Pricing),
			PriorityMultiplier: readDynamicPriorityMultiplier(model.Pricing),
		}
		if dynamicRule.FastMultiplier == nil && existing != nil {
			dynamicRule.FastMultiplier = existing.FastMultiplier
		}
		if dynamicRule.PriorityMultiplier == nil && existing != nil {
			dynamicRule.PriorityMultiplier = existing.PriorityMultiplier
		}
		rules = append(rules, dynamicRule)
		ruleByID[normalizedModelID] = dynamicRule
	}
	out := make([]CodexContextPricingRule, 0, len(rules))
	for _, rule := range rules {
		out = append(out, *rule)
	}
	return out
}

func removeContextPricingRuleForModel(
	rules *[]*CodexContextPricingRule,
	ruleByID map[string]*CodexContextPricingRule,
	normalizedModelID string,
	knownModelBases map[string]bool,
) {
	existing, ok := ruleByID[normalizedModelID]
	if !ok {
		return
	}
	for key, value := range ruleByID {
		if value == existing {
			delete(ruleByID, key)
		}
	}
	remainingModelIDs := []string{}
	for _, modelID := range existing.ModelIDs {
		if normalizeModelIDWithBases(modelID, knownModelBases) != normalizedModelID {
			remainingModelIDs = append(remainingModelIDs, modelID)
		}
	}
	index := -1
	for position, rule := range *rules {
		if rule == existing {
			index = position
			break
		}
	}
	if len(remainingModelIDs) == 0 {
		if index >= 0 {
			*rules = append((*rules)[:index], (*rules)[index+1:]...)
		}
		return
	}
	replacement := &CodexContextPricingRule{
		ModelIDs:           remainingModelIDs,
		Threshold:          existing.Threshold,
		Standard:           existing.Standard,
		LongContext:        existing.LongContext,
		FastMultiplier:     existing.FastMultiplier,
		PriorityMultiplier: existing.PriorityMultiplier,
	}
	if index >= 0 {
		(*rules)[index] = replacement
	}
	for _, modelID := range remainingModelIDs {
		ruleByID[normalizeModelIDWithBases(modelID, knownModelBases)] = replacement
	}
}

func uniqueStrings(values ...string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

// dynamicRates ports dynamicRates. It returns nil when either cache price is
// unresolved and no static fallback supplies it; the caller then reports both
// missing cache prices, exactly like the TS diagnostic that reads
// `standard?.cacheRead === undefined || longContext?.cacheRead === undefined`.
func dynamicRates(model pricing.Model, fallback *PricingRates) *PricingRates {
	var cacheRead float64
	haveCacheRead := false
	if model.CacheReadCostPerMillion != nil {
		cacheRead = *model.CacheReadCostPerMillion / 1_000_000
		haveCacheRead = true
	} else if fallback != nil {
		cacheRead = fallback.CacheRead
		haveCacheRead = true
	}
	var cacheCreation float64
	haveCacheCreation := false
	if model.CacheWriteCostPerMillion != nil {
		cacheCreation = *model.CacheWriteCostPerMillion / 1_000_000
		haveCacheCreation = true
	} else if fallback != nil {
		cacheCreation = fallback.CacheCreation
		haveCacheCreation = true
	}
	if !haveCacheRead || !haveCacheCreation {
		return nil
	}
	return &PricingRates{
		Input:         model.InputCostPerMillion / 1_000_000,
		Output:        model.OutputCostPerMillion / 1_000_000,
		CacheRead:     cacheRead,
		CacheCreation: cacheCreation,
	}
}

// dynamicLongContextRates ports dynamicLongContextRates: the tier's own cache
// prices win, then the model's, then the static fallback.
func dynamicLongContextRates(model pricing.Model, tier dynamicContextTier, fallback *PricingRates) *PricingRates {
	var cacheRead float64
	haveCacheRead := false
	if tier.cacheRead != nil {
		cacheRead = *tier.cacheRead / 1_000_000
		haveCacheRead = true
	} else if model.CacheReadCostPerMillion != nil {
		cacheRead = *model.CacheReadCostPerMillion / 1_000_000
		haveCacheRead = true
	} else if fallback != nil {
		cacheRead = fallback.CacheRead
		haveCacheRead = true
	}
	var cacheCreation float64
	haveCacheCreation := false
	if tier.cacheWrite != nil {
		cacheCreation = *tier.cacheWrite / 1_000_000
		haveCacheCreation = true
	} else if model.CacheWriteCostPerMillion != nil {
		cacheCreation = *model.CacheWriteCostPerMillion / 1_000_000
		haveCacheCreation = true
	} else if fallback != nil {
		cacheCreation = fallback.CacheCreation
		haveCacheCreation = true
	}
	if !haveCacheRead || !haveCacheCreation {
		return nil
	}
	return &PricingRates{
		Input:         tier.input / 1_000_000,
		Output:        tier.output / 1_000_000,
		CacheRead:     cacheRead,
		CacheCreation: cacheCreation,
	}
}

type dynamicContextTier struct {
	threshold  float64
	input      float64
	output     float64
	cacheRead  *float64
	cacheWrite *float64
}

func readDynamicContextTier(pricingMap map[string]any) *dynamicContextTier {
	parsedExplicit := readDynamicContextTiers(pricingMap)
	if len(parsedExplicit) > 0 {
		if !hasChangingLaterContextTier(parsedExplicit) {
			return parsedExplicit[0]
		}
		return nil
	}
	contextOver200k := ReadRecord(pricingMap["context_over_200k"])
	if contextOver200k == nil {
		return nil
	}
	merged := map[string]any{}
	for key, value := range contextOver200k {
		merged[key] = value
	}
	merged["tier"] = map[string]any{"type": "context", "size": float64(200_000)}
	return parseDynamicContextTier(merged)
}

func hasChangingDynamicContextTiers(pricingMap map[string]any) bool {
	tiers := readDynamicContextTiers(pricingMap)
	return len(tiers) > 0 && hasChangingLaterContextTier(tiers)
}

func readDynamicContextTiers(pricingMap map[string]any) []*dynamicContextTier {
	values := []map[string]any{}
	if rawTiers, ok := pricingMap["tiers"].([]any); ok {
		for _, value := range rawTiers {
			if record := ReadRecord(value); record != nil {
				values = append(values, record)
			}
		}
	}
	tiers := []*dynamicContextTier{}
	for _, value := range values {
		parsed := parseDynamicContextTier(value)
		if parsed != nil {
			tiers = append(tiers, parsed)
		}
	}
	sort.SliceStable(tiers, func(left, right int) bool {
		return tiers[left].threshold < tiers[right].threshold
	})
	return tiers
}

func hasChangingLaterContextTier(tiers []*dynamicContextTier) bool {
	if len(tiers) == 0 {
		return false
	}
	first := tiers[0]
	for _, tier := range tiers[1:] {
		if tier.input != first.input ||
			tier.output != first.output ||
			!sameFloatPointer(tier.cacheRead, first.cacheRead) ||
			!sameFloatPointer(tier.cacheWrite, first.cacheWrite) {
			return true
		}
	}
	return false
}

func sameFloatPointer(left, right *float64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func parseDynamicContextTier(value map[string]any) *dynamicContextTier {
	tierRecord := ReadRecord(value["tier"])
	var thresholdValue any
	if tierRecord != nil && ReadString(tierRecord, []string{"type"}) == "context" {
		thresholdValue = tierRecord["size"]
	}
	threshold, ok := safePositiveInteger(thresholdValue)
	if !ok {
		return nil
	}
	input, ok := finiteNonNegative(value["input"])
	if !ok {
		return nil
	}
	output, ok := finiteNonNegative(value["output"])
	if !ok {
		return nil
	}
	return &dynamicContextTier{
		threshold:  threshold,
		input:      input,
		output:     output,
		cacheRead:  nullableFiniteNonNegative(value, "cache_read"),
		cacheWrite: nullableFiniteNonNegative(value, "cache_write"),
	}
}

func readDynamicMultiplier(pricingMap map[string]any) *float64 {
	for _, key := range []string{"fastMultiplier", "fast_multiplier"} {
		if value, ok := finitePositive(pricingMap[key]); ok {
			return &value
		}
	}
	return nil
}

func readDynamicPriorityMultiplier(pricingMap map[string]any) *float64 {
	for _, key := range []string{"priorityMultiplier", "priority_multiplier"} {
		if value, ok := finitePositive(pricingMap[key]); ok {
			return &value
		}
	}
	return nil
}

func finiteNonNegative(value any) (float64, bool) {
	number, ok := jsonNumberValue(value)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
		return 0, false
	}
	return number, true
}

func nullableFiniteNonNegative(record map[string]any, key string) *float64 {
	value, ok := record[key]
	if !ok || value == nil {
		return nil
	}
	number, ok := finiteNonNegative(value)
	if !ok {
		return nil
	}
	return &number
}

func finitePositive(value any) (float64, bool) {
	number, ok := jsonNumberValue(value)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number <= 0 {
		return 0, false
	}
	return number, true
}

func safePositiveInteger(value any) (float64, bool) {
	number, ok := safeNonNegativeInteger(value)
	if !ok || number <= 0 {
		return 0, false
	}
	return number, true
}

// SelectUnambiguousDynamicPricingModels ports
// selectUnambiguousDynamicPricingModels. The catalogue is provider-scoped
// while Codex records only carry a model id: rows for the same id whose prices
// disagree cannot be told apart, so the id stays with the static fallback.
func SelectUnambiguousDynamicPricingModels(models []pricing.Model) []pricing.Model {
	byModelID := map[string][]int{}
	order := []string{}
	for index, model := range models {
		key := strings.ToLower(strings.TrimSpace(model.ModelID))
		if _, ok := byModelID[key]; !ok {
			order = append(order, key)
		}
		byModelID[key] = append(byModelID[key], index)
	}
	collapsed := map[string]int{}
	for _, key := range order {
		entries := byModelID[key]
		if len(entries) == 1 {
			collapsed[key] = entries[0]
			continue
		}
		if !dynamicPriceRowsAgree(models, entries) {
			continue
		}
		collapsed[key] = pickCollapsedRepresentative(models, dynamicPriceAgreementGroup(models, entries))
	}
	out := []pricing.Model{}
	for index, model := range models {
		key := strings.ToLower(strings.TrimSpace(model.ModelID))
		collapsedIndex, ok := collapsed[key]
		if ok && collapsedIndex == index {
			out = append(out, model)
		}
	}
	return out
}

// dynamicPriceRowsAgree: rows agree when their priced signature is identical;
// all-zero rows compare only with all-zero rows.
func dynamicPriceRowsAgree(models []pricing.Model, entries []int) bool {
	group := dynamicPriceAgreementGroup(models, entries)
	signature := priceRowSignature(models[group[0]])
	for _, index := range group {
		if priceRowSignature(models[index]) != signature {
			return false
		}
	}
	return true
}

// dynamicPriceAgreementGroup returns the rows the agreement check and the
// representative choice both see. When any row carries a real price, zero rows
// drop out of the group entirely — including an official vendor's $0
// placeholder row, which would otherwise win the representative pick and
// silently price the model as free. Only when the whole group is zero-priced
// do zero rows compare with each other.
func dynamicPriceAgreementGroup(models []pricing.Model, entries []int) []int {
	priced := []int{}
	for _, index := range entries {
		if priceRowIsPositive(models[index]) {
			priced = append(priced, index)
		}
	}
	if len(priced) > 0 {
		return priced
	}
	return entries
}

func priceRowIsPositive(model pricing.Model) bool {
	return model.InputCostPerMillion > 0 || model.OutputCostPerMillion > 0
}

func priceRowSignature(model pricing.Model) string {
	payload := []any{
		model.InputCostPerMillion,
		model.OutputCostPerMillion,
		floatPointerValue(model.CacheReadCostPerMillion),
		floatPointerValue(model.CacheWriteCostPerMillion),
		model.Pricing,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	return string(encoded)
}

func floatPointerValue(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

var officialVendorProviderIDs = map[string]bool{
	"openai": true, "anthropic": true, "google": true, "deepseek": true,
	"moonshotai": true, "zhipuai": true, "zai": true, "xiaomi": true,
	"alibaba": true, "xai": true, "minimax": true, "nvidia": true,
	"longcat": true,
}

// pickCollapsedRepresentative prefers the official vendor row, then the
// alphabetically first provider. Rows that agree on price can disagree on
// context window, and the representative carries its own into the rule, so the
// tie-break has to be explicit: arrival order is the catalogue's ORDER BY.
func pickCollapsedRepresentative(models []pricing.Model, entries []int) int {
	candidates := make([]int, len(entries))
	copy(candidates, entries)
	sort.SliceStable(candidates, func(left, right int) bool {
		leftModel := models[candidates[left]]
		rightModel := models[candidates[right]]
		leftOfficial := officialVendorProviderIDs[strings.ToLower(strings.TrimSpace(leftModel.Provider))]
		rightOfficial := officialVendorProviderIDs[strings.ToLower(strings.TrimSpace(rightModel.Provider))]
		if leftOfficial != rightOfficial {
			return leftOfficial
		}
		leftProvider := strings.ToLower(strings.TrimSpace(leftModel.Provider))
		rightProvider := strings.ToLower(strings.TrimSpace(rightModel.Provider))
		if leftProvider != rightProvider {
			return leftProvider < rightProvider
		}
		return leftModel.ModelID < rightModel.ModelID
	})
	return candidates[0]
}

// CodexSessionFingerprintMemo memoizes fingerprint computation within a single
// collect: the same file set is fingerprinted up to three times per run, and
// each fingerprint opens the file and hashes its tail. A memo hit still
// verifies the stat identity first, so a file changed between passes
// recomputes and the stability assertion keeps its teeth. The memo lives for
// one collect only — cross-run reuse would weaken the changed-while-collecting
// detection.
type CodexSessionFingerprintMemo struct {
	entries     map[string]CodexSessionFileFingerprint
	fingerprint func(string) (CodexSessionFileFingerprint, error)
}

// CreateCodexSessionFingerprintMemo builds a memo backed by the shared
// attribution-cache fingerprint (the function the TS module imports).
func CreateCodexSessionFingerprintMemo() *CodexSessionFingerprintMemo {
	return createCodexSessionFingerprintMemoWith(codexSessionFileFingerprint)
}

func createCodexSessionFingerprintMemoWith(
	fingerprint func(string) (CodexSessionFileFingerprint, error),
) *CodexSessionFingerprintMemo {
	return &CodexSessionFingerprintMemo{entries: map[string]CodexSessionFileFingerprint{}, fingerprint: fingerprint}
}

// Get returns the file's fingerprint, recomputing when the stat identity moved.
func (m *CodexSessionFingerprintMemo) Get(filePath string) (CodexSessionFileFingerprint, error) {
	if cached, ok := m.entries[filePath]; ok {
		if current, err := os.Lstat(filePath); err == nil && sameStatIdentity(current, cached) {
			return cached, nil
		}
		// Fall through to recompute; a vanished file surfaces the same error it
		// would have without the memo.
	}
	fingerprint, err := m.fingerprint(filePath)
	if err != nil {
		return CodexSessionFileFingerprint{}, err
	}
	m.entries[filePath] = fingerprint
	return fingerprint, nil
}

// sameStatIdentity mirrors the TS memo's check: the current lstat must still
// describe the fingerprinted revision.
func sameStatIdentity(current os.FileInfo, fingerprint CodexSessionFileFingerprint) bool {
	stat := codexStatOf(current)
	return float64(stat.size) == fingerprint.Size &&
		stat.mtimeMs == fingerprint.MtimeMs &&
		stat.ctimeMs == fingerprint.CtimeMs &&
		stat.ino == fingerprint.Ino
}

// codexSessionFileFingerprint is a package variable so the memoization tests
// can count real computations the way the TS suite spies on the module export.
var codexSessionFileFingerprint = func(filePath string) (CodexSessionFileFingerprint, error) {
	return FingerprintCodexSessionFile(filePath)
}

// fingerprintForDiscovery prefers the memo, falling back to the package
// fingerprint function (which tests may replace).
func fingerprintForDiscovery(filePath string, memo *CodexSessionFingerprintMemo) (CodexSessionFileFingerprint, error) {
	if memo != nil {
		return memo.Get(filePath)
	}
	return codexSessionFileFingerprint(filePath)
}

// contextPricingReadLimits mirrors codexChildSessionReadLimits with this
// module's label.
func contextPricingReadLimits() JSONLReadLimits {
	maxBytes := int64(4 * 1024 * 1024 * 1024)
	maxLineBytes := int64(1024 * 1024)
	maxDiscarded := int64(64 * 1024 * 1024)
	return JSONLReadLimits{
		MaxBytes:              &maxBytes,
		MaxLineBytes:          &maxLineBytes,
		MaxDiscardedLineBytes: &maxDiscarded,
		RelevantMetadataKeys:  []string{"total_token_usage", "last_token_usage", "subagent"},
		CodexUsageOnly:        true,
		DiscardableLineTypes:  []string{"compacted", "event_msg", "response_item", "turn_context"},
		Label:                 "Codex context pricing",
	}
}

func cpHasOwn(record UnknownRecord, key string) bool {
	if record == nil {
		return false
	}
	_, ok := record[key]
	return ok
}

// cpNullish mirrors JS nullish coalescing over a record field.
func cpNullish(record UnknownRecord, key string, fallback any) any {
	if record != nil {
		if value, ok := record[key]; ok && value != nil {
			return value
		}
	}
	return fallback
}

// formatJSNumber renders a token count the way a JS template literal would.
// Every component reaching this key is a validated safe integer, so the
// shortest decimal form matches JS's Number#toString.
func formatJSNumber(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

// errorText mirrors the walker's helper: the underlying error without the
// path prefix Node's messages would not include twice.
func errorText(err error) string {
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		return pathErr.Err.Error()
	}
	return err.Error()
}

func emitStderr(stderr func(string), line string) {
	if stderr != nil {
		stderr(line)
	}
}

func float64Pointer(value float64) *float64 {
	return &value
}

// orderedCosts accumulates raw costs by key, keeping insertion order so the
// result matches the TS Map iteration order.
type orderedCosts struct {
	values map[string]float64
	order  []string
}

func newOrderedCosts() *orderedCosts {
	return &orderedCosts{values: map[string]float64{}}
}

func (o *orderedCosts) add(key string, cost CodexContextPricingCost) {
	current, ok := o.values[key]
	if ok {
		o.values[key] = current + cost.CostUSD
		return
	}
	o.order = append(o.order, key)
	o.values[key] = cost.CostUSD
}

// costTotals accumulates priced (date, model) costs, keeping insertion order.
type costTotals struct {
	values map[string]*CodexContextPricingCost
	order  []string
}

func newCostTotals() *costTotals {
	return &costTotals{values: map[string]*CodexContextPricingCost{}}
}

func (o *costTotals) add(key string, cost CodexContextPricingCost) {
	current, ok := o.values[key]
	if ok {
		current.CostUSD += cost.CostUSD
		return
	}
	entry := cost
	o.order = append(o.order, key)
	o.values[key] = &entry
}

func (o *costTotals) list() []CodexContextPricingCost {
	out := make([]CodexContextPricingCost, 0, len(o.order))
	for _, key := range o.order {
		out = append(out, *o.values[key])
	}
	return out
}

// orderedUsages accumulates usages by key in insertion order.
type orderedUsages struct {
	values map[string]*CodexContextPricingUsage
	order  []string
}

func newOrderedUsages() *orderedUsages {
	return &orderedUsages{values: map[string]*CodexContextPricingUsage{}}
}

func (o *orderedUsages) set(key string, usage *CodexContextPricingUsage) {
	if _, ok := o.values[key]; !ok {
		o.order = append(o.order, key)
	}
	o.values[key] = usage
}

func (o *orderedUsages) list() []CodexContextPricingUsage {
	out := make([]CodexContextPricingUsage, 0, len(o.order))
	for _, key := range o.order {
		out = append(out, *o.values[key])
	}
	return out
}

// orderedKeySet is an insertion-ordered set with removal, the TS Set shape.
type orderedKeySet struct {
	present map[string]bool
	entries []string
}

func newOrderedKeySet() *orderedKeySet {
	return &orderedKeySet{present: map[string]bool{}}
}

func (s *orderedKeySet) add(key string) {
	if s.present[key] {
		return
	}
	s.present[key] = true
	s.entries = append(s.entries, key)
}

func (s *orderedKeySet) remove(key string) {
	delete(s.present, key)
}

func (s *orderedKeySet) order() []string {
	out := make([]string, 0, len(s.present))
	for _, key := range s.entries {
		if s.present[key] {
			out = append(out, key)
		}
	}
	return out
}

// orderedIndexes maps a key to an ordered index list.
type orderedIndexes struct {
	values map[string][]int
	order  []string
}

func newOrderedIndexes() *orderedIndexes {
	return &orderedIndexes{values: map[string][]int{}}
}

func (o *orderedIndexes) append(key string, index int) {
	if _, ok := o.values[key]; !ok {
		o.order = append(o.order, key)
	}
	o.values[key] = append(o.values[key], index)
}
