package tools

// The Droid adapter's rules, pinned against ccusage v20.0.33 (commit 1308c416):
// rust/adapters/droid/src/{parser,loader}.rs.

import (
	"path/filepath"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// droidOptions builds Options with DROID_SESSIONS_DIR pointing at root.
func droidOptions(t *testing.T, root string) Options {
	t.Helper()
	return Options{
		Env: func(key string) (string, bool) {
			if key == "DROID_SESSIONS_DIR" {
				return root, true
			}
			return "", false
		},
		Timezone: "UTC",
		Corpus:   testCorpus(t),
	}
}

// TestDroidNormalizeModelNameCollapsesDotsAndBrackets pins
// normalize_droid_model_name (parser.rs:216-251): `custom:` is stripped, any
// bracketed run disappears, the rest is ASCII-lowercased and every '.',
// whitespace or '-' run collapses into one dash, with leading/trailing dashes
// trimmed.
func TestDroidNormalizeModelNameCollapsesDotsAndBrackets(t *testing.T) {
	cases := map[string]string{
		"custom:Claude-Opus-4.5-Thinking-[Anthropic]-0": "claude-opus-4-5-thinking-0",
		"Claude-Sonnet-4-[Anthropic]":                   "claude-sonnet-4",
		"gemini-2.5-pro":                                "gemini-2-5-pro",
		"  GPT-5.5   [OpenAI]  ":                        "gpt-5-5",
		"a...b":                                         "a-b",
		"-leading-and-trailing-":                        "leading-and-trailing",
		"[all-bracketed]":                               "",
	}
	for input, want := range cases {
		if got := normalizeDroidModelName(input); got != want {
			t.Fatalf("normalizeDroidModelName(%q) = %q, want %q", input, got, want)
		}
	}
}

// TestDroidThinkingTokensEnterExtraAndBillingOutput pins parser.rs:139-166 and
// 145-165: thinkingTokens is the entry's extra (never a model-breakdown bucket)
// but the cost formula bills it as output tokens.
func TestDroidThinkingTokensEnterExtraAndBillingOutput(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "session-a.settings.json"), `{
		"model": "Claude-Opus-4-5",
		"providerLock": "anthropic",
		"providerLockTimestamp": "2026-05-01T01:02:03.000Z",
		"tokenUsage": {
			"inputTokens": 100,
			"outputTokens": 50,
			"cacheCreationTokens": 20,
			"cacheReadTokens": 10,
			"thinkingTokens": 5
		}
	}`)
	entries, err := LoadDroid(droidOptions(t, root))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want one", entries)
	}
	entry := entries[0]
	if entry.Usage != (Usage{Input: 100, Output: 50, CacheCreation: 20, CacheRead: 10, Extra: 5}) {
		t.Fatalf("usage = %+v, want thinking tokens in Extra", entry.Usage)
	}
	if entry.Usage.Total() != 185 {
		t.Fatalf("total = %d, want 185 including thinking tokens", entry.Usage.Total())
	}
	if entry.SessionID != "session-a" || entry.Date != "2026-05-01" || entry.Model != "claude-opus-4-5" {
		t.Fatalf("entry = %+v", entry)
	}

	corpus := testCorpus(t)
	pricing, ok := corpus.Find("claude-opus-4-5")
	if !ok {
		t.Fatal("claude-opus-4-5 is missing from the corpus")
	}
	billed := nativepricing.Usage{Input: 100, Output: 55, CacheCreate5m: 20, CacheRead: 10}
	unbilled := nativepricing.Usage{Input: 100, Output: 50, CacheCreate5m: 20, CacheRead: 10}
	want := nativepricing.CostFromPricing(billed, pricing, false)
	if want <= 0 {
		t.Fatalf("expected a positive cost for claude-opus-4-5, got %v", want)
	}
	if entry.CostUSD != want {
		t.Fatalf("cost = %v, want %v (thinking tokens billed as output)", entry.CostUSD, want)
	}
	if entry.CostUSD == nativepricing.CostFromPricing(unbilled, pricing, false) {
		t.Fatal("cost ignored the thinking tokens")
	}
}

