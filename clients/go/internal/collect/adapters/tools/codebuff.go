package tools

// The Codebuff adapter, ported from ccusage v20.0.33 (commit 1308c416):
// rust/adapters/codebuff/src/{paths,parser,loader}.rs.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// codebuffDefaultModel is DEFAULT_CODEBUFF_MODEL (parser.rs:10).
const codebuffDefaultModel = "codebuff-unknown"

// codebuffDefaultChannels are the three install channels (paths.rs:6).
var codebuffDefaultChannels = []string{
	"~/.config/manicode",
	"~/.config/manicode-dev",
	"~/.config/manicode-staging",
}

// codebuffUsage is AssistantUsage (parser.rs:12-21).
type codebuffUsage struct {
	model   string
	credits float64
	usage   Usage
}

// codebuffRecord is one assistant message before pricing.
type codebuffRecord struct {
	timestamp int64
	sessionID string
	model     string
	provider  string
	credits   *float64
	usage     Usage
	dedupKey  string
}

// LoadCodebuff reads every chat-messages.json under each channel's projects
// directory.
func LoadCodebuff(o Options) ([]Entry, error) {
	roots, err := resolveRoots(o, "CODEBUFF_DATA_DIR", codebuffDefaultChannels, func(root string) bool {
		return isDirectory(codebuffProjectRoot(root))
	})
	if err != nil {
		return nil, err
	}
	// paths.rs:39-50: each root maps to its projects directory (unless it
	// already is one) and the mapped roots are deduplicated.
	projectRoots := make([]string, 0, len(roots))
	for _, root := range roots {
		projectRoots = append(projectRoots, codebuffProjectRoot(root))
	}
	files := []string{}
	for _, root := range DedupePaths(projectRoots) {
		files = append(files, CollectFiles(root, func(name string) bool {
			return name == "chat-messages.json"
		})...)
	}
	sort.Strings(files)

	// loader.rs:41-52: last-wins per dedup key in file order.
	records := make([]codebuffRecord, 0, len(files))
	positions := map[string]int{}
	for _, file := range files {
		content, err := os.ReadFile(file)
		if err != nil {
			o.debugf("Failed to read Codebuff chat file " + file + ": " + err.Error())
			continue
		}
		for _, record := range parseCodebuffChatFile(content, file) {
			if position, ok := positions[record.dedupKey]; ok {
				records[position] = record
				continue
			}
			positions[record.dedupKey] = len(records)
			records = append(records, record)
		}
	}
	// loader.rs:51 sorts the surviving entries by timestamp.
	sort.SliceStable(records, func(i, j int) bool { return records[i].timestamp < records[j].timestamp })

	entries := make([]Entry, 0, len(records))
	for _, record := range records {
		entries = append(entries, codebuffEntry(o, record))
	}
	return entries, nil
}

// codebuffProjectRoot is the per-root `projects` rewrite (paths.rs:41-45).
func codebuffProjectRoot(root string) string {
	if filepath.Base(root) == "projects" {
		return root
	}
	return filepath.Join(root, "projects")
}

// codebuffContext is CodebuffContext (parser.rs:35-38).
type codebuffContext struct {
	chatID    string
	sessionID string
}

