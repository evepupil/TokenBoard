package tools

// The Qwen adapter, ported from ccusage v20.0.33 (commit 1308c416):
// rust/adapters/qwen/src/{paths,parser,report,lib}.rs.
//
// Qwen chat logs live at <root>/projects/<project>/chats/<file>.jsonl and record
// Gemini-style usageMetadata blocks on assistant turns. The source never reports
// a USD cost, so display mode prints zero and auto/calculate price the tokens
// through the model -> qwen/<model> -> alibaba/<model> chain.

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// qwenDefaultDataDirs is the default root (paths.rs:20-22).
var qwenDefaultDataDirs = []string{"~/.qwen"}

// qwenDefaultModel is DEFAULT_QWEN_MODEL (parser.rs:25).
const qwenDefaultModel = "unknown"

// qwenChatEntry is one parsed chat record before the dedup and pricing passes.
// timestampText is part of entry_id (parser.rs:290-302), so it is carried even
// though Entry only keeps the millis.
type qwenChatEntry struct {
	timestamp     int64
	timestampText string
	sessionID     string
	model         string
	project       string
	usage         Usage
}

// LoadQwen reads every three-segment chat file under each root's projects tree,
// dedupes first-wins in sorted file order (entry_id, parser.rs:290-302) and
// returns entries ordered by timestamp.
func LoadQwen(o Options) ([]Entry, error) {
	roots, err := resolveRoots(o, "QWEN_DATA_DIR", qwenDefaultDataDirs, isDirectory)
	if err != nil {
		return nil, err
	}
	files := []string{}
	for _, root := range roots {
		projects := filepath.Join(root, "projects")
		if !isDirectory(projects) {
			continue
		}
		for _, file := range CollectFiles(projects, func(name string) bool { return strings.HasSuffix(name, ".jsonl") }) {
			if qwenIsChatFile(projects, file) {
				files = append(files, file)
			}
		}
	}
	sort.Strings(files)
	seen := map[string]bool{}
	entries := []Entry{}
	for _, file := range files {
		for _, chat := range parseQwenChatFile(file, o) {
			key := qwenEntryID(chat)
			if seen[key] {
				continue
			}
			seen[key] = true
			entries = append(entries, qwenEntryToEntry(chat, o))
		}
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Timestamp < entries[j].Timestamp })
	return entries, nil
}

// qwenIsChatFile is is_chat_file (paths.rs:48-60): exactly
// <project>/chats/<file>.jsonl relative to the projects directory.
func qwenIsChatFile(projects, file string) bool {
	relative, err := filepath.Rel(projects, file)
	if err != nil {
		return false
	}
	parts := strings.Split(relative, string(filepath.Separator))
	if len(parts) != 3 || parts[0] == "" || parts[0] == "." {
		return false
	}
	return parts[1] == "chats" && strings.HasSuffix(parts[2], ".jsonl")
}

// qwenProjectFromFile is project_from_file (paths.rs:62-77): the last
// projects/<project>/chats/<file> window in the path.
func qwenProjectFromFile(file string) (string, bool) {
	parts := strings.Split(filepath.ToSlash(file), "/")
	for index := len(parts) - 4; index >= 0; index-- {
		if parts[index] == "projects" && parts[index+2] == "chats" {
			return parts[index+1], true
		}
	}
	return "", false
}

