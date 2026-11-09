package tools

// The Gemini CLI adapter, ported from ccusage v20.0.33 (commit 1308c416):
// rust/adapters/gemini/src/{paths,parser,loader}.rs.
//
// Unlike the other tool adapters, Gemini logs come in two shapes that share one
// record envelope: per-line JSONL transcripts (a small state machine carries the
// session id and model across lines) and whole-file JSON documents holding a
// messages array, a single direct event or a stats block. Both feed the same
// event builder, so cached-token normalisation and total-token backfill happen
// in exactly one place.

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// geminiDefaultDataDirs is the default discovery root (paths.rs:25-30).
var geminiDefaultDataDirs = []string{"~/.gemini/tmp"}

// geminiProviderPrefixes is PROVIDER_PREFIXES (parser.rs:15): the candidate
// order the pricing table is asked in, before the bare model name.
var geminiProviderPrefixes = []string{"google", "gemini", "vertex_ai", "openrouter/google"}

// geminiDefaultModel is DEFAULT_MODEL for the stats path (parser.rs:14).
const geminiDefaultModel = "unknown"

// LoadGemini reads every .json and .jsonl log under each root (paths.rs:34-44)
// and returns the parsed entries ordered by timestamp.
func LoadGemini(o Options) ([]Entry, error) {
	roots, err := resolveRoots(o, "GEMINI_DATA_DIR", geminiDefaultDataDirs, isDirectory)
	if err != nil {
		return nil, err
	}
	files := []string{}
	for _, root := range roots {
		files = append(files, CollectFiles(root, func(name string) bool {
			file := filepath.Base(name)
			dot := strings.LastIndexByte(file, '.')
			if dot <= 0 {
				return false
			}
			switch file[dot+1:] {
			case "json", "jsonl":
				return true
			}
			return false
		})...)
	}
	sort.Strings(files)
	files = DedupePaths(files)
	entries := []Entry{}
	for _, file := range files {
		if geminiIsJSONL(file) {
			entries = append(entries, parseGeminiJSONLFile(file, o)...)
		} else {
			entries = append(entries, parseGeminiJSONFile(file, o)...)
		}
	}
	// events.sort_by_key(|event| event.timestamp) in loader.rs:39: stable, so
	// equal timestamps keep file order and, inside a file, line order.
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Timestamp < entries[j].Timestamp })
	return entries, nil
}

// geminiIsJSONL mirrors Path::extension() == "jsonl" (loader.rs:26-29): a
// leading dot does not introduce an extension.
func geminiIsJSONL(file string) bool {
	base := filepath.Base(file)
	dot := strings.LastIndexByte(base, '.')
	return dot > 0 && base[dot+1:] == "jsonl"
}

// geminiTokens is GeminiTokens (parser.rs:91-99). Every count goes through the
// float-tolerant reader, unlike the shared integer-only lenient_u64.
type geminiTokens struct {
	Input, Output, Cached, Thoughts, Tool uint64
	Total                                 uint64
	HasTotal                              bool
}

// parseGeminiJSONFile is parse_json_file (parser.rs:115-163). The three
// branches are tried in order: a messages array, a single top-level direct
// event, then the stats block.
func parseGeminiJSONFile(file string, o Options) []Entry {
	fallback := geminiFileModifiedMillis(file)
	content, err := os.ReadFile(file)
	if err != nil {
		o.debugf("Failed to read Gemini log file " + file + ": " + err.Error())
		return nil
	}
	record, ok := geminiDecodeObject(content)
	if !ok {
		return nil
	}
	sessionID := geminiSessionID(record, file)
	sessionTimestamp := fallback
	if millis, ok := geminiRawTimestamp(record, "startTime"); ok {
		sessionTimestamp = millis
	} else if millis, ok := geminiRawTimestamp(record, "lastUpdated"); ok {
		sessionTimestamp = millis
	}
	if messages, ok := record["messages"].([]any); ok {
		entries := make([]Entry, 0, len(messages))
		for _, raw := range messages {
			message, ok := LenientObject(raw)
			if !ok {
				continue
			}
			// The messages branch compares the raw, untrimmed discriminator.
			if kind, _ := message["type"].(string); kind != "gemini" {
				continue
			}
			if entry, ok := geminiDirectEvent(message, "", false, sessionID, sessionTimestamp, o); ok {
				entries = append(entries, entry)
			}
		}
		return entries
	}
	if kind, _ := record["type"].(string); kind == "gemini" {
		entry, ok := geminiDirectEvent(record, "", false, sessionID, fallback, o)
		if !ok {
			return nil
		}
		return []Entry{entry}
	}
	stats, present := geminiStatsValue(record)
	if !present {
		return nil
	}
	timestamp := fallback
	if millis, ok := geminiRawTimestamp(record, "timestamp"); ok {
		timestamp = millis
	}
	hint, hasHint := NonEmptyString(record["model"])
	return geminiStatsEvents(stats, hint, hasHint, sessionID, timestamp, o)
}

