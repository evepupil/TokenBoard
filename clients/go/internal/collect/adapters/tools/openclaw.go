package tools

// The OpenClaw adapter, ported from ccusage v20.0.33 (commit 1308c416):
// rust/adapters/openclaw/src/{paths,parser,loader,sqlite}.rs.
//
// OpenClaw keeps two generations of transcripts: legacy JSONL session files
// (`*.jsonl`, plus the `.deleted.*`/`.reset.*` archives) and per-agent SQLite
// stores under `agents/<id>/agent/openclaw-agent.sqlite`. After
// `openclaw doctor --fix` both copies of one event can exist on disk, and the
// SQLite row carries the provider-billed cost, so it replaces the migrated JSONL
// copy.
//
// One Rust input is absent from the shared Options layer: the CLI's
// `--open-claw-path` flag. Only OPENCLAW_DIR and the four default directories are
// reachable here (see the S4 report for this deviation).

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	_ "modernc.org/sqlite"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// openclawDefaultRoots are the four default state directories (paths.rs:23-31).
var openclawDefaultRoots = []string{"~/.openclaw", "~/.clawdbot", "~/.moltbot", "~/.moldbot"}

// openclawLine is one parsed transcript record (parser.rs:18-67). Data is the
// nested model-change source when present, Message the assistant payload when it
// deserializes, and Timestamp the raw root-level timestamp value.
type openclawLine struct {
	Type       string
	HasType    bool
	CustomType string
	ID         string
	Data       map[string]any
	ModelID    string
	Model      string
	Provider   string
	Message    map[string]any
	HasMessage bool
	Timestamp  any
}

// LoadOpenclaw reads every JSONL session file and agent database under each root.
func LoadOpenclaw(o Options) ([]Entry, error) {
	roots, err := openclawRoots(o)
	if err != nil {
		return nil, err
	}
	entries := []Entry{}
	seen := map[string]bool{}
	// SQLite-era event ids (`session_id`, message `id`) win over the
	// content-based JSONL ids, so SQLite candidates are collected first and
	// merged after the JSONL pass (loader.rs:31-99).
	sqliteIDs := map[string]bool{}
	sqliteEntries := []Entry{}
	for _, root := range roots {
		sqliteEntries = append(sqliteEntries, openclawAgentEntries(root, o)...)
		files, err := openclawCollectSessionFiles(root)
		if err != nil {
			return nil, err
		}
		for _, file := range files {
			fileEntries, err := openclawParseSessionFile(file, o)
			if err != nil {
				o.debugf("Failed to read OpenClaw session file " + file + ": " + err.Error())
				continue
			}
			for _, entry := range fileEntries {
				id := openclawEntryID(entry)
				if seen[id] {
					continue
				}
				seen[id] = true
				entries = append(entries, entry)
			}
		}
	}
	for _, entry := range sqliteEntries {
		if entry.MessageID == "" {
			id := openclawEntryID(entry)
			if !seen[id] {
				seen[id] = true
				entries = append(entries, entry)
			}
			continue
		}
		sqliteID := "openclaw:" + entry.SessionID + ":" + entry.MessageID
		if sqliteIDs[sqliteID] {
			continue
		}
		sqliteIDs[sqliteID] = true
		// A migrated JSONL duplicate carries no stable id, but it still shares
		// the session, timestamp, model and usage; its cost can differ, so the
		// content identity (without cost) finds it and the SQLite row replaces it
		// (loader.rs:81-95).
		if position := openclawFindEntry(entries, func(existing Entry) bool {
			return existing.SessionID == entry.SessionID && existing.MessageID == entry.MessageID
		}); position >= 0 {
			entries[position] = entry
		} else if position := openclawFindEntry(entries, func(existing Entry) bool {
			return openclawMigrationID(existing) == openclawMigrationID(entry)
		}); position >= 0 {
			entries[position] = entry
		} else {
			seen[openclawEntryID(entry)] = true
			entries = append(entries, entry)
		}
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Timestamp < entries[j].Timestamp })
	return entries, nil
}

