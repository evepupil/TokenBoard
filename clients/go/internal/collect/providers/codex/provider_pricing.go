package codex

import (
	"errors"
	"fmt"
	"math"
	"strconv"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Port of the context-pricing reconciliation half of codex.ts: the raw usage
// merge, the mixed-model split, and the final cost pass. These run after the
// scoped/bounded/hook collection has produced daily snapshots.

// contextPricingReconciliationMessages are the three mixed-model failures. They
// double as the prefixes the retry matches on (isCodexContextPricingReconciliationChange),
// so a throw site must build its message from the same constant the retry reads.
const (
	cannotSplitMixedModelUsage              = "Codex context pricing cannot split mixed-model usage for "
	mixedModelUsageHasNoPositiveTokenTotal  = "Codex context pricing mixed-model usage has no positive token total for "
	mixedModelCostExceedsContextPricedDaily = "Codex context pricing mixed-model cost exceeds context-priced daily usage for "
)

var contextPricingReconciliationPrefixes = []string{
	cannotSplitMixedModelUsage,
	mixedModelUsageHasNoPositiveTokenTotal,
	mixedModelCostExceedsContextPricedDaily,
}

// canonicalAttributionChangeMessages are the canonical-attribution races the
// bounded path retries once.
var canonicalAttributionChangeMessages = map[string]bool{
	"Codex session changed during scoped collection; retry the sync":                       true,
	"Canonical Codex session attribution is missing a bounded session row; retry the sync": true,
	"Codex child session changed while correcting; retry the sync":                         true,
}

// childSessionChangeMessages are the child-session races the hook path retries.
var childSessionChangeMessages = map[string]bool{
	"Codex child session changed before reading; retry the sync":       true,
	"Codex child session changed while reading; retry the sync":        true,
	"Codex child session changed while correcting; retry the sync":     true,
	"Codex child session changed while fingerprinting; retry the sync": true,
}

// mergeContextPricingUsages ports mergeContextPricingUsages: one entry per
// (date, model, attributed model, service tier, context tier).
func (r *Rules) MergeContextPricingUsages(usages []CodexContextPricingUsage) []CodexContextPricingUsage {
	merged := map[string]*CodexContextPricingUsage{}
	order := []string{}
	for _, usage := range usages {
		model := r.NormalizeModelID(usage.Model)
		attributed := ""
		if usage.AttributedModel != nil {
			attributed = r.NormalizeModelID(*usage.AttributedModel)
		}
		serviceTier := string(usage.ServiceTier)
		if serviceTier == "" {
			serviceTier = "standard"
		}
		key := usage.UsageDate + "\x00" + model + "\x00" + attributed + "\x00" + serviceTier + "\x00" + usage.ContextTier
		current, ok := merged[key]
		if !ok {
			copied := usage
			copied.Model = model
			merged[key] = &copied
			order = append(order, key)
			continue
		}
		current.InputTokens += usage.InputTokens
		current.UncachedInputTokens += usage.UncachedInputTokens
		current.OutputTokens += usage.OutputTokens
		current.CacheReadTokens += usage.CacheReadTokens
		current.CacheCreationTokens += usage.CacheCreationTokens
		if current.TotalTokens == nil || usage.TotalTokens == nil {
			current.TotalTokens = nil
		} else {
			total := *current.TotalTokens + *usage.TotalTokens
			current.TotalTokens = &total
		}
	}
	out := make([]CodexContextPricingUsage, 0, len(order))
	for _, key := range order {
		out = append(out, *merged[key])
	}
	return out
}

// formatCostAmount ports formatCostAmount: four significant digits, so a
// sub-cent share stays readable instead of printing as 0.000000.
func formatCostAmount(value float64) string {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return formatJSNumber(value)
	}
	if value == 0 {
		return "0"
	}
	text := strconv.FormatFloat(value, 'g', 4, 64)
	parsed, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return text
	}
	return formatJSNumber(parsed)
}