// parseGeminiJSONLFile is parse_jsonl_file (parser.rs:165-219): a line-level
// state machine. sessionId/session_id and model set state subsequent lines
// inherit, a direct event with an id replaces the earlier event carrying the
// same id in place, and anything else contributes its stats block.
func parseGeminiJSONLFile(file string, o Options) []Entry {
	fallback := geminiFileModifiedMillis(file)
	content, err := os.ReadFile(file)
	if err != nil {
		o.debugf("Failed to read Gemini log file " + file + ": " + err.Error())
		return nil
	}
	sessionID := geminiFileStem(file)
	currentModel := ""
	hasCurrentModel := false
	entries := []Entry{}
	directIndexes := map[string]int{}
	for _, raw := range strings.Split(string(content), "\n") {
		line := strings.TrimSuffix(raw, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		record, ok := geminiDecodeObject([]byte(line))
		if !ok {
			continue
		}
		if value, ok := NonEmptyString(record["sessionId"]); ok {
			sessionID = value
		} else if value, ok := NonEmptyString(record["session_id"]); ok {
			sessionID = value
		}
		if value, ok := NonEmptyString(record["model"]); ok {
			currentModel, hasCurrentModel = value, true
		}
		if kind, _ := record["type"].(string); kind == "gemini" {
			entry, ok := geminiDirectEvent(record, currentModel, hasCurrentModel, sessionID, fallback, o)
			if !ok {
				continue
			}
			if id, ok := NonEmptyString(record["id"]); ok {
				if index, seen := directIndexes[id]; seen {
					entries[index] = entry
				} else {
					directIndexes[id] = len(entries)
					entries = append(entries, entry)
				}
			} else {
				entries = append(entries, entry)
			}
			continue
		}
		stats, present := geminiStatsValue(record)
		if !present {
			continue
		}
		timestamp := fallback
		if millis, ok := geminiRawTimestamp(record, "timestamp"); ok {
			timestamp = millis
		}
		entries = append(entries, geminiStatsEvents(stats, currentModel, hasCurrentModel, sessionID, timestamp, o)...)
	}
	return entries
}

// geminiDirectEvent is parse_direct_event (parser.rs:221-269): the model comes
// from the record, else the inherited hint, and the timestamp from `timestamp`,
// else `created_at`, else the caller's fallback.
func geminiDirectEvent(record map[string]any, hint string, hasHint bool, sessionID string, fallback int64, o Options) (Entry, bool) {
	tokens, ok := geminiParseTokens(record["tokens"])
	if !ok {
		return Entry{}, false
	}
	timestamp := fallback
	if millis, ok := geminiRawTimestamp(record, "timestamp"); ok {
		timestamp = millis
	} else if millis, ok := geminiRawTimestamp(record, "created_at"); ok {
		timestamp = millis
	}
	model, ok := NonEmptyString(record["model"])
	if !ok && hasHint {
		model, ok = hint, true
	}
	if !ok {
		return Entry{}, false
	}
	messageID, _ := NonEmptyString(record["id"])
	return geminiBuildEvent(model, sessionID, timestamp, tokens, geminiNormalizeSessionInput, messageID, o)
}

// geminiStatsEvents is parse_stats_events (parser.rs:271-313). A models map is
// expanded into one event per model (serde_json iterates the map in key order);
// only when that yields nothing does the stats object itself count as one
// token record.
func geminiStatsEvents(stats any, hint string, hasHint bool, sessionID string, timestamp int64, o Options) []Entry {
	object, ok := LenientObject(stats)
	if !ok {
		return nil
	}
	if models, ok := LenientObject(object["models"]); ok {
		keys := make([]string, 0, len(models))
		for model := range models {
			keys = append(keys, model)
		}
		sort.Strings(keys)
		entries := make([]Entry, 0, len(keys))
		for _, model := range keys {
			data, ok := LenientObject(models[model])
			if !ok {
				continue
			}
			tokens, ok := geminiParseTokens(data["tokens"])
			if !ok {
				continue
			}
			if entry, ok := geminiBuildEvent(model, sessionID, timestamp, tokens, geminiSubtractCachedOverlap, "", o); ok {
				entries = append(entries, entry)
			}
		}
		if len(entries) > 0 {
			return entries
		}
	}
	tokens, ok := geminiParseTokens(object)
	if !ok {
		return nil
	}
	model := geminiDefaultModel
	if hasHint {
		model = hint
	}
	entry, ok := geminiBuildEvent(model, sessionID, timestamp, tokens, geminiSubtractCachedOverlap, "", o)
	if !ok {
		return nil
	}
	return []Entry{entry}
}

// geminiBuildEvent is build_event (parser.rs:315-358). The extra bucket the
// REPORT carries is recomputed in event_to_loaded (parser.rs:460-462) as
// total - (input + output + cache_read), which differs from the fallback extra
// whenever the reported total is smaller than the named buckets; the cost usage
// keeps billing output + the fallback extra (parser.rs:455-459).
func geminiBuildEvent(model, sessionID string, timestamp int64, tokens geminiTokens, normalize func(geminiTokens) (uint64, uint64), messageID string, o Options) (Entry, bool) {
	if strings.TrimSpace(model) == "" {
		return Entry{}, false
	}
	inputWithoutCache, cacheRead := normalize(tokens)
	input := SaturatingAddU64(inputWithoutCache, tokens.Tool)
	total := tokens.Total
	if !tokens.HasTotal {
		total = SaturatingAddU64(
			SaturatingAddU64(input, tokens.Output),
			SaturatingAddU64(cacheRead, tokens.Thoughts),
		)
	}
	usage := Usage{
		Input:     input,
		Output:    tokens.Output,
		CacheRead: cacheRead,
		Extra:     tokens.Thoughts,
	}
	ApplyTotalFallback(&usage, total)
	if usage.Input == 0 && usage.Output == 0 && usage.CacheRead == 0 && usage.Extra == 0 {
		return Entry{}, false
	}
	billedExtra := usage.Extra
	usage.Extra = SaturatingSubU64(total, SaturatingAddU64(
		SaturatingAddU64(usage.Input, usage.Output),
		usage.CacheRead,
	))
	entry := Entry{
		Timestamp:   timestamp,
		Date:        FormatDateTZ(timestamp, o.Timezone),
		Model:       model,
		Usage:       usage,
		SessionID:   sessionID,
		MessageID:   messageID,
		ProjectPath: "Gemini",
	}
	// calculate_gemini_cost (parser.rs:496-521) prices at the event timestamp
	// and bills output + the fallback extra, which PriceEntry reproduces by
	// folding Extra into the billed output.
	billed := entry
	billed.Usage.Extra = billedExtra
	PriceEntry(o.Corpus, &billed, geminiModelCandidates(model), PriceAt(timestamp), o.Mode, LookupFindAt)
	entry.CostUSD = billed.CostUSD
	entry.MissingPricing = billed.MissingPricing
	return entry, true
}

// geminiParseTokens is parse_tokens (parser.rs:360-384).
func geminiParseTokens(value any) (geminiTokens, bool) {
	record, ok := LenientObject(value)
	if !ok {
		return geminiTokens{}, false
	}
	tokens := geminiTokens{
		Input:    geminiTokenNumber(record, "input", "prompt", "input_tokens", "prompt_tokens"),
		Output:   geminiTokenNumber(record, "output", "candidates", "output_tokens", "candidates_tokens"),
		Cached:   geminiTokenNumber(record, "cached", "cached_tokens"),
		Thoughts: geminiTokenNumber(record, "thoughts", "reasoning", "thoughts_tokens", "reasoning_tokens"),
		Tool:     geminiTokenNumber(record, "tool", "tool_tokens"),
	}
	// value_u64(record.get("total").or_else(|| record.get("total_tokens"))):
	// a present-but-unusable `total` blocks the `total_tokens` fallback.
	if raw, ok := record["total"]; ok {
		if total, ok := geminiValueU64(raw); ok {
			tokens.Total, tokens.HasTotal = total, true
		}
	} else if raw, ok := record["total_tokens"]; ok {
		if total, ok := geminiValueU64(raw); ok {
			tokens.Total, tokens.HasTotal = total, true
		}
	}
	return tokens, true
}

// geminiTokenNumber is token_number (parser.rs:386-390): the first alias that
// reads back as a number, else zero.
func geminiTokenNumber(record map[string]any, keys ...string) uint64 {
	for _, key := range keys {
		if value, ok := geminiValueU64(record[key]); ok {
			return value
		}
	}
	return 0
}

// geminiValueU64 is value_u64 (parser.rs:392-398): any finite JSON number,
// clamped at zero and truncated, saturating at u64::MAX like Rust's `as u64`.
func geminiValueU64(value any) (uint64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	parsed, err := number.Float64()
	if err != nil {
		return 0, false
	}
	if parsed <= 0 {
		return 0, true
	}
	if parsed >= 18446744073709551615.0 {
		return ^uint64(0), true
	}
	return uint64(parsed), true
}

// geminiSubtractCachedOverlap is subtract_cached_overlap_tokens
// (parser.rs:400-404).
func geminiSubtractCachedOverlap(tokens geminiTokens) (uint64, uint64) {
	cacheRead := tokens.Cached
	cachedPortion := MinU64(tokens.Input, cacheRead)
	return SaturatingSubU64(tokens.Input, cachedPortion), cacheRead
}

// geminiNormalizeSessionInput is normalize_session_input (parser.rs:406-416):
// the split is only applied when the reported total is the cached-inclusive sum
// and not also the exclusive one.
func geminiNormalizeSessionInput(tokens geminiTokens) (uint64, uint64) {
	inclusive := SaturatingAddU64(
		SaturatingAddU64(tokens.Input, tokens.Output),
		SaturatingAddU64(tokens.Thoughts, tokens.Tool),
	)
	exclusive := SaturatingAddU64(inclusive, tokens.Cached)
	if tokens.Cached > 0 && tokens.HasTotal && tokens.Total == inclusive && tokens.Total != exclusive {
		return geminiSubtractCachedOverlap(tokens)
	}
	return tokens.Input, tokens.Cached
}

// geminiSessionID resolves the record's session id, falling back to the file
// stem (parser.rs:121-126).
func geminiSessionID(record map[string]any, file string) string {
	if value, ok := NonEmptyString(record["sessionId"]); ok {
		return value
	}
	if value, ok := NonEmptyString(record["session_id"]); ok {
		return value
	}
	return geminiFileStem(file)
}

// geminiStatsValue is GeminiRecord::stats (parser.rs:84-88): the top-level
// stats when present (a JSON null counts as absent, matching Option<Value>),
// else result.stats.
func geminiStatsValue(record map[string]any) (any, bool) {
	if stats, ok := record["stats"]; ok && stats != nil {
		return stats, true
	}
	if result, ok := LenientObject(record["result"]); ok {
		if stats, ok := result["stats"]; ok && stats != nil {
			return stats, true
		}
	}
	return nil, false
}

// geminiRawTimestamp reads one of the untrimmed string timestamp fields and
// runs it through the strict length gate (parser.rs:418-425). Non-strings and
// rejected spellings are absent.
func geminiRawTimestamp(record map[string]any, key string) (int64, bool) {
	text, ok := record[key].(string)
	if !ok {
		return 0, false
	}
	return ParseTSTimestamp(text)
}

// geminiModelCandidates is model_candidates (parser.rs:540-551): the provider
// prefixes in order, then the bare model, first occurrence kept.
func geminiModelCandidates(model string) []string {
	candidates := make([]string, 0, len(geminiProviderPrefixes)+1)
	for _, prefix := range geminiProviderPrefixes {
		candidates = append(candidates, prefix+"/"+model)
	}
	candidates = append(candidates, model)
	return DedupePaths(candidates)
}

// geminiDecodeObject decodes exactly one JSON object from content, the Go
// equivalent of serde_json's from_str/from_slice into the record envelope:
// trailing data, non-objects and malformed JSON are all rejected. Numbers stay
// as json.Number so the float-tolerant token readers see the original literal.
func geminiDecodeObject(content []byte) (map[string]any, bool) {
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, false
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, false
	}
	return LenientObject(value)
}

// geminiFileModifiedMillis is file_modified_timestamp (parser.rs:431-439):
// mtime in milliseconds, or the Unix epoch when it cannot be read.
func geminiFileModifiedMillis(file string) int64 {
	info, err := os.Stat(file)
	if err != nil {
		return 0
	}
	millis := info.ModTime().UnixMilli()
	if millis < 0 {
		return 0
	}
	return millis
}

// geminiFileStem mirrors Path::file_stem for the fallbacks that name a session
// after its file: a leading dot does not start an extension.
func geminiFileStem(file string) string {
	base := filepath.Base(file)
	if dot := strings.LastIndexByte(base, '.'); dot > 0 {
		return base[:dot]
	}
	return base
}
