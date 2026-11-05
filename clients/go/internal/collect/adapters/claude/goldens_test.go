package claude

// The golden tests freeze the whole Claude adapter against the JSON ccusage
// 20.0.33 actually prints for the committed fixture tree. Everything below the
// report builders is covered transitively: the fixture exercises the two
// parsers (entry.go), the pricing pass (cost.go), the dedupe index (dedupe.go)
// and the two report builders (daily.go, session.go), and any deviation shows
// up as a field-level diff against ccusage's own answer.
//
// The comparison is strict: every leaf of every report must match, with no
// exemptions. The one divergence this corpus once had - a duplicate UNKNOWN
// member in a null-free line, which ccusage's serde path ignores and this parser
// used to reject - was fixed in entry.go (isKnownMember), not waived here. A
// future mismatch is a defect in the port or in a rule that has not been ported
// yet; neither may be papered over by an exemption list.
//
// The goldens are regenerated only with
// `node clients/go/scripts/gen-claude-goldens.mjs`; that script owns the
// version pin, the clean-environment assertions and the fixture hash. This file
// never writes them.
//
// Registered coverage gaps (accepted, not defects to chase here):
//
//   - M-2: every fixture line is well formed, so the corpus only proves the
//     ACCEPT half of the parser. "A duplicate modelled field must drop the line"
//     is pinned by entry_test.go, not by a golden.
//   - M-3: the fixture has no files near the --since window and no --until edge,
//     so a prune or window regression would not show up here; collect_test.go
//     owns those.
//   - M-5: parseMember and knownChildMember are two hand-kept lists. Adding a
//     field to one without the other silently widens the duplicate rule; the
//     comment on parseMember says so, but nothing enforces it.

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// goldenReports is the committed ccusage 20.0.33 output for the fixture tree.
//
//go:embed goldens/claude-reports.json
var goldenReports []byte

// The window the goldens were minted under. gen-claude-goldens.mjs passes
// -s/-u 20260225/20260331; the mtime prune below needs a clock, and a fixed one
// keeps the test independent of the day it runs on.
const (
	goldenSince = "20260225"
	goldenUntil = "20260331"
)

// goldenNow is well after both the fixture dates and the window, so the --since
// prune never sees a window that opens in the future.
var goldenNow = time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)

// maxDiffPaths caps how many differing paths one failure prints. The first
// differences are the informative ones; a whole-document dump is not. The walk
// collects one past the cap so the message can say "at least" instead of
// claiming an exact count it did not measure.
const maxDiffPaths = 10

// Report labels, used for failure messages and command lookups.
const (
	reportDailyAuto      = "daily --mode auto"
	reportDailyCalculate = "daily --mode calculate"
	reportSession        = "session"
)

// goldenCommand is one recorded invocation: argv[0] is the literal "ccusage"
// and the fixture tree appears only as the <fixture-tree> placeholder in env.
type goldenCommand struct {
	Mode string            `json:"mode"`
	Argv []string          `json:"argv"`
	Env  map[string]string `json:"env"`
}

// goldenDocument is goldens/claude-reports.json. The three reports stay raw so
// they reach the comparison as `any` trees, which makes key order irrelevant
// and keeps every number's exact value.
type goldenDocument struct {
	ClaudeVersion string          `json:"claudeVersion"`
	Commands      []goldenCommand `json:"commands"`
	FixtureSha256 string          `json:"fixtureSha256"`
	Daily         struct {
		Auto      json.RawMessage `json:"auto"`
		Calculate json.RawMessage `json:"calculate"`
	} `json:"daily"`
	Sessions json.RawMessage `json:"sessions"`
}

