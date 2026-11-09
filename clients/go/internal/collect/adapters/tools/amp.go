package tools

// The Amp adapter, ported from ccusage v20.0.33 (commit 1308c416):
// rust/adapters/amp/src/{paths,parser,loader}.rs.

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

// ampDefaultDataDir is the default root (paths.rs:26).
var ampDefaultDataDir = []string{"~/.local/share/amp"}

// LoadAmp reads every thread file under each root's threads directory.
func LoadAmp(o Options) ([]Entry, error) {
	roots, err := resolveRoots(o, "AMP_DATA_DIR", ampDefaultDataDir, isDirectory)
	if err != nil {
		return nil, err
	}
	entries := []Entry{}
	for _, root := range roots {
		files := CollectFiles(filepath.Join(root, "threads"), func(name string) bool {
			return strings.HasSuffix(name, ".json")
		})
		for _, file := range files {
			content, err := os.ReadFile(file)
			if err != nil {
				o.debugf("Failed to read Amp thread file " + file + ": " + err.Error())
				continue
			}
			parsed, err := parseAmpThread(content, o)
			if err != nil {
				o.debugf("Failed to read Amp thread file " + file + ": " + err.Error())
				continue
			}
			entries = append(entries, parsed...)
		}
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Timestamp < entries[j].Timestamp })
	return entries, nil
}

func isDirectory(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// parseAmpThread is read_thread_file (parser.rs:96-116): a whole file is one
// JSON object; any decode failure or a missing id yields no entries.
func parseAmpThread(content []byte, o Options) ([]Entry, error) {
	// serde_json::from_slice rejects a document that is not UTF-8, so a file
	// with a stray byte is dropped. Decoding through a string would replace it
	// with U+FFFD and keep the file.
	if !utf8.Valid(content) {
		return nil, nil
	}
	var thread any
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	if err := decoder.Decode(&thread); err != nil {
		return nil, err
	}
	// serde_json::from_slice rejects trailing content, so a second value or
	// junk after the object fails the whole file rather than being ignored.
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, nil
	}
	object, ok := LenientObject(thread)
	if !ok {
		return nil, nil
	}
	threadID, ok := NonEmptyString(object["id"])
	if !ok {
		return nil, nil
	}
	messages, _ := object["messages"].([]any)
	if ledger, ok := LenientObject(object["usageLedger"]); ok {
		if events, ok := ledger["events"].([]any); ok {
			return parseAmpLedgerEvents(events, ampCacheByMessageID(messages), threadID, o), nil
		}
	}
	return parseAmpMessages(messages, threadID, o), nil
}

// ampCacheByMessageID is cache_tokens_by_message_id (parser.rs:331-352): cache
// creation/read keyed by an assistant message's integer messageId.
func ampCacheByMessageID(messages []any) map[int64][2]uint64 {
	cache := map[int64][2]uint64{}
	for _, raw := range messages {
		message, ok := LenientObject(raw)
		if !ok {
			continue
		}
		if role, _ := NonEmptyString(message["role"]); role != "assistant" {
			continue
		}
		id, ok := message["messageId"].(json.Number)
		if !ok {
			continue
		}
		key, err := id.Int64()
		if err != nil {
			continue
		}
		usage, _ := LenientObject(message["usage"])
		cache[key] = [2]uint64{
			LenientU64(usage["cacheCreationInputTokens"]),
			LenientU64(usage["cacheReadInputTokens"]),
		}
	}
	return cache
}

// parseAmpLedgerEvents is parse_ledger_events (parser.rs:121-221).
func parseAmpLedgerEvents(events []any, cache map[int64][2]uint64, threadID string, o Options) []Entry {
	entries := []Entry{}
	for _, raw := range events {
		event, ok := LenientObject(raw)
		if !ok {
			continue
		}
		timestampText, ok := NonEmptyString(event["timestamp"])
		if !ok {
			continue
		}
		millis, ok := ParseTSTimestamp(timestampText)
		if !ok {
			continue
		}
		model, ok := NonEmptyString(event["model"])
		if !ok {
			continue
		}
		tokens, ok := LenientObject(event["tokens"])
		if !ok {
			continue
		}
		var joined [2]uint64
		if id, ok := event["toMessageId"].(json.Number); ok {
			if key, err := id.Int64(); err == nil {
				joined = cache[key]
			}
		}
		usage := Usage{
			Input:         LenientU64(tokens["input"]),
			Output:        LenientU64(tokens["output"]),
			CacheCreation: joined[0],
			CacheRead:     joined[1],
		}
		ApplyTotalFallback(&usage, LenientU64(tokens["total"]))
		if usage.Total() == 0 {
			continue
		}
		entry := Entry{
			Timestamp:   millis,
			Date:        FormatDateTZ(millis, o.Timezone),
			Model:       model,
			Usage:       usage,
			SessionID:   threadID,
			MessageID:   ampMessageID(event["id"]),
			ProjectPath: "Amp",
			Credits:     optionalFloat(event["credits"]),
		}
		PriceEntry(o.Corpus, &entry, []string{model}, PriceAt(entry.Timestamp), o.Mode, LookupFindAt)
		entries = append(entries, entry)
	}
	return entries
}

// parseAmpMessages is parse_message_usage (parser.rs:223-329).
func parseAmpMessages(messages []any, threadID string, o Options) []Entry {
	entries := []Entry{}
	for _, raw := range messages {
		message, ok := LenientObject(raw)
		if !ok {
			continue
		}
		if role, _ := NonEmptyString(message["role"]); role != "assistant" {
			continue
		}
		usageObject, ok := LenientObject(message["usage"])
		if !ok {
			continue
		}
		timestampText, ok := NonEmptyString(usageObject["timestamp"])
		if !ok {
			timestampText, ok = NonEmptyString(message["timestamp"])
		}
		if !ok {
			continue
		}
		millis, ok := ParseTSTimestamp(timestampText)
		if !ok {
			continue
		}
		model, ok := NonEmptyString(usageObject["model"])
		if !ok {
			model, ok = NonEmptyString(message["model"])
		}
		if !ok {
			continue
		}
		usage := Usage{
			Input:         LenientU64(usageObject["inputTokens"]),
			Output:        LenientU64(usageObject["outputTokens"]),
			CacheCreation: LenientU64(usageObject["cacheCreationInputTokens"]),
			CacheRead:     LenientU64(usageObject["cacheReadInputTokens"]),
		}
		ApplyTotalFallback(&usage, LenientU64(usageObject["totalTokens"]))
		if usage.Total() == 0 {
			continue
		}
		entry := Entry{
			Timestamp:   millis,
			Date:        FormatDateTZ(millis, o.Timezone),
			Model:       model,
			Usage:       usage,
			SessionID:   threadID,
			MessageID:   ampMessageID(message["messageId"]),
			ProjectPath: "Amp",
			Credits:     optionalFloat(usageObject["credits"]),
		}
		PriceEntry(o.Corpus, &entry, []string{model}, PriceAt(entry.Timestamp), o.Mode, LookupFindAt)
		entries = append(entries, entry)
	}
	return entries
}

// ampMessageID reads a message id that may be a number or a string.
func ampMessageID(value any) string {
	if number, ok := value.(json.Number); ok {
		return number.String()
	}
	if text, ok := NonEmptyString(value); ok {
		return text
	}
	return ""
}

// optionalFloat is Value::as_f64 as an optional: a present 0 stays Some(0).
func optionalFloat(value any) *float64 {
	parsed, ok := LenientF64(value)
	if !ok {
		return nil
	}
	return &parsed
}
