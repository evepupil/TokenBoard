package codex

// The golden tests freeze the whole Codex adapter against the JSON ccusage
// 20.0.33 actually prints for the committed fixture tree under testdata/
// codex-fixture. Everything below the report builder is covered transitively:
// the fixture exercises file discovery (paths.go), the two readers
// (reader.go: plain JSONL and concatenated zstd), the line classifier and
// parser (detect.go, parser.go), the fork replay plan (replay.go), the
// aggregation and dedupe table (aggregate.go) and the pricing/report pass
// (report.go), and any deviation shows up as a field-level diff against
// ccusage's own answer.
//
// The comparison is strict: every leaf of every report must match, with no
// exemptions. A mismatch is a defect in the port or a rule that has not been
// ported yet; neither may be papered over by an exemption list.
//
// auto, calculate and the unbounded daily are three separate goldens because
// they answer different questions:
//
//   - auto and calculate must agree for this tree (no fixture line carries a
//     reported costUSD), and a divergence means the fixture lost that property;
//   - the unbounded daily proves the window is the only thing that changes a
//     report over the same tree.
//
// The goldens are regenerated only with
// `node clients/go/scripts/gen-codex-goldens.mjs`; that script owns the
// version pin, the clean-environment assertions and the fixture hash. This file
// never writes them.
//
// Registered coverage gaps (accepted, not defects to chase here):
//
//   - Invalid UTF-8 in a *modeled* position (a key or a typed string value)
//     fails the whole line under serde, but a windowed golden cannot tell a
//     dropped line from a booked one for such a line, so parser_test.go owns
//     that half and this corpus pins only the unknown-member case (2026-05-24).
//   - The fixture carries no config.toml, so the Auto speed policy is always
//     the Standard tier and the recorded fast/flex events are what the
//     multipliers apply to. A user's `service_tier = "fast"` config is pinned by
//     speed_test.go and report_test.go, not by a golden.
//   - Every fixture model is priced from the embedded corpus, so the report
//     layer never prints missingPricing or unpricedModels here; those are pinned
//     by report_test.go.