// ruleProvenance names the upstream source that produces each report field, so
// a failure points at the rule the port violates instead of only at the value.
// Every citation is for ccusage v20.0.33 (commit 1308c416); the file paths are
// the ones collect.go's header lists.
var ruleProvenance = map[string]string{
	"daily":               "daily.rs:78-160 summarize_daily_files (group by local date, sort ascending)",
	"sessions":            "commands/mod.rs:146-206 load_session_rows (filter by date, then group)",
	"totals":              "output.rs:79-145 totals_json (saturating sums, sorted unpricedModels)",
	"date":                "daily.rs:131-145 groups by the entry's date in -z (date_utils.rs:313-324)",
	"modelsUsed":          "daily.rs:620-633 appends the display name; <synthetic> and model-less lines add none",
	"modelName":           "daily.rs:338-346 appends -fast for usage.speed==fast; model_aliases.rs:14-26 resolves aliases",
	"modelBreakdowns":     "daily.rs:616-644 accumulates per display name, sorted by descending cost (daily.rs:647)",
	"cost":                "daily.rs:317-330 prices before dedupe; cost.rs:31-75 is the auto/calculate/display ladder",
	"totalCost":           "daily.rs:620-633 sums the surviving entries' costs in row order",
	"missingPricing":      "types.rs:109-111 serializes it only when true; cost.rs:48-75 decides it",
	"inputTokens":         "types.rs:67-96 saturating TokenCounts (and entry.go's isKnownMember for duplicates)",
	"outputTokens":        "types.rs:67-96 saturating TokenCounts",
	"cacheCreationTokens": "types.rs:41-50: 5m+1h when cache_creation is present, the flat count otherwise",
	"cacheReadTokens":     "types.rs:67-96 saturating TokenCounts",
	"totalTokens":         "types.rs:89-95 TokenCounts::total",
	"unpricedModels":      "output.rs:127-145 deduplicates and sorts the missing-pricing display names",
	"sessionId":           "commands/mod.rs:186-206 groups by the PATH-derived session id (paths.rs:290-331)",
	"projectPath":         "commands/mod.rs:189-192 (paths.rs:290-331 PathSessionParts)",
	"firstActivity":       "summary.rs:136-152 keeps the earliest timestamp of the session's in-window entries",
	"lastActivity":        "summary.rs:136-152 keeps the latest timestamp of the session's in-window entries",
}

// TestClaudeDailyMatchesTheGoldens compares `ccusage claude daily --json
// --breakdown` row by row, once per --mode, against the adapter's own daily
// document. auto and calculate are separate goldens because the fixture carries
// a reported costUSD: auto trusts it, calculate ignores it.
func TestClaudeDailyMatchesTheGoldens(t *testing.T) {
	document := loadGoldens(t)

	for _, testCase := range []struct {
		mode    CostMode
		label   string
		subtest string
		golden  json.RawMessage
	}{
		{mode: nativepricing.ModeAuto, label: reportDailyAuto, subtest: "auto", golden: document.Daily.Auto},
		{mode: nativepricing.ModeCalculate, label: reportDailyCalculate, subtest: "calculate", golden: document.Daily.Calculate},
	} {
		t.Run(testCase.subtest, func(t *testing.T) {
			dailyJSON, _, err := collectFixture(t, testCase.mode)
			if err != nil {
				t.Fatalf("Collect(%s): %v", testCase.label, err)
			}
			compareReport(t, testCase.label, testCase.golden, dailyJSON, document.command(t, testCase.subtest))
		})
	}
}

// TestClaudeSessionsMatchTheGoldens compares `ccusage claude session --json`
// against the adapter's session document. ccusage's session command has no
// --mode flag and runs in the default (auto) mode, so one golden covers it.
func TestClaudeSessionsMatchTheGoldens(t *testing.T) {
	document := loadGoldens(t)

	_, sessionsJSON, err := collectFixture(t, nativepricing.ModeAuto)
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	compareReport(t, reportSession, document.Sessions, sessionsJSON, document.command(t, "session"))
}

// TestClaudeGoldensPinTheDuplicateMemberLine keeps the duplicate-member ruling
// visible at the report level: the fixture's project-b/session-gamma.jsonl
// carries a line with two unknown `dup` members and no null literal, and
// ccusage counts it. Both its tokens and the session's activity window must stay
// counted here, so a regression to the old unconditional-drop rule fails with a
// named path rather than only inside the entry parser's unit tests.
func TestClaudeGoldensPinTheDuplicateMemberLine(t *testing.T) {
	document := loadGoldens(t)
	report, ok := decodeTree(t, "golden sessions", document.Sessions).(map[string]any)
	if !ok {
		t.Fatalf("golden sessions is not an object")
	}
	rows, ok := report["sessions"].([]any)
	if !ok {
		t.Fatalf("golden sessions has no sessions array")
	}

	found := map[string]map[string]any{}
	names := make([]string, 0, len(rows))
	for index, row := range rows {
		object, ok := row.(map[string]any)
		if !ok {
			t.Fatalf("golden sessions[%d] is %T, want an object", index, row)
		}
		name, _ := object["sessionId"].(string)
		names = append(names, name)
		found[name] = object
	}
	sort.Strings(names)
	wantNames := []string{"sess-dup-2", "sess-ocgo-b", "session-alpha", "session-gamma"}
	if !reflect.DeepEqual(names, wantNames) {
		t.Fatalf("golden session set is %v, want %v", names, wantNames)
	}

	gamma := found["session-gamma"]
	// 9/1 is the one valid line in that file; the duplicate-member line adds
	// another 1/1 at 07:00:04. Losing it gives 9/1 and 07:00:00, the shape the
	// port produced before the isKnownMember gate existed.
	if got, want := gamma["inputTokens"], float64(10); got != want {
		t.Fatalf("golden session-gamma inputTokens = %v, want %v (the duplicate-member line must be counted)", got, want)
	}
	if got, want := gamma["outputTokens"], float64(2); got != want {
		t.Fatalf("golden session-gamma outputTokens = %v, want %v (the duplicate-member line must be counted)", got, want)
	}
	if got, want := gamma["lastActivity"], "2026-03-10T07:00:04.000Z"; got != want {
		t.Fatalf("golden session-gamma lastActivity = %v, want %v", got, want)
	}
}

