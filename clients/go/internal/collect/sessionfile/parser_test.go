package sessionfile

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Fixtures mirror session-jsonl-parser.test.ts. parseSessionJSONLContent
// splits on "\n" like parseSessionJsonl does, rather than going through the
// bounded line reader, so each case pins the parser itself.

func parseSessionJSONLContent(t *testing.T, input ParseInput, content string) ParseResult {
	t.Helper()
	lines := make([]Line, 0, strings.Count(content, "\n")+1)
	for _, text := range strings.Split(content, "\n") {
		lines = append(lines, Line{Text: text})
	}
	result, err := Parse(input, lines)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return result
}

func requireParseResult(t *testing.T, got, want ParseResult) {
	t.Helper()
	if got.IgnoredUploadSafeRows != want.IgnoredUploadSafeRows ||
		got.SkippedOversizedRows != want.SkippedOversizedRows ||
		got.LargestSkippedOversizedRow != want.LargestSkippedOversizedRow ||
		got.MalformedRows != want.MalformedRows ||
		got.MissingCost != want.MissingCost ||
		got.UnparsedTokenLikeRows != want.UnparsedTokenLikeRows {
		t.Fatalf("parse counters mismatch:\n got %+v\nwant %+v", got, want)
	}
	if !reflect.DeepEqual(got.Snapshots, want.Snapshots) {
		t.Fatalf("snapshots mismatch:\n got %#v\nwant %#v", got.Snapshots, want.Snapshots)
	}
}

func requireSingleSnapshot(t *testing.T, result ParseResult) contract.Snapshot {
	t.Helper()
	if len(result.Snapshots) != 1 {
		t.Fatalf("got %d snapshots, want 1: %#v", len(result.Snapshots), result.Snapshots)
	}
	return result.Snapshots[0]
}

func requireResultDoesNotContain(t *testing.T, result ParseResult, needle string) {
	t.Helper()
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal parse result: %v", err)
	}
	if strings.Contains(string(encoded), needle) {
		t.Fatalf("parse result leaked %q: %s", needle, encoded)
	}
}

func codexParseInput(sessionID string) ParseInput {
	return ParseInput{
		Source:      contract.SourceCodex,
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		SessionID:   sessionID,
	}
}

func claudeParseInput(sessionID string) ParseInput {
	return ParseInput{
		Source:      contract.SourceClaudeCode,
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-05-22T10:00:00.000Z",
		SessionID:   sessionID,
	}
}

func TestParseSessionJSONLCodexTokenCountRowsWithoutConversationFields(t *testing.T) {
	result := parseSessionJSONLContent(t, codexParseInput("codex-session"),
		`{"type":"event_msg","timestamp":"2026-05-22T01:00:00.000Z","payload":{"type":"token_count","prompt":"do not upload","info":{"model":"gpt-5","last_token_usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"total_tokens":20,"cost_usd":0.04}}}}`+"\n")

	requireParseResult(t, result, ParseResult{
		Snapshots: []contract.Snapshot{{
			Source:        contract.SourceCodex,
			UsageDate:     "2026-05-22",
			Timezone:      "Asia/Shanghai",
			Model:         "gpt-5",
			InputTokens:   10,
			OutputTokens:  5,
			CacheCreation: 2,
			CacheRead:     3,
			TotalTokens:   20,
			CostUSD:       0.04,
			SessionCount:  1,
			CollectedAt:   "2026-05-22T10:00:00.000Z",
		}},
	})
	requireResultDoesNotContain(t, result, "do not upload")
}

func TestParseSessionJSONLNormalizesCodexTotalsWithSeparateCachedInput(t *testing.T) {
	result := parseSessionJSONLContent(t, codexParseInput("codex-session"),
		`{"type":"event_msg","timestamp":"2026-05-22T01:00:00.000Z","payload":{"type":"token_count","info":{"model":"gpt-5","last_token_usage":{"input_tokens":10,"cached_input_tokens":20,"cache_write_input_tokens":3,"output_tokens":4,"total_tokens":15,"cost_usd":0.04}}}}`+"\n")

	snapshot := requireSingleSnapshot(t, result)
	if snapshot.InputTokens != 10 || snapshot.OutputTokens != 4 || snapshot.CacheCreation != 3 ||
		snapshot.CacheRead != 20 || snapshot.TotalTokens != 37 {
		t.Fatalf("snapshot = %#v, want input 10, output 4, cacheCreation 3, cacheRead 20, total 37", snapshot)
	}
}

