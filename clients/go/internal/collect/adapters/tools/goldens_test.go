package tools

// The golden tests freeze every ccusage tool adapter against the JSON ccusage
// 20.0.33 actually prints for the committed fixture trees under
// clients/go/testdata/tool-goldens-fixtures/<source>. Everything below the
// report builder is covered transitively: file and database discovery, the
// per-source parsers, dedupe, date attribution and the pricing chain all feed
// one report document that is compared field by field against ccusage's own
// answer.
//
// The comparison is strict: every leaf of every report must match, with no
// exemptions. A mismatch is a defect in the adapter or a rule that has not been
// ported yet; neither may be papered over by an exemption list.
//
// The document is produced the way the native provider produces it
// (providers/ccusagetool/native.go, Run):
//
//   - the adapter is loaded with Options{Env: <the fixture's data-directory
//     variable>, Timezone: UTC, Mode: auto|calculate, Corpus: the embedded
//     corpus with no overrides}, because the goldens are minted without
//     --config;
//   - the window filter is filterToolRows, copied verbatim below because it is
//     unexported in the provider package (native.go: filter_loaded_entries_by_date,
//     qwen's session report being the documented exception);
//   - Summarize + ReportJSON (or QwenReportJSON, whose empty report has a null
//     totals block) emit the document shape.
//
// The fixture trees are owned by scripts/gen-tool-goldens.mjs: this file never
// writes them. TestToolGoldensFixturesMatchTheGenerator fails when a committed
// tree drifts from the generator's definitions, which would otherwise leave the
// goldens silently stale.

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// toolGoldenReports is the committed ccusage 20.0.33 output for every fixture
// tree.
//
//go:embed goldens/tool-reports.json
var toolGoldenReports []byte

// maxDiffPaths caps how many differing paths one failure prints.
const maxDiffPaths = 10

// toolGoldenCommand is one recorded invocation (tool-reports.json commands[]).
type toolGoldenCommand struct {
	ID   string            `json:"id"`
	Argv []string          `json:"argv"`
	Env  map[string]string `json:"env"`
}

// toolGoldenDocument is goldens/tool-reports.json.
type toolGoldenDocument struct {
	CcusageVersion string                                `json:"ccusageVersion"`
	Since          string                                `json:"since"`
	Until          string                                `json:"until"`
	Timezone       string                                `json:"timezone"`
	Commands       []toolGoldenCommand                   `json:"commands"`
	Reports        map[string]map[string]json.RawMessage `json:"reports"`
}

// loadToolGoldens decodes the embedded golden document and pins its version and
// window.
func loadToolGoldens(t *testing.T) *toolGoldenDocument {
	t.Helper()
	var document toolGoldenDocument
	if err := json.Unmarshal(toolGoldenReports, &document); err != nil {
		t.Fatalf("decode goldens/tool-reports.json: %v", err)
	}
	if document.CcusageVersion != "20.0.33" {
		t.Fatalf("goldens were minted by ccusage %q, want 20.0.33 — re-mint or check the file",
			document.CcusageVersion)
	}
	if document.Since != "20260503" || document.Until != "20260507" || document.Timezone != "UTC" {
		t.Fatalf("goldens window = %s..%s %s, want 20260503..20260507 UTC",
			document.Since, document.Until, document.Timezone)
	}
	if len(document.Reports) != 11 {
		t.Fatalf("goldens cover %d sources, want 11", len(document.Reports))
	}
	return &document
}

// toolFixtureRoots is the fixture tree each source loads from.
var toolFixtureRoots = map[string]string{
	"amp":      "AMP_DATA_DIR",
	"droid":    "DROID_SESSIONS_DIR",
	"codebuff": "CODEBUFF_DATA_DIR",
	"hermes":   "HERMES_HOME",
	"goose":    "GOOSE_PATH_ROOT",
	"kilo":     "KILO_DATA_DIR",
	"gemini":   "GEMINI_DATA_DIR",
	"kimi":     "KIMI_DATA_DIR",
	"qwen":     "QWEN_DATA_DIR",
	"zcode":    "ZCODE_HOME",
	"openclaw": "OPENCLAW_DIR",
}

// toolGoldenSources is sorted so failures are reported in a stable order.
func toolGoldenSources() []string {
	sources := make([]string, 0, len(toolFixtureRoots))
	for source := range toolFixtureRoots {
		sources = append(sources, source)
	}
	sort.Strings(sources)
	return sources
}