// openclawRoots is paths() (paths.rs:11-42), minus the CLI flag the shared
// Options cannot carry: a non-blank OPENCLAW_DIR is the only source, otherwise
// the four defaults that exist.
func openclawRoots(o Options) ([]string, error) {
	if raw, ok := o.envLookup()("OPENCLAW_DIR"); ok && strings.TrimSpace(raw) != "" {
		return openclawExistingDirectories(raw), nil
	}
	home, err := o.homeDir()
	if err != nil {
		return nil, nil
	}
	roots := []string{}
	for _, name := range openclawDefaultRoots {
		candidate := expandHome(name, home)
		if isDirectory(candidate) {
			roots = append(roots, candidate)
		}
	}
	return roots, nil
}

// openclawExistingDirectories is existing_path_list (paths.rs:34-42): split,
// trim, drop empties, keep existing directories, dedupe by literal path.
func openclawExistingDirectories(raw string) []string {
	out := []string{}
	for _, path := range SplitEnvList(raw) {
		if isDirectory(path) {
			out = append(out, path)
		}
	}
	return DedupePaths(out)
}

// openclawCollectSessionFiles is collect_session_files (paths.rs:44-73): a
// recursive walk that refuses symlinks, sorted by path. Unlike the shared
// CollectFiles helper it propagates read errors, as the Rust walk does.
func openclawCollectSessionFiles(root string) ([]string, error) {
	if !isDirectory(root) {
		return nil, nil
	}
	files := []string{}
	if err := openclawWalkSessionFiles(root, 0, &files); err != nil {
		return nil, err
	}
	sort.Strings(files)
	return files, nil
}