// mixedUsage is one attributed model's share of a mixed-model context row.
type mixedUsage struct {
	InputTokens         float64
	OutputTokens        float64
	CacheCreationTokens float64
	CacheReadTokens     float64
	TotalTokens         float64
	CostUSD             float64
}

// mixedContextEntry is one context-priced (date, model) row being rebuilt from
// the attributed usages.
type mixedContextEntry struct {
	snapshot         contract.Snapshot
	attributedUsages map[string]*mixedUsage
	attributedOrder  []string
}

func addMixedContextUsage(usages map[string]*mixedUsage, order *[]string, attributedModel string, usage mixedUsage) {
	current, ok := usages[attributedModel]
	if !ok {
		copied := usage
		usages[attributedModel] = &copied
		*order = append(*order, attributedModel)
		return
	}
	current.InputTokens += usage.InputTokens
	current.OutputTokens += usage.OutputTokens
	current.CacheCreationTokens += usage.CacheCreationTokens
	current.CacheReadTokens += usage.CacheReadTokens
	current.TotalTokens += usage.TotalTokens
	current.CostUSD += usage.CostUSD
}

// splitMixedCodexContextPricingSnapshots ports
// splitMixedCodexContextPricingSnapshots: a session file whose turns ran on a
// non-context model and a context-priced model is attributed by ccusage to the
// non-context one, so the context row is rebuilt from the raw usage and the
// attributed share is moved out of the canonical row.
func (r *Rules) SplitMixedContextPricingSnapshots(
	snapshots []contract.Snapshot,
	usages []CodexContextPricingUsage,
	costs []CodexContextPricingCost,
	stderr func(string),
	timezone, collectedAt string,
) ([]contract.Snapshot, error) {
	contextEntries := map[string]*mixedContextEntry{}
	order := []string{}
	for _, usage := range usages {
		if usage.AttributedModel == nil || *usage.AttributedModel == "" {
			continue
		}
		model := r.NormalizeModelID(usage.Model)
		attributed := r.NormalizeModelID(*usage.AttributedModel)
		key := usage.UsageDate + "\x00" + model
		// The raw usage keeps Codex's legacy shape, where cached input is
		// folded into the input count. The canonical row ccusage produces is
		// additive, so both sides are compared in the additive shape and the
		// total is rebuilt from it.
		inputTokens := usage.UncachedInputTokens
		outputTokens := usage.OutputTokens
		cacheCreationTokens := usage.CacheCreationTokens
		cacheReadTokens := usage.CacheReadTokens
		totalTokens := inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens
		usageCost := 0.0
		if priced := r.PriceCodexContextPricingUsages([]CodexContextPricingUsage{usage}); len(priced) > 0 {
			usageCost = priced[0].CostUSD
		}
		current, ok := contextEntries[key]
		if ok {
			current.snapshot.InputTokens += int64(inputTokens)
			current.snapshot.OutputTokens += int64(outputTokens)
			current.snapshot.CacheCreation += int64(cacheCreationTokens)
			current.snapshot.CacheRead += int64(cacheReadTokens)
			current.snapshot.TotalTokens += int64(totalTokens)
			addMixedContextUsage(current.attributedUsages, &current.attributedOrder, attributed, mixedUsage{
				InputTokens: inputTokens, OutputTokens: outputTokens, CacheCreationTokens: cacheCreationTokens,
				CacheReadTokens: cacheReadTokens, TotalTokens: totalTokens, CostUSD: usageCost,
			})
			continue
		}
		attributedUsages := map[string]*mixedUsage{}
		attributedOrder := []string{}
		addMixedContextUsage(attributedUsages, &attributedOrder, attributed, mixedUsage{
			InputTokens: inputTokens, OutputTokens: outputTokens, CacheCreationTokens: cacheCreationTokens,
			CacheReadTokens: cacheReadTokens, TotalTokens: totalTokens, CostUSD: usageCost,
		})
		contextEntries[key] = &mixedContextEntry{
			attributedUsages: attributedUsages,
			attributedOrder:  attributedOrder,
			snapshot: contract.Snapshot{
				Source:        contract.SourceCodex,
				UsageDate:     usage.UsageDate,
				Timezone:      timezone,
				Model:         model,
				InputTokens:   int64(inputTokens),
				OutputTokens:  int64(outputTokens),
				CacheCreation: int64(cacheCreationTokens),
				CacheRead:     int64(cacheReadTokens),
				TotalTokens:   int64(totalTokens),
				CostUSD:       0,
				SessionCount:  0,
				CollectedAt:   collectedAt,
			},
		}
		order = append(order, key)
	}
	if len(contextEntries) == 0 {
		return snapshots, nil
	}

	result := make([]contract.Snapshot, len(snapshots))
	copy(result, snapshots)
	costsByKey := map[string]float64{}
	for _, cost := range costs {
		costsByKey[cost.UsageDate+"\x00"+r.NormalizeModelID(cost.Model)] = cost.CostUSD
	}
	// Every lookup below is by usageDate + normalized model, so index the
	// snapshots once: a mixed day has one entry per model and a linear scan
	// would make this quadratic on the hottest path.
	// Indexes, not pointers: appending a rebuilt context row can reallocate
	// the slice, and a pointer taken before the append would then point into
	// the discarded backing array.
	snapshotByIndex := map[string]int{}
	for index := range result {
		key := result[index].UsageDate + "\x00" + r.NormalizeModelID(result[index].Model)
		if _, ok := snapshotByIndex[key]; !ok {
			snapshotByIndex[key] = index
		}
	}
	canonicalContextIndexes := map[string]int{}

	for _, key := range order {
		entry := contextEntries[key]
		contextSnapshot := &entry.snapshot
		existingKey := contextSnapshot.UsageDate + "\x00" + r.NormalizeModelID(contextSnapshot.Model)
		existingIndex, hasExisting := snapshotByIndex[existingKey]
		if hasExisting {
			existing := &result[existingIndex]
			// A same-day context row may already exist for sessions ccusage
			// attributed directly to the context-priced model; the mixed
			// sessions still move into it before its cost is rewritten.
			existing.InputTokens += contextSnapshot.InputTokens
			existing.OutputTokens += contextSnapshot.OutputTokens
			existing.CacheCreation += contextSnapshot.CacheCreation
			existing.CacheRead += contextSnapshot.CacheRead
			existing.TotalTokens += contextSnapshot.TotalTokens
		}
		type canonicalShare struct {
			canonical      *contract.Snapshot
			canonicalIndex int
			usage          mixedUsage
		}
		shares := make([]canonicalShare, 0, len(entry.attributedOrder))
		totalAttributedTokens := 0.0
		totalMixedCost := 0.0
		for _, attributedModel := range entry.attributedOrder {
			attributedUsage := entry.attributedUsages[attributedModel]
			canonicalIndex, ok := snapshotByIndex[contextSnapshot.UsageDate+"\x00"+attributedModel]
			if !ok {
				message := cannotSplitMixedModelUsage + contextSnapshot.UsageDate + "/" + contextSnapshot.Model
				emitStderr(stderr, message)
				return nil, errors.New(message)
			}
			canonical := &result[canonicalIndex]
			// The attributed usage is normally a subset of the canonical row,
			// but the two are derived independently, so a field can come out
			// larger. Clipping each token field to what the row holds keeps the
			// day moving instead of failing the whole source; the context row
			// keeps the full attributed amount.
			clipped := mixedUsage{
				InputTokens:         math.Min(attributedUsage.InputTokens, float64(canonical.InputTokens)),
				OutputTokens:        math.Min(attributedUsage.OutputTokens, float64(canonical.OutputTokens)),
				CacheCreationTokens: math.Min(attributedUsage.CacheCreationTokens, float64(canonical.CacheCreation)),
				CacheReadTokens:     math.Min(attributedUsage.CacheReadTokens, float64(canonical.CacheRead)),
				TotalTokens:         math.Min(attributedUsage.TotalTokens, float64(canonical.TotalTokens)),
				CostUSD:             attributedUsage.CostUSD,
			}
			clippedFields := []string{}
			appendClip := func(field string, attributed, canonicalValue float64) {
				if attributed > canonicalValue {
					clippedFields = append(clippedFields,
						fmt.Sprintf("%s %s > %s", field, formatJSNumber(attributed), formatJSNumber(canonicalValue)))
				}
			}
			appendClip("inputTokens", attributedUsage.InputTokens, float64(canonical.InputTokens))
			appendClip("outputTokens", attributedUsage.OutputTokens, float64(canonical.OutputTokens))
			appendClip("cacheCreationTokens", attributedUsage.CacheCreationTokens, float64(canonical.CacheCreation))
			appendClip("cacheReadTokens", attributedUsage.CacheReadTokens, float64(canonical.CacheRead))
			appendClip("totalTokens", attributedUsage.TotalTokens, float64(canonical.TotalTokens))
			if len(clippedFields) > 0 {
				// A warning, not a reconciliation change: the row keeps moving
				// with the amounts it holds.
				emitStderr(stderr, fmt.Sprintf(
					"Codex context pricing clipped mixed-model usage for %s/%s to the canonical daily row: %s",
					contextSnapshot.UsageDate, attributedModel, joinStrings(clippedFields, ", ")))
			}
			shares = append(shares, canonicalShare{canonical: canonical, canonicalIndex: canonicalIndex, usage: clipped})
			totalAttributedTokens += clipped.TotalTokens
			totalMixedCost += clipped.CostUSD
		}
		contextCost := costsByKey[contextSnapshot.UsageDate+"\x00"+r.NormalizeModelID(contextSnapshot.Model)]
		if !isSafeNonNegativeInteger(totalAttributedTokens) || totalAttributedTokens <= 0 {
			message := mixedModelUsageHasNoPositiveTokenTotal + contextSnapshot.UsageDate
			emitStderr(stderr, message)
			return nil, errors.New(message)
		}
		if math.IsNaN(totalMixedCost) || math.IsInf(totalMixedCost, 0) || totalMixedCost < 0 ||
			totalMixedCost > contextCost+1e-12 {
			message := mixedModelCostExceedsContextPricedDaily + contextSnapshot.UsageDate
			emitStderr(stderr, message)
			return nil, errors.New(message)
		}
		for _, share := range shares {
			amount := share.usage.CostUSD
			// The move conserves the day's cost only while the context model is
			// not the dearer of the two. When it is, the row is floored at zero
			// and the excess stays in the day, reported rather than swallowed.
			if math.IsNaN(amount) || math.IsInf(amount, 0) || amount < 0 {
				message := "Codex context pricing mixed-model cost is invalid for " + contextSnapshot.UsageDate
				emitStderr(stderr, message)
				return nil, errors.New(message)
			}
			canonicalCostBefore := share.canonical.CostUSD
			share.canonical.InputTokens -= int64(share.usage.InputTokens)
			share.canonical.OutputTokens -= int64(share.usage.OutputTokens)
			share.canonical.CacheCreation -= int64(share.usage.CacheCreationTokens)
			share.canonical.CacheRead -= int64(share.usage.CacheReadTokens)
			share.canonical.TotalTokens -= int64(share.usage.TotalTokens)
			// Clipping each field independently can leave more cache reads than
			// total tokens behind; `cacheRead <= total` is a shared ingest
			// invariant, so restore it here.
			if share.canonical.CacheRead > share.canonical.TotalTokens {
				share.canonical.CacheRead = share.canonical.TotalTokens
			}
			if amount > canonicalCostBefore+1e-12 {
				emitStderr(stderr, fmt.Sprintf(
					"Codex context pricing floored %s cost to 0 for %s: this row's attributed context-priced share (%s) exceeded its canonical total (%s); %s of this row's share could not be deducted",
					share.canonical.Model, contextSnapshot.UsageDate, formatCostAmount(amount),
					formatCostAmount(canonicalCostBefore), formatCostAmount(amount-canonicalCostBefore)))
			}
			share.canonical.CostUSD = math.Max(0, canonicalCostBefore-amount)
			canonicalContextIndexes[share.canonical.UsageDate+"\x00"+share.canonical.Model] = share.canonicalIndex
		}
		if hasExisting {
			result[existingIndex].CostUSD = contextCost
		} else {
			contextSnapshot.CostUSD = contextCost
			result = append(result, *contextSnapshot)
			// Keep the index in step with the list, so a later entry whose
			// attributed model is this context model still finds the row.
			if _, ok := snapshotByIndex[existingKey]; !ok {
				snapshotByIndex[existingKey] = len(result) - 1
			}
		}
	}

	for _, index := range canonicalContextIndexes {
		canonical := &result[index]
		if canonical.InputTokens != 0 || canonical.OutputTokens != 0 || canonical.CacheCreation != 0 ||
			canonical.CacheRead != 0 || canonical.TotalTokens != 0 {
			continue
		}
		canonical.Correction = contract.CorrectionCodexContextPricing
	}
	return result, nil
}

