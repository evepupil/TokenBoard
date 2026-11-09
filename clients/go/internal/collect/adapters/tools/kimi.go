package tools

// The Kimi adapter, ported from ccusage v20.0.33 (commit 1308c416):
// rust/adapters/kimi/src/{paths,parser,loader}.rs.
//
// Two wire formats share one JSONL stream: the old CLI writes
// message.type=="StatusUpdate" lines with snake_case token counts and a
// float-seconds timestamp, the Kimi Code CLI writes type=="usage.record" lines
// with camelCase counts and an integer-millisecond `time`. Only turn-scoped
// records are per-turn amounts; session-scoped records are cumulative totals and
// are skipped.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// kimiDefaultDataDirs are both default roots (paths.rs:30-37).
var kimiDefaultDataDirs = []string{"~/.kimi", "~/.kimi-code"}

const (
	// kimiDefaultModel is DEFAULT_MODEL (parser.rs:17), also the display name
	// whose price is picked by timestamp.
	kimiDefaultModel = "kimi-for-coding"
	// kimiDefaultProvider is DEFAULT_PROVIDER (parser.rs:18).
	kimiDefaultProvider = "moonshot"
	// kimiForCodingK26CutoffMillis is KIMI_FOR_CODING_K2_6_CUTOFF_MS
	// (parser.rs:19): kimi-for-coding bills as k2.5 before this instant and as
	// k2.6 from it on.
	kimiForCodingK26CutoffMillis int64 = 1_776_698_890_072
)

// kimiWireEntry is KimiUsageEntry (parser.rs:107-119). timestampText is what the
// dedup key and the report timestamp use, so it is kept alongside the millis.
type kimiWireEntry struct {
	timestamp     int64
	timestampText string
	sessionID     string
	model         string
	messageID     string
	usage         Usage
}

// key is kimi_entry_key (parser.rs:310-323), the nine-part first-wins dedup key.
func (e kimiWireEntry) key() string {
	return fmt.Sprintf("%s:%s:%s:%s:%d:%d:%d:%d:%d",
		e.sessionID, e.messageID, e.timestampText, e.model,
		e.usage.Input, e.usage.Output, e.usage.CacheCreation, e.usage.CacheRead, e.usage.Extra,
	)
}

// LoadKimi reads every wire.jsonl under each root's sessions tree
// (paths.rs:41-56), dedupes first-wins over the sorted file order and returns
// entries ordered by timestamp.
func LoadKimi(o Options) ([]Entry, error) {
	roots, err := resolveRoots(o, "KIMI_DATA_DIR", kimiDefaultDataDirs, isDirectory)
	if err != nil {
		return nil, err
	}
	files := []string{}
	for _, root := range roots {
		sessions := filepath.Join(root, "sessions")
		for _, file := range CollectFiles(sessions, func(name string) bool { return name == "wire.jsonl" }) {
			if kimiWireDepth(sessions, file) {
				files = append(files, file)
			}
		}
	}
	sort.Strings(files)
	files = DedupePaths(files)
	seen := map[string]bool{}
	entries := []Entry{}
	for _, file := range files {
		for _, wire := range parseKimiWireFile(file, o) {
			key := wire.key()
			if seen[key] {
				continue
			}
			seen[key] = true
			entries = append(entries, kimiEntryToEntry(wire, o))
		}
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Timestamp < entries[j].Timestamp })
	return entries, nil
}

// kimiWireDepth is is_kimi_wire_file's component count (paths.rs:58-74): old
// layout sessions/<group>/<session>/wire.jsonl (3), new layout
// sessions/<workspace>/<session>/agents/<agent>/wire.jsonl (5).
func kimiWireDepth(sessions, file string) bool {
	relative, err := filepath.Rel(sessions, file)
	if err != nil {
		return false
	}
	count := 0
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		if part == "" || part == "." {
			continue
		}
		count++
	}
	return count == 3 || count == 5
}