func openclawWalkSessionFiles(dir string, depth int, files *[]string) error {
	if depth > maxWalkDepth {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	if len(entries) > maxWalkEntries {
		entries = entries[:maxWalkEntries]
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		switch {
		case entry.Type()&os.ModeSymlink != 0:
			continue
		case entry.IsDir():
			if err := openclawWalkSessionFiles(path, depth+1, files); err != nil {
				return err
			}
		case entry.Type().IsRegular() && openclawIsSessionFile(entry.Name()):
			*files = append(*files, path)
		}
	}
	return nil
}

// openclawIsSessionFile is is_openclaw_session_file (paths.rs:75-83): the suffix
// starting at the first ".jsonl" must be the live name or one of the two archive
// spellings.
func openclawIsSessionFile(name string) bool {
	index := strings.Index(name, ".jsonl")
	if index < 0 {
		return false
	}
	suffix := name[index:]
	return suffix == ".jsonl" ||
		strings.HasPrefix(suffix, ".jsonl.deleted.") ||
		strings.HasPrefix(suffix, ".jsonl.reset.")
}

// openclawSessionID is extract_session_id (parser.rs:443-457).
func openclawSessionID(path string) string {
	name := filepath.Base(path)
	index := strings.Index(name, ".jsonl")
	if index < 0 {
		return name
	}
	stem := name[:index]
	if stem == "" {
		return name
	}
	return stem
}

// openclawParseSessionFile is parse_session_file (parser.rs:175-214).
func openclawParseSessionFile(path string, o Options) ([]Entry, error) {
	sessionID := openclawSessionID(path)
	fallback := openclawFileMtimeMillis(path)
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	entries := []Entry{}
	currentModel := ""
	currentProvider := ""
	for _, line := range openclawLines(content) {
		// Only model-tracking records and usage-bearing lines are worth a parse
		// (parser.rs:186-188).
		if !openclawPrefilter(line) {
			continue
		}
		value, ok := decodeToolJSONValue(line)
		if !ok {
			continue
		}
		record, ok := openclawParseLine(value)
		if !ok {
			continue
		}
		if openclawIsModelChange(record) {
			model, provider := openclawModelChangeSource(record)
			if model != "" {
				currentModel = model
			}
			if provider != "" {
				currentProvider = provider
			}
			continue
		}
		entry, ok := openclawMessageEntry(record, sessionID, currentModel, currentProvider, fallback, o, false)
		if ok {
			entries = append(entries, entry)
		}
	}
	return entries, nil
}

// openclawLines is byte_lines (core/src/fast.rs:101-127): split on '\n', a
// trailing newline does not produce an empty final line, and a CR is left on the
// line (JSON parsers treat it as trailing whitespace).
func openclawLines(content []byte) [][]byte {
	lines := [][]byte{}
	for len(content) > 0 {
		index := bytes.IndexByte(content, '\n')
		if index < 0 {
			lines = append(lines, content)
			break
		}
		lines = append(lines, content[:index])
		content = content[index+1:]
	}
	return lines
}

// openclawPrefilter is the LinePrefilter::any over the three markers
// (parser.rs:187-188).
func openclawPrefilter(line []byte) bool {
	return bytes.Contains(line, []byte(`"model_change"`)) ||
		bytes.Contains(line, []byte(`"model-snapshot"`)) ||
		bytes.Contains(line, []byte(`"usage"`))
}

// openclawParseLine mirrors the typed OpenClawLine deserialization
// (parser.rs:18-67): unknown fields are ignored, the two string-typed fields are
// strict, and every other field is lenient.
func openclawParseLine(value any) (openclawLine, bool) {
	object, ok := LenientObject(value)
	if !ok {
		return openclawLine{}, false
	}
	line := openclawLine{}
	if raw, present := object["type"]; present && raw != nil {
		text, ok := raw.(string)
		if !ok {
			return openclawLine{}, false
		}
		line.Type = text
		line.HasType = true
	}
	if raw, present := object["customType"]; present && raw != nil {
		text, ok := raw.(string)
		if !ok {
			return openclawLine{}, false
		}
		line.CustomType = text
	}
	if data, ok := LenientObject(object["data"]); ok {
		line.Data = data
	}
	line.ID, _ = NonEmptyString(object["id"])
	line.ModelID, _ = NonEmptyString(object["modelId"])
	line.Model, _ = NonEmptyString(object["model"])
	line.Provider, _ = NonEmptyString(object["provider"])
	line.Timestamp = object["timestamp"]
	if message, ok := openclawParseMessage(object["message"]); ok {
		line.Message = message
		line.HasMessage = true
	}
	return line, true
}

// openclawParseMessage mirrors lenient_object::<OpenClawMessage>
// (jsonl.rs:131-141): a non-object is absent, and an object that fails the
// typed struct (a non-string role, a non-object usage) is absent too.
func openclawParseMessage(raw any) (map[string]any, bool) {
	message, ok := LenientObject(raw)
	if !ok {
		return nil, false
	}
	if role, present := message["role"]; present && role != nil {
		if _, ok := role.(string); !ok {
			return nil, false
		}
	}
	if usage, present := message["usage"]; present && usage != nil {
		if _, ok := LenientObject(usage); !ok {
			return nil, false
		}
	}
	return message, true
}

// openclawIsModelChange is is_model_change (parser.rs:216-222).
func openclawIsModelChange(line openclawLine) bool {
	if line.Type == "model_change" {
		return true
	}
	return line.Type == "custom" && line.CustomType == "model-snapshot"
}

// openclawModelChangeSource is model_change_source (parser.rs:227-241): the
// nested data block wins over the root fields, and modelId wins over model.
func openclawModelChangeSource(line openclawLine) (string, string) {
	if line.Data != nil {
		model, ok := NonEmptyString(line.Data["modelId"])
		if !ok {
			model, _ = NonEmptyString(line.Data["model"])
		}
		provider, _ := NonEmptyString(line.Data["provider"])
		return model, provider
	}
	model := line.ModelID
	if model == "" {
		model = line.Model
	}
	return model, line.Provider
}

// openclawMessageEntry is parse_transcript_message (parser.rs:267-328) plus
// openclaw_entry_to_loaded (parser.rs:353-418). fromSQLite selects whether the
// record's stable id survives: the JSONL path discards it, matching
// parse_message_entry (parser.rs:243-258).
func openclawMessageEntry(line openclawLine, sessionID, currentModel, currentProvider string, fallback int64, o Options, fromSQLite bool) (Entry, bool) {
	if line.Type != "message" || !line.HasMessage {
		return Entry{}, false
	}
	message := line.Message
	if role, _ := message["role"].(string); role != "assistant" {
		return Entry{}, false
	}
	usageObject, ok := LenientObject(message["usage"])
	if !ok {
		return Entry{}, false
	}
	usage := Usage{
		Input:         LenientU64(usageObject["input"]),
		Output:        LenientU64(usageObject["output"]),
		CacheRead:     LenientU64(usageObject["cacheRead"]),
		CacheCreation: LenientU64(usageObject["cacheWrite"]),
	}
	ApplyTotalFallback(&usage, LenientU64(usageObject["totalTokens"]))
	if usage.Total() == 0 {
		return Entry{}, false
	}
	rawTimestamp := message["timestamp"]
	if rawTimestamp == nil {
		rawTimestamp = line.Timestamp
	}
	timestamp := fallback
	if parsed, ok := openclawTimestampFromValue(rawTimestamp); ok {
		timestamp = parsed
	}
	model, ok := NonEmptyString(message["modelId"])
	if !ok {
		model, ok = NonEmptyString(message["model"])
	}
	if !ok && currentModel != "" {
		model = currentModel
	}
	if model == "" {
		model = "unknown"
	}
	provider, _ := NonEmptyString(message["provider"])
	if provider == "" {
		provider = currentProvider
	}
	var reported *float64
	if costObject, ok := LenientObject(usageObject["cost"]); ok {
		if value, ok := LenientF64(costObject["total"]); ok {
			reported = &value
		}
	}
	messageID := ""
	if fromSQLite {
		messageID = line.ID
	}
	entry := Entry{
		Timestamp:    timestamp,
		Date:         FormatDateTZ(timestamp, o.Timezone),
		Model:        "[openclaw] " + model,
		Usage:        usage,
		ReportedCost: reported,
		SessionID:    sessionID,
		MessageID:    messageID,
		ProjectPath:  "OpenClaw",
		Version:      provider,
	}
	// openclaw is a rich session source (SessionAccumulator), so the session
	// row's last/first activity come from these per-entry timestamps.
	entry.LastActivity = timestamp
	entry.FirstActivity = timestamp
	openclawPriceEntry(o, &entry)
	return entry, true
}

// openclawPriceEntry prices one entry. The display name is "[openclaw] model";
// the pricing identity is that decorated name only when the table prices it
// exactly, otherwise the bare model (parser.rs:382-387). openclaw bills the
// named buckets only - extra_total_tokens is not folded into output - and its
// missing-pricing gate is missing_pricing_model_for_usage (cost.rs:48-71).
func openclawPriceEntry(o Options, entry *Entry) {
	pricingModel := entry.Model
	if _, ok := o.Corpus.FindExact(entry.Model); !ok {
		pricingModel = strings.TrimPrefix(entry.Model, "[openclaw] ")
	}
	switch {
	case o.Mode == nativepricing.ModeDisplay:
		entry.CostUSD = reportedOrZero(entry.ReportedCost)
	case o.Mode == nativepricing.ModeAuto && entry.ReportedCost != nil:
		entry.CostUSD = *entry.ReportedCost
	default:
		entry.CostUSD = 0
		if pricing, ok := o.Corpus.FindAt(pricingModel, entry.Timestamp); ok {
			entry.CostUSD = nativepricing.CostFromPricing(nativepricing.Usage{
				Input:         int64(entry.Usage.Input),
				Output:        int64(entry.Usage.Output),
				CacheCreate5m: int64(entry.Usage.CacheCreation),
				CacheRead:     int64(entry.Usage.CacheRead),
			}, pricing, false)
		}
	}
	if o.Mode == nativepricing.ModeDisplay || (o.Mode == nativepricing.ModeAuto && entry.ReportedCost != nil) {
		entry.MissingPricing = false
		return
	}
	buckets := entry.Usage.Input + entry.Usage.Output + entry.Usage.CacheCreation + entry.Usage.CacheRead
	if buckets == 0 {
		entry.MissingPricing = false
		return
	}
	_, found := o.Corpus.Find(pricingModel)
	entry.MissingPricing = !found
}

// openclawTimestampFromValue is timestamp_from_value (parser.rs:420-441):
// integer or unsigned milliseconds, then a real truncated to milliseconds, then
// the strict RFC3339 gate.
func openclawTimestampFromValue(value any) (int64, bool) {
	switch typed := value.(type) {
	case json.Number:
		if parsed, err := typed.Int64(); err == nil {
			return openclawTimestampFromMillis(parsed)
		}
		parsed, err := typed.Float64()
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return 0, false
		}
		truncated := math.Trunc(parsed)
		if truncated >= float64(math.MaxInt64) {
			return openclawTimestampFromMillis(math.MaxInt64)
		}
		if truncated <= float64(math.MinInt64) {
			return 0, false
		}
		return openclawTimestampFromMillis(int64(truncated))
	case string:
		return ParseTSTimestamp(typed)
	}
	return 0, false
}