// applyCollectedCodexContextPricing ports applyCollectedCodexContextPricing:
// rewrite the model hints, price the raw usages, split the mixed-model days,
// then write the costs back.
func applyCollectedCodexContextPricing(input struct {
	Snapshots   []contract.Snapshot
	Usages      []CodexContextPricingUsage
	Stderr      func(string)
	Timezone    string
	CollectedAt string
	Rules       *Rules
}) ([]contract.Snapshot, error) {
	rules := input.Rules
	if rules == nil {
		rules = DefaultRules()
	}
	mappedUsages := rules.ApplyCodexContextPricingUsageModelHints(
		input.Usages, rules.ContextPricingModelHints(input.Snapshots))
	costs := rules.PriceCodexContextPricingUsages(mappedUsages)
	split, err := rules.SplitMixedContextPricingSnapshots(
		input.Snapshots, mappedUsages, costs, input.Stderr, input.Timezone, input.CollectedAt)
	if err != nil {
		return nil, err
	}
	costSnapshots := make([]CostSnapshot, len(split))
	for index, snapshot := range split {
		costSnapshots[index] = CostSnapshotFromContract(snapshot)
	}
	priced, err := rules.ApplyCodexContextPricingCosts(costSnapshots, costs, input.Stderr)
	if err != nil {
		return nil, err
	}
	out := make([]contract.Snapshot, len(split))
	for index := range split {
		out[index] = priced[index].ApplyToContract(split[index])
	}
	return out, nil
}