// parseKimiWireFile is read_wire_file (parser.rs:121-130).
func parseKimiWireFile(file string, o Options) []kimiWireEntry {
	model := kimiConfigModel(file)
	fallback := kimiFileModifiedMillis(file)
	content, err := os.ReadFile(file)
	if err != nil {
		o.debugf("Failed to read Kimi wire file " + file + ": " + err.Error())
		return nil
	}
	entries := []kimiWireEntry{}
	for _, raw := range strings.Split(string(content), "\n") {
		line := strings.TrimSuffix(raw, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		record, ok := kimiDecodeObject([]byte(line))
		if !ok {
			continue
		}
		if entry, ok := kimiWireLineToEntry(record, file, model, fallback); ok {
			entries = append(entries, entry)
		}
	}
	return entries
}

// kimiWireLineToEntry is wire_line_to_entry (parser.rs:177-188).
func kimiWireLineToEntry(record map[string]any, file, configModel string, fallback int64) (kimiWireEntry, bool) {
	kind, _ := NonEmptyString(record["type"])
	switch kind {
	case "usage.record":
		return kimiNewFormatEntry(record, file, fallback)
	case "metadata":
		return kimiWireEntry{}, false
	default:
		return kimiOldFormatEntry(record, file, configModel, fallback)
	}
}

// kimiNewFormatEntry is wire_line_to_entry_new (parser.rs:190-233).
func kimiNewFormatEntry(record map[string]any, file string, fallback int64) (kimiWireEntry, bool) {
	// Session-scoped records are cumulative; only turns are per-turn amounts.
	if scope, _ := NonEmptyString(record["usageScope"]); scope != "turn" {
		return kimiWireEntry{}, false
	}
	usageObject, present, valid := kimiOptionalObject(record, "usage")
	if !valid || !present {
		return kimiWireEntry{}, false
	}
	usage := Usage{
		Input:         LenientU64(usageObject["inputOther"]),
		Output:        LenientU64(usageObject["output"]),
		CacheCreation: LenientU64(usageObject["inputCacheCreation"]),
		CacheRead:     LenientU64(usageObject["inputCacheRead"]),
	}
	if usage.Total() == 0 {
		return kimiWireEntry{}, false
	}
	timestamp := fallback
	if millis, ok := kimiOptionalInt64(record["time"]); ok {
		timestamp = millis
	}
	model, _ := NonEmptyString(record["model"])
	if model == "" {
		model = kimiDefaultModel
	}
	model = strings.TrimPrefix(model, "kimi-code/")
	return kimiWireEntry{
		timestamp:     timestamp,
		timestampText: FormatRFC3339Millis(timestamp),
		sessionID:     kimiExtractSessionID(file),
		model:         model,
		usage:         usage,
	}, true
}

// kimiOldFormatEntry is wire_line_to_entry_old (parser.rs:235-275).
func kimiOldFormatEntry(record map[string]any, file, configModel string, fallback int64) (kimiWireEntry, bool) {
	message, present, valid := kimiOptionalObject(record, "message")
	if !valid || !present {
		return kimiWireEntry{}, false
	}
	if kind, _ := NonEmptyString(message["type"]); kind != "StatusUpdate" {
		return kimiWireEntry{}, false
	}
	payload, present, valid := kimiOptionalObject(message, "payload")
	if !valid || !present {
		return kimiWireEntry{}, false
	}
	tokenUsage, present, valid := kimiOptionalObject(payload, "token_usage")
	if !valid || !present {
		return kimiWireEntry{}, false
	}
	usage := Usage{
		Input:         LenientU64(tokenUsage["input_other"]),
		Output:        LenientU64(tokenUsage["output"]),
		CacheCreation: LenientU64(tokenUsage["input_cache_creation"]),
		CacheRead:     LenientU64(tokenUsage["input_cache_read"]),
	}
	ApplyTotalFallback(&usage, LenientU64(tokenUsage["total"]))
	if usage.Total() == 0 {
		return kimiWireEntry{}, false
	}
	timestamp := fallback
	if seconds, ok := LenientF64(record["timestamp"]); ok {
		if millis, ok := kimiSecondsToMillis(seconds); ok {
			timestamp = millis
		}
	}
	messageID, _ := NonEmptyString(payload["message_id"])
	return kimiWireEntry{
		timestamp:     timestamp,
		timestampText: FormatRFC3339Millis(timestamp),
		sessionID:     kimiExtractSessionID(file),
		model:         configModel,
		messageID:     messageID,
		usage:         usage,
	}, true
}

// kimiEntryToEntry is kimi_entry_to_loaded (parser.rs:325-370).
func kimiEntryToEntry(wire kimiWireEntry, o Options) Entry {
	entry := Entry{
		Timestamp:   wire.timestamp,
		Date:        FormatDateTZ(wire.timestamp, o.Timezone),
		Model:       wire.model,
		Usage:       wire.usage,
		SessionID:   wire.sessionID,
		MessageID:   wire.messageID,
		ProjectPath: "Kimi",
	}
	// calculate_kimi_cost (parser.rs:372-396) builds its usage from the four
	// named buckets only: a total-token leftover is reported as extra but never
	// billed. PriceEntry folds Extra into the billed output for the sources that
	// ask it to, so bill a copy with Extra cleared.
	billed := entry
	billed.Usage.Extra = 0
	PriceEntry(o.Corpus, &billed, kimiModelCandidates(wire.model, wire.timestamp), PriceAt(wire.timestamp), o.Mode, LookupFindAt)
	entry.CostUSD = billed.CostUSD
	entry.MissingPricing = billed.MissingPricing
	return entry
}

// kimiModelCandidates is model_candidates (parser.rs:415-428): the default
// display model prices as a timestamp-selected Moonshot id first; the display
// name itself is never changed.
func kimiModelCandidates(model string, timestamp int64) []string {
	candidates := []string{}
	if model == kimiDefaultModel {
		candidates = append(candidates, kimiForCodingPricingModel(timestamp))
	}
	candidates = append(candidates,
		kimiDefaultProvider+"/"+model,
		"kimi/"+model,
		model,
	)
	return DedupePaths(candidates)
}

// kimiForCodingPricingModel is kimi_for_coding_pricing_model
// (parser.rs:430-436).
func kimiForCodingPricingModel(timestamp int64) string {
	if timestamp < kimiForCodingK26CutoffMillis {
		return kimiDefaultProvider + "/kimi-k2.5"
	}
	return kimiDefaultProvider + "/kimi-k2.6"
}

// kimiConfigModel is read_model_from_config (parser.rs:132-143): the model field
// of <root>/config.json, else the default when the root or file cannot be read.
func kimiConfigModel(wirePath string) string {
	root, ok := kimiRootFromWirePath(wirePath)
	if !ok {
		return kimiDefaultModel
	}
	content, err := os.ReadFile(filepath.Join(root, "config.json"))
	if err != nil {
		return kimiDefaultModel
	}
	config, ok := kimiDecodeObject(content)
	if !ok {
		return kimiDefaultModel
	}
	if model, ok := NonEmptyString(config["model"]); ok {
		return model
	}
	return kimiDefaultModel
}

// kimiRootFromWirePath is kimi_root_from_wire_path (parser.rs:145-165).
func kimiRootFromWirePath(wirePath string) (string, bool) {
	agentDir := filepath.Dir(wirePath)
	if filepath.Base(filepath.Dir(agentDir)) == "agents" {
		// agents/<agent> -> agents -> <session> -> <workspace> -> sessions -> root
		return filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(agentDir))))), true
	}
	// <session> -> <group> -> sessions -> root
	return filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(wirePath)))), true
}

