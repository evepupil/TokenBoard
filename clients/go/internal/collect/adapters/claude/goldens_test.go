package claude

// The golden tests freeze the whole Claude adapter against the JSON ccusage
// 20.0.33 actually prints for the committed fixture tree. Everything below the
// report builders is covered transitively: the fixture exercises the two
// parsers (entry.go), the pricing pass (cost.go), the dedupe index (dedupe.go)
// and the two report builders (daily.go, session.go), and any deviation shows
// up as a field-level diff against ccusage's own answer.
//
// The goldens are regenerated only with
// `node clients/go/scripts/gen-claude-goldens.mjs`; that script owns the
// version pin, the clean-environment assertions and the fixture hash. This file
// never writes them.
//
// One divergence is registered, not fixed: see registeredDivergences. It is the
// deliberate duplicate-member rule the controller ruled on in
// .superpowers/sdd/2026-11-05-s2-claude-code-adapter/progress.md
// ("Ruling (Task 2, duplicate keys)"), and it is frozen here as an exact table
// so it can never silently widen.

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
// differences are the informative ones; a whole-document dump is not.
const maxDiffPaths = 10

// maxCollectedDiffs bounds the walk. Every difference is collected (not just
// the first few) so the registered divergence can be matched exactly and a
// stale registration detected; a report with more differences than this is
// broken beyond any useful diff, which the message says outright.
const maxCollectedDiffs = 512

// Report labels used by the divergence table.
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
	"inputTokens":         "types.rs:67-96 saturating TokenCounts",
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

// registeredDivergence is one measured difference between the port and ccusage
// that this repository has decided to keep. Both values are frozen, so the
// divergence can neither widen nor silently disappear.
type registeredDivergence struct {
	// path is the tree path the diff walker reports.
	path string
	// golden is the value ccusage printed, port the value the adapter built.
	// Both are the JSON rendering the diff walker produces.
	golden string
	port   string
}

// duplicateMemberCause documents the one cause behind every entry below.
//
// The fixture's projects/project-b/session-gamma.jsonl carries the invalid-row
// probe `{"...","dup":1,"dup":2,"message":{...}}`. ccusage only runs its
// duplicate-member deep scan when the line contains a null literal
// (lib.rs:727-736); this line has none, so serde's typed deserialization runs
// instead, and a duplicate member of an UNMODELLED field is simply ignored. The
// line therefore survives upstream and contributes 1 input token, 1 output
// token and 0.000018 USD on claude-sonnet-4-20250514 at 2026-03-10T07:00:04Z.
//
// entry.go rejects duplicate members unconditionally (its scanner comment cites
// lib.rs:738-830). That is a deliberate superset: see the controller ruling in
// progress.md ("Ruling (Task 2, duplicate keys): keep the plan's 'unconditional
// drop' ... cost if wrong: one golden divergence entry"). This table IS that
// entry, and it is measured, not assumed: with the line removed from a copy of
// the fixture, the port matches ccusage tree-for-tree on all three reports.
//
// Consequence for a real transcript: the port under-counts one line by 1 input,
// 1 output and its cost. It never over-counts, and it never drops a line whose
// duplicate member is a modelled field (serde rejects those too).
const duplicateMemberCause = "duplicate-member probe line dropped by the port, kept by ccusage"