// parseCodebuffChatFile is load_chat_file (parser.rs:40-95). A file that is not
// a JSON array yields no entries, exactly like serde's all-or-nothing read.
func parseCodebuffChatFile(content []byte, path string) []codebuffRecord {
	var messages []any
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	if err := decoder.Decode(&messages); err != nil {
		return nil
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil
	}
	context := deriveCodebuffContext(path)
	chatTimestamp, hasChatTimestamp := parseCodebuffChatIDTimestamp(context.chatID)
	fileTimestamp := codebuffFileModTime(path) // 0 is UNIX_EPOCH (parser.rs:47)

	records := []codebuffRecord{}
	for ordinal, raw := range messages {
		message, ok := LenientObject(raw)
		if !ok {
			continue
		}
		if !isCodebuffAssistantMessage(message) {
			continue
		}
		usage := extractCodebuffUsage(message)
		if !codebuffHasSignal(usage) {
			continue
		}
		timestamp, ok := codebuffMessageTimestamp(message)
		if !ok {
			if hasChatTimestamp {
				timestamp = chatTimestamp
			} else {
				timestamp = fileTimestamp
			}
		}
		model := usage.model
		if model == "" {
			model = codebuffDefaultModel
		}
		var credits *float64
		if usage.credits > 0 {
			value := usage.credits
			credits = &value
		}
		records = append(records, codebuffRecord{
			timestamp: timestamp,
			sessionID: context.sessionID,
			model:     model,
			provider:  inferCodebuffProvider(model),
			credits:   credits,
			usage:     usage.usage,
			dedupKey:  codebuffDedupKey(message, context.sessionID, timestamp, model, usage, ordinal),
		})
	}
	return records
}

// deriveCodebuffContext is derive_context (parser.rs:97-125).
func deriveCodebuffContext(path string) codebuffContext {
	chatID := "unknown"
	if name := codebuffBaseName(filepath.Dir(path)); name != "" {
		chatID = name
	}
	chatsDir := filepath.Dir(filepath.Dir(path))
	projectDir := filepath.Dir(chatsDir)
	project := "unknown"
	if name := codebuffBaseName(projectDir); name != "" {
		project = name
	}
	channel := "manicode"
	if name := codebuffBaseName(filepath.Dir(filepath.Dir(projectDir))); name != "" {
		channel = name
	}
	return codebuffContext{chatID: chatID, sessionID: channel + "/" + project + "/" + chatID}
}

// codebuffBaseName is Path::file_name as a plain string: "", "." and the
// filesystem root all mean "no name".
func codebuffBaseName(path string) string {
	name := filepath.Base(path)
	switch name {
	case "", ".", "..", string(filepath.Separator):
		return ""
	}
	return name
}

// isCodebuffAssistantMessage is is_assistant_message (parser.rs:127-134):
// variant wins over role, and only ai/agent/assistant count.
func isCodebuffAssistantMessage(message map[string]any) bool {
	value, ok := NonEmptyString(message["variant"])
	if !ok {
		value, ok = NonEmptyString(message["role"])
	}
	if !ok {
		return false
	}
	switch value {
	case "ai", "agent", "assistant":
		return true
	default:
		return false
	}
}

// extractCodebuffUsage is extract_assistant_usage (parser.rs:136-159).
func extractCodebuffUsage(message map[string]any) codebuffUsage {
	var usage codebuffUsage
	if metadata, ok := LenientObject(message["metadata"]); ok {
		if model, ok := NonEmptyString(metadata["model"]); ok {
			usage.model = model
		}
		mergeCodebuffUsage(&usage, parseCodebuffUsageObject(metadata["usage"]))
		if codebuff, ok := LenientObject(metadata["codebuff"]); ok {
			mergeCodebuffUsage(&usage, parseCodebuffUsageObject(codebuff["usage"]))
		}
		if runState, ok := codebuffRunStateUsage(metadata); ok {
			mergeCodebuffUsage(&usage, runState)
		}
	}
	if credits := PositiveFinite(message["credits"]); credits > 0 && usage.credits <= 0 {
		usage.credits = credits
	}
	return usage
}