// openclawTimestampFromMillis is timestamp_from_millis (parser.rs:434-441):
// only non-negative values are timestamps.
func openclawTimestampFromMillis(raw int64) (int64, bool) {
	if raw < 0 {
		return 0, false
	}
	return raw, true
}

// openclawCreatedAtMillis is the SQLite reader's created_at fallback
// (sqlite.rs:131-139): an integer, else a truncated real, floored at zero.
func openclawCreatedAtMillis(value any) int64 {
	millis := int64(0)
	switch typed := value.(type) {
	case int64:
		millis = typed
	case float64:
		if !math.IsNaN(typed) && !math.IsInf(typed, 0) {
			truncated := math.Trunc(typed)
			if truncated >= float64(math.MaxInt64) {
				millis = math.MaxInt64
			} else if truncated > float64(math.MinInt64) {
				millis = int64(truncated)
			}
		}
	}
	if millis < 0 {
		return 0
	}
	return millis
}

// openclawFileMtimeMillis is file_modified_timestamp (parser.rs:459-467): the
// file mtime, or the Unix epoch when it is unavailable or before it.
func openclawFileMtimeMillis(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	millis := info.ModTime().UnixMilli()
	if millis < 0 {
		return 0
	}
	return millis
}

// openclawEntryID is entry_id (parser.rs:469-471).
func openclawEntryID(entry Entry) string {
	return openclawMigrationID(entry) + ":" + strconv.FormatFloat(entry.CostUSD, 'f', -1, 64)
}