func TestParseSessionJSONLNormalizesLowCodexTotalWithCachedInputInInputTokens(t *testing.T) {
	result := parseSessionJSONLContent(t, codexParseInput("codex-session"),
		`{"type":"event_msg","timestamp":"2026-05-22T01:00:00.000Z","payload":{"type":"token_count","info":{"model":"gpt-5","last_token_usage":{"input_tokens":20,"cached_input_tokens":5,"cache_write_input_tokens":3,"output_tokens":4,"total_tokens":10,"cost_usd":0.04}}}}`+"\n")

	snapshot := requireSingleSnapshot(t, result)
	if snapshot.InputTokens != 20 || snapshot.OutputTokens != 4 || snapshot.CacheCreation != 3 ||
		snapshot.CacheRead != 5 || snapshot.TotalTokens != 27 {
		t.Fatalf("snapshot = %#v, want input 20, output 4, cacheCreation 3, cacheRead 5, total 27", snapshot)
	}
}

// A legacy Codex record folds cached input into input_tokens, so its total is
// input + output + cache creation — adding the cache read again would count
// those tokens twice and push the uploaded total past what the record ever
// reported.
func TestParseSessionJSONLKeepsLegacyCodexTotalFreeOfDoubleCountedCachedInput(t *testing.T) {
	for _, usage := range []string{
		`{"input_tokens":100,"cached_input_tokens":40,"output_tokens":1}`,
		`{"input_tokens":100,"cached_input_tokens":40,"output_tokens":1,"total_tokens":0}`,
	} {
		result := parseSessionJSONLContent(t, codexParseInput("codex-session"),
			`{"type":"event_msg","timestamp":"2026-05-22T01:00:00.000Z","payload":{"type":"token_count","info":{"model":"gpt-5","last_token_usage":`+usage+`}}}`+"\n")

		snapshot := requireSingleSnapshot(t, result)
		if snapshot.InputTokens != 100 || snapshot.OutputTokens != 1 || snapshot.CacheCreation != 0 ||
			snapshot.CacheRead != 40 || snapshot.TotalTokens != 101 {
			t.Fatalf("usage %s produced %#v, want input 100, output 1, cacheCreation 0, cacheRead 40, total 101", usage, snapshot)
		}
	}
}

func TestParseSessionJSONLClaudeAssistantUsageRows(t *testing.T) {
	result := parseSessionJSONLContent(t, claudeParseInput("claude-session"),
		`{"type":"assistant","timestamp":"2026-05-22T02:00:00.000Z","message":{"model":"claude-sonnet-4-5","content":[{"type":"text","text":"do not upload"}],"usage":{"input_tokens":8,"output_tokens":13,"cache_creation_input_tokens":21,"cache_read_input_tokens":34}},"costUSD":0.12}`+"\n")

	requireParseResult(t, result, ParseResult{
		Snapshots: []contract.Snapshot{{
			Source:        contract.SourceClaudeCode,
			UsageDate:     "2026-05-22",
			Timezone:      "Asia/Shanghai",
			Model:         "claude-sonnet-4-5",
			InputTokens:   8,
			OutputTokens:  13,
			CacheCreation: 21,
			CacheRead:     34,
			TotalTokens:   76,
			CostUSD:       0.12,
			SessionCount:  1,
			CollectedAt:   "2026-05-22T10:00:00.000Z",
		}},
	})
	requireResultDoesNotContain(t, result, "do not upload")
}

func TestParseSessionJSONLIgnoresClaudeUserToolResultsWithTokenFields(t *testing.T) {
	result := parseSessionJSONLContent(t, claudeParseInput("claude-session"),
		`{"type":"user","timestamp":"2026-05-22T02:00:00.000Z","message":{"role":"user","content":"do not upload"},"toolUseResult":{"totalTokens":10,"inputTokens":4,"outputTokens":6}}`+"\n")

	if len(result.Snapshots) != 0 {
		t.Fatalf("got %d snapshots, want 0: %#v", len(result.Snapshots), result.Snapshots)
	}
	if result.UnparsedTokenLikeRows != 0 {
		t.Fatalf("unparsedTokenLikeRows = %d, want 0", result.UnparsedTokenLikeRows)
	}
	requireResultDoesNotContain(t, result, "do not upload")
}

