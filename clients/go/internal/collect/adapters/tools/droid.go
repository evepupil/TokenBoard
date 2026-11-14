package tools

// The Droid adapter, ported from ccusage v20.0.33 (commit 1308c416):
// rust/adapters/droid/src/{paths,parser,loader}.rs plus the shared
// ccusage-core/src/{utils,date_utils}.rs helpers this package already ports.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// droidDefaultSessionsDir is the default root (paths.rs:22-41).
var droidDefaultSessionsDir = []string{"~/.factory/sessions"}

// droidRecord is one parsed settings file before pricing. A record without a
// providerLockTimestamp bills at the static table (parser.rs:126-143);
// pricingSet keeps the epoch instant distinguishable from that static case.
type droidRecord struct {
	timestamp        int64
	pricingTimestamp int64
	pricingSet       bool
	sessionID        string
	model            string
	provider         string
	usage            Usage
}

// LoadDroid reads every `<name>.settings.json` under the session roots.
func LoadDroid(o Options) ([]Entry, error) {
	roots, err := resolveRoots(o, "DROID_SESSIONS_DIR", droidDefaultSessionsDir, isDirectory)
	if err != nil {
		return nil, err
	}
	files := []string{}
	for _, root := range roots {
		files = append(files, CollectFiles(root, func(name string) bool {
			return strings.HasSuffix(name, ".settings.json")
		})...)
	}
	sort.Strings(files)

	records := make([]droidRecord, 0, len(files))
	for _, file := range files {
		record, ok, err := loadDroidSettingsFile(file)
		if err != nil {
			o.debugf("Failed to read Droid settings file " + file + ": " + err.Error())
			continue
		}
		if ok {
			records = append(records, record)
		}
	}

	// loader.rs:41-51: stable sort by timestamp, then walk in reverse so the
	// first hit per session id is that session's newest snapshot.
	sort.SliceStable(records, func(i, j int) bool { return records[i].timestamp < records[j].timestamp })
	seen := map[string]bool{}
	entries := make([]Entry, 0, len(records))
	for index := len(records) - 1; index >= 0; index-- {
		record := records[index]
		if seen[record.sessionID] {
			continue
		}
		seen[record.sessionID] = true
		entries = append(entries, droidEntry(o, record))
	}
	return entries, nil
}

// loadDroidSettingsFile is load_settings_file (parser.rs:32-94). ok is false
// for a document that carries no usable snapshot; err is only a read or parse
// failure, which the loader downgrades to a debug line.
func loadDroidSettingsFile(path string) (droidRecord, bool, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return droidRecord{}, false, nil
		}
		return droidRecord{}, false, err
	}
	var decoded any
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	if err := decoder.Decode(&decoded); err != nil {
		return droidRecord{}, false, err
	}
	// serde_json::from_str rejects trailing non-whitespace, so a second decode
	// that is not EOF is a parse failure too.
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("trailing JSON value")
		}
		return droidRecord{}, false, err
	}
	settings, ok := LenientObject(decoded)
	if !ok {
		return droidRecord{}, false, nil
	}
	usage, ok := parseDroidTokenUsage(settings["tokenUsage"])
	if !ok {
		return droidRecord{}, false, nil
	}

	provider := normalizeDroidProviderField(settings["providerLock"])
	model := ""
	if value, ok := droidStringField(settings, "model"); ok {
		model = normalizeDroidModelName(value)
	} else if sidecar, ok := droidSidecarModel(path); ok {
		model = sidecar
	}
	if model == "" {
		model = defaultDroidModelFromProvider(provider)
	}
	if provider == "unknown" {
		provider = inferDroidProviderFromModel(model)
	}

	timestamp, pricingTimestamp, pricingSet, ok := droidSettingsTimestamp(settings, path)
	if !ok {
		return droidRecord{}, false, nil
	}
	sessionID := "unknown"
	if base := filepath.Base(path); strings.HasSuffix(base, ".settings.json") {
		sessionID = strings.TrimSuffix(base, ".settings.json")
	}
	return droidRecord{
		timestamp:        timestamp,
		pricingTimestamp: pricingTimestamp,
		pricingSet:       pricingSet,
		sessionID:        sessionID,
		model:            model,
		provider:         provider,
		usage:            usage,
	}, true, nil
}

// parseDroidTokenUsage is parse_token_usage (parser.rs:96-124): thinking tokens
// enter the extra bucket, totalTokens fills the gap, and an all-zero snapshot is
// dropped.
func parseDroidTokenUsage(value any) (Usage, bool) {
	record, ok := LenientObject(value)
	if !ok {
		return Usage{}, false
	}
	usage := Usage{
		Input:         LenientU64(record["inputTokens"]),
		Output:        LenientU64(record["outputTokens"]),
		CacheCreation: LenientU64(record["cacheCreationTokens"]),
		CacheRead:     LenientU64(record["cacheReadTokens"]),
		Extra:         LenientU64(record["thinkingTokens"]),
	}
	ApplyTotalFallback(&usage, LenientU64(record["totalTokens"]))
	if usage.Total() == 0 {
		return Usage{}, false
	}
	return usage, true
}

