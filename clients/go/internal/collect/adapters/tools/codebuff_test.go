package tools

// The Codebuff adapter's rules, pinned against ccusage v20.0.33 (commit
// 1308c416): rust/adapters/codebuff/src/{parser,loader}.rs.

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// codebuffOptions builds Options with CODEBUFF_DATA_DIR pointing at root.
func codebuffOptions(t *testing.T, root string) Options {
	t.Helper()
	return Options{
		Env: func(key string) (string, bool) {
			if key == "CODEBUFF_DATA_DIR" {
				return root, true
			}
			return "", false
		},
		Timezone: "UTC",
		Corpus:   testCorpus(t),
	}
}

// writeCodebuffChat writes <root>/projects/<project>/chats/<chatID>/chat-messages.json.
func writeCodebuffChat(t *testing.T, root, project, chatID, content string) {
	t.Helper()
	writeFile(t, filepath.Join(root, "projects", project, "chats", chatID, "chat-messages.json"), content)
}

// TestCodebuffFallsBackThroughUsageSources pins extract_assistant_usage and
// parse_usage_object (parser.rs:136-264): each field is filled from the first
// source that carries a positive value - metadata.usage, metadata.codebuff.usage
// then the runState history's assistant providerOptions - through the documented
// alias keys, with cacheRead taking the maximum alias and totalTokens filling
// the gap.
func TestCodebuffFallsBackThroughUsageSources(t *testing.T) {
	root := t.TempDir()
	writeCodebuffChat(t, root, "project-a", "chat-merged", `[
		{"role":"user","text":"hello"},
		{"id":"merged","role":"assistant","timestamp":"2026-01-02T03:04:05.000Z","metadata":{
			"usage":{"inputTokens":100},
			"codebuff":{"usage":{"outputTokens":50}},
			"runState":{"sessionState":{"mainAgentState":{"messageHistory":[
				{"role":"user","providerOptions":{}},
				{"role":"assistant","providerOptions":{"codebuff":{"model":"openai/gpt-5","usage":{"cacheReadInputTokens":10,"cacheCreationInputTokens":20}}}}
			]}}}
		}}
	]`)
	writeCodebuffChat(t, root, "project-a", "chat-aliases", `[
		{"id":"aliases","variant":"agent","metadata":{"usage":{
			"promptTokens":5,
			"completionTokens":6,
			"cacheReadInputTokens":3,
			"prompt_tokens_details":{"cached_tokens":7},
			"cachedTokensCreated":8,
			"totalTokens":40
		}}}
	]`)
	entries, err := LoadCodebuff(codebuffOptions(t, root))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want two", entries)
	}
	byMessage := map[string]Entry{}
	for _, entry := range entries {
		byMessage[entry.MessageID] = entry
	}
	channel := filepath.Base(root)
	merged, ok := byMessage["codebuff:"+channel+"/project-a/chat-merged:merged"]
	if !ok {
		t.Fatalf("entries = %+v, want the merged message", entries)
	}
	if merged.Usage != (Usage{Input: 100, Output: 50, CacheCreation: 20, CacheRead: 10}) {
		t.Fatalf("merged usage = %+v, want every field filled from its own source", merged.Usage)
	}
	if merged.Model != "openai/gpt-5" {
		t.Fatalf("merged model = %q, want the runState codebuff model", merged.Model)
	}
	aliases, ok := byMessage["codebuff:"+channel+"/project-a/chat-aliases:aliases"]
	if !ok {
		t.Fatalf("entries = %+v, want the alias message", entries)
	}
	if aliases.Usage != (Usage{Input: 5, Output: 6, CacheCreation: 8, CacheRead: 7, Extra: 14}) {
		t.Fatalf("aliases usage = %+v, want the alias keys, max cacheRead and the total fallback", aliases.Usage)
	}
	if aliases.Usage.Total() != 40 {
		t.Fatalf("aliases total = %d, want the reported 40", aliases.Usage.Total())
	}
}