// TestClaudeFixtureHashIsCurrent fails when the fixture tree changed without a
// regeneration, which would otherwise leave the goldens silently stale.
func TestClaudeFixtureHashIsCurrent(t *testing.T) {
	document := loadGoldens(t)
	current, err := fixtureTreeHash(fixtureRoot(t))
	if err != nil {
		t.Fatalf("hash the fixture tree: %v", err)
	}
	if current != document.FixtureSha256 {
		t.Fatalf("the fixture tree changed but the goldens were not regenerated:\n"+
			"  golden fixtureSha256: %s\n"+
			"  current tree hash:    %s\n"+
			"Re-mint with: node clients/go/scripts/gen-claude-goldens.mjs",
			document.FixtureSha256, current)
	}
}

// loadGoldens decodes the embedded golden document and pins the version it was
// minted against.
func loadGoldens(t *testing.T) *goldenDocument {
	t.Helper()
	var document goldenDocument
	if err := json.Unmarshal(goldenReports, &document); err != nil {
		t.Fatalf("decode goldens/claude-reports.json: %v", err)
	}
	if document.ClaudeVersion != "20.0.33" {
		t.Fatalf("goldens were minted by ccusage %q, want 20.0.33 — re-mint or check the file",
			document.ClaudeVersion)
	}
	if document.FixtureSha256 == "" {
		t.Fatalf("goldens carry no fixtureSha256")
	}
	return &document
}

// command returns the recorded invocation for mode, failing the test when the
// golden has no such entry (that would mean a report was frozen without the
// command that produced it).
func (d *goldenDocument) command(t *testing.T, mode string) goldenCommand {
	t.Helper()
	for _, command := range d.Commands {
		if command.Mode == mode {
			return command
		}
	}
	t.Fatalf("goldens record no command for mode %q", mode)
	return goldenCommand{}
}

// fixtureRoot is the committed fixture tree, as an absolute path.
func fixtureRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("testdata", "claude-fixture"))
	if err != nil {
		t.Fatalf("resolve the fixture root: %v", err)
	}
	return root
}

// collectFixture drives the adapter over the fixture tree exactly the way the
// golden commands did: the same roots, the same window, the same timezone and
// no pricing overrides (the goldens are minted without --config).
//
// The resolver reads CLAUDE_CONFIG_DIR through an injected env, so the process
// environment stays untouched there. CCUSAGE_MODEL_ALIASES is different: the
// report layer reads it with os.Getenv (report.go), so the test clears it for
// its own duration - gen-claude-goldens.mjs refuses to run when the variable is
// non-empty, so the goldens always carry the identity mapping.
func collectFixture(t *testing.T, mode CostMode) (dailyJSON, sessionsJSON []byte, err error) {
	t.Helper()
	t.Setenv(modelAliasesEnv, "")

	root := fixtureRoot(t)
	env := homeEnv(t.TempDir(), map[string]string{"CLAUDE_CONFIG_DIR": root})
	roots, err := ResolveRoots(env, "")
	if err != nil {
		return nil, nil, fmt.Errorf("ResolveRoots(CLAUDE_CONFIG_DIR=%s): %w", root, err)
	}
	if len(roots.Dirs) != 1 {
		return nil, nil, fmt.Errorf("ResolveRoots returned %d roots (%v), want exactly the fixture tree",
			len(roots.Dirs), roots.Dirs)
	}

	// ScanFiles is Collect's own first step; calling it here proves the fixture
	// tree is discovered before a comparison failure has to be interpreted.
	files, err := ScanFiles(roots, "")
	if err != nil {
		return nil, nil, fmt.Errorf("ScanFiles: %w", err)
	}
	if len(files) == 0 {
		return nil, nil, fmt.Errorf("ScanFiles found no transcripts below %s", root)
	}

	return Collect(context.Background(), Options{
		Timezone: "UTC",
		Since:    goldenSince,
		Until:    goldenUntil,
		Roots:    roots,
		Mode:     mode,
		// A --since prune line means a fixture file's mtime is older than the
		// window; that is worth seeing in the test log, not swallowing.
		Stderr: func(line string) { t.Logf("collect: %s", line) },
		Now:    goldenNow,
	})
}

