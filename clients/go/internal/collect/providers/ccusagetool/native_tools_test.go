package ccusagetool

// The native report source wiring (S4a Task 14): the same seam as
// providers/codex/native.go. These tests pin that every tool source has a
// registered native provider, that the default path still runs ccusage, and
// that one end-to-end native collection lands in the same snapshot shape the
// ccusage path normalizes to.

import (
	"context"
	"encoding/json"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/adapters/tools"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/pricing"
)

// TestRegisterNativeInstallsEveryToolProvider pins the registry seam:
// RegisterNative answers for every one of the twelve tool sources (copilot
// included since S4b). A silently missing registration would make a parity run
// compare ccusage against itself.
func TestRegisterNativeInstallsEveryToolProvider(t *testing.T) {
	for _, source := range contract.CcusageToolSources() {
		provider, ok := collect.LookupNative(source)
		if !ok || provider == nil {
			t.Fatalf("collect.LookupNative(%q) = (%v, %v), want the native provider", source, provider, ok)
		}
		ccusageProvider, ok := collect.Lookup(source)
		if !ok || ccusageProvider == nil {
			t.Fatalf("collect.Lookup(%q) has no ccusage provider", source)
		}
	}
}

// TestEveryToolSourceReachesANativeAdapter pins production reachability, not
// just registration: an adapter that registers itself from its own init()
// (copilot does) only runs when some NON-TEST file imports it. A
// `_test.go`-only import keeps this test green while every production build
// answers `tools: no native adapter for "copilot"`. import_test.go carries the
// blank imports; this asserts the result.
func TestEveryToolSourceReachesANativeAdapter(t *testing.T) {
	for _, source := range contract.CcusageToolSources() {
		command, ok := contract.CcusageToolCommand(source)
		if !ok {
			t.Fatalf("CcusageToolCommand(%q) has no command", source)
		}
		if !tools.HasNativeAdapter(command) {
			t.Fatalf("%s has no native adapter reachable from this package's non-test imports", command)
		}
	}
}