// droidSettingsTimestamp is settings_timestamp (parser.rs:126-143): a parseable
// providerLockTimestamp is both the display and the pricing instant; otherwise
// the file mtime is the display instant and pricing stays static (find, not
// find_at).
func droidSettingsTimestamp(settings map[string]any, path string) (int64, int64, bool, bool) {
	if text, ok := droidStringField(settings, "providerLockTimestamp"); ok {
		if millis, ok := ParseTSTimestamp(text); ok {
			return millis, millis, true, true
		}
	}
	millis, ok := droidFileModTime(path)
	if !ok {
		return 0, 0, false, false
	}
	return millis, 0, false, true
}

// droidFileModTime is fs::metadata(path).modified() with the pre-epoch and
// stat-failure cases collapsed to "absent" (parser.rs:135-141).
func droidFileModTime(path string) (int64, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, false
	}
	modified := info.ModTime()
	if modified.Before(time.Unix(0, 0)) {
		return 0, false
	}
	return modified.UnixMilli(), true
}

// droidEntry is to_loaded_entry (loader.rs:54-90).
func droidEntry(o Options, record droidRecord) Entry {
	entry := Entry{
		Timestamp:   record.timestamp,
		Date:        FormatDateTZ(record.timestamp, o.Timezone),
		Model:       record.model,
		Usage:       record.usage,
		SessionID:   record.sessionID,
		MessageID:   "droid:" + record.sessionID,
		ProjectPath: "Droid",
	}
	priceDroid(&entry, record, o)
	return entry
}

// priceDroid is calculate_droid_cost plus missing_droid_pricing
// (parser.rs:145-179). Droid always uses CostMode::Calculate, ignoring --mode:
// the settings file never reports a USD cost. Thinking tokens bill as output,
// and a record without a providerLockTimestamp uses the static table
// (pricing_timestamp = None), while a locked one bills with find_at.
func priceDroid(entry *Entry, record droidRecord, o Options) {
	usage := nativepricing.Usage{
		Input:         TokenCount(entry.Usage.Input),
		Output:        TokenCount(SaturatingAddU64(entry.Usage.Output, entry.Usage.Extra)),
		CacheCreate5m: TokenCount(entry.Usage.CacheCreation),
		CacheRead:     TokenCount(entry.Usage.CacheRead),
	}
	at := time.Time{}
	if record.pricingSet {
		// Some(timestamp) in Rust, even for the epoch instant itself.
		at = time.UnixMilli(record.pricingTimestamp)
	}
	candidates := droidModelCandidates(entry.Model, record.provider)
	entry.CostUSD = 0
	entry.MissingPricing = false
	for _, candidate := range candidates {
		pricing, ok := LookupFindAt(o.Corpus, candidate, at)
		if !ok {
			continue
		}
		cost := nativepricing.CostFromPricing(usage, pricing, false)
		if cost > 0 {
			entry.CostUSD = cost
			return
		}
	}
	// missing_pricing_model_for_candidates uses the fuzzy table without a
	// timestamp, so a zero-rate placeholder still counts as priced.
	if entry.Usage.Total() == 0 {
		return
	}
	entry.MissingPricing = true
	for _, candidate := range candidates {
		if _, ok := o.Corpus.Find(candidate); ok {
			entry.MissingPricing = false
			return
		}
	}
}

// droidModelCandidates is droid_model_candidates (parser.rs:181-191).
func droidModelCandidates(model, provider string) []string {
	candidates := []string{model}
	for _, prefix := range droidProviderPrefixes(provider) {
		candidates = append(candidates, prefix+model)
	}
	return DedupePaths(candidates)
}

// droidProviderPrefixes is provider_prefixes (parser.rs:193-209).
func droidProviderPrefixes(provider string) []string {
	switch provider {
	case "anthropic":
		return []string{"anthropic/", "openrouter/anthropic/"}
	case "openai":
		return []string{"openai/", "openrouter/openai/"}
	case "google":
		return []string{"google/", "vertex_ai/", "openrouter/google/"}
	case "xai":
		return []string{"xai/", "openrouter/x-ai/"}
	case "unknown":
		return nil
	default:
		return []string{provider + "/", "openrouter/" + provider + "/"}
	}
}