// ContextPricingModelHints ports codexContextPricingModelHints.
func (r *Rules) ContextPricingModelHints(snapshots []contract.Snapshot) CodexContextPricingModelHints {
	hints := CodexContextPricingModelHints{}
	for _, snapshot := range snapshots {
		if snapshot.TotalTokens <= 0 || !r.IsCodexContextPricingModel(snapshot.Model) {
			continue
		}
		models, ok := hints[snapshot.UsageDate]
		if !ok {
			models = map[string]bool{}
			hints[snapshot.UsageDate] = models
		}
		models[r.NormalizeModelID(snapshot.Model)] = true
	}
	return hints
}

// reportUnrecoverablePendingCodexPricing ports
// reportUnrecoverablePendingCodexPricing.
func (r *Rules) ReportUnrecoverablePendingCodexPricing(snapshots []contract.Snapshot, stderr func(string)) {
	if len(snapshots) == 0 {
		return
	}
	details := make([]string, 0, len(snapshots))
	for _, snapshot := range snapshots {
		details = append(details, snapshot.UsageDate+"/"+r.NormalizeModelID(snapshot.Model))
	}
	emitStderr(stderr, "Codex context pricing is unavailable for pending snapshots without source session files; keeping them pending: "+
		joinStrings(details, ", "))
}