// compareReport diffs one report against its golden. Every difference is a
// failure: there is no exemption list, because a real divergence is fixed in
// the adapter rather than waived here.
func compareReport(t *testing.T, label string, golden, port []byte, command goldenCommand) {
	t.Helper()
	want := decodeTree(t, label+" golden", golden)
	got := decodeTree(t, label+" port", port)
	if differences := diffTrees("", want, got, maxDiffPaths+1); len(differences) > 0 {
		reportDifferences(t, label, differences, command)
	}
}

// TestFieldNameStripsArrayIndices pins the provenance lookup's key extraction:
// a diff path ends in an array index about as often as it ends in a field name.
func TestFieldNameStripsArrayIndices(t *testing.T) {
	for path, want := range map[string]string{
		"daily[2].modelBreakdowns[0].cost":      "cost",
		"daily[10].modelsUsed[0]":               "modelsUsed",
		"daily[8].totalTokens":                  "totalTokens",
		"totals.inputTokens":                    "inputTokens",
		"sessions[3].lastActivity":              "lastActivity",
		"daily[10].modelBreakdowns (row count)": "modelBreakdowns",
	} {
		if got := fieldName(path); got != want {
			t.Fatalf("fieldName(%q) = %q, want %q", path, got, want)
		}
	}
}

// fixtureTreeHash recomputes the fixture tree hash gen-claude-goldens.mjs
// records. Both sides must use this exact algorithm:
//
//	files := every regular file below root, relative paths with "/" separators,
//	         sorted ascending by byte value
//	for each file, feed sha256:  path 0x00 decimal-byte-length 0x00 content 0x00
//
// NUL never appears in a path, so the length field cannot be confused with
// content. The JS side sorts with Array.prototype.sort (UTF-16 code units) and
// this side with sort.Strings (bytes); the two orders agree for the ASCII paths
// a transcript tree uses.
func fixtureTreeHash(root string) (string, error) {
	paths := []string{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			// The generator refuses the same condition: a symlink or device node
			// in the fixture tree would hash differently on the two sides.
			return fmt.Errorf("%s is not a regular file", path)
		}
		relativePath, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		paths = append(paths, filepath.ToSlash(relativePath))
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(paths)

	digest := sha256.New()
	for _, relativePath := range paths {
		content, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relativePath)))
		if err != nil {
			return "", err
		}
		fmt.Fprintf(digest, "%s\x00%d\x00", relativePath, len(content))
		digest.Write(content)
		digest.Write([]byte{0})
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

// treeDifference is one mismatched leaf (or row count) between the golden and
// the port's document.
type treeDifference struct {
	path string
	want string
	got  string
}

func (d treeDifference) String() string {
	return fmt.Sprintf("%s: golden %s, port %s", d.path, d.want, d.got)
}

// decodeTree parses a report document into the generic JSON tree. Numbers land
// as float64, which is what makes the comparison exact: two values that parse
// to the same double compare equal no matter how either side spelled them
// (ccusage prints 0.0 where encoding/json prints 0, and -0.0 where it prints
// -0). The comparison itself is on the bit pattern, so -0 and +0 still differ.
func decodeTree(t *testing.T, label string, data []byte) any {
	t.Helper()
	var tree any
	if err := json.Unmarshal(data, &tree); err != nil {
		t.Fatalf("%s is not valid JSON: %v", label, err)
	}
	return tree
}

// diffTrees walks two decoded JSON trees and returns the first limit
// differences as "daily[2].modelBreakdowns[0].cost"-style paths.
func diffTrees(path string, want, got any, limit int) []treeDifference {
	differences := []treeDifference{}
	walkTree(path, want, got, &differences, limit)
	return differences
}