func TestParseSessionJSONLIgnoresClaudeSyntheticZeroUsageAssistantRows(t *testing.T) {
	result := parseSessionJSONLContent(t, claudeParseInput("claude-session"),
		`{"type":"assistant","timestamp":"2026-05-22T02:00:00.000Z","message":{"model":"<synthetic>","content":[{"type":"text","text":"do not upload"}],"usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"total_tokens":0}}}`+"\n")

	requireParseResult(t, result, ParseResult{
		IgnoredUploadSafeRows: 1,
		Snapshots:             []contract.Snapshot{},
	})
	requireResultDoesNotContain(t, result, "do not upload")
}

func TestParseSessionJSONLMarksTokenRowsWithoutCost(t *testing.T) {
	result := parseSessionJSONLContent(t, codexParseInput("codex-session"),
		`{"type":"event_msg","timestamp":"2026-05-22T01:00:00.000Z","payload":{"type":"token_count","info":{"model":"gpt-5","last_token_usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}}`+"\n")

	if !result.MissingCost {
		t.Fatal("missingCost = false, want true")
	}
	snapshot := requireSingleSnapshot(t, result)
	if snapshot.Source != contract.SourceCodex || snapshot.Model != "gpt-5" ||
		snapshot.TotalTokens != 15 || snapshot.CostUSD != 0 {
		t.Fatalf("snapshot = %#v, want codex/gpt-5 with total 15 and cost 0", snapshot)
	}
}

func TestParseSessionJSONLTreatsExplicitZeroCostAsParsed(t *testing.T) {
	result := parseSessionJSONLContent(t, codexParseInput("codex-session"),
		`{"type":"event_msg","timestamp":"2026-05-22T01:00:00.000Z","payload":{"type":"token_count","info":{"model":"gpt-5","last_token_usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,"cost_usd":0}}}}`+"\n")

	if result.MissingCost {
		t.Fatal("missingCost = true, want false for an explicit zero cost")
	}
	if snapshot := requireSingleSnapshot(t, result); snapshot.CostUSD != 0 {
		t.Fatalf("costUsd = %v, want 0", snapshot.CostUSD)
	}
}

func TestParseSessionJSONLIgnoresCodexCumulativeTokenCountMetadataRows(t *testing.T) {
	result := parseSessionJSONLContent(t, codexParseInput("codex-session"),
		`{"type":"event_msg","timestamp":"2026-05-22T01:00:00.000Z","payload":{"type":"token_count","info":{"model":"gpt-5","total_token_usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}}`+"\n")

	if len(result.Snapshots) != 0 || result.MalformedRows != 0 || result.UnparsedTokenLikeRows != 0 {
		t.Fatalf("got %+v, want no snapshots, no malformed rows and no unparsed token rows", result)
	}
}

func TestParseSessionJSONLIgnoresLegacyCodexPayloadCumulativeTokenCountRows(t *testing.T) {
	result := parseSessionJSONLContent(t, codexParseInput("codex-session"),
		`{"type":"event_msg","timestamp":"2026-05-22T01:00:00.000Z","payload":{"type":"token_count","total_token_usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}`+"\n")

	if len(result.Snapshots) != 0 || result.MalformedRows != 0 || result.UnparsedTokenLikeRows != 0 {
		t.Fatalf("got %+v, want no snapshots, no malformed rows and no unparsed token rows", result)
	}
}

func TestParseSessionJSONLIgnoresCodexTokenUsageRecordMetadata(t *testing.T) {
	input := codexParseInput("session")
	input.CollectedAt = "2026-09-19T00:00:00.000Z"
	result := parseSessionJSONLContent(t, input,
		`{"type":"token_usage_record","timestamp":"2026-09-18T12:00:00.000Z","payload":{"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12},"turn_token_usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12},"thread_token_usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}`)

	if len(result.Snapshots) != 0 || result.UnparsedTokenLikeRows != 0 {
		t.Fatalf("got %+v, want no snapshots and no unparsed token rows", result)
	}
}