// codebuffRunStateUsage is extract_usage_from_run_state (parser.rs:161-197):
// the history is walked newest-first so the most recent assistant message wins
// each still-empty field; the codebuff provider's model is taken even when no
// tokens accompany it.
func codebuffRunStateUsage(metadata map[string]any) (codebuffUsage, bool) {
	runState, ok := LenientObject(metadata["runState"])
	if !ok {
		return codebuffUsage{}, false
	}
	sessionState, ok := LenientObject(runState["sessionState"])
	if !ok {
		return codebuffUsage{}, false
	}
	mainAgentState, ok := LenientObject(sessionState["mainAgentState"])
	if !ok {
		return codebuffUsage{}, false
	}
	history, ok := mainAgentState["messageHistory"].([]any)
	if !ok {
		return codebuffUsage{}, false
	}
	var usage codebuffUsage
	found := false
	for index := len(history) - 1; index >= 0; index-- {
		entry, ok := LenientObject(history[index])
		if !ok {
			continue
		}
		if role, _ := NonEmptyString(entry["role"]); role != "assistant" {
			continue
		}
		providerOptions, ok := LenientObject(entry["providerOptions"])
		if !ok {
			continue
		}
		var entryUsage codebuffUsage
		mergeCodebuffUsage(&entryUsage, parseCodebuffUsageObject(providerOptions["usage"]))
		if codebuff, ok := LenientObject(providerOptions["codebuff"]); ok {
			mergeCodebuffUsage(&entryUsage, parseCodebuffUsageObject(codebuff["usage"]))
			if model, ok := NonEmptyString(codebuff["model"]); ok {
				entryUsage.model = model
			}
		}
		if codebuffHasSignal(entryUsage) || entryUsage.model != "" {
			found = true
		}
		mergeCodebuffUsage(&usage, entryUsage)
	}
	return usage, found
}

// parseCodebuffUsageObject is parse_usage_object (parser.rs:199-264).
func parseCodebuffUsageObject(value any) codebuffUsage {
	var usage codebuffUsage
	record, ok := LenientObject(value)
	if !ok {
		return usage
	}
	usage.usage.Input = PickU64(
		record["inputTokens"],
		record["input_tokens"],
		record["promptTokens"],
		record["prompt_tokens"],
	)
	usage.usage.Output = PickU64(
		record["outputTokens"],
		record["output_tokens"],
		record["completionTokens"],
		record["completion_tokens"],
	)
	cacheRead := PickU64(record["cacheReadInputTokens"], record["cache_read_input_tokens"])
	if details, ok := LenientObject(record["promptTokensDetails"]); ok {
		cacheRead = codebuffMaxU64(cacheRead, PickU64(details["cachedTokens"]))
	}
	if details, ok := LenientObject(record["prompt_tokens_details"]); ok {
		cacheRead = codebuffMaxU64(cacheRead, PickU64(details["cached_tokens"]))
	}
	usage.usage.CacheRead = cacheRead
	usage.usage.CacheCreation = PickU64(
		record["cacheCreationInputTokens"],
		record["cache_creation_input_tokens"],
		record["cacheCreationTokens"],
		record["cache_creation_tokens"],
		record["cachedTokensCreated"],
		record["cached_tokens_created"],
	)
	total := PickU64(record["totalTokens"], record["total_tokens"], record["total"])
	ApplyTotalFallback(&usage.usage, total)
	usage.credits = PositiveFinite(record["credits"])
	if model, ok := NonEmptyString(record["model"]); ok {
		usage.model = model
	}
	return usage
}

// mergeCodebuffUsage is merge_fallback (parser.rs:266-288): every field keeps
// its value unless it is still zero.
func mergeCodebuffUsage(target *codebuffUsage, fallback codebuffUsage) {
	if target.usage.Input == 0 {
		target.usage.Input = fallback.usage.Input
	}
	if target.usage.Output == 0 {
		target.usage.Output = fallback.usage.Output
	}
	if target.usage.CacheCreation == 0 {
		target.usage.CacheCreation = fallback.usage.CacheCreation
	}
	if target.usage.CacheRead == 0 {
		target.usage.CacheRead = fallback.usage.CacheRead
	}
	if target.usage.Extra == 0 {
		target.usage.Extra = fallback.usage.Extra
	}
	if target.credits <= 0 {
		target.credits = fallback.credits
	}
	if target.model == "" {
		target.model = fallback.model
	}
}