// openclawMigrationID is migration_id (parser.rs:477-491): the content identity
// shared by a legacy JSONL event and its migrated SQLite copy, deliberately
// without the cost.
func openclawMigrationID(entry Entry) string {
	return strings.Join([]string{
		"openclaw",
		entry.SessionID,
		FormatRFC3339Millis(entry.Timestamp),
		entry.Model,
		strconv.FormatUint(entry.Usage.Input, 10),
		strconv.FormatUint(entry.Usage.Output, 10),
		strconv.FormatUint(entry.Usage.CacheCreation, 10),
		strconv.FormatUint(entry.Usage.CacheRead, 10),
		strconv.FormatUint(entry.Usage.Extra, 10),
	}, ":")
}

func openclawFindEntry(entries []Entry, match func(Entry) bool) int {
	for index, entry := range entries {
		if match(entry) {
			return index
		}
	}
	return -1
}

// openclawAgentEntries reads every per-agent database under one root
// (sqlite.rs:59-71).
func openclawAgentEntries(root string, o Options) []Entry {
	entries := []Entry{}
	for _, dbPath := range openclawAgentDatabases(root) {
		entries = append(entries, openclawDatabaseEntries(dbPath, o)...)
	}
	return entries
}

// openclawAgentDatabases is collect_agent_databases (sqlite.rs:22-49): a lexical
// scan that never follows a symlink.
func openclawAgentDatabases(root string) []string {
	agentsPath := filepath.Join(root, "agents")
	if !openclawIsDirectoryNoSymlink(agentsPath) {
		return nil
	}
	agents, err := os.ReadDir(agentsPath)
	if err != nil {
		return nil
	}
	databases := []string{}
	for _, agent := range agents {
		if !agent.IsDir() {
			continue
		}
		agentPath := filepath.Join(agentsPath, agent.Name(), "agent")
		if !openclawIsDirectoryNoSymlink(agentPath) {
			continue
		}
		path := filepath.Join(agentPath, "openclaw-agent.sqlite")
		if openclawIsFileNoSymlink(path) {
			databases = append(databases, path)
		}
	}
	sort.Strings(databases)
	return databases
}