import (
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

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// goldenReports is the committed ccusage 20.0.33 output for the fixture tree.
//
//go:embed goldens/codex-reports.json
var goldenReports []byte

// The window and zone the windowed goldens were minted under.
// gen-codex-goldens.mjs passes -s/-u 20260518/20260528 -z UTC.
const (
	goldenSince    = "20260518"
	goldenUntil    = "20260528"
	goldenTimezone = "UTC"
)

// maxDiffPaths caps how many differing paths one failure prints. The walk
// collects one past the cap so the message can say "at least" instead of
// claiming an exact count it did not measure.
const maxDiffPaths = 10

// goldenCommand is one recorded invocation: argv[0] is the literal "ccusage"
// and the fixture tree appears only as the <fixture-tree> placeholder in env.
type goldenCommand struct {
	Mode string            `json:"mode"`
	Argv []string          `json:"argv"`
	Env  map[string]string `json:"env"`
}

// goldenDocument is goldens/codex-reports.json. Every report stays raw so it
// reaches the comparison as an `any` tree, which makes key order irrelevant and
// keeps every number's exact value.
type goldenDocument struct {
	CcusageVersion string                     `json:"ccusageVersion"`
	Commands       []goldenCommand            `json:"commands"`
	FixtureSha256  string                     `json:"fixtureSha256"`
	Reports        map[string]json.RawMessage `json:"reports"`
}

// TestCodexDailyMatchesTheGoldens compares `ccusage codex daily --json` row by
// row, once per --mode, and once without a window, against the adapter's own
// daily document.
func TestCodexDailyMatchesTheGoldens(t *testing.T) {
	document := loadGoldens(t)

	for _, testCase := range []struct {
		command string
		label   string
		mode    nativepricing.CostMode
		since   string
		until   string
		golden  json.RawMessage
	}{
		{command: "auto", label: "daily --mode auto", mode: nativepricing.ModeAuto, since: goldenSince, until: goldenUntil, golden: document.report(t, "auto")},
		{command: "calculate", label: "daily --mode calculate", mode: nativepricing.ModeCalculate, since: goldenSince, until: goldenUntil, golden: document.report(t, "calculate")},
		{command: "unbounded", label: "daily (unbounded)", mode: nativepricing.ModeAuto, golden: document.report(t, "unbounded")},
	} {
		t.Run(testCase.command, func(t *testing.T) {
			reportJSON := collectFixtureReport(t, ReportDaily, testCase.mode, testCase.since, testCase.until)
			compareReport(t, testCase.label, testCase.golden, reportJSON, document.command(t, testCase.command))
		})
	}
}

// TestCodexSessionsMatchTheGoldens compares `ccusage codex session --json`
// against the adapter's session document. ccusage's session command has no
// --mode flag and runs in the default (auto) mode, so one golden covers it.
func TestCodexSessionsMatchTheGoldens(t *testing.T) {
	document := loadGoldens(t)

	reportJSON := collectFixtureReport(t, ReportSession, nativepricing.ModeAuto, goldenSince, goldenUntil)
	compareReport(t, "session", document.report(t, "session"), reportJSON, document.command(t, "session"))
}

// TestCodexGoldensPinTheUnknownMemberLine keeps the UTF-8 ruling visible at the
// report level: sessions/2026/05/24/rollout-...-broken.jsonl holds one line
// whose invalid byte sits in `note`, a member the typed decode never reads, and
// serde skips unmodeled members without validating them - so ccusage bills the
// line's 9/0 request. A regression to "drop any non-UTF-8 line" shows up here as
// 20/2 instead of 29/2; the opposite regression (billing lines whose invalid
// byte sits in a modeled string or key) is pinned by parser_test.go, since the
// windowed golden rows cannot distinguish a dropped line from a booked one.
func TestCodexGoldensPinTheUnknownMemberLine(t *testing.T) {
	document := loadGoldens(t)
	report, ok := decodeTree(t, "golden auto", document.report(t, "auto")).(map[string]any)
	if !ok {
		t.Fatalf("golden auto is not an object")
	}
	rows, ok := report["daily"].([]any)
	if !ok {
		t.Fatalf("golden auto has no daily array")
	}
	for _, row := range rows {
		object, ok := row.(map[string]any)
		if !ok {
			t.Fatalf("golden daily row is %T, want an object", row)
		}
		if object["date"] != "2026-05-24" {
			continue
		}
		if got, want := object["inputTokens"], float64(29); got != want {
			t.Fatalf("golden 2026-05-24 inputTokens = %v, want %v (the unknown-member line must be counted)", got, want)
		}
		if got, want := object["outputTokens"], float64(2); got != want {
			t.Fatalf("golden 2026-05-24 outputTokens = %v, want %v", got, want)
		}
		return
	}
	t.Fatalf("golden auto has no row for 2026-05-24")
}

// TestCodexGoldensPinTheHeadlessExecRow pins the `codex exec` path end to end:
// sessions/2026/05/12/rollout-...-exec.jsonl is a headless rollout (usage on a
// result object, no session record types) dated before the window, so only the
// unbounded daily carries its row - the windowed reports must not.
func TestCodexGoldensPinTheHeadlessExecRow(t *testing.T) {
	document := loadGoldens(t)

	unbounded, ok := decodeTree(t, "golden unbounded", document.report(t, "unbounded")).(map[string]any)
	if !ok {
		t.Fatalf("golden unbounded is not an object")
	}
	rows, ok := unbounded["daily"].([]any)
	if !ok {
		t.Fatalf("golden unbounded has no daily array")
	}
	for _, row := range rows {
		object, ok := row.(map[string]any)
		if !ok {
			t.Fatalf("golden unbounded row is %T, want an object", row)
		}
		if object["date"] != "2026-05-12" {
			continue
		}
		models, ok := object["models"].(map[string]any)
		if !ok || len(models) != 1 {
			t.Fatalf("golden 2026-05-12 models = %v, want exactly gpt-5.1-codex", object["models"])
		}
		model, ok := models["gpt-5.1-codex"].(map[string]any)
		if !ok {
			t.Fatalf("golden 2026-05-12 model is %v, want gpt-5.1-codex", models)
		}
		// 14 input minus 2 cached read, 3 output, 1 reasoning, total 17.
		for field, want := range map[string]float64{
			"inputTokens":           12,
			"cacheReadTokens":       2,
			"outputTokens":          3,
			"reasoningOutputTokens": 1,
			"totalTokens":           17,
		} {
			if got := object[field]; got != want {
				t.Fatalf("golden 2026-05-12 %s = %v, want %v", field, got, want)
			}
			if got := model[field]; got != want {
				t.Fatalf("golden 2026-05-12 model %s = %v, want %v", field, got, want)
			}
		}
		if model["isFallback"] != false {
			t.Fatalf("golden 2026-05-12 model isFallback = %v, want false (the result object names the model)", model["isFallback"])
		}
		return
	}
	t.Fatalf("golden unbounded has no row for 2026-05-12 (the headless exec rollout must be billed in the unbounded report)")
}

// TestCodexFixtureHashIsCurrent fails when the fixture tree changed without a
// regeneration, which would otherwise leave the goldens silently stale.
func TestCodexFixtureHashIsCurrent(t *testing.T) {
	document := loadGoldens(t)
	root := fixtureRoot(t)
	current, err := codexFixtureTreeHash(root)
	if err != nil {
		t.Fatalf("hash the fixture tree: %v", err)
	}
	if current != document.FixtureSha256 {
		t.Fatalf("the fixture tree changed but the goldens were not regenerated:\n"+
			"  golden fixtureSha256: %s\n"+
			"  current tree hash:    %s\n"+
			"Re-mint with: node clients/go/scripts/gen-codex-goldens.mjs",
			document.FixtureSha256, current)
	}
}

// loadGoldens decodes the embedded golden document and pins the version it was
// minted against.
func loadGoldens(t *testing.T) *goldenDocument {
	t.Helper()
	var document goldenDocument
	if err := json.Unmarshal(goldenReports, &document); err != nil {
		t.Fatalf("decode goldens/codex-reports.json: %v", err)
	}
	if document.CcusageVersion != "20.0.33" {
		t.Fatalf("goldens were minted by ccusage %q, want 20.0.33 — re-mint or check the file",
			document.CcusageVersion)
	}
	if document.FixtureSha256 == "" {
		t.Fatalf("goldens carry no fixtureSha256")
	}
	return &document
}

// report returns one recorded report, failing when it was never frozen.
func (d *goldenDocument) report(t *testing.T, mode string) json.RawMessage {
	t.Helper()
	report, ok := d.Reports[mode]
	if !ok {
		t.Fatalf("goldens record no report for mode %q", mode)
	}
	return report
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
	root, err := filepath.Abs(filepath.Join("testdata", "codex-fixture"))
	if err != nil {
		t.Fatalf("resolve the fixture root: %v", err)
	}
	return root
}

// collectFixtureReport drives the adapter over the fixture tree exactly the way
// the golden commands did: CODEX_HOME is the tree, the timezone and window are
// the golden's, the speed is Auto (whose config probe finds no config.toml), and
// the pricing is the embedded corpus with no overrides (the goldens are minted
// without --config).
func collectFixtureReport(t *testing.T, kind ReportKind, mode nativepricing.CostMode, since, until string) json.RawMessage {
	t.Helper()
	root := fixtureRoot(t)
	env := func(key string) (string, bool) {
		if key == "CODEX_HOME" {
			return root, true
		}
		return "", false
	}
	homes, err := HomePaths(env, func() (string, error) {
		return "", fmt.Errorf("HOME must not be consulted when CODEX_HOME is set")
	})
	if err != nil {
		t.Fatalf("HomePaths: %v", err)
	}
	// The sources are the unpruned discovery output: LoadGroups prunes itself
	// and hands the bounded replay plan the same "available" set ccusage does.
	sources := CollectDedupedSources(UsageSources(homes))
	if len(sources) != 2 {
		t.Fatalf("discovered %d sources under %s, want sessions/ and archived_sessions/", len(sources), root)
	}
	groups, err := LoadGroups(sources, kind, goldenTimezone, since, until)
	if err != nil {
		t.Fatalf("LoadGroups(%v): %v", kind, err)
	}
	if len(groups) == 0 {
		t.Fatalf("LoadGroups returned no groups below %s", root)
	}
	corpus, err := nativepricing.LoadEmbeddedCorpus()
	if err != nil {
		t.Fatalf("LoadEmbeddedCorpus: %v", err)
	}
	speed := ResolveSpeedPolicy(SpeedAuto, homes)
	document := ReportJSON(groups, kind, &corpus, speed, mode)
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("marshal the report: %v", err)
	}
	return encoded
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

// codexFixtureTreeHash recomputes the fixture tree hash gen-codex-goldens.mjs
// records. Both sides use this exact algorithm:
//
//	files := every regular file below root, relative paths with "/" separators,
//	         sorted ascending by byte value
//	for each file, feed sha256:  path 0x00 decimal-byte-length 0x00 content 0x00
//
// NUL never appears in a path, so the length field cannot be confused with
// content. The JS side sorts with Array.prototype.sort (UTF-16 code units) and
// this side with sort.Strings (bytes); the two orders agree for the ASCII paths
// a transcript tree uses.
func codexFixtureTreeHash(root string) (string, error) {
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
// (ccusage prints 0.0 where encoding/json prints 0). The comparison itself is on
// the bit pattern, so -0 and +0 still differ.
func decodeTree(t *testing.T, label string, data []byte) any {
	t.Helper()
	var tree any
	if err := json.Unmarshal(data, &tree); err != nil {
		t.Fatalf("%s is not valid JSON: %v", label, err)
	}
	return tree
}

// diffTrees walks two decoded JSON trees and returns the first limit
// differences as "daily[2].models.gpt-5.1-codex.outputTokens"-style paths.
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

// renderValue prints one value compactly, truncating so one field cannot flood
// the failure output.
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

// codexRuleProvenance names the upstream source behind each report field, so a
// failure points at the rule the port violates instead of only at the value.
// Every citation is for ccusage v20.0.33 (commit 1308c416); the rust paths are
// the ones the adapter file headers list.
var codexRuleProvenance = map[string]string{
	"daily":                 "aggregate.rs:408-430 codex_period_for groups by the event's date in -z (daily kind)",
	"sessions":              "aggregate.rs:408-430 codex_period_for keys a session report by the session id",
	"date":                  "aggregate.rs:408-430 codex_period_for (date_utils.rs:313-324 format_date_tz)",
	"sessionId":             "paths.rs session id derivation: <directory>/<rollout file>",
	"sessionFile":           "report.rs row building: str::rfind('/') on the period key",
	"directory":             "report.rs row building: the part of the period key before the last '/'",
	"lastActivity":          "aggregate.rs:432-461 accumulate_codex_event_into_group keeps the latest timestamp",
	"models":                "aggregate.rs:463-524 accumulate_codex_event_into_model_usage (per model name)",
	"totals":                "report.rs:147-181 totals_json (saturating sums over the non-cached counters)",
	"inputTokens":           "report.rs:122-128 non_cached_input_tokens (input minus cached and cache-creation)",
	"cacheCreationTokens":   "aggregate.rs:463-524 cache_creation_input_tokens accumulator",
	"cacheReadTokens":       "aggregate.rs:463-524 cached_input_tokens accumulator",
	"outputTokens":          "aggregate.rs:463-524 output_tokens accumulator",
	"reasoningOutputTokens": "aggregate.rs:463-524 reasoning_output_tokens accumulator",
	"totalTokens":           "aggregate.rs:432-461 total_tokens accumulator",
	"isFallback":            "aggregate.rs:463-524 IsFallback |= event.is_fallback_model",
	"costUSD":               "report.rs:183-268 calculate_codex_*_cost (bucket formula, service-tier multipliers, long-context split)",
	"missingPricing":        "report.rs model JSON: serialized only for an unpriced model outside display mode",
	"unpricedModels":        "report.rs totals_json: deduplicated and sorted unpriced display names",
}

// fieldName is the last object key in a diff path, without its array index:
// "daily[2].models.gpt-5.1-codex.costUSD" names "costUSD", and
// "daily[2].models (row count)" names "models".
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

// codexRuleFor names the upstream source behind a differing field.
func codexRuleFor(path string) string {
	name := fieldName(path)
	if rule, ok := codexRuleProvenance[name]; ok {
		return rule
	}
	return fmt.Sprintf("no provenance entry for %q (add one to codexRuleProvenance)", name)
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
		fmt.Fprintf(&message, "    rule: %s\n", codexRuleFor(difference.path))
	}
	fmt.Fprintf(&message, "golden minted by: %s\n", strings.Join(command.Argv, " "))
	if value, ok := command.Env["CODEX_HOME"]; ok {
		fmt.Fprintf(&message, "  with CODEX_HOME=%s\n", value)
	}
	fmt.Fprintf(&message, "There is no exemption list: fix the adapter, not the golden.\n")
	t.Error(message.String())
}