func TestParseSessionJSONLIgnoresCompactedCodexLatestTokenUsageMetadata(t *testing.T) {
	input := codexParseInput("session")
	input.CollectedAt = "2026-09-19T00:00:00.000Z"
	result := parseSessionJSONLContent(t, input,
		`{"type":"compacted","timestamp":"2026-09-18T12:00:00.000Z","payload":{"latest_token_usage_record":{"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12},"turn_token_usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12},"thread_token_usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}}`)

	if len(result.Snapshots) != 0 || result.UnparsedTokenLikeRows != 0 {
		t.Fatalf("got %+v, want no snapshots and no unparsed token rows", result)
	}
}

func TestParseSessionJSONLReportsTokenLikeRowsNotParsed(t *testing.T) {
	result := parseSessionJSONLContent(t, codexParseInput("codex-session"),
		`{"type":"usage_summary","timestamp":"2026-05-22T01:00:00.000Z","token_usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,"cost_usd":0.03}}`+"\n")

	if len(result.Snapshots) != 0 || result.MalformedRows != 0 || result.UnparsedTokenLikeRows != 1 {
		t.Fatalf("got %+v, want no snapshots, no malformed rows and 1 unparsed token row", result)
	}
}

func TestParseSessionJSONLReportsMalformedNonEmptyRows(t *testing.T) {
	result := parseSessionJSONLContent(t, codexParseInput("codex-session"), "{\"type\":\"event_msg\"\n\n")

	if len(result.Snapshots) != 0 || result.MalformedRows != 1 || result.UnparsedTokenLikeRows != 0 {
		t.Fatalf("got %+v, want no snapshots, 1 malformed row and no unparsed token rows", result)
	}
}

// The TS parser runs every row through usageSnapshotSchema.parse, so a row the
// contract rejects fails the whole source there. Without the same check here a
// hook sync would keep a poisoned snapshot in its cursor and replay it into an
// upload batch the server rejects as a whole.
func TestParseSessionJSONLRejectsSnapshotsThatFailContractValidation(t *testing.T) {
	input := ParseInput{
		Source:      contract.SourceClaudeCode,
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-10-30T00:00:00Z",
		SessionID:   "session-1",
	}
	lines := []Line{{Text: `{"timestamp":"2026-10-30T08:00:00Z","message":{"model":"claude-sonnet-4","usage":{"input_tokens":10,"cache_read_input_tokens":500,"total_tokens":20,"cost_usd":0.01}}}`}}

	_, err := Parse(input, lines)
	if err == nil {
		t.Fatal("Parse accepted a snapshot with cacheRead > total; usageSnapshotSchema rejects the same row")
	}
	want := "claude-code 2026-10-30 claude-sonnet-4: cacheReadTokens must not exceed totalTokens"
	if err.Error() != want {
		t.Fatalf("error = %q, want %q", err.Error(), want)
	}
}

func TestParseSessionJSONLRejectsFractionalTokenCounts(t *testing.T) {
	input := ParseInput{
		Source:      contract.SourceClaudeCode,
		Timezone:    "Asia/Shanghai",
		CollectedAt: "2026-10-30T00:00:00Z",
		SessionID:   "session-1",
	}
	lines := []Line{{Text: `{"timestamp":"2026-10-30T08:00:00Z","message":{"model":"claude-sonnet-4","usage":{"input_tokens":1.5,"output_tokens":2,"total_tokens":3.5,"cost_usd":0.01}}}`}}

	_, err := Parse(input, lines)
	if err == nil {
		t.Fatal("Parse truncated a fractional token count; z.number().int() rejects it")
	}
}

func TestParseSessionJSONLReportsInvalidTimezoneWithContext(t *testing.T) {
	input := codexParseInput("codex-session")
	input.Timezone = "Not/AZone"

	lines := []Line{{Text: `{"type":"event_msg","timestamp":"2026-05-22T01:00:00.000Z","payload":{"type":"token_count","info":{"model":"gpt-5","last_token_usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,"cost_usd":0}}}}`}}
	_, err := Parse(input, lines)
	if err == nil {
		t.Fatal("expected an invalid-timezone error, got nil")
	}
	want := "Invalid timezone for session JSONL formatDate: Not/AZone"
	if err.Error() != want {
		t.Fatalf("error = %q, want %q", err.Error(), want)
	}
}