// codebuffHasSignal is has_signal (parser.rs:290-297).
func codebuffHasSignal(usage codebuffUsage) bool {
	return usage.usage.Input > 0 ||
		usage.usage.Output > 0 ||
		usage.usage.CacheCreation > 0 ||
		usage.usage.CacheRead > 0 ||
		usage.usage.Extra > 0 ||
		usage.credits > 0
}

// codebuffMessageTimestamp is message_timestamp (parser.rs:299-306).
func codebuffMessageTimestamp(message map[string]any) (int64, bool) {
	if millis, ok := codebuffTimestampValue(message["timestamp"]); ok {
		return millis, true
	}
	if millis, ok := codebuffTimestampValue(message["createdAt"]); ok {
		return millis, true
	}
	if metadata, ok := LenientObject(message["metadata"]); ok {
		return codebuffTimestampValue(metadata["timestamp"])
	}
	return 0, false
}

// codebuffTimestampValue is timestamp_value (parser.rs:319-333): a strict TS
// string, or an integer number treated as seconds until it reaches 1e10.
func codebuffTimestampValue(value any) (int64, bool) {
	switch typed := value.(type) {
	case string:
		return ParseTSTimestamp(typed)
	case json.Number:
		raw, err := typed.Int64()
		if err != nil {
			return 0, false
		}
		millis := raw
		if raw < 10_000_000_000 {
			// checked_mul(1_000): overflow means "no timestamp".
			if raw > math.MaxInt64/1000 || raw < math.MinInt64/1000 {
				return 0, false
			}
			millis = raw * 1000
		}
		if millis <= 0 {
			return 0, false
		}
		return millis, true
	default:
		return 0, false
	}
}

// parseCodebuffChatIDTimestamp is parse_codebuff_chat_id_timestamp
// (parser.rs:308-317): the chat directory name is an ISO timestamp with dashes
// where the colons should be.
func parseCodebuffChatIDTimestamp(chatID string) (int64, bool) {
	date, timePart, ok := strings.Cut(chatID, "T")
	if !ok {
		return 0, false
	}
	for replaced := 0; replaced < 2; {
		index := strings.IndexByte(timePart, '-')
		if index < 0 {
			break
		}
		timePart = timePart[:index] + ":" + timePart[index+1:]
		replaced++
	}
	return ParseTSTimestamp(date + "T" + timePart)
}

// codebuffFileModTime is file_modified_timestamp, with the UNIX_EPOCH fallback
// as zero (parser.rs:335-343).
func codebuffFileModTime(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	modified := info.ModTime()
	if modified.Before(time.Unix(0, 0)) {
		return 0
	}
	return modified.UnixMilli()
}

// codebuffDedupKey is dedup_key (parser.rs:345-365): a message id when present,
// otherwise the ordinal-bearing identity key.
func codebuffDedupKey(message map[string]any, sessionID string, timestamp int64, model string, usage codebuffUsage, ordinal int) string {
	if id, ok := NonEmptyString(message["id"]); ok {
		return "codebuff:" + sessionID + ":" + id
	}
	return fmt.Sprintf(
		"codebuff:%s:%s:%s:%d:%d:%d:%d:%d:%d",
		sessionID,
		FormatRFC3339Millis(timestamp),
		model,
		ordinal,
		usage.usage.Input,
		usage.usage.Output,
		usage.usage.CacheRead,
		usage.usage.CacheCreation,
		usage.usage.Extra,
	)
}

// codebuffASCIILower mirrors Rust's str::to_ascii_lowercase, which leaves
// non-ASCII runes untouched where strings.ToLower would not.
func codebuffASCIILower(value string) string {
	out := []byte(value)
	for index, char := range out {
		if char >= 'A' && char <= 'Z' {
			out[index] = char + ('a' - 'A')
		}
	}
	return string(out)
}