// normalizeDroidModelName is normalize_droid_model_name (parser.rs:216-251).
func normalizeDroidModelName(model string) string {
	raw := strings.TrimPrefix(model, "custom:")
	var withoutBrackets strings.Builder
	bracketDepth := 0
	for _, char := range raw {
		switch char {
		case '[':
			bracketDepth++
		case ']':
			if bracketDepth > 0 {
				bracketDepth--
			}
		default:
			if bracketDepth == 0 {
				withoutBrackets.WriteRune(char)
			}
		}
	}
	lowered := droidASCIILower(strings.TrimRight(strings.TrimSpace(withoutBrackets.String()), "-"))
	var normalized strings.Builder
	previousDash := false
	for _, char := range lowered {
		next := char
		if char == '.' || unicode.IsSpace(char) || char == '-' {
			next = '-'
		}
		if next == '-' {
			if !previousDash {
				normalized.WriteRune('-')
				previousDash = true
			}
			continue
		}
		normalized.WriteRune(next)
		previousDash = false
	}
	return strings.Trim(normalized.String(), "-")
}

// normalizeDroidProviderField applies string_field plus
// normalize_droid_provider (parser.rs:211-214, 253-266) to providerLock.
func normalizeDroidProviderField(value any) string {
	text, ok := NonEmptyString(value)
	if !ok {
		return "unknown"
	}
	normalized := strings.ReplaceAll(droidASCIILower(strings.TrimSpace(text)), "-", "_")
	switch normalized {
	case "":
		return "unknown"
	case "claude", "anthropic":
		return "anthropic"
	case "openai":
		return "openai"
	case "google", "google_ai", "gemini", "vertex", "vertex_ai":
		return "google"
	case "xai", "x_ai", "grok":
		return "xai"
	default:
		return normalized
	}
}

// inferDroidProviderFromModel is infer_droid_provider_from_model
// (parser.rs:268-288).
func inferDroidProviderFromModel(model string) string {
	switch {
	case strings.Contains(model, "claude"),
		strings.Contains(model, "opus"),
		strings.Contains(model, "sonnet"),
		strings.Contains(model, "haiku"):
		return "anthropic"
	case strings.HasPrefix(model, "gpt-"),
		strings.Contains(model, "-gpt-"),
		strings.Contains(model, "chatgpt"),
		len(model) >= 2 && model[0] == 'o' && model[1] >= '0' && model[1] <= '9':
		return "openai"
	case strings.Contains(model, "gemini"):
		return "google"
	case strings.Contains(model, "grok"):
		return "xai"
	default:
		return "unknown"
	}
}

// defaultDroidModelFromProvider is default_model_from_provider
// (parser.rs:290-299).
func defaultDroidModelFromProvider(provider string) string {
	switch provider {
	case "anthropic":
		return "claude-unknown"
	case "openai":
		return "gpt-unknown"
	case "google":
		return "gemini-unknown"
	case "xai":
		return "grok-unknown"
	default:
		return "unknown"
	}
}

// droidSidecarModel is extract_model_from_sidecar_jsonl (parser.rs:301-318):
// the `<prefix>.jsonl` beside the settings file, first 500 lines, first `Model:`
// occurrence.
func droidSidecarModel(settingsPath string) (string, bool) {
	base := filepath.Base(settingsPath)
	prefix, ok := strings.CutSuffix(base, ".settings.json")
	if !ok {
		return "", false
	}
	file, err := os.Open(filepath.Join(filepath.Dir(settingsPath), prefix+".jsonl"))
	if err != nil {
		return "", false
	}
	defer func() { _ = file.Close() }()
	reader := bufio.NewReader(file)
	for line := 0; line < 500; line++ {
		text, err := reader.ReadString('\n')
		if len(text) > 0 {
			if model, ok := droidModelFromLine(text); ok {
				return model, true
			}
		}
		if err != nil {
			break
		}
	}
	return "", false
}

// droidModelFromLine is extract_droid_model_from_line (parser.rs:320-332).
func droidModelFromLine(line string) (string, bool) {
	_, tail, ok := strings.Cut(line, "Model:")
	if !ok {
		return "", false
	}
	if index := strings.IndexAny(tail, "\"\\["); index >= 0 {
		tail = tail[:index]
	}
	raw := strings.TrimSpace(tail)
	if raw == "" {
		return "", false
	}
	normalized := normalizeDroidModelName(raw)
	if normalized == "" {
		return "", false
	}
	return normalized, true
}

// droidStringField is string_field (parser.rs:211-214): a trimmed, non-empty
// string or nothing.
func droidStringField(record map[string]any, key string) (string, bool) {
	return NonEmptyString(record[key])
}

// droidASCIILower mirrors Rust's str::to_ascii_lowercase, which leaves non-ASCII
// runes untouched where strings.ToLower would not.
func droidASCIILower(value string) string {
	out := []byte(value)
	for index, char := range out {
		if char >= 'A' && char <= 'Z' {
			out[index] = char + ('a' - 'A')
		}
	}
	return string(out)
}