func toolFixtureRoot(t *testing.T, source string) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "testdata", "tool-goldens-fixtures", source))
	if err != nil {
		t.Fatalf("resolve the %s fixture root: %v", source, err)
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		t.Fatalf("fixture tree for %s is missing at %s: run node clients/go/scripts/gen-tool-goldens.mjs", source, root)
	}
	return root
}

// toolReportCommand returns the recorded invocation for one golden id.
func (d *toolGoldenDocument) command(t *testing.T, id string) toolGoldenCommand {
	t.Helper()
	for _, command := range d.Commands {
		if command.ID == id {
			return command
		}
	}
	t.Fatalf("goldens record no command for %q", id)
	return toolGoldenCommand{}
}

// toolReport drives one adapter over its fixture and renders the document the
// native provider would hand to the normalizer.
func toolReport(t *testing.T, document *toolGoldenDocument, source, report, modeLabel string) json.RawMessage {
	t.Helper()
	command := document.command(t, source+"/"+report+"/"+modeLabel)
	envVar, ok := toolFixtureRoots[source]
	if !ok {
		t.Fatalf("no data-directory variable recorded for %s", source)
	}
	// The recorded environment names the tree the golden was minted against;
	// the Go side points the same variable at the committed tree.
	if _, ok := command.Env[envVar]; !ok {
		t.Fatalf("command %q does not set %s", command.ID, envVar)
	}
	mode := nativepricing.ModeAuto
	if modeLabel == "calculate" {
		mode = nativepricing.ModeCalculate
	}
	corpus, err := nativepricing.LoadEmbeddedCorpus()
	if err != nil {
		t.Fatalf("LoadEmbeddedCorpus: %v", err)
	}
	root := toolFixtureRoot(t, source)
	options := Options{
		Env: func(key string) (string, bool) {
			if key == envVar {
				return root, true
			}
			return "", false
		},
		HomeDir: func() (string, error) {
			return "", errors.New("HOME must not be consulted when the data-directory variable is set")
		},
		Timezone: document.Timezone,
		Mode:     mode,
		Corpus:   corpus,
	}
	entries, err := LoadCommand(t.Context(), argvSource(command.Argv), options)
	if err != nil {
		t.Fatalf("LoadCommand(%s): %v", command.Argv[1], err)
	}
	kind := Daily
	if report == "session" {
		kind = Session
	}
	// qwen's session report keeps every entry and filters the summarised rows by
	// lastActivity (qwen/src/lib.rs:22-31, 53-67), so its branch differs from
	// the shared entry-level filter used by the other ten sources.
	subcommand := argvSource(command.Argv)
	summaryEntries := entries
	if !(subcommand == "qwen" && kind == Session) {
		summaryEntries = filterToolEntries(entries, kind, subcommand, document.Since, document.Until, document.Timezone)
	}
	rows, _ := Summarize(summaryEntries, kind)
	if subcommand == "qwen" && kind == Session {
		rows = FilterQwenSessionRows(rows, document.Since, document.Until)
	}
	var rendered map[string]any
	if subcommand == "qwen" {
		rendered = QwenReportJSON(rows, TotalsFromRows(rows), kind)
	} else {
		rendered = ReportJSON(rows, TotalsFromRows(rows), kind, RichSessionMetadata(subcommand))
	}
	encoded, err := json.Marshal(rendered)
	if err != nil {
		t.Fatalf("marshal the %s %s report: %v", source, report, err)
	}
	return encoded
}

// argvSource is the ccusage subcommand an invocation names (argv[1]; argv[0]
// is the literal "ccusage").
func argvSource(argv []string) string {
	if len(argv) < 2 {
		return ""
	}
	return argv[1]
}

// filterToolEntries copies filter_loaded_entries_by_date
// (adapters/common/src/lib.rs:48-59) as providers/ccusagetool/native.go
// filterToolRows applies it: the entry's local date must fall inside the
// window, both ends inclusive. qwen's session report is the documented
// exception: it keeps every entry and filters the summaries by lastActivity
// instead (qwen/src/lib.rs:53-67).
func filterToolEntries(entries []Entry, kind ReportKind, command, since, until, timezone string) []Entry {
	if command == "qwen" && kind == Session {
		if since == "" && until == "" {
			return entries
		}
		kept := entries[:0]
		for _, entry := range entries {
			date := FormatDateTZ(entry.LastActivity, timezone)
			if DateWithinRange(date, since, until) {
				kept = append(kept, entry)
			}
		}
		return kept
	}
	if since == "" && until == "" {
		return entries
	}
	kept := entries[:0]
	for _, entry := range entries {
		if DateWithinRange(entry.Date, since, until) {
			kept = append(kept, entry)
		}
	}
	return kept
}