// reportUnpricedCodexSnapshots ports reportUnpricedCodexSnapshots.
//
// Only a snapshot with real usage and a zero cost is worth a line: ccusage prices
// models from its own builtin catalogue, so a model missing from the TokenBoard
// override set still arrives with a real cost. The TS side was fixed first
// (bcd4004) and this port missed the filter.
func reportUnpricedCodexSnapshots(snapshots []contract.Snapshot, covered map[string]bool, stderr func(string)) {
	seen := map[string]bool{}
	order := []string{}
	for _, snapshot := range snapshots {
		if snapshot.Source != contract.SourceCodex || snapshot.TotalTokens <= 0 {
			continue
		}
		if snapshot.CostUSD > 0 {
			continue
		}
		if covered[snapshot.Model] || seen[snapshot.Model] {
			continue
		}
		seen[snapshot.Model] = true
		order = append(order, snapshot.Model)
	}
	for _, model := range order {
		emitStderr(stderr, "TokenBoard model pricing unavailable for Codex model "+model+"; preserving collected result")
	}
}

// isCodexContextPricingReconciliationChange ports the retry predicate for the
// three mixed-model failures.
func isCodexContextPricingReconciliationChange(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	for _, prefix := range contextPricingReconciliationPrefixes {
		if hasPrefix(message, prefix) {
			return true
		}
	}
	return false
}