// TestDroidMtimeFallbackForcesStaticPricing pins settings_timestamp
// (parser.rs:126-143) together with the pricing split: a settings file without
// providerLockTimestamp bills at the static table even though its entry still
// carries the file mtime as its display timestamp, while a locked file bills
// with find_at at the lock instant.
//
// deepseek-v4-flash is the probe because it is the one scheduled model: static
// $0.15/M input, $0.14/M before the 2026-08-17 UTC cutoff.
func TestDroidMtimeFallbackForcesStaticPricing(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "dated.settings.json"), `{
		"model": "deepseek-v4-flash",
		"providerLock": "deepseek",
		"providerLockTimestamp": "2026-05-01T01:02:03.000Z",
		"tokenUsage": {"inputTokens": 1000000}
	}`)
	writeFile(t, filepath.Join(root, "undated.settings.json"), `{
		"model": "deepseek-v4-flash",
		"providerLock": "deepseek",
		"tokenUsage": {"inputTokens": 1000000}
	}`)
	entries, err := LoadDroid(droidOptions(t, root))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want two", entries)
	}

	corpus := testCorpus(t)
	staticPricing, ok := corpus.Find("deepseek-v4-flash")
	if !ok {
		t.Fatal("deepseek-v4-flash is missing from the corpus")
	}
	lockedMillis, ok := ParseTSTimestamp("2026-05-01T01:02:03.000Z")
	if !ok {
		t.Fatal("fixture timestamp does not parse")
	}
	scheduledPricing, ok := corpus.FindAt("deepseek-v4-flash", lockedMillis)
	if !ok {
		t.Fatal("deepseek-v4-flash has no scheduled pricing")
	}
	priced := nativepricing.Usage{Input: 1_000_000}
	wantStatic := nativepricing.CostFromPricing(priced, staticPricing, false)
	wantScheduled := nativepricing.CostFromPricing(priced, scheduledPricing, false)
	if wantStatic == wantScheduled {
		t.Fatalf("expected the static and scheduled rates to differ, both are %v", wantStatic)
	}

	bySession := map[string]Entry{}
	for _, entry := range entries {
		bySession[entry.SessionID] = entry
	}
	dated, ok := bySession["dated"]
	if !ok {
		t.Fatalf("entries = %+v, want a dated entry", entries)
	}
	undated, ok := bySession["undated"]
	if !ok {
		t.Fatalf("entries = %+v, want an undated entry", entries)
	}
	if dated.CostUSD != wantScheduled {
		t.Fatalf("dated cost = %v, want the scheduled %v", dated.CostUSD, wantScheduled)
	}
	if undated.CostUSD != wantStatic {
		t.Fatalf("undated cost = %v, want the static %v", undated.CostUSD, wantStatic)
	}
	if undated.Timestamp <= 0 {
		t.Fatalf("undated timestamp = %d, want the file mtime", undated.Timestamp)
	}
	if undated.CostUSD == wantScheduled {
		t.Fatal("mtime fallback was used as a pricing timestamp")
	}
}

// TestDroidDedupKeepsNewestSnapshotPerSession pins loader.rs:41-51: files are
// sorted, entries are stably sorted by timestamp and then walked in reverse, so
// the first hit per session id is its newest snapshot.
func TestDroidDedupKeepsNewestSnapshotPerSession(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "archive", "session-c.settings.json"), `{
		"model": "gpt-5",
		"providerLock": "openai",
		"providerLockTimestamp": "2026-05-01T01:02:03.000Z",
		"tokenUsage": {"inputTokens": 10, "outputTokens": 20}
	}`)
	writeFile(t, filepath.Join(root, "session-c.settings.json"), `{
		"model": "gpt-5",
		"providerLock": "openai",
		"providerLockTimestamp": "2026-05-02T01:02:03.000Z",
		"tokenUsage": {"inputTokens": 100, "outputTokens": 200}
	}`)
	entries, err := LoadDroid(droidOptions(t, root))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want the newest snapshot only", entries)
	}
	if entries[0].SessionID != "session-c" || entries[0].Usage.Input != 100 || entries[0].Usage.Output != 200 {
		t.Fatalf("entry = %+v, want the 2026-05-02 snapshot", entries[0])
	}
	if entries[0].Date != "2026-05-02" {
		t.Fatalf("date = %q, want the newest snapshot's day", entries[0].Date)
	}
}

// TestDroidProviderPrefixCandidatesFirstPositiveWins pins droid_model_candidates
// (parser.rs:181-209) and calculate_droid_cost's loop (parser.rs:145-165): the
// candidate chain starts with the bare model and then the provider's prefixes,
// and the first candidate that prices above zero wins even when an earlier
// candidate resolves to a zero-rate placeholder.
func TestDroidProviderPrefixCandidatesFirstPositiveWins(t *testing.T) {
	candidates := map[string][]string{
		"anthropic": {"m", "anthropic/m", "openrouter/anthropic/m"},
		"openai":    {"m", "openai/m", "openrouter/openai/m"},
		"google":    {"m", "google/m", "vertex_ai/m", "openrouter/google/m"},
		"xai":       {"m", "xai/m", "openrouter/x-ai/m"},
		"deepseek":  {"m", "deepseek/m", "openrouter/deepseek/m"},
		"unknown":   {"m"},
	}
	for provider, want := range candidates {
		got := droidModelCandidates("m", provider)
		if len(got) != len(want) {
			t.Fatalf("candidates(%s) = %v, want %v", provider, got, want)
		}
		for index := range want {
			if got[index] != want[index] {
				t.Fatalf("candidates(%s) = %v, want %v", provider, got, want)
			}
		}
	}

	root := t.TempDir()
	writeFile(t, filepath.Join(root, "session.settings.json"), `{
		"model": "claude-opus-4-5",
		"providerLock": "anthropic",
		"providerLockTimestamp": "2026-05-01T01:02:03.000Z",
		"tokenUsage": {"inputTokens": 1000, "outputTokens": 500}
	}`)
	zeroPlaceholder := nativepricing.Corpus{Models: map[string]nativepricing.CorpusModel{
		"claude-opus-4-5":           {},
		"anthropic/claude-opus-4-5": {Input: 1e-6, Output: 1e-6},
	}}
	options := droidOptions(t, root)
	options.Corpus = zeroPlaceholder
	entries, err := LoadDroid(options)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want one", entries)
	}
	want := nativepricing.CostFromPricing(
		nativepricing.Usage{Input: 1000, Output: 500},
		zeroPlaceholder.Models["anthropic/claude-opus-4-5"],
		false,
	)
	if want <= 0 {
		t.Fatal("fixture pricing must be positive")
	}
	if entries[0].CostUSD != want {
		t.Fatalf("cost = %v, want the prefixed candidate's %v", entries[0].CostUSD, want)
	}

	allZero := nativepricing.Corpus{Models: map[string]nativepricing.CorpusModel{
		"claude-opus-4-5": {},
	}}
	options.Corpus = allZero
	entries, err = LoadDroid(options)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].CostUSD != 0 {
		t.Fatalf("entries = %+v, want a zero cost when every candidate prices at zero", entries)
	}
}