// TestCodebuffSessionIDFromChannelProjectChat pins derive_context
// (parser.rs:97-125): the session id is `{channel}/{project}/{chatId}` where the
// channel is the data root's directory name (`manicode` when the path is too
// shallow), the project is the chats directory's grandparent and the chat id is
// the chat-messages.json parent.
func TestCodebuffSessionIDFromChannelProjectChat(t *testing.T) {
	root := t.TempDir()
	writeCodebuffChat(t, root, "project-a", "chat-1", `[
		{"id":"m","role":"assistant","timestamp":"2026-01-02T03:04:05.000Z","metadata":{"usage":{"inputTokens":1}}}
	]`)
	entries, err := LoadCodebuff(codebuffOptions(t, root))
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Base(root) + "/project-a/chat-1"
	if len(entries) != 1 || entries[0].SessionID != want {
		t.Fatalf("entries = %+v, want session %q", entries, want)
	}

	home := t.TempDir()
	defaultRoot := filepath.Join(home, ".config", "manicode")
	writeCodebuffChat(t, defaultRoot, "project-a", "chat-1", `[
		{"id":"m","role":"assistant","timestamp":"2026-01-02T03:04:05.000Z","metadata":{"usage":{"inputTokens":1}}}
	]`)
	options := Options{
		Env:      func(string) (string, bool) { return "", false },
		HomeDir:  func() (string, error) { return home, nil },
		Timezone: "UTC",
		Corpus:   testCorpus(t),
	}
	entries, err = LoadCodebuff(options)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].SessionID != "manicode/project-a/chat-1" {
		t.Fatalf("entries = %+v, want the manicode channel", entries)
	}

	projectsRoot := filepath.Join(t.TempDir(), "projects")
	writeFile(t, filepath.Join(projectsRoot, "project-a", "chats", "chat-1", "chat-messages.json"), `[
		{"id":"m","role":"assistant","timestamp":"2026-01-02T03:04:05.000Z","metadata":{"usage":{"inputTokens":1}}}
	]`)
	entries, err = LoadCodebuff(codebuffOptions(t, projectsRoot))
	if err != nil {
		t.Fatal(err)
	}
	// The channel is the directory that holds `projects`, even when the data
	// root itself is named projects (parser.rs:113-120).
	want = filepath.Base(filepath.Dir(projectsRoot)) + "/project-a/chat-1"
	if len(entries) != 1 || entries[0].SessionID != want {
		t.Fatalf("entries = %+v, want session %q", entries, want)
	}
}

// TestCodebuffDedupLastWinsByIdThenOrdinal pins dedup_key (parser.rs:345-365)
// with loader.rs:41-52: entries with the same message id collapse last-wins,
// while id-less entries fall back to an ordinal-bearing key that keeps them
// distinct.
func TestCodebuffDedupLastWinsByIdThenOrdinal(t *testing.T) {
	root := t.TempDir()
	writeCodebuffChat(t, root, "project-a", "chat-by-id", `[
		{"id":"m-1","role":"assistant","timestamp":"2026-01-02T03:04:05.000Z","metadata":{"usage":{"inputTokens":1}}},
		{"id":"m-1","role":"assistant","timestamp":"2026-01-02T03:04:05.000Z","metadata":{"usage":{"inputTokens":9}}}
	]`)
	entries, err := LoadCodebuff(codebuffOptions(t, root))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Usage.Input != 9 {
		t.Fatalf("entries = %+v, want the last message id snapshot", entries)
	}

	root = t.TempDir()
	writeCodebuffChat(t, root, "project-a", "chat-no-id", `[
		{"role":"assistant","timestamp":"2026-01-02T03:04:05.000Z","metadata":{"usage":{"inputTokens":1}}},
		{"role":"assistant","timestamp":"2026-01-02T03:04:05.000Z","metadata":{"usage":{"inputTokens":1}}}
	]`)
	entries, err = LoadCodebuff(codebuffOptions(t, root))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want the ordinal to keep both id-less messages", entries)
	}
}

// TestCodebuffCreditsOnlyWhenPositive pins parser.rs:154-158 and
// loader.rs:84: a positive top-level credits value only fills a non-positive
// parsed one, zero is dropped, and the entry's model falls back to
// codebuff-unknown.
func TestCodebuffCreditsOnlyWhenPositive(t *testing.T) {
	root := t.TempDir()
	writeCodebuffChat(t, root, "project-a", "chat-credits", `[
		{"id":"a","role":"assistant","timestamp":"2026-01-02T03:04:05.000Z","credits":1.25,"metadata":{"usage":{"inputTokens":10}}},
		{"id":"b","role":"assistant","timestamp":"2026-01-02T03:04:05.000Z","credits":2,"metadata":{"usage":{"inputTokens":10,"credits":0.75}}},
		{"id":"c","role":"assistant","timestamp":"2026-01-02T03:04:05.000Z","metadata":{"usage":{"inputTokens":10}}},
		{"id":"d","role":"assistant","timestamp":"2026-01-02T03:04:05.000Z","credits":0,"metadata":{"usage":{"inputTokens":10}}}
	]`)
	entries, err := LoadCodebuff(codebuffOptions(t, root))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 4 {
		t.Fatalf("entries = %+v, want four", entries)
	}
	byID := map[string]Entry{}
	for _, entry := range entries {
		byID[entry.MessageID] = entry
	}
	session := filepath.Base(root) + "/project-a/chat-credits"
	if got := byID["codebuff:"+session+":a"].Credits; got == nil || *got != 1.25 {
		t.Fatalf("credits(a) = %v, want 1.25", got)
	}
	if got := byID["codebuff:"+session+":b"].Credits; got == nil || *got != 0.75 {
		t.Fatalf("credits(b) = %v, want the usage-level 0.75", got)
	}
	if got := byID["codebuff:"+session+":c"].Credits; got != nil {
		t.Fatalf("credits(c) = %v, want nil", *got)
	}
	if got := byID["codebuff:"+session+":d"].Credits; got != nil {
		t.Fatalf("credits(d) = %v, want nil for a zero", *got)
	}
	if model := byID["codebuff:"+session+":c"].Model; model != "codebuff-unknown" {
		t.Fatalf("model = %q, want the codebuff-unknown default", model)
	}
}