// isChildSessionChange ports isChildSessionChange.
func isChildSessionChange(err error) bool {
	if err == nil {
		return false
	}
	return childSessionChangeMessages[err.Error()]
}

// isCanonicalAttributionChange ports isCanonicalAttributionChange.
func isCanonicalAttributionChange(err error) bool {
	if err == nil {
		return false
	}
	return canonicalAttributionChangeMessages[err.Error()] || isCodexContextPricingReconciliationChange(err)
}

// isUnboundedCodexCollectionChange ports isUnboundedCodexCollectionChange.
func isUnboundedCodexCollectionChange(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return message == "Codex session inventory changed during unbounded collection; retry the sync" ||
		hasPrefix(message, "Codex session changed while fingerprinting;") ||
		isChildSessionChange(err) ||
		isCodexContextPricingReconciliationChange(err)
}

// isCodexReconciliationChange ports isCodexReconciliationChange.
func isCodexReconciliationChange(err error) bool {
	return isUnboundedCodexCollectionChange(err) || isCanonicalAttributionChange(err)
}

// codexSnapshotGroupKey is the grouping MergeSnapshots uses, so "already
// covered" means the same thing on both sides of the merge.
func codexSnapshotGroupKey(snapshot contract.Snapshot) string {
	return snapshot.AckGroupKey()
}

// codexSnapshotIdentity is the snapshot identity the reusable-pending filter
// compares, mirroring the TS JSON.stringify array.
func codexSnapshotIdentity(snapshot contract.Snapshot) string {
	return fmt.Sprintf("%s\x00%s\x00%s\x00%s\x00%d\x00%d\x00%d\x00%d\x00%d\x00%v\x00%d\x00%s",
		snapshot.Source, snapshot.UsageDate, snapshot.Timezone, snapshot.Model,
		snapshot.InputTokens, snapshot.OutputTokens, snapshot.CacheCreation, snapshot.CacheRead,
		snapshot.TotalTokens, snapshot.CostUSD, snapshot.SessionCount, snapshot.Correction)
}

func hasPrefix(value, prefix string) bool {
	return len(value) >= len(prefix) && value[:len(prefix)] == prefix
}

func joinStrings(values []string, separator string) string {
	out := ""
	for index, value := range values {
		if index > 0 {
			out += separator
		}
		out += value
	}
	return out
}