// kimiExtractSessionID is extract_session_id (parser.rs:288-308): the session
// directory, which for the new layout is the agents directory's parent.
func kimiExtractSessionID(wirePath string) string {
	parent := filepath.Dir(wirePath)
	sessionDir := parent
	if filepath.Base(filepath.Dir(parent)) == "agents" {
		sessionDir = filepath.Dir(filepath.Dir(parent))
	}
	name := filepath.Base(sessionDir)
	if name == "" || name == "." || name == string(filepath.Separator) {
		return "unknown"
	}
	return name
}

// kimiOptionalObject mirrors a nested Option<Struct> field: a missing or null
// value is absent, a non-object value fails the whole line's deserialization.
func kimiOptionalObject(record map[string]any, key string) (map[string]any, bool, bool) {
	value, present := record[key]
	if !present || value == nil {
		return nil, false, true
	}
	object, ok := LenientObject(value)
	return object, true, ok
}

// kimiOptionalInt64 is lenient_i64 (jsonl.rs:95-101): an integer literal that
// fits i64, else absent.
func kimiOptionalInt64(value any) (int64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	parsed, err := number.Int64()
	if err != nil {
		return 0, false
	}
	return parsed, true
}

// kimiSecondsToMillis is timestamp_from_seconds (parser.rs:277-286).
func kimiSecondsToMillis(seconds float64) (int64, bool) {
	if math.IsNaN(seconds) || math.IsInf(seconds, 0) {
		return 0, false
	}
	millis := math.Trunc(seconds * 1000)
	if millis < math.MinInt64 || millis > math.MaxInt64 {
		return 0, false
	}
	return int64(millis), true
}

// kimiDecodeObject decodes exactly one JSON object per line, matching
// serde_json::from_slice's whole-input requirement.
func kimiDecodeObject(content []byte) (map[string]any, bool) {
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

// kimiFileModifiedMillis is file_modified_timestamp (parser.rs:167-175).
func kimiFileModifiedMillis(file string) int64 {
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
