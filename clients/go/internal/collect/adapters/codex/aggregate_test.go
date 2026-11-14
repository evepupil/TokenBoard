package codex

// The Codex aggregation layer, pinned against ccusage v20.0.33 (commit
// 1308c416): the dedupe key, the service-tier merge, the compaction
// attribution and the per-request long-context split of
// rust/adapters/codex/src/aggregate.rs. Each test names the rule it protects.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeSourceFile(t *testing.T, dir, name string, lines ...string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(joinLines(lines...)), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func headlessLine(timestamp, model string, input, output uint64) string {
	return `{"model":"` + model + `","timestamp":"` + timestamp + `","usage":{"input_tokens":` +
		itoa(input) + `,"output_tokens":` + itoa(output) + `}}`
}

func mustLoadDaily(t *testing.T, sources []FileGroup) map[string]*Group {
	t.Helper()
	groups, err := LoadGroups(sources, ReportDaily, "UTC", "", "")
	if err != nil {
		t.Fatalf("LoadGroups: %v", err)
	}
	return groups
}

// TestDailyDedupeIgnoresSessionButSessionDedupeUsesIt pins codex_event_key
// (aggregate.rs:753-780): a daily key carries no session id, so the same event
// in two sessions is counted once; the session key does carry it, so each
// session keeps its own copy.
func TestDailyDedupeIgnoresSessionButSessionDedupeUsesIt(t *testing.T) {
	root := t.TempDir()
	line := headlessLine("2026-01-05T12:00:00Z", "gpt-5.4", 100, 20)
	first := writeSourceFile(t, root, "2026/01/05/a.jsonl", line)
	second := writeSourceFile(t, root, "2026/01/05/b.jsonl", line)
	sources := []FileGroup{{Dir: root, Files: []string{first, second}}}

	daily := mustLoadDaily(t, sources)
	if len(daily) != 1 || daily["2026-01-05"] == nil {
		t.Fatalf("daily groups = %+v, want one 2026-01-05 group", daily)
	}
	if got := daily["2026-01-05"].Input; got != 100 {
		t.Fatalf("daily input = %d, want the event counted once (100)", got)
	}

	sessions, err := LoadGroups(sources, ReportSession, "UTC", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 {
		t.Fatalf("session groups = %d, want 2: %+v", len(sessions), sessions)
	}
	for name, group := range sessions {
		if group.Input != 100 {
			t.Fatalf("session %q input = %d, want 100", name, group.Input)
		}
	}
}

// tokenCountWithTier emits the settings event that sets a tier followed by one
// token_count event carrying the same usage.
func tokenCountWithTier(timestamp, tier string, input uint64) []string {
	settings := `{"type":"event_msg","timestamp":"` + timestamp + `","payload":{"type":"thread_settings_applied","thread_settings":{"service_tier":"` + tier + `"}}}`
	usage := tokenCountLine(timestamp,
		`{"total_token_usage":{"input_tokens":`+itoa(input)+`,"total_tokens":`+itoa(input)+`},"last_token_usage":{"input_tokens":`+itoa(input)+`,"total_tokens":`+itoa(input)+`}}`)
	return []string{settings, usage}
}

// TestServiceTierMergePrefersStandardOverFastOverFlex pins
// merge_codex_service_tiers (types.rs:22-38) as used by insert_dedupe_record
// (aggregate.rs:711-721): a duplicate event combines tiers order-independently,
// with Standard above Fast above Flex, and the merged tier is what the second
// pass credits.
func TestServiceTierMergePrefersStandardOverFastOverFlex(t *testing.T) {
	cases := []struct {
		name       string
		first      string
		second     string
		wantBucket string
	}{
		{"standard after fast", "fast", "standard", "standard"},
		{"fast after standard", "standard", "fast", "standard"},
		{"fast after flex", "flex", "fast", "fast"},
		{"flex and standard", "flex", "standard", "standard"},
	}
	for _, tc := range cases {
		root := t.TempDir()
		files := []string{
			writeSourceFile(t, root, "2026/01/05/a.jsonl", tokenCountWithTier("2026-01-05T12:00:00.000Z", tc.first, 50)...),
			writeSourceFile(t, root, "2026/01/05/b.jsonl", tokenCountWithTier("2026-01-05T12:00:00.000Z", tc.second, 50)...),
		}
		groups := mustLoadDaily(t, []FileGroup{{Dir: root, Files: files}})
		usage := groups["2026-01-05"].Models["gpt-5"]
		if usage == nil {
			t.Fatalf("%s: model missing from the group", tc.name)
		}
		if usage.Input != 50 {
			t.Fatalf("%s: input = %d, want the duplicate counted once", tc.name, usage.Input)
		}
		got := map[string]uint64{
			"standard": usage.RecordedStandard.Input,
			"fast":     usage.RecordedFast.Input,
			"flex":     usage.RecordedFlex.Input,
		}
		for name, value := range got {
			want := uint64(0)
			if name == tc.wantBucket {
				want = 50
			}
			if value != want {
				t.Fatalf("%s: recorded %s input = %d, want %d", tc.name, name, value, want)
			}
		}
	}
}

// TestCompactionRecordUsesEarliestFileCopy pins the file-order rule of
// insert_dedupe_record (aggregate.rs:722-735) and the second pass
// (aggregate.rs:594-640): a compaction response copied into several files is
// emitted once, from the lowest file index, with that copy's timestamp, model
// and merged tier.
func TestCompactionRecordUsesEarliestFileCopy(t *testing.T) {
	root := t.TempDir()
	record := func(timestamp, model string, input uint64, tier string) []string {
		settings := `{"type":"event_msg","timestamp":"` + timestamp + `","payload":{"type":"thread_settings_applied","thread_settings":{"service_tier":"` + tier + `"}}}`
		usage := `{"type":"token_usage_record","timestamp":"` + timestamp + `","payload":{"response_id":"resp-1","model":"` + model + `","usage":{"input_tokens":` + itoa(input) + `,"output_tokens":1}}}`
		marker := `{"type":"compacted","payload":{"compaction_response_id":"resp-1"}}`
		return []string{settings, usage, marker}
	}
	earliest := writeSourceFile(t, root, "2026/01/05/a.jsonl", record("2026-01-05T12:00:00.000Z", "gpt-5.4", 100, "standard")...)
	copied := writeSourceFile(t, root, "2026/01/05/b.jsonl", record("2026-01-06T12:00:00.000Z", "gpt-5.5", 900, "fast")...)
	groups := mustLoadDaily(t, []FileGroup{{Dir: root, Files: []string{earliest, copied}}})

	group := groups["2026-01-05"]
	if group == nil {
		t.Fatalf("groups = %+v, want the earliest copy's date", groups)
	}
	if group.Input != 100 {
		t.Fatalf("input = %d, want the earliest copy's 100", group.Input)
	}
	if len(group.Models) != 1 || group.Models["gpt-5.4"] == nil {
		t.Fatalf("models = %+v, want only the earliest copy's gpt-5.4", group.Models)
	}
	if groups["2026-01-06"] != nil {
		t.Fatalf("the later copy must not contribute a group: %+v", groups["2026-01-06"])
	}
}

// TestLongContextBucketIsDecidedPerRequest pins
// accumulate_codex_event_into_model_usage (aggregate.rs:463-524): the tier is
// decided from each request's own input size against the model's threshold, not
// from the summed totals.
func TestLongContextBucketIsDecidedPerRequest(t *testing.T) {
	root := t.TempDir()
	// gpt-5.5's models.dev boundary is 272K input tokens.
	large := writeSourceFile(t, root, "2026/01/05/a.jsonl",
		headlessLine("2026-01-05T12:00:00Z", "gpt-5.5", 300_000, 1_000),
		headlessLine("2026-01-05T12:00:01Z", "gpt-5.5", 1_000, 500),
	)
	groups := mustLoadDaily(t, []FileGroup{{Dir: root, Files: []string{large}}})
	usage := groups["2026-01-05"].Models["gpt-5.5"]
	if usage == nil {
		t.Fatal("gpt-5.5 missing from the group")
	}
	if usage.Input != 301_000 {
		t.Fatalf("input = %d, want both requests", usage.Input)
	}
	if usage.LongContextInput != 300_000 {
		t.Fatalf("long-context input = %d, want only the 300K request", usage.LongContextInput)
	}
	if usage.LongContextOutput != 1_000 {
		t.Fatalf("long-context output = %d, want only the 300K request's output", usage.LongContextOutput)
	}
}

// TestTimestampedUsageOnlyForTimeDependentModels pins the
// has_time_dependent_pricing gate (aggregate.rs:487-497): only the DeepSeek V4
// families record per-timestamp buckets.
func TestTimestampedUsageOnlyForTimeDependentModels(t *testing.T) {
	root := t.TempDir()
	file := writeSourceFile(t, root, "2026/01/05/a.jsonl",
		headlessLine("2026-01-05T12:00:00Z", "deepseek-v4-flash", 10, 5),
		headlessLine("2026-01-05T12:00:00Z", "gpt-5.4", 10, 5),
	)
	groups := mustLoadDaily(t, []FileGroup{{Dir: root, Files: []string{file}}})
	models := groups["2026-01-05"].Models
	if timed := models["deepseek-v4-flash"]; timed == nil || len(timed.Timestamped) != 1 {
		t.Fatalf("deepseek-v4-flash timestamped = %+v, want one bucket", timed)
	}
	if static := models["gpt-5.4"]; static == nil || len(static.Timestamped) != 0 {
		t.Fatalf("gpt-5.4 timestamped = %+v, want none", static)
	}
}

// TestInvalidTimestampFailsTheWholeReport pins aggregate.rs:332-334: an
// unparseable event timestamp is a hard error, not a skipped event. Only a
// session event can carry one - the parser keeps its timestamp string verbatim
// (parser.rs:805-812), while a headless entry with an unusable timestamp falls
// back to the file's mtime before aggregation ever sees it.
func TestInvalidTimestampFailsTheWholeReport(t *testing.T) {
	root := t.TempDir()
	file := writeSourceFile(t, root, "2026/01/05/a.jsonl",
		tokenCountLine("not-a-timestamp", `{"last_token_usage":{"input_tokens":10}}`),
	)
	_, err := LoadGroups([]FileGroup{{Dir: root, Files: []string{file}}}, ReportDaily, "UTC", "", "")
	if err == nil || !strings.Contains(err.Error(), "Invalid Codex timestamp: not-a-timestamp") {
		t.Fatalf("LoadGroups error = %v, want the invalid-timestamp failure", err)
	}
}

// TestLastActivityUsesRawTimestampString pins aggregate.rs:441-448: the field
// keeps the lexicographically greatest raw event timestamp - here the offset
// spelling, which sorts after the Z spelling even though 11:30Z is later.
func TestLastActivityUsesRawTimestampString(t *testing.T) {
	root := t.TempDir()
	file := writeSourceFile(t, root, "2026/01/05/a.jsonl",
		`{"type":"event_msg","timestamp":"2026-01-05T11:30:00Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10}}}}`,
		`{"type":"event_msg","timestamp":"2026-01-05T12:00:00+01:00","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":20}}}}`,
	)
	groups := mustLoadDaily(t, []FileGroup{{Dir: root, Files: []string{file}}})
	if got := groups["2026-01-05"].LastActivity; got != "2026-01-05T12:00:00+01:00" {
		t.Fatalf("last activity = %q, want the raw string maximum", got)
	}
}

// TestRangeFilterDropsEventsOutsideWindow pins codex_period_for
// (aggregate.rs:408-430): both bounds are inclusive and compared as compact
// dates, and out-of-window events contribute nothing.
func TestRangeFilterDropsEventsOutsideWindow(t *testing.T) {
	root := t.TempDir()
	file := writeSourceFile(t, root, "2026/01/05/a.jsonl",
		headlessLine("2026-01-04T12:00:00Z", "gpt-5.4", 1, 1),
		headlessLine("2026-01-05T12:00:00Z", "gpt-5.4", 10, 1),
		headlessLine("2026-01-06T12:00:00Z", "gpt-5.4", 100, 1),
	)
	groups, err := LoadGroups([]FileGroup{{Dir: root, Files: []string{file}}}, ReportDaily, "UTC", "20260105", "20260105")
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 1 || groups["2026-01-05"] == nil {
		t.Fatalf("groups = %+v, want only the in-window day", groups)
	}
	if got := groups["2026-01-05"].Input; got != 10 {
		t.Fatalf("input = %d, want only the 20260105 event", got)
	}
}

// TestLoadGroupsUsesOnlyTheDiscoveryItWasGiven pins that the bounded replay
// plan's "available" side is the caller's discovery, not a second directory
// walk: load_groups_from_sources hands for_bounded_files exactly the file
// groups it was given (aggregate.rs:91-114). A parent file that exists on disk
// but is missing from the discovery is therefore not "available", and the
// child's copied prefix is billed rather than silently skipped.
func TestLoadGroupsUsesOnlyTheDiscoveryItWasGiven(t *testing.T) {
	root := t.TempDir()
	shared := headlessLine("2026-05-20T01:00:00Z", "gpt-5.4", 100, 10)
	parent := writeSourceFile(t, root, "2026/05/20/parent.jsonl",
		sessionMeta("2026-05-20T00:00:00.000Z", "parent", ""), shared)
	child := writeSourceFile(t, root, "2026/05/22/child.jsonl",
		sessionMeta("2026-05-22T00:00:00.000Z", "child", "parent"), shared,
		headlessLine("2026-05-22T01:00:00Z", "gpt-5.4", 7, 3))

	load := func(files []string) map[string]*Group {
		t.Helper()
		groups, err := LoadGroups([]FileGroup{{Dir: root, Files: files}}, ReportDaily, "UTC", "", "")
		if err != nil {
			t.Fatalf("LoadGroups: %v", err)
		}
		return groups
	}
	withParent := load([]string{parent, child})
	if got := withParent["2026-05-20"]; got == nil || got.Input != 100 {
		t.Fatalf("with the parent discovered, 2026-05-20 = %+v, want the parent's 100", got)
	}
	if got := withParent["2026-05-22"]; got == nil || got.Input != 7 {
		t.Fatalf("with the parent discovered, 2026-05-22 = %+v, want the post-fork 7", got)
	}
	// Same directory, but the caller's discovery omits the parent: no hidden
	// re-walk may resurrect it.
	withoutParent := load([]string{child})
	if got := withoutParent["2026-05-20"]; got == nil || got.Input != 100 {
		t.Fatalf("without the parent discovered, 2026-05-20 = %+v, want the copied prefix billed", got)
	}
}