// TestDroidSidecarModelFallback pins extract_model_from_sidecar_jsonl
// (parser.rs:301-332): without settings.model the sibling
// `<prefix>.jsonl` is scanned for the first `Model:` line within its first 500
// lines; past that the provider default applies.
func TestDroidSidecarModelFallback(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "session-b.settings.json"), `{
		"providerLock": "anthropic",
		"providerLockTimestamp": "2026-05-02T01:02:03.000Z",
		"tokenUsage": {"inputTokens": 10, "outputTokens": 20}
	}`)
	writeFile(t, filepath.Join(root, "session-b.jsonl"),
		`{"content":"Model: Claude Opus 4.5 Thinking [Anthropic]"}`+"\n")
	entries, err := LoadDroid(droidOptions(t, root))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Model != "claude-opus-4-5-thinking" {
		t.Fatalf("entries = %+v, want the sidecar model", entries)
	}

	late := t.TempDir()
	writeFile(t, filepath.Join(late, "session-d.settings.json"), `{
		"providerLock": "anthropic",
		"providerLockTimestamp": "2026-05-02T01:02:03.000Z",
		"tokenUsage": {"inputTokens": 10, "outputTokens": 20}
	}`)
	content := ""
	for line := 0; line < 500; line++ {
		content += "{\"content\":\"filler\"}\n"
	}
	content += `{"content":"Model: too-late [Anthropic]"}` + "\n"
	writeFile(t, filepath.Join(late, "session-d.jsonl"), content)
	entries, err = LoadDroid(droidOptions(t, late))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Model != "claude-unknown" {
		t.Fatalf("entries = %+v, want the provider default past 500 lines", entries)
	}
}

// TestDroidBadFilesAreSkipped pins the loader's per-file tolerance
// (loader.rs:29-40): unreadable JSON, non-object documents, a missing
// tokenUsage and an all-zero usage each drop only their own file.
func TestDroidBadFilesAreSkipped(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "broken.settings.json"), `{"tokenUsage": [`)
	writeFile(t, filepath.Join(root, "array.settings.json"), `[]`)
	writeFile(t, filepath.Join(root, "nousage.settings.json"), `{"model":"gpt-5"}`)
	writeFile(t, filepath.Join(root, "zero.settings.json"), `{"model":"gpt-5","tokenUsage":{"inputTokens":0}}`)
	writeFile(t, filepath.Join(root, "good.settings.json"), `{
		"model": "gpt-5",
		"providerLock": "openai",
		"providerLockTimestamp": "2026-05-01T01:02:03.000Z",
		"tokenUsage": {"inputTokens": 7}
	}`)
	entries, err := LoadDroid(droidOptions(t, root))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].SessionID != "good" || entries[0].Usage.Input != 7 {
		t.Fatalf("entries = %+v, want only the good settings file", entries)
	}
}

// TestDroidDefaultsToFactorySessions pins the default root
// (paths.rs:22-41): HOME/.factory/sessions, with DROID_SESSIONS_DIR unset.
func TestDroidDefaultsToFactorySessions(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".factory", "sessions", "session.settings.json"), `{
		"model": "gpt-5",
		"providerLockTimestamp": "2026-05-01T01:02:03.000Z",
		"tokenUsage": {"inputTokens": 3}
	}`)
	options := Options{
		Env:      func(string) (string, bool) { return "", false },
		HomeDir:  func() (string, error) { return home, nil },
		Timezone: "UTC",
		Corpus:   testCorpus(t),
	}
	entries, err := LoadDroid(options)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].SessionID != "session" {
		t.Fatalf("entries = %+v, want the default root's entry", entries)
	}
}