func walkTree(path string, want, got any, differences *[]treeDifference, limit int) {
	if len(*differences) >= limit {
		return
	}

	switch wantValue := want.(type) {
	case map[string]any:
		gotValue, ok := got.(map[string]any)
		if !ok {
			addDifference(differences, path, want, got)
			return
		}
		for _, key := range unionKeys(wantValue, gotValue) {
			wantItem, wantSeen := wantValue[key]
			gotItem, gotSeen := gotValue[key]
			child := joinFieldPath(path, key)
			switch {
			case !gotSeen:
				addDifference(differences, child, wantItem, missingValue{})
			case !wantSeen:
				addDifference(differences, child, missingValue{}, gotItem)
			default:
				walkTree(child, wantItem, gotItem, differences, limit)
			}
			if len(*differences) >= limit {
				return
			}
		}
	case []any:
		gotValue, ok := got.([]any)
		if !ok {
			addDifference(differences, path, want, got)
			return
		}
		if len(wantValue) != len(gotValue) {
			addDifference(differences, path+" (row count)", len(wantValue), len(gotValue))
		}
		for index := 0; index < len(wantValue) && index < len(gotValue); index++ {
			if len(*differences) >= limit {
				return
			}
			walkTree(fmt.Sprintf("%s[%d]", path, index), wantValue[index], gotValue[index], differences, limit)
		}
	case float64:
		gotValue, ok := got.(float64)
		if !ok || math.Float64bits(wantValue) != math.Float64bits(gotValue) {
			addDifference(differences, path, want, got)
		}
	default:
		if !reflect.DeepEqual(want, got) {
			addDifference(differences, path, want, got)
		}
	}
}

// missingValue marks a key present on only one side.
type missingValue struct{}

func addDifference(differences *[]treeDifference, path string, want, got any) {
	*differences = append(*differences, treeDifference{
		path: path,
		want: renderValue(want),
		got:  renderValue(got),
	})
}

// renderValue prints one value compactly. Documents are never dumped whole;
// a long value is truncated so one field cannot flood the failure output.
func renderValue(value any) string {
	if _, ok := value.(missingValue); ok {
		return "<absent>"
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf("<unprintable %T>", value)
	}
	const maxRenderedValue = 160
	if len(encoded) > maxRenderedValue {
		return string(encoded[:maxRenderedValue]) + "…"
	}
	return string(encoded)
}

// unionKeys returns every key of both objects in sorted order, so a failure
// lists differences deterministically instead of in map iteration order.
func unionKeys(left, right map[string]any) []string {
	keys := make([]string, 0, len(left)+len(right))
	seen := make(map[string]bool, len(left)+len(right))
	for _, object := range []map[string]any{left, right} {
		for key := range object {
			if !seen[key] {
				seen[key] = true
				keys = append(keys, key)
			}
		}
	}
	sort.Strings(keys)
	return keys
}

func joinFieldPath(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

// fieldName is the last object key in a diff path, without its array index:
// "daily[2].modelBreakdowns[0].cost" names "cost", "daily[10].modelsUsed[0]"
// names "modelsUsed", and "totals.inputTokens" names "inputTokens".
func fieldName(path string) string {
	if index := strings.LastIndexByte(path, '.'); index >= 0 {
		path = path[index+1:]
	}
	if index := strings.IndexByte(path, '['); index >= 0 {
		path = path[:index]
	}
	if index := strings.IndexByte(path, ' '); index >= 0 {
		path = path[:index]
	}
	return path
}

// ruleFor names the upstream source behind a differing field.
func ruleFor(path string) string {
	name := fieldName(path)
	if rule, ok := ruleProvenance[name]; ok {
		return rule
	}
	return fmt.Sprintf("no provenance entry for %q (add one to ruleProvenance)", name)
}

// reportDifferences fails the test with the field-level diff and its sources:
// the command the golden was minted by, and the upstream rule each field's port
// is supposed to follow.
func reportDifferences(t *testing.T, label string, differences []treeDifference, command goldenCommand) {
	t.Helper()
	shown := differences
	count := strconv.Itoa(len(differences))
	if len(differences) > maxDiffPaths {
		// The walk stopped at the cap, so the real count is unknown and larger.
		shown = differences[:maxDiffPaths]
		count = "at least " + strconv.Itoa(maxDiffPaths+1)
	}
	var message strings.Builder
	fmt.Fprintf(&message,
		"%s does not match the ccusage 20.0.33 golden: %s field difference(s), first %d shown:\n",
		label, count, len(shown))
	for _, difference := range shown {
		fmt.Fprintf(&message, "  %s\n", difference)
		fmt.Fprintf(&message, "    rule: %s\n", ruleFor(difference.path))
	}
	fmt.Fprintf(&message, "golden minted by: %s\n", strings.Join(command.Argv, " "))
	if value, ok := command.Env["CLAUDE_CONFIG_DIR"]; ok {
		fmt.Fprintf(&message, "  with CLAUDE_CONFIG_DIR=%s\n", value)
	}
	fmt.Fprintf(&message, "There is no exemption list: fix the adapter, not the golden.\n")
	t.Error(message.String())
}
