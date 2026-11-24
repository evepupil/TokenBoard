package codex

// The report shape of ccusage's Codex adapter, pinned against v20.0.33
// (commit 1308c416): rust/adapters/codex/src/report.rs:16-146.

import (
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

func testCorpus(t *testing.T) *nativepricing.Corpus {
	t.Helper()
	corpus, err := nativepricing.LoadEmbeddedCorpus()
	if err != nil {
		t.Fatal(err)
	}
	return &corpus
}

// TestReportDailyShapeMatchesCcusage pins group_json and model_usage_json
// (report.rs:58-145): the fixed key set, the non-cached input semantics (input
// minus both cache buckets), and the absence of session-only fields on daily
// rows.
func TestReportDailyShapeMatchesCcusage(t *testing.T) {
	group := newGroup()
	group.Input, group.CachedInput, group.CacheCreation = 100, 20, 10
	group.Output, group.Reasoning, group.Total = 30, 5, 140
	group.Models["gpt-5.4"] = &ModelUsage{Input: 100, CachedInput: 20, CacheCreation: 10, Output: 30, Reasoning: 5, Total: 140}
	document := ReportJSON(map[string]*Group{"2026-01-05": group}, ReportDaily, testCorpus(t), SpeedPolicy{}, nativepricing.ModeCalculate)

	rows, ok := document["daily"].([]any)
	if !ok || len(rows) != 1 {
		t.Fatalf("document = %+v, want one daily row", document)
	}
	row := rows[0].(map[string]any)
	want := []string{"date", "inputTokens", "cacheCreationTokens", "cacheReadTokens", "outputTokens", "reasoningOutputTokens", "totalTokens", "costUSD", "models"}
	for _, key := range want {
		if _, present := row[key]; !present {
			t.Fatalf("row missing %q: %+v", key, row)
		}
	}
	if _, present := row["sessionFile"]; present {
		t.Fatal("a daily row must not carry session fields")
	}
	if got := row["inputTokens"]; got != uint64(70) {
		t.Fatalf("inputTokens = %v, want 70 (100 - 20 - 10)", got)
	}
	if got := row["cacheReadTokens"]; got != uint64(20) {
		t.Fatalf("cacheReadTokens = %v, want cached input", got)
	}
	model := row["models"].(map[string]any)["gpt-5.4"].(map[string]any)
	if got := model["inputTokens"]; got != uint64(70) {
		t.Fatalf("model inputTokens = %v, want the same non-cached split", got)
	}
	if _, present := model["missingPricing"]; present {
		t.Fatal("a priced model must not carry missingPricing")
	}
	totals := document["totals"].(map[string]any)
	for _, key := range []string{"inputTokens", "cacheCreationTokens", "cacheReadTokens", "outputTokens", "reasoningOutputTokens", "totalTokens", "costUSD"} {
		if _, present := totals[key]; !present {
			t.Fatalf("totals missing %q: %+v", key, totals)
		}
	}
}

// TestSessionRowSplitsDirectoryAndFile pins the session row's extra fields
// (report.rs:98-108): sessionFile is the text after the last '/', directory the
// text before it, and a period without a slash keeps the whole id as the file.
func TestSessionRowSplitsDirectoryAndFile(t *testing.T) {
	group := newGroup()
	group.LastActivity = "2026-01-05T12:00:00Z"
	document := ReportJSON(map[string]*Group{"2026/01/05/rollout-abc": group}, ReportSession, testCorpus(t), SpeedPolicy{}, nativepricing.ModeCalculate)
	row := document["sessions"].([]any)[0].(map[string]any)
	if row["sessionFile"] != "rollout-abc" || row["directory"] != "2026/01/05" {
		t.Fatalf("session split = %v / %v", row["sessionFile"], row["directory"])
	}
	if row["lastActivity"] != "2026-01-05T12:00:00Z" {
		t.Fatalf("lastActivity = %v", row["lastActivity"])
	}

	document = ReportJSON(map[string]*Group{"rollout-abc": group}, ReportSession, testCorpus(t), SpeedPolicy{}, nativepricing.ModeCalculate)
	row = document["sessions"].([]any)[0].(map[string]any)
	if row["sessionFile"] != "rollout-abc" || row["directory"] != "" {
		t.Fatalf("slashless split = %v / %v, want the id with an empty directory", row["sessionFile"], row["directory"])
	}
}

// TestMissingPricingOnlyOutsideDisplayMode pins report.rs:26-33 and 81-85: an
// unpriced model is flagged per row and listed in totals, except in display
// mode, which never prices anything.
func TestMissingPricingOnlyOutsideDisplayMode(t *testing.T) {
	group := newGroup()
	group.Models["tokenboard-unpriced-2099"] = &ModelUsage{Input: 10, Total: 10}
	groups := map[string]*Group{"2026-01-05": group}

	calculated := ReportJSON(groups, ReportDaily, testCorpus(t), SpeedPolicy{}, nativepricing.ModeCalculate)
	row := calculated["daily"].([]any)[0].(map[string]any)
	model := row["models"].(map[string]any)["tokenboard-unpriced-2099"].(map[string]any)
	if model["missingPricing"] != true {
		t.Fatal("an unpriced model must be flagged in calculate mode")
	}
	unpriced, ok := calculated["totals"].(map[string]any)["unpricedModels"].([]string)
	if !ok || len(unpriced) != 1 || unpriced[0] != "tokenboard-unpriced-2099" {
		t.Fatalf("unpricedModels = %v", calculated["totals"])
	}

	display := ReportJSON(groups, ReportDaily, testCorpus(t), SpeedPolicy{}, nativepricing.ModeDisplay)
	row = display["daily"].([]any)[0].(map[string]any)
	model = row["models"].(map[string]any)["tokenboard-unpriced-2099"].(map[string]any)
	if _, present := model["missingPricing"]; present {
		t.Fatal("display mode must not flag missing pricing")
	}
	if _, present := display["totals"].(map[string]any)["unpricedModels"]; present {
		t.Fatal("display mode must not list unpriced models")
	}
}