// inferCodebuffProvider is infer_provider (parser.rs:367-390).
func inferCodebuffProvider(model string) string {
	lowered := codebuffASCIILower(model)
	switch {
	case strings.HasPrefix(lowered, "claude-"),
		strings.HasPrefix(lowered, "anthropic/"),
		strings.HasPrefix(lowered, "anthropic."):
		return "anthropic"
	case strings.HasPrefix(lowered, "gpt-"),
		strings.HasPrefix(lowered, "o1"),
		strings.HasPrefix(lowered, "o3"),
		strings.HasPrefix(lowered, "o4"),
		strings.HasPrefix(lowered, "openai/"):
		return "openai"
	case strings.HasPrefix(lowered, "gemini"), strings.HasPrefix(lowered, "google/"):
		return "google"
	case strings.HasPrefix(lowered, "grok"), strings.HasPrefix(lowered, "xai/"):
		return "xai"
	case strings.HasPrefix(lowered, "openrouter/"):
		return "openrouter"
	default:
		return "unknown"
	}
}

// codebuffEntry is to_loaded_entry (loader.rs:55-91).
func codebuffEntry(o Options, record codebuffRecord) Entry {
	entry := Entry{
		Timestamp:   record.timestamp,
		Date:        FormatDateTZ(record.timestamp, o.Timezone),
		Model:       record.model,
		Usage:       record.usage,
		SessionID:   record.sessionID,
		MessageID:   record.dedupKey,
		ProjectPath: "Codebuff",
		Credits:     record.credits,
	}
	priceCodebuff(&entry, record.provider, o)
	return entry
}

// priceCodebuff is calculate_codebuff_cost plus missing_codebuff_pricing
// (parser.rs:392-447). Codebuff always uses CostMode::Calculate, ignoring
// --mode; extra tokens bill as output, and a zero bare-model cost retries under
// the provider prefix.
func priceCodebuff(entry *Entry, provider string, o Options) {
	usage := nativepricing.Usage{
		Input:         int64(entry.Usage.Input),
		Output:        int64(entry.Usage.Output) + int64(entry.Usage.Extra),
		CacheCreate5m: int64(entry.Usage.CacheCreation),
		CacheRead:     int64(entry.Usage.CacheRead),
	}
	// Rust passes Some(entry.timestamp) to calculate_cost_for_usage_at, even for
	// the epoch instant, so the lookup is find_at rather than the static table.
	at := time.UnixMilli(entry.Timestamp)
	cost := codebuffPriceAt(o.Corpus, entry.Model, usage, at)
	if cost > 0 || provider == "unknown" || strings.HasPrefix(entry.Model, provider+"/") {
		entry.CostUSD = cost
	} else {
		entry.CostUSD = codebuffPriceAt(o.Corpus, provider+"/"+entry.Model, usage, at)
	}
	entry.MissingPricing = false
	if entry.Usage.Total() == 0 {
		return
	}
	entry.MissingPricing = true
	for _, candidate := range codebuffPricingCandidates(entry.Model, provider) {
		if _, ok := o.Corpus.Find(candidate); ok {
			entry.MissingPricing = false
			return
		}
	}
}

// codebuffPricingCandidates is the candidate list
// missing_codebuff_pricing builds (parser.rs:437-440).
func codebuffPricingCandidates(model, provider string) []string {
	candidates := []string{model}
	if provider != "unknown" && !strings.HasPrefix(model, provider+"/") {
		candidates = append(candidates, provider+"/"+model)
	}
	return candidates
}

// codebuffPriceAt is calculate_cost_for_usage_at in Calculate mode
// (cost.rs:31-46, 84-100): no reported cost, find_at at the entry timestamp.
func codebuffPriceAt(corpus nativepricing.Corpus, model string, usage nativepricing.Usage, at time.Time) float64 {
	pricing, ok := LookupFindAt(corpus, model, at)
	if !ok {
		return 0
	}
	return nativepricing.CostFromPricing(usage, pricing, false)
}

// codebuffMaxU64 is core::cmp::max for the two cache-read alias reads.
func codebuffMaxU64(left, right uint64) uint64 {
	if left > right {
		return left
	}
	return right
}