// registeredDivergences is the complete set of allowed differences, keyed by
// report. Every entry must appear in the diff and nothing else may.
var registeredDivergences = map[string][]registeredDivergence{
	reportDailyAuto: {
		{"daily[8].inputTokens", "500010", "500009"},
		{"daily[8].outputTokens", "22", "21"},
		{"daily[8].totalTokens", "500032", "500030"},
		{"daily[8].totalCost", "1.65036", "1.650342"},
		{"daily[8].modelBreakdowns[0].inputTokens", "250010", "250009"},
		{"daily[8].modelBreakdowns[0].outputTokens", "12", "11"},
		{"daily[8].modelBreakdowns[0].cost", "0.9002099999999998", "0.9001919999999999"},
		{"totals.inputTokens", "501966", "501965"},
		{"totals.outputTokens", "187", "186"},
		{"totals.totalTokens", "503453", "503451"},
		{"totals.totalCost", "2.184083", "2.1840650000000004"},
	},
	reportDailyCalculate: {
		{"daily[8].inputTokens", "500010", "500009"},
		{"daily[8].outputTokens", "22", "21"},
		{"daily[8].totalTokens", "500032", "500030"},
		{"daily[8].totalCost", "1.65036", "1.650342"},
		{"daily[8].modelBreakdowns[0].inputTokens", "250010", "250009"},
		{"daily[8].modelBreakdowns[0].outputTokens", "12", "11"},
		{"daily[8].modelBreakdowns[0].cost", "0.9002099999999998", "0.9001919999999999"},
		{"totals.inputTokens", "501966", "501965"},
		{"totals.outputTokens", "187", "186"},
		{"totals.totalTokens", "503453", "503451"},
		{"totals.totalCost", "1.684122", "1.6841039999999998"},
	},
	reportSession: {
		{"sessions[3].inputTokens", "10", "9"},
		{"sessions[3].outputTokens", "2", "1"},
		{"sessions[3].totalTokens", "12", "10"},
		{"sessions[3].totalCost", "0.000059999999999999995", "0.000042"},
		{"sessions[3].lastActivity", `"2026-03-10T07:00:04.000Z"`, `"2026-03-10T07:00:00.000Z"`},
		{"sessions[3].modelBreakdowns[0].inputTokens", "10", "9"},
		{"sessions[3].modelBreakdowns[0].outputTokens", "2", "1"},
		{"sessions[3].modelBreakdowns[0].cost", "0.000059999999999999995", "0.000042"},
		{"totals.inputTokens", "501955", "501954"},
		{"totals.outputTokens", "186", "185"},
		{"totals.totalTokens", "503441", "503439"},
		{"totals.totalCost", "2.1840349999999997", "2.184017"},
	},
}

