package codex

import (
	"math"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Port of the context-pricing reconciliation cases in codex.test.ts, driven at
// the layer that owns the semantics: the daily snapshots ccusage produced plus
// the raw usage the session files carry.

func dailySnapshot(date, model string, input, output, cacheCreation, cacheRead, total int64, cost float64) contract.Snapshot {
	return contract.Snapshot{
		Source:        contract.SourceCodex,
		UsageDate:     date,
		Timezone:      "UTC",
		Model:         model,
		InputTokens:   input,
		OutputTokens:  output,
		CacheCreation: cacheCreation,
		CacheRead:     cacheRead,
		TotalTokens:   total,
		CostUSD:       cost,
		SessionCount:  1,
		CollectedAt:   "2026-05-20T01:00:00.000Z",
	}
}

func usageOf(date, model string, attributed string, uncachedInput, output, cacheCreation, cacheRead, total float64) CodexContextPricingUsage {
	usage := CodexContextPricingUsage{
		UsageDate:           date,
		Model:               model,
		UncachedInputTokens: uncachedInput,
		// The legacy shape folds cached input into the input count; the split
		// compares the additive field, so both are set the way the parser sets
		// them.
		InputTokens:         uncachedInput + cacheRead,
		OutputTokens:        output,
		CacheCreationTokens: cacheCreation,
		CacheReadTokens:     cacheRead,
		TotalTokens:         &total,
		ServiceTier:         ServiceTierStandard,
		ContextTier:         contextTierStandard,
	}
	if attributed != "" {
		value := attributed
		usage.AttributedModel = &value
	}
	return usage
}

func applyPricing(t *testing.T, snapshots []contract.Snapshot, usages []CodexContextPricingUsage) ([]contract.Snapshot, []string) {
	t.Helper()
	lines := []string{}
	result, err := applyCollectedCodexContextPricing(struct {
		Snapshots   []contract.Snapshot
		Usages      []CodexContextPricingUsage
		Stderr      func(string)
		Timezone    string
		CollectedAt string
		Rules       *Rules
	}{
		Snapshots:   snapshots,
		Usages:      usages,
		Stderr:      func(line string) { lines = append(lines, line) },
		Timezone:    "UTC",
		CollectedAt: "2026-05-20T01:00:00.000Z",
		Rules:       DefaultRules(),
	})
	if err != nil {
		t.Fatalf("apply: %v (stderr %v)", err, lines)
	}
	return result, lines
}

func findSnapshot(t *testing.T, snapshots []contract.Snapshot, model string) contract.Snapshot {
	t.Helper()
	for _, snapshot := range snapshots {
		if snapshot.Model == model {
			return snapshot
		}
	}
	t.Fatalf("no snapshot for %s in %+v", model, snapshots)
	return contract.Snapshot{}
}

// The canonical row was attributed the whole session, but part of it ran on a
// context-priced model: those tokens and their share of the cost move to the
// context row.
func TestSplitsMixedModelContextUsageFromANonContextDailyAttribution(t *testing.T) {
	snapshots := []contract.Snapshot{
		dailySnapshot("2026-05-20", "deepseek-v4-flash", 30, 0, 0, 0, 30, 0.001),
	}
	usages := []CodexContextPricingUsage{
		usageOf("2026-05-20", "deepseek-v4-flash", "deepseek-v4-flash", 10, 0, 0, 0, 10),
		usageOf("2026-05-20", "gpt-5.6-sol", "deepseek-v4-flash", 20, 0, 0, 0, 20),
	}
	result, lines := applyPricing(t, snapshots, usages)
	if len(result) != 2 {
		t.Fatalf("result = %+v", result)
	}
	canonical := findSnapshot(t, result, "deepseek-v4-flash")
	if canonical.TotalTokens != 10 {
		t.Errorf("canonical total = %d, want 10", canonical.TotalTokens)
	}
	wantCost := 0.001 - 20*4.0/1_000_000
	if math.Abs(canonical.CostUSD-wantCost) > 1e-12 {
		t.Errorf("canonical cost = %v, want %v", canonical.CostUSD, wantCost)
	}
	context := findSnapshot(t, result, "gpt-5.6-sol")
	if context.TotalTokens != 20 {
		t.Errorf("context total = %d, want 20", context.TotalTokens)
	}
	if math.Abs(context.CostUSD-20*4.0/1_000_000) > 1e-12 {
		t.Errorf("context cost = %v", context.CostUSD)
	}
	if context.SessionCount != 0 {
		t.Errorf("the rebuilt context row counts no sessions: %d", context.SessionCount)
	}
	for _, line := range lines {
		if strings.Contains(line, "floored") {
			t.Errorf("unexpected floor: %s", line)
		}
	}
}

// A legacy record folds cached input into the input count while ccusage
// reports the additive form. Comparing the raw input against the canonical
// input would report an overflow for a consistent day; the split compares the
// uncached field and rebuilds the total additively.
func TestComparesMixedModelInputAgainstTheCanonicalUncachedRepresentation(t *testing.T) {
	snapshots := []contract.Snapshot{
		// ccusage's additive form: 100 uncached + 400 cached = 500 total.
		dailySnapshot("2026-05-20", "deepseek-v4-flash", 100, 0, 0, 400, 500, 0.001),
	}
	usages := []CodexContextPricingUsage{
		// Legacy shape: input 500 already includes the 400 cached.
		usageOf("2026-05-20", "deepseek-v4-flash", "deepseek-v4-flash", 100, 0, 0, 400, 500),
		usageOf("2026-05-20", "gpt-5.6-sol", "deepseek-v4-flash", 100, 0, 0, 100, 200),
	}
	result, lines := applyPricing(t, snapshots, usages)
	canonical := findSnapshot(t, result, "deepseek-v4-flash")
	if canonical.TotalTokens != 300 || canonical.InputTokens != 0 || canonical.CacheRead != 300 {
		t.Errorf("canonical = %+v", canonical)
	}
	if math.Abs(canonical.CostUSD-0.00056) > 1e-12 {
		t.Errorf("canonical cost = %v, want 0.00045", canonical.CostUSD)
	}
	context := findSnapshot(t, result, "gpt-5.6-sol")
	if context.TotalTokens != 200 || context.InputTokens != 100 || context.CacheRead != 100 {
		t.Errorf("context = %+v", context)
	}
	if math.Abs(context.CostUSD-0.00044) > 1e-12 {
		t.Errorf("context cost = %v, want 0.00055", context.CostUSD)
	}
	for _, line := range lines {
		if strings.Contains(line, "floored") {
			t.Errorf("unexpected floor: %s", line)
		}
	}
}

// The two sides are priced with different rates, so a subset of tokens can
// cost more than the whole row did. The row floors at zero and the excess is
// reported with its figures rather than silently absorbed.
func TestReconcilesWhenTheContextModelIsDearerThanTheCanonicalModel(t *testing.T) {
	snapshots := []contract.Snapshot{
		dailySnapshot("2026-05-20", "deepseek-v4-flash", 30, 0, 0, 0, 30, 0.00001),
	}
	usages := []CodexContextPricingUsage{
		usageOf("2026-05-20", "deepseek-v4-flash", "deepseek-v4-flash", 30, 0, 0, 0, 30),
		usageOf("2026-05-20", "gpt-5.6-sol", "deepseek-v4-flash", 20, 0, 0, 0, 20),
	}
	result, lines := applyPricing(t, snapshots, usages)
	canonical := findSnapshot(t, result, "deepseek-v4-flash")
	if canonical.TotalTokens != 10 || canonical.CostUSD != 0 {
		t.Errorf("canonical = %+v", canonical)
	}
	context := findSnapshot(t, result, "gpt-5.6-sol")
	if math.Abs(context.CostUSD-0.00008) > 1e-12 {
		t.Errorf("context cost = %v, want 0.0001", context.CostUSD)
	}
	want := "Codex context pricing floored deepseek-v4-flash cost to 0 for 2026-05-20: " +
		"this row's attributed context-priced share (0.00008) exceeded its canonical total (0.00001); " +
		"0.00007 of this row's share could not be deducted"
	found := false
	for _, line := range lines {
		if line == want {
			found = true
		}
	}
	if !found {
		t.Errorf("missing floor message; got %v", lines)
	}
}

// The attributed and canonical rows are derived independently, so a field can
// exceed the row without either side being corrupt. The split clips to what
// the row holds and reports the clip instead of failing the source.
func TestClipsMixedModelUsageThatExceedsTheCanonicalRow(t *testing.T) {
	snapshots := []contract.Snapshot{
		dailySnapshot("2026-05-20", "deepseek-v4-flash", 30, 0, 0, 0, 30, 0.001),
	}
	// Additive shape: 50 uncached + 20 cached = 70 total, larger than the row's 30.
	usages := []CodexContextPricingUsage{
		usageOf("2026-05-20", "deepseek-v4-flash", "deepseek-v4-flash", 30, 0, 0, 0, 30),
		usageOf("2026-05-20", "gpt-5.6-sol", "deepseek-v4-flash", 50, 0, 0, 20, 70),
	}
	result, lines := applyPricing(t, snapshots, usages)
	canonical := findSnapshot(t, result, "deepseek-v4-flash")
	if canonical.InputTokens < 0 || canonical.CacheRead < 0 || canonical.TotalTokens < 0 {
		t.Errorf("the canonical row went negative: %+v", canonical)
	}
	if canonical.CacheRead > canonical.TotalTokens {
		t.Errorf("cache reads exceed the total: %+v", canonical)
	}
	found := false
	for _, line := range lines {
		if strings.HasPrefix(line, "Codex context pricing clipped mixed-model usage for 2026-05-20/deepseek-v4-flash") {
			found = true
		}
	}
	if !found {
		t.Errorf("missing clip message; got %v", lines)
	}
	context := findSnapshot(t, result, "gpt-5.6-sol")
	if context.TotalTokens != 70 {
		t.Errorf("the context row keeps the full attributed amount: %+v", context)
	}
}

// Clipping each field independently can leave more cache reads than total
// tokens behind; the split restores the ingest invariant instead of emitting a
// snapshot the server rejects.
func TestNeverLeavesCacheReadsAboveTotalWhenTheRowsDisagreeAboutWhatIsCached(t *testing.T) {
	snapshots := []contract.Snapshot{
		// Canonical row: 0 input, 10 cache read, 10 total.
		dailySnapshot("2026-05-20", "deepseek-v4-flash", 0, 0, 0, 10, 10, 0.001),
	}
	// Attributed: 0 input, 5 cache read, 5 total — leaving 5 cache read and 5
	// total after the move; then a second share removes the total but leaves
	// reads.
	usages := []CodexContextPricingUsage{
		usageOf("2026-05-20", "deepseek-v4-flash", "deepseek-v4-flash", 0, 0, 0, 10, 10),
		usageOf("2026-05-20", "gpt-5.6-sol", "deepseek-v4-flash", 0, 0, 0, 10, 10),
	}
	result, _ := applyPricing(t, snapshots, usages)
	canonical := findSnapshot(t, result, "deepseek-v4-flash")
	if canonical.CacheRead > canonical.TotalTokens {
		t.Errorf("cache reads exceed the total: %+v", canonical)
	}
}

// A day where the same context model absorbs several non-context attributions
// produces one context row, not one per attributed model.
func TestAggregatesOneContextModelSharedByMultipleNonContextAttributions(t *testing.T) {
	snapshots := []contract.Snapshot{
		dailySnapshot("2026-05-20", "deepseek-v4-flash", 30, 0, 0, 0, 30, 0.002),
		dailySnapshot("2026-05-20", "kimi-k2", 40, 0, 0, 0, 40, 0.002),
	}
	usages := []CodexContextPricingUsage{
		usageOf("2026-05-20", "gpt-5.6-sol", "deepseek-v4-flash", 10, 0, 0, 0, 10),
		usageOf("2026-05-20", "gpt-5.6-sol", "kimi-k2", 20, 0, 0, 0, 20),
	}
	result, _ := applyPricing(t, snapshots, usages)
	contextRows := []contract.Snapshot{}
	for _, snapshot := range result {
		if snapshot.Model == "gpt-5.6-sol" {
			contextRows = append(contextRows, snapshot)
		}
	}
	if len(contextRows) != 1 {
		t.Fatalf("context rows = %+v", contextRows)
	}
	if contextRows[0].TotalTokens != 30 {
		t.Errorf("context total = %d, want 30", contextRows[0].TotalTokens)
	}
	if findSnapshot(t, result, "deepseek-v4-flash").TotalTokens != 20 {
		t.Errorf("flash row = %+v", findSnapshot(t, result, "deepseek-v4-flash"))
	}
	if findSnapshot(t, result, "kimi-k2").TotalTokens != 20 {
		t.Errorf("kimi row = %+v", findSnapshot(t, result, "kimi-k2"))
	}
}

// A same-day context row that ccusage already attributed directly absorbs the
// mixed sessions before its cost is rewritten, rather than duplicating it.
func TestMergesMixedContextUsageIntoAnExistingSameDayContextSnapshot(t *testing.T) {
	snapshots := []contract.Snapshot{
		dailySnapshot("2026-05-20", "deepseek-v4-flash", 30, 0, 0, 0, 30, 0.001),
		dailySnapshot("2026-05-20", "gpt-5.6-sol", 40, 0, 0, 0, 40, 0.0002),
	}
	usages := []CodexContextPricingUsage{
		usageOf("2026-05-20", "gpt-5.6-sol", "", 40, 0, 0, 0, 40),
		usageOf("2026-05-20", "gpt-5.6-sol", "deepseek-v4-flash", 10, 0, 0, 0, 10),
	}
	result, _ := applyPricing(t, snapshots, usages)
	contextRows := []contract.Snapshot{}
	for _, snapshot := range result {
		if snapshot.Model == "gpt-5.6-sol" {
			contextRows = append(contextRows, snapshot)
		}
	}
	if len(contextRows) != 1 {
		t.Fatalf("context rows = %+v", contextRows)
	}
	if contextRows[0].TotalTokens != 50 {
		t.Errorf("merged context total = %d, want 50", contextRows[0].TotalTokens)
	}
}

// The canonical row that loses all of its tokens is marked as corrected, which
// is how the server knows the zero is a reconciliation artifact rather than a
// real day of no usage.
func TestMarksAFullyMovedCanonicalRowAsCorrected(t *testing.T) {
	snapshots := []contract.Snapshot{
		dailySnapshot("2026-05-20", "deepseek-v4-flash", 20, 0, 0, 0, 20, 0.0005),
	}
	usages := []CodexContextPricingUsage{
		usageOf("2026-05-20", "gpt-5.6-sol", "deepseek-v4-flash", 20, 0, 0, 0, 20),
	}
	result, _ := applyPricing(t, snapshots, usages)
	canonical := findSnapshot(t, result, "deepseek-v4-flash")
	if canonical.TotalTokens != 0 {
		t.Fatalf("canonical = %+v", canonical)
	}
	if canonical.Correction != contract.CorrectionCodexContextPricing {
		t.Errorf("correction = %q", canonical.Correction)
	}
}

// An attributed model with no canonical row cannot be split: the whole day's
// numbers would be wrong, so the source fails with a retryable message.
func TestFailsWhenAnAttributedModelHasNoCanonicalRow(t *testing.T) {
	snapshots := []contract.Snapshot{
		dailySnapshot("2026-05-20", "deepseek-v4-flash", 30, 0, 0, 0, 30, 0.001),
	}
	usages := []CodexContextPricingUsage{
		usageOf("2026-05-20", "gpt-5.6-sol", "missing-model", 10, 0, 0, 0, 10),
	}
	_, err := applyCollectedCodexContextPricing(struct {
		Snapshots   []contract.Snapshot
		Usages      []CodexContextPricingUsage
		Stderr      func(string)
		Timezone    string
		CollectedAt string
		Rules       *Rules
	}{
		Snapshots: snapshots, Usages: usages, Timezone: "UTC", CollectedAt: "2026-05-20T01:00:00.000Z",
		Rules: DefaultRules(),
	})
	if err == nil || !strings.HasPrefix(err.Error(), cannotSplitMixedModelUsage) {
		t.Fatalf("err = %v", err)
	}
	if !isCodexContextPricingReconciliationChange(err) {
		t.Error("the failure must be retryable")
	}
}

// The reconciliation messages are the retry prefixes; a reworded message would
// silently drop out of the retry set.
func TestReconciliationChangePredicatesMatchTheThrowMessages(t *testing.T) {
	if !isCodexReconciliationChange(errString(cannotSplitMixedModelUsage + "2026-05-20/gpt-5.6-sol")) {
		t.Error("cannotSplit must be retryable")
	}
	if !isCodexReconciliationChange(errString(mixedModelUsageHasNoPositiveTokenTotal + "2026-05-20")) {
		t.Error("no-positive-total must be retryable")
	}
	if !isCodexReconciliationChange(errString(mixedModelCostExceedsContextPricedDaily + "2026-05-20")) {
		t.Error("cost-exceeds must be retryable")
	}
	if isCodexReconciliationChange(errString("something else")) {
		t.Error("an unrelated error must not be retryable")
	}
}

type errString string

func (e errString) Error() string { return string(e) }

// ccusage prices models from its own builtin catalogue, so a model missing from the
// TokenBoard override set still arrives with a real cost. The TS side was fixed first
// (bcd4004) and this port missed the filter, which made the warning fire for every
// priced model on every run.
func TestReportUnpricedCodexSnapshotsOnlyWarnsAboutZeroCostRows(t *testing.T) {
	priced := dailySnapshot("2026-05-22", "ccusage-priced-model", 10, 2, 0, 0, 12, 0.25)
	unpriced := dailySnapshot("2026-05-22", "genuinely-unpriced-model", 10, 2, 0, 0, 12, 0)

	lines := []string{}
	reportUnpricedCodexSnapshots([]contract.Snapshot{priced, unpriced}, map[string]bool{}, func(line string) {
		lines = append(lines, line)
	})

	if len(lines) != 1 {
		t.Fatalf("diagnostics = %v, want exactly one line", lines)
	}
	if !strings.Contains(lines[0], "genuinely-unpriced-model") {
		t.Errorf("diagnostic = %q, want the zero-cost model", lines[0])
	}
}

// A model the TokenBoard catalogue covers is not unpriced either, even at zero cost:
// the catalogue priced it and the collector already said so.
func TestReportUnpricedCodexSnapshotsStaysQuietAboutCoveredModels(t *testing.T) {
	covered := dailySnapshot("2026-05-22", "covered-model", 10, 2, 0, 0, 12, 0)

	lines := []string{}
	reportUnpricedCodexSnapshots([]contract.Snapshot{covered}, map[string]bool{"covered-model": true}, func(line string) {
		lines = append(lines, line)
	})

	if len(lines) != 0 {
		t.Fatalf("diagnostics = %v, want none", lines)
	}
}