// TestCodebuffUnixEpochFallback pins message_timestamp and the file fallback
// chain (parser.rs:299-343): message.timestamp then createdAt then
// metadata.timestamp, seconds scaled to milliseconds, the chat directory's
// embedded timestamp next, and the file mtime last. The only remaining
// fallback, UNIX_EPOCH, is unreachable once the file has been read (a stat
// failure cannot be staged from a test), so the mtime case is the last
// observable step.
func TestCodebuffUnixEpochFallback(t *testing.T) {
	root := t.TempDir()
	fixedMtime := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	path := filepath.Join(root, "projects", "project-a", "chats", "chat-x", "chat-messages.json")
	writeFile(t, path, `[
		{"id":"seconds","role":"assistant","timestamp":1790000000,"metadata":{"usage":{"inputTokens":1}}},
		{"id":"zero","role":"assistant","timestamp":0,"createdAt":"2026-01-02T03:04:06.000Z","metadata":{"usage":{"inputTokens":1}}},
		{"id":"metadata","role":"assistant","metadata":{"timestamp":"2026-01-02T03:04:07.000Z","usage":{"inputTokens":1}}}
	]`)
	if err := os.Chtimes(path, fixedMtime, fixedMtime); err != nil {
		t.Fatal(err)
	}
	entries, err := LoadCodebuff(codebuffOptions(t, root))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 {
		t.Fatalf("entries = %+v, want three", entries)
	}
	byID := map[string]Entry{}
	for _, entry := range entries {
		byID[entry.MessageID] = entry
	}
	session := filepath.Base(root) + "/project-a/chat-x"
	if got := byID["codebuff:"+session+":seconds"].Timestamp; got != 1_790_000_000_000 {
		t.Fatalf("seconds timestamp = %d, want the millisecond value", got)
	}
	createdAt, ok := ParseTSTimestamp("2026-01-02T03:04:06.000Z")
	if !ok {
		t.Fatal("fixture timestamp does not parse")
	}
	if got := byID["codebuff:"+session+":zero"].Timestamp; got != createdAt {
		t.Fatalf("zero timestamp = %d, want the createdAt fallback %d", got, createdAt)
	}
	metadataAt, ok := ParseTSTimestamp("2026-01-02T03:04:07.000Z")
	if !ok {
		t.Fatal("fixture timestamp does not parse")
	}
	if got := byID["codebuff:"+session+":metadata"].Timestamp; got != metadataAt {
		t.Fatalf("metadata timestamp = %d, want %d", got, metadataAt)
	}

	chatRoot := t.TempDir()
	writeCodebuffChat(t, chatRoot, "project-a", "2026-01-02T03-04-05.000Z", `[
		{"id":"chat","role":"assistant","metadata":{"usage":{"inputTokens":1}}}
	]`)
	entries, err = LoadCodebuff(codebuffOptions(t, chatRoot))
	if err != nil {
		t.Fatal(err)
	}
	chatAt, ok := ParseTSTimestamp("2026-01-02T03:04:05.000Z")
	if !ok {
		t.Fatal("fixture timestamp does not parse")
	}
	if len(entries) != 1 || entries[0].Timestamp != chatAt {
		t.Fatalf("entries = %+v, want the chat id's timestamp %d", entries, chatAt)
	}
	if entries[0].Date != "2026-01-02" {
		t.Fatalf("date = %q, want the chat id's day", entries[0].Date)
	}

	mtimeRoot := t.TempDir()
	mtimeChat := filepath.Join(mtimeRoot, "projects", "project-a", "chats", "chat-x", "chat-messages.json")
	writeFile(t, mtimeChat, `[
		{"id":"mtime","role":"assistant","metadata":{"usage":{"inputTokens":1}}}
	]`)
	if err := os.Chtimes(mtimeChat, fixedMtime, fixedMtime); err != nil {
		t.Fatal(err)
	}
	entries, err = LoadCodebuff(codebuffOptions(t, mtimeRoot))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Timestamp != fixedMtime.UnixMilli() || entries[0].Timestamp == 0 {
		t.Fatalf("entries = %+v, want the file mtime fallback", entries)
	}
}

// TestCodebuffNonAssistantAndEmptyRowsAreSkipped pins is_assistant_message and
// has_signal (parser.rs:127-134, 290-297): variant wins over role, only
// ai/agent/assistant count, and a usage with no tokens and no credits produces
// no entry.
func TestCodebuffNonAssistantAndEmptyRowsAreSkipped(t *testing.T) {
	root := t.TempDir()
	writeCodebuffChat(t, root, "project-a", "chat-filter", `[
		"not-an-object",
		{"variant":"user","role":"assistant","metadata":{"usage":{"inputTokens":99}}},
		{"role":"ai","metadata":{"usage":{"inputTokens":1}}},
		{"role":"assistant","metadata":{"usage":{"inputTokens":0,"outputTokens":0}}}
	]`)
	entries, err := LoadCodebuff(codebuffOptions(t, root))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Usage.Input != 1 {
		t.Fatalf("entries = %+v, want only the ai message with tokens", entries)
	}
}