// TestClaudeDailyMatchesTheGoldens compares `ccusage claude daily --json
// --breakdown` row by row, once per --mode, against the adapter's own daily
// document. auto and calculate are separate goldens because the fixture carries
// a reported costUSD: auto trusts it, calculate ignores it.
func TestClaudeDailyMatchesTheGoldens(t *testing.T) {
	document := loadGoldens(t)

	for _, testCase := range []struct {
		mode   CostMode
		label  string
		golden json.RawMessage
	}{
		{mode: nativepricing.ModeAuto, label: reportDailyAuto, golden: document.Daily.Auto},
		{mode: nativepricing.ModeCalculate, label: reportDailyCalculate, golden: document.Daily.Calculate},
	} {
		t.Run(strings.TrimPrefix(testCase.label, "daily --mode "), func(t *testing.T) {
			dailyJSON, _, err := collectFixture(t, testCase.mode)
			if err != nil {
				t.Fatalf("Collect(%s): %v", testCase.label, err)
			}
			compareReport(t, testCase.label, testCase.golden, dailyJSON,
				document.command(t, strings.TrimPrefix(testCase.label, "daily --mode ")))
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

// TestClaudeSessionsGoldensCarryTheExpectedSessionSet pins the two session
// rules a row-count comparison alone would miss: the AgentProgress wrapper is
// daily-only, and the cross-file requestless duplicate survives exactly once
// under the larger entry's PATH session id.
func TestClaudeSessionsGoldensCarryTheExpectedSessionSet(t *testing.T) {
	document := loadGoldens(t)
	report, ok := decodeTree(t, "golden sessions", document.Sessions).(map[string]any)
	if !ok {
		t.Fatalf("golden sessions is not an object")
	}
	rows, ok := report["sessions"].([]any)
	if !ok {
		t.Fatalf("golden sessions has no sessions array")
	}
	names := make([]string, 0, len(rows))
	for index, row := range rows {
		object, ok := row.(map[string]any)
		if !ok {
			t.Fatalf("golden sessions[%d] is %T, want an object", index, row)
		}
		name, _ := object["sessionId"].(string)
		names = append(names, name)
	}
	sort.Strings(names)
	want := []string{"sess-dup-2", "sess-ocgo-b", "session-alpha", "session-gamma"}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("golden session set is %v, want %v", names, want)
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

// compareReport diffs one report against its golden, subtracts the registered
// divergence and fails on anything left over. A registration that no longer
// reproduces is a failure too: the table must describe reality, not history.
func compareReport(t *testing.T, label string, golden, port []byte, command goldenCommand) {
	t.Helper()
	want := decodeTree(t, label+" golden", golden)
	got := decodeTree(t, label+" port", port)
	differences := diffTrees("", want, got, maxCollectedDiffs)
	if len(differences) >= maxCollectedDiffs {
		t.Fatalf("%s: the diff walk hit its %d-path cap; the documents are unrelated",
			label, maxCollectedDiffs)
	}

	registered := registeredDivergences[label]
	unexpected, stale := partitionDifferences(differences, registered)
	if len(unexpected) > 0 {
		reportDifferences(t, label, unexpected, command, len(registered))
	}
	if len(stale) > 0 {
		var message strings.Builder
		fmt.Fprintf(&message,
			"%s: %d registered divergence(s) no longer reproduce — the exemption table is stale:\n",
			label, len(stale))
		for _, cell := range stale {
			fmt.Fprintf(&message, "  %s: golden %s, port %s (cause: %s)\n",
				cell.path, cell.golden, cell.port, duplicateMemberCause)
		}
		fmt.Fprintf(&message,
			"If the port now matches ccusage here, delete the entry. If the values moved, "+
				"re-examine the duplicate-member ruling before updating them.\n")
		t.Error(message.String())
	}
}

// partitionDifferences splits the measured differences into those a registered
// cell accounts for and those it does not, and returns the registered cells
// that never appeared.
func partitionDifferences(differences []treeDifference, registered []registeredDivergence) (unexpected []treeDifference, stale []registeredDivergence) {
	used := make([]bool, len(registered))
	for _, difference := range differences {
		matched := false
		for index, cell := range registered {
			if used[index] || cell.path != difference.path ||
				cell.golden != difference.want || cell.port != difference.got {
				continue
			}
			used[index] = true
			matched = true
			break
		}
		if !matched {
			unexpected = append(unexpected, difference)
		}
	}
	for index, cell := range registered {
		if !used[index] {
			stale = append(stale, cell)
		}
	}
	return unexpected, stale
}

// TestPartitionDifferences pins the exemption machinery in both directions: a
// difference a registered cell describes is absorbed, and a registered cell
// that describes nothing is reported stale. Without the second half, a fixed
// divergence would sit in the table forever and hide the next one at the same
// path.
func TestPartitionDifferences(t *testing.T) {
	registered := []registeredDivergence{
		{path: "totals.inputTokens", golden: "10", port: "9"},
		{path: "daily[0].totalCost", golden: "1.5", port: "1.4"},
	}

	unexpected, stale := partitionDifferences([]treeDifference{
		{path: "totals.inputTokens", want: "10", got: "9"},
	}, registered)
	if len(unexpected) != 0 {
		t.Fatalf("unexpected = %v, want none: the cell matches exactly", unexpected)
	}
	if len(stale) != 1 || stale[0].path != "daily[0].totalCost" {
		t.Fatalf("stale = %v, want exactly the unmatched daily[0].totalCost cell", stale)
	}

	// A path that matches but whose values moved is NOT the registered
	// divergence any more, so it must surface as a real difference.
	unexpected, stale = partitionDifferences([]treeDifference{
		{path: "totals.inputTokens", want: "10", got: "8"},
	}, registered)
	if len(unexpected) != 1 || unexpected[0].got != "8" {
		t.Fatalf("unexpected = %v, want the moved totals.inputTokens difference", unexpected)
	}
	if len(stale) != 2 {
		t.Fatalf("stale = %v, want both cells when neither matches", stale)
	}

	// An unrelated extra difference never gets absorbed.
	unexpected, _ = partitionDifferences([]treeDifference{
		{path: "totals.inputTokens", want: "10", got: "9"},
		{path: "daily[3].modelBreakdowns[0].modelName", want: `"a"`, got: `"b"`},
	}, registered)
	if len(unexpected) != 1 || unexpected[0].path != "daily[3].modelBreakdowns[0].modelName" {
		t.Fatalf("unexpected = %v, want only the unregistered modelName difference", unexpected)
	}
}

// TestFieldNameStripsArrayIndices pins the provenance lookup's key extraction.
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
func reportDifferences(t *testing.T, label string, differences []treeDifference, command goldenCommand, registeredCount int) {
	t.Helper()
	shown := differences
	if len(shown) > maxDiffPaths {
		shown = shown[:maxDiffPaths]
	}
	var message strings.Builder
	fmt.Fprintf(&message,
		"%s does not match the ccusage 20.0.33 golden: %d unregistered field difference(s), first %d shown:\n",
		label, len(differences), len(shown))
	for _, difference := range shown {
		fmt.Fprintf(&message, "  %s\n", difference)
		fmt.Fprintf(&message, "    rule: %s\n", ruleFor(difference.path))
	}
	fmt.Fprintf(&message, "golden minted by: %s\n", strings.Join(command.Argv, " "))
	if value, ok := command.Env["CLAUDE_CONFIG_DIR"]; ok {
		fmt.Fprintf(&message, "  with CLAUDE_CONFIG_DIR=%s\n", value)
	}
	fmt.Fprintf(&message,
		"%d difference(s) are registered under %q (cause: %s); anything else is a regression.\n",
		registeredCount, label, duplicateMemberCause)
	t.Error(message.String())
}