func openclawIsDirectoryNoSymlink(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsDir()
}

func openclawIsFileNoSymlink(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular()
}

// openclawDatabaseEntries is read_agent_database (sqlite.rs:80-178).
func openclawDatabaseEntries(dbPath string, o Options) []Entry {
	database, err := openToolReadOnlySQLiteDatabase(dbPath)
	if err != nil {
		o.debugf("Failed to open OpenClaw agent database: " + dbPath)
		return nil
	}
	defer database.Close()
	if !openclawHasTranscriptEvents(database) {
		o.debugf("OpenClaw agent database has no transcript_events table: " + dbPath)
		return nil
	}
	rows, err := database.Query("SELECT session_id, seq, event_json, created_at FROM transcript_events ORDER BY session_id ASC, seq ASC")
	if err != nil {
		o.debugf("Failed to query OpenClaw agent database: " + dbPath)
		return nil
	}
	defer rows.Close()
	// Model/provider tracking is per session in the JSONL path; SQLite rows
	// arrive in session order, so the tracked state resets at each boundary.
	currentSession := ""
	haveSession := false
	currentModel := ""
	currentProvider := ""
	entries := []Entry{}
	for rows.Next() {
		var sessionValue, seqValue, eventValue, createdAtValue any
		if err := rows.Scan(&sessionValue, &seqValue, &eventValue, &createdAtValue); err != nil {
			continue
		}
		sessionID, ok := sessionValue.(string)
		if !ok {
			continue
		}
		if !haveSession || currentSession != sessionID {
			haveSession = true
			currentSession = sessionID
			currentModel = ""
			currentProvider = ""
		}
		fallback := openclawCreatedAtMillis(createdAtValue)
		eventJSON, ok := eventValue.(string)
		if !ok {
			continue
		}
		value, ok := decodeToolJSONValue([]byte(eventJSON))
		if !ok {
			continue
		}
		line, ok := openclawParseLine(value)
		if !ok {
			continue
		}
		if openclawIsModelChange(line) {
			model, provider := openclawModelChangeSource(line)
			if model != "" {
				currentModel = model
			}
			if provider != "" {
				currentProvider = provider
			}
			continue
		}
		entry, ok := openclawMessageEntry(line, sessionID, currentModel, currentProvider, fallback, o, true)
		if ok {
			entries = append(entries, entry)
		}
	}
	if err := rows.Err(); err != nil {
		o.debugf("Failed to read OpenClaw agent database " + dbPath + ": " + err.Error())
	}
	return entries
}

// openclawHasTranscriptEvents is table_exists (sqlite.rs:180-190).
func openclawHasTranscriptEvents(database *sql.DB) bool {
	var one int
	err := database.QueryRow("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1", "transcript_events").Scan(&one)
	return err == nil
}