// parseQwenChatFile is read_chat_file (parser.rs:98-117).
func parseQwenChatFile(file string, o Options) []qwenChatEntry {
	fallback := qwenFileTimestamp(file, o)
	content, err := os.ReadFile(file)
	if err != nil {
		o.debugf("Failed to read Qwen chat file " + file + ": " + err.Error())
		return nil
	}
	entries := []qwenChatEntry{}
	for _, raw := range strings.Split(string(content), "\n") {
		line := strings.TrimSuffix(raw, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		record, ok := qwenDecodeObject([]byte(line))
		if !ok {
			continue
		}
		if entry, ok := qwenParseLine(record, file, fallback); ok {
			entries = append(entries, entry)
		}
	}
	return entries
}

// qwenParseLine is parse_line (parser.rs:119-210).
func qwenParseLine(record map[string]any, file string, fallback int64) (qwenChatEntry, bool) {
	if kind, _ := NonEmptyString(record["type"]); kind != "assistant" {
		return qwenChatEntry{}, false
	}
	metadata, ok := LenientObject(record["usageMetadata"])
	if !ok {
		return qwenChatEntry{}, false
	}
	usage := Usage{
		Input:     LenientU64(metadata["promptTokenCount"]),
		Output:    LenientU64(metadata["candidatesTokenCount"]),
		CacheRead: LenientU64(metadata["cachedContentTokenCount"]),
		Extra:     LenientU64(metadata["thoughtsTokenCount"]),
	}
	ApplyTotalFallback(&usage, LenientU64(metadata["totalTokenCount"]))
	if usage.Input == 0 && usage.Output == 0 && usage.CacheRead == 0 && usage.Extra == 0 {
		return qwenChatEntry{}, false
	}

	timestamp := fallback
	timestampText := FormatRFC3339Millis(fallback)
	if text, ok := NonEmptyString(record["timestamp"]); ok {
		if millis, ok := ParseTSTimestamp(text); ok {
			timestamp, timestampText = millis, text
		}
	}
	project, ok := qwenProjectFromFile(file)
	if !ok {
		project = "unknown"
	}
	sessionID, ok := NonEmptyString(record["sessionId"])
	if !ok {
		sessionID = project + "-" + qwenFileStem(file)
	}
	model, ok := NonEmptyString(record["model"])
	if !ok {
		model = qwenDefaultModel
	}
	return qwenChatEntry{
		timestamp:     timestamp,
		timestampText: timestampText,
		sessionID:     sessionID,
		model:         model,
		project:       project,
		usage:         usage,
	}, true
}

// qwenEntryToEntry is the LoadedEntry conversion in parse_line
// (parser.rs:172-209).
func qwenEntryToEntry(chat qwenChatEntry, o Options) Entry {
	entry := Entry{
		Timestamp:   chat.timestamp,
		Date:        FormatDateTZ(chat.timestamp, o.Timezone),
		Model:       chat.model,
		Usage:       chat.usage,
		SessionID:   chat.sessionID,
		ProjectPath: chat.project,
	}
	// qwen's session report goes through SessionAccumulator, which takes
	// last/first activity from the entry timestamp (summary.rs:130-156) and
	// then filters rows by that lastActivity (lib.rs:53-67). Zero would read
	// as 1970 and drop every session from the report.
	entry.LastActivity = chat.timestamp
	entry.FirstActivity = chat.timestamp
	// calculate_qwen_cost (parser.rs:212-234) bills output + extra, which
	// PriceEntry reproduces by folding Extra into the billed output.
	PriceEntry(o.Corpus, &entry, qwenModelCandidates(chat.model), PriceAt(chat.timestamp), o.Mode, LookupFindAt)
	return entry
}

// qwenModelCandidates is qwen_model_candidates (parser.rs:253-259).
func qwenModelCandidates(model string) []string {
	return []string{model, "qwen/" + model, "alibaba/" + model}
}

// qwenEntryID is entry_id (parser.rs:290-302): the JSON array serialization of
// the fields that identify one chat record across files.
func qwenEntryID(entry qwenChatEntry) string {
	payload, err := json.Marshal([]any{
		entry.sessionID,
		entry.timestampText,
		entry.model,
		entry.usage.Input,
		entry.usage.Output,
		entry.usage.CacheRead,
		entry.usage.Extra,
	})
	if err != nil {
		return entry.sessionID + "\x00" + entry.timestampText
	}
	return string(payload)
}

// QwenReportJSON is qwen's report_from_rows (report.rs:11-20): the only tool
// adapter whose empty report prints `"totals": null` instead of a zeroed block.
// qwen is also one of the three rich sources whose session rows carry
// lastActivity/firstActivity/projectPath (report.rs:14).
func QwenReportJSON(rows []Row, totals Totals, kind ReportKind) map[string]any {
	document := ReportJSON(rows, totals, kind, kind == Session)
	if len(rows) == 0 {
		document["totals"] = nil
	}
	return document
}

// FilterQwenSessionRows is filter_session_summaries (qwen/src/lib.rs:53-67): the
// session report is narrowed by each row's lastActivity instead of by entry
// dates, with both bounds inclusive over the `-`-stripped spelling. An empty
// bound is unset; a missing lastActivity falls outside any range.
func FilterQwenSessionRows(rows []Row, since, until string) []Row {
	if since == "" && until == "" {
		return rows
	}
	filtered := make([]Row, 0, len(rows))
	for _, row := range rows {
		date := compactDate(FormatRFC3339Millis(row.LastActivity))
		if since != "" && date < compactDate(since) {
			continue
		}
		if until != "" && date > compactDate(until) {
			continue
		}
		filtered = append(filtered, row)
	}
	return filtered
}

// qwenFileTimestamp is file_timestamp (parser.rs:261-281): the mtime, and the
// current time when it cannot be read (including a pre-epoch stamp, which
// duration_since(UNIX_EPOCH) rejects).
func qwenFileTimestamp(file string, o Options) int64 {
	info, err := os.Stat(file)
	if err != nil {
		o.debugf("Failed to read Qwen chat file timestamp for " + file + ": " + err.Error())
		return time.Now().UnixMilli()
	}
	millis := info.ModTime().UnixMilli()
	if millis < 0 {
		o.debugf("Failed to read Qwen chat file timestamp for " + file + ": file time is before the Unix epoch")
		return time.Now().UnixMilli()
	}
	return millis
}

// qwenFileStem mirrors Path::file_stem for the <project>-<stem> session default.
func qwenFileStem(file string) string {
	base := filepath.Base(file)
	if dot := strings.LastIndexByte(base, '.'); dot > 0 {
		return base[:dot]
	}
	return base
}

// qwenDecodeObject decodes exactly one JSON object per line, matching
// serde_json::from_slice's whole-input requirement.
func qwenDecodeObject(content []byte) (map[string]any, bool) {
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