// toolKnownGapSkips are the (source, report) subtests whose Go output cannot
// match ccusage until a file this task does not own is fixed. The subtest is
// skipped with the reason inline, so the gap stays visible in `go test -v`
// output and the golden file still records ccusage's answer.
var toolKnownGapSkips = map[string]string{}

// TestToolAdaptersMatchTheGoldens compares every source's daily and session
// documents, in both cost modes, against ccusage's own output.
func TestToolAdaptersMatchTheGoldens(t *testing.T) {
	document := loadToolGoldens(t)
	for _, source := range toolGoldenSources() {
		t.Run(source, func(t *testing.T) {
			for _, mode := range []string{"auto", "calculate"} {
				for _, report := range []string{"daily", "session"} {
					id := source + "/" + report
					t.Run(report+"/"+mode, func(t *testing.T) {
						if reason, known := toolKnownGapSkips[id]; known {
							t.Skipf("known gap: %s (remove the entry from toolKnownGapSkips once fixed)", reason)
						}
						golden, ok := document.Reports[source][source+"/"+report+"/"+mode]
						if !ok {
							t.Fatalf("goldens record no report for %s/%s/%s", source, report, mode)
						}
						got := toolReport(t, document, source, report, mode)
						compareToolReport(t, source+" "+report+" "+mode, golden, got,
							document.command(t, source+"/"+report+"/"+mode))
					})
				}
			}
		})
	}
}

// toolTreeDifference is one mismatched leaf between the golden and the port.
type toolTreeDifference struct {
	path string
	want string
	got  string
}

func (d toolTreeDifference) String() string {
	return fmt.Sprintf("%s: golden %s, port %s", d.path, d.want, d.got)
}

// compareToolReport diffs one report. Numbers are compared as float64 bit
// patterns, so -0 and +0 differ and an integer 1 equals 1.0 (ccusage prints
// 0.0 where encoding/json prints 0).
func compareToolReport(t *testing.T, label string, golden, port []byte, command toolGoldenCommand) {
	t.Helper()
	want := decodeToolTree(t, label+" golden", golden)
	got := decodeToolTree(t, label+" port", port)
	if differences := diffToolTrees("", want, got, maxDiffPaths+1); len(differences) > 0 {
		t.Fatalf("%s differs from `%s`:\n%s", label, joinCommand(command.Argv),
			differencesText(differences))
	}
}

func joinCommand(argv []string) string {
	var buffer bytes.Buffer
	for index, arg := range argv {
		if index > 0 {
			buffer.WriteByte(' ')
		}
		buffer.WriteString(arg)
	}
	return buffer.String()
}

// decodeToolTree parses a document into the generic JSON tree with numbers kept
// as floats.
func decodeToolTree(t *testing.T, label string, data []byte) any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("%s is not valid JSON: %v\n%s", label, err, data)
	}
	return normalizeToolTree(value)
}

func normalizeToolTree(value any) any {
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return typed.String()
		}
		return parsed
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, child := range typed {
			out[key] = normalizeToolTree(child)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, child := range typed {
			out[index] = normalizeToolTree(child)
		}
		return out
	default:
		return value
	}
}