// TestUseNativeToolsDefaultsToTheCcusagePath pins that flipping the switch is a
// reviewed commit: the constant is false and the registered provider runs the
// ccusage subprocess.
func TestUseNativeToolsDefaultsToTheCcusagePath(t *testing.T) {
	if useNativeTools {
		t.Fatal("useNativeTools must default to false until the parity gate is green")
	}
	runner := &testRunner{t: t, responses: map[string]any{
		"amp daily --json --timezone UTC":   dailyReport(t, "2026-01-02"),
		"amp session --json --timezone UTC": sessionReport(t, "s-1", ""),
	}}
	if _, ok := collect.Lookup(contract.SourceAmp); !ok {
		t.Fatal("amp has no ccusage provider")
	}
	_, err := Collect(context.Background(), contract.SourceAmp, Options{
		Timezone: "UTC",
		Env:      envFunc(toolEnv(t)),
		Runner:   runner.run,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) == 0 {
		t.Fatal("the default path must invoke ccusage")
	}
}

// ampFixtureHome writes one Amp thread carrying a single token_count event and
// points AMP_DATA_DIR at it.
func ampFixtureHome(t *testing.T) (string, func(string) string) {
	t.Helper()
	root := t.TempDir()
	threads := filepath.Join(root, "threads")
	if err := os.MkdirAll(threads, 0o700); err != nil {
		t.Fatal(err)
	}
	thread := `{"id":"thread-1","messages":[{"role":"assistant","timestamp":"2026-01-02T03:04:05.000Z",
		"model":"gpt-5.5","usage":{"inputTokens":1000,"outputTokens":500}}]}`
	if err := os.WriteFile(filepath.Join(threads, "T-1.json"), []byte(thread), 0o600); err != nil {
		t.Fatal(err)
	}
	env := func(key string) string {
		if key == "AMP_DATA_DIR" {
			return root
		}
		return ""
	}
	return root, env
}

// TestNativeToolCollectNormalizesThroughTheSharedPipeline pins the end-to-end
// obligation: the native adapter's report goes through the same
// ccusage.NormalizeCcusageDailyJSON call the subprocess path uses, so the
// snapshot shape and the cost carry over unchanged.
func TestNativeToolCollectNormalizesThroughTheSharedPipeline(t *testing.T) {
	_, env := ampFixtureHome(t)
	snapshots, err := nativeCollect(context.Background(), contract.SourceAmp, Options{
		Timezone:    "UTC",
		CollectedAt: testCollectedAt,
		StateDir:    t.TempDir(),
		HomeDir:     t.TempDir(),
		Env:         env,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 {
		t.Fatalf("snapshots = %+v, want one", snapshots)
	}
	snapshot := snapshots[0]
	if snapshot.Source != contract.SourceAmp || snapshot.UsageDate != "2026-01-02" {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	if snapshot.Model != "gpt-5.5" || snapshot.InputTokens != 1000 || snapshot.OutputTokens != 500 {
		t.Fatalf("snapshot = %+v, want the adapter's tokens", snapshot)
	}
	if snapshot.CostUSD <= 0 {
		t.Fatalf("cost = %v, want the priced amp cost", snapshot.CostUSD)
	}
}

// TestQwenNativeWindowFiltersDailyEntriesButSessionRowsByLastActivity pins
// qwen's two window paths (lib.rs:22-31, 53-67). A session whose earlier entry
// falls before --since keeps that entry's tokens in the session report, while
// the daily report counts only the entry dated on or after --since. Routing
// both reports through the entry filter would silently undercount sessions.
func TestQwenNativeWindowFiltersDailyEntriesButSessionRowsByLastActivity(t *testing.T) {
	root := t.TempDir()
	chats := filepath.Join(root, "projects", "proj", "chats")
	if err := os.MkdirAll(chats, 0o700); err != nil {
		t.Fatal(err)
	}
	lines := []string{
		`{"type":"assistant","sessionId":"s1","model":"qwen3-coder-plus","timestamp":"2026-02-22T12:00:00.000Z","usageMetadata":{"promptTokenCount":10}}`,
		`{"type":"assistant","sessionId":"s1","model":"qwen3-coder-plus","timestamp":"2026-02-24T12:00:00.000Z","usageMetadata":{"promptTokenCount":10}}`,
	}
	if err := os.WriteFile(filepath.Join(chats, "s1.jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	env := func(key string) string {
		if key == "QWEN_DATA_DIR" {
			return root
		}
		return ""
	}
	runner := newNativeToolRunner(preparedForTest(t), "", env, func(string) {})
	reportTokens := func(report string) int64 {
		t.Helper()
		decoded, err := runner.Run(context.Background(), "ccusage",
			[]string{"qwen", report, "--json", "--since", "2026-02-24", "--timezone", "UTC"},
			ccusage.CommandOptions{TimeoutMs: 30000})
		if err != nil {
			t.Fatalf("%s report: %v", report, err)
		}
		document, ok := decoded.(ccusage.OrderedObject)
		if !ok {
			t.Fatalf("%s report = %T, want an ordered record", report, decoded)
		}
		key := "daily"
		if report == "session" {
			key = "sessions"
		}
		rowsValue, ok := document.Get(key)
		if !ok {
			t.Fatalf("%s report has no %s rows", report, key)
		}
		rows, ok := rowsValue.([]any)
		if !ok || len(rows) != 1 {
			t.Fatalf("%s = %#v, want one row", key, rowsValue)
		}
		tokens, ok := ccusage.RecordGet(rows[0], "inputTokens")
		if !ok {
			t.Fatalf("%s row has no inputTokens", key)
		}
		switch number := tokens.(type) {
		case json.Number:
			value, err := number.Int64()
			if err != nil {
				t.Fatal(err)
			}
			return value
		case float64:
			return int64(number)
		default:
			t.Fatalf("%s inputTokens = %T, want a number", key, tokens)
			return 0
		}
	}
	if got := reportTokens("daily"); got != 10 {
		t.Fatalf("daily inputTokens = %d, want the one in-window entry", got)
	}
	if got := reportTokens("session"); got != 20 {
		t.Fatalf("session inputTokens = %d, want both entries of the surviving session", got)
	}
}

// TestNativeToolRunnerAnswersGeminiUnderTheCLICommandName pins the command-name
// mapping: the gemini-cli source invokes the `gemini` subcommand, and an
// unknown command is an error rather than an empty report.
func TestNativeToolRunnerAnswersGeminiUnderTheCLICommandName(t *testing.T) {
	call, err := parseNativeToolArgs([]string{"gemini", "daily", "--json", "--timezone", "UTC"})
	if err != nil {
		t.Fatal(err)
	}
	if call.command != "gemini" || call.report != "daily" || call.timezone != "UTC" {
		t.Fatalf("call = %+v", call)
	}
	if _, err := parseNativeToolArgs([]string{"copilot", "daily", "--json"}); err != nil {
		t.Fatalf("copilot parses as a command name; the adapter registry decides support: %v", err)
	}
	runner := newNativeToolRunner(preparedForTest(t), "", nil, nil)
	_, err = runner.Run(context.Background(), "ccusage", []string{"import", "daily", "--json"},
		ccusage.CommandOptions{})
	if err == nil {
		t.Fatal("an unsupported command must fail, not answer with an empty report")
	}
}

// TestNativeToolRunnerHonoursTheCommandTimeout pins the TimeoutMs contract: the
// subprocess path kills the child at the prepared budget, and the in-process
// source must turn the same budget into a deadline instead of ignoring it.
func TestNativeToolRunnerHonoursTheCommandTimeout(t *testing.T) {
	root, env := ampFixtureHome(t)
	_ = root
	for index := 0; index < 400; index++ {
		threads := filepath.Join(env("AMP_DATA_DIR"), "threads")
		content := `{"id":"thread-` + itoa(index) + `","messages":[{"role":"assistant","timestamp":"2026-01-02T03:04:05.000Z","model":"gpt-5.5","usage":{"inputTokens":10}}]}`
		if err := os.WriteFile(filepath.Join(threads, "T-extra-"+itoa(index)+".json"), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	runner := newNativeToolRunner(preparedForTest(t), "", nil, nil)
	_, err := runner.Run(context.Background(), "ccusage",
		[]string{"amp", "daily", "--json", "--timezone", "UTC"},
		ccusage.CommandOptions{
			Env:       []string{"AMP_DATA_DIR=" + env("AMP_DATA_DIR")},
			TimeoutMs: 1,
		})
	if err == nil {
		t.Fatal("a 1ms budget over 400 files must fail with the timeout line")
	}
	if err.Error()[:21] != "Command timed out aft" {
		t.Fatalf("err = %v, want the ccusage timeout wording", err)
	}
}

// preparedForTest builds the minimal prepared pricing config the runner needs:
// a static catalogue and no explicit config.
func preparedForTest(t *testing.T) pricing.PreparedConfig {
	t.Helper()
	prepared, err := pricing.Prepare(pricing.PrepareInput{
		StateDir: t.TempDir(),
		Stderr:   func(string) {},
	})
	if err != nil {
		t.Fatalf("prepare pricing: %v", err)
	}
	return prepared
}

func itoa(value int) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func commandOptionsWith(ampDir string) ccusage.CommandOptions {
	return ccusage.CommandOptions{Env: []string{"AMP_DATA_DIR=" + ampDir, "HOME=" + ampDir}, TimeoutMs: 30000}
}

// TestCopilotAdapterIsImportedFromAProductionFile guards the registration
// path: copilot's adapter registers from its own init(), so the import that
// makes it reachable must live in a non-test file. A _test.go import would
// keep every other test green while production binaries answered
// `tools: no native adapter for "copilot"` once the native switch flips.
func TestCopilotAdapterIsImportedFromAProductionFile(t *testing.T) {
	const target = "internal/collect/adapters/copilot"
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), name, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		for _, spec := range file.Imports {
			if path, err := strconv.Unquote(spec.Path.Value); err == nil && strings.HasSuffix(path, target) {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("no non-test file of providers/ccusagetool imports " + target +
			"; the copilot adapter would not register in a production build")
	}
}