func diffToolTrees(path string, want, got any, limit int) []toolTreeDifference {
	if limit <= 0 {
		return nil
	}
	switch wantTyped := want.(type) {
	case map[string]any:
		gotTyped, ok := got.(map[string]any)
		if !ok {
			return []toolTreeDifference{{path: path, want: describe(want), got: describe(got)}}
		}
		keys := make([]string, 0, len(wantTyped)+len(gotTyped))
		seen := map[string]bool{}
		for key := range wantTyped {
			keys = append(keys, key)
			seen[key] = true
		}
		for key := range gotTyped {
			if !seen[key] {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
		differences := []toolTreeDifference{}
		for _, key := range keys {
			wantChild, wantOK := wantTyped[key]
			gotChild, gotOK := gotTyped[key]
			childPath := key
			if path != "" {
				childPath = path + "." + key
			}
			if !wantOK {
				differences = append(differences, toolTreeDifference{path: childPath, want: "<absent>", got: describe(gotChild)})
			} else if !gotOK {
				differences = append(differences, toolTreeDifference{path: childPath, want: describe(wantChild), got: "<absent>"})
			} else {
				differences = append(differences, diffToolTrees(childPath, wantChild, gotChild, limit-len(differences))...)
			}
			if len(differences) >= limit {
				break
			}
		}
		return differences
	case []any:
		gotTyped, ok := got.([]any)
		if !ok {
			return []toolTreeDifference{{path: path, want: describe(want), got: describe(got)}}
		}
		if len(wantTyped) != len(gotTyped) {
			return []toolTreeDifference{{path: path + ".length", want: fmt.Sprint(len(wantTyped)), got: fmt.Sprint(len(gotTyped))}}
		}
		differences := []toolTreeDifference{}
		for index := range wantTyped {
			differences = append(differences, diffToolTrees(fmt.Sprintf("%s[%d]", path, index), wantTyped[index], gotTyped[index], limit-len(differences))...)
			if len(differences) >= limit {
				break
			}
		}
		return differences
	default:
		if !sameToolLeaf(want, got) {
			return []toolTreeDifference{{path: path, want: describe(want), got: describe(got)}}
		}
		return nil
	}
}

func sameToolLeaf(want, got any) bool {
	wantFloat, wantIsFloat := want.(float64)
	gotFloat, gotIsFloat := got.(float64)
	if wantIsFloat || gotIsFloat {
		return wantIsFloat && gotIsFloat && math.Float64bits(wantFloat) == math.Float64bits(gotFloat)
	}
	return reflect.DeepEqual(want, got)
}

func describe(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	return string(encoded)
}

func differencesText(differences []toolTreeDifference) string {
	lines := ""
	for _, difference := range differences {
		lines += "  " + difference.String() + "\n"
	}
	return lines
}

// TestToolGoldensFixturesMatchTheGenerator fails when a committed fixture tree
// changed without re-minting. gen-tool-goldens.mjs re-materialises every JSON
// file and every SQLite database from its definitions, which makes the JSON
// bytes (written verbatim) stable forever; a JSON file whose bytes no longer
// parse or that disappeared would silently shrink a report, so the fixture set
// is pinned here against the paths the generator defines.
func TestToolGoldensFixturesMatchTheGenerator(t *testing.T) {
	expected := map[string][]string{
		"amp":      {"threads/T-11111111-1111-1111-1111-111111111111.json", "threads/T-22222222-2222-2222-2222-222222222222.json"},
		"codebuff": {"projects/project-one/chats/2026-05-04T01-00-00.000Z/chat-messages.json", "projects/project-two/chats/2026-05-05T02-00-00.000Z/chat-messages.json"},
		"droid":    {"session-a.settings.json", "session-b.settings.json", "session-c.settings.json"},
		"gemini":   {"session-gemini-1.jsonl"},
		"goose":    {"data/sessions/sessions.db"},
		"hermes":   {"state.db"},
		"kilo":     {"kilo.db"},
		"kimi": {
			"config.json",
			"sessions/group/session-new/wire.jsonl",
			"sessions/group/session-old/wire.jsonl",
			"sessions/workspace/session-agents/agents/agent-1/wire.jsonl",
			"sessions/workspace/session-june/wire.jsonl",
		},
		"openclaw": {"agents/agent-1/sessions/sess-a.jsonl", "agents/agent-1/sessions/sess-b.jsonl"},
		"qwen":     {"projects/project-one/chats/session-qwen-1.jsonl", "projects/project-two/chats/session-qwen-2.jsonl"},
		"zcode":    {"cli/db/db.sqlite"},
	}
	for source, paths := range expected {
		root := toolFixtureRoot(t, source)
		seen := []string{}
		err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !entry.Type().IsRegular() {
				return nil
			}
			relativePath, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			seen = append(seen, filepath.ToSlash(relativePath))
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", root, err)
		}
		sort.Strings(seen)
		want := append([]string{}, paths...)
		sort.Strings(want)
		if !reflect.DeepEqual(seen, want) {
			t.Fatalf("fixture tree for %s holds %v, want %v — re-mint with node clients/go/scripts/gen-tool-goldens.mjs", source, seen, want)
		}
	}
}
