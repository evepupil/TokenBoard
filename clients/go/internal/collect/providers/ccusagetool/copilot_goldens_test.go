package ccusagetool

// The copilot golden test freezes the copilot adapter against the JSON ccusage
// 20.0.33 prints for the upstream integration fixture tree
// (clients/go/testdata/copilot-goldens-fixtures/copilot, byte-identical to
// rust/adapters/copilot/tests/fixtures at commit 1308c416). The table is
// driven through the native provider's runner - the same seam the ccusage
// subprocess sits behind - so discovery, both parsers, the reconciliation, the
// pricing walk and the report builder are all compared end to end.
//
// It lives in this package rather than the adapter's because the runner is
// unexported here and reaches the adapter through the registry. It runs with
// the default environment: a maintainer whose shell exports COPILOT_HOME or
// COPILOT_OTEL_FILE_EXPORTER_PATH would otherwise read their own files, so
// every fixture COPILOT_HOME is layered over the environment explicitly.
//
// The comparison is strict: every leaf of every report must match bit for bit
// (numbers as float64 bit patterns). There is no exemption list.
//
// The fixture tree and the goldens are owned by scripts/gen-copilot-goldens.mjs:
// this file never writes them. That script also re-derives the upstream CLI
// snapshots committed under upstream/ and fails when ccusage no longer prints
// them, and CI runs it with --check.

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/pricing"
)

// copilotGoldenReports is the committed ccusage 20.0.33 output.
//
//go:embed copilot-goldens/copilot-reports.json
var copilotGoldenReports []byte

type copilotGoldenCommand struct {
	ID          string   `json:"id"`
	Argv        []string `json:"argv"`
	CopilotHome string   `json:"copilotHome"`
}

type copilotGoldenDocument struct {
	CcusageVersion        string                     `json:"ccusageVersion"`
	Since                 string                     `json:"since"`
	Until                 string                     `json:"until"`
	Timezone              string                     `json:"timezone"`
	Commands              []copilotGoldenCommand     `json:"commands"`
	CrossCheckedSnapshots []string                   `json:"crossCheckedSnapshots"`
	Reports               map[string]json.RawMessage `json:"reports"`
}

func loadCopilotGoldens(t *testing.T) *copilotGoldenDocument {
	t.Helper()
	var document copilotGoldenDocument
	if err := json.Unmarshal(copilotGoldenReports, &document); err != nil {
		t.Fatalf("decode goldens/copilot-reports.json: %v", err)
	}
	if document.CcusageVersion != "20.0.33" {
		t.Fatalf("goldens were minted by ccusage %q, want 20.0.33", document.CcusageVersion)
	}
	if document.Since != "20260101" || document.Until != "20260228" || document.Timezone != "UTC" {
		t.Fatalf("goldens window = %s..%s %s, want 20260101..20260228 UTC",
			document.Since, document.Until, document.Timezone)
	}
	if len(document.Reports) != 4 {
		t.Fatalf("goldens cover %d reports, want daily+session in two modes", len(document.Reports))
	}
	if len(document.CrossCheckedSnapshots) != 2 {
		t.Fatalf("goldens record %d upstream snapshots, want 2", len(document.CrossCheckedSnapshots))
	}
	return &document
}

func copilotFixtureHome(t *testing.T) string {
	t.Helper()
	home, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "testdata", "copilot-goldens-fixtures", "copilot"))
	if err != nil {
		t.Fatal(err)
	}
	return home
}

// TestCopilotAdaptersMatchTheGoldens runs the provider's runner over the
// fixture tree for each recorded invocation and compares the decoded report
// bit for bit.
func TestCopilotAdaptersMatchTheGoldens(t *testing.T) {
	document := loadCopilotGoldens(t)
	home := copilotFixtureHome(t)
	prepared, err := pricing.Prepare(pricing.PrepareInput{StateDir: t.TempDir(), Stderr: func(string) {}})
	if err != nil {
		t.Fatalf("prepare pricing: %v", err)
	}
	for _, command := range document.Commands {
		t.Run(command.ID, func(t *testing.T) {
			golden, ok := document.Reports[command.ID]
			if !ok {
				t.Fatalf("goldens record no report for %s", command.ID)
			}
			if command.CopilotHome != "<fixture-tree>/copilot" {
				t.Fatalf("command %s names COPILOT_HOME %q", command.ID, command.CopilotHome)
			}
			// The recorded argv starts with the literal "ccusage"; the runner
			// answers the rest, with the fixture home winning over the
			// environment and the exporter path never read.
			runner := newNativeToolRunner(prepared, home, nil, nil)
			runner.overrides = map[string]string{
				"COPILOT_HOME":                    home,
				"COPILOT_OTEL_FILE_EXPORTER_PATH": "",
			}
			got, err := runner.Run(t.Context(), "ccusage", command.Argv[1:], ccusage.CommandOptions{})
			if err != nil {
				t.Fatalf("native runner %v: %v", command.Argv[1:], err)
			}
			compareCopilotReports(t, command.ID, golden, got)
		})
	}
}

// copilotCostNear compares two costs at the 1e-12 relative precision the
// fixture's decimal credit amounts need.
func copilotCostNear(got, want float64) bool {
	return math.Abs(got-want) <= 1e-12*math.Max(math.Abs(want), 1)
}

func compareCopilotReports(t *testing.T, label string, golden []byte, got any) {
	t.Helper()
	want := decodeCopilotTree(t, label+" golden", golden)
	// The runner answers providers ordered objects (ccusage.OrderedObject);
	// re-encode that same shape before comparing, so the test sees exactly what
	// the normalizer would.
	port := decodeCopilotTree(t, label+" port", mustMarshal(t, plainCopilotValue(got)))
	if differences := diffCopilotTrees("", want, port, 11); len(differences) > 0 {
		t.Fatalf("%s differs from ccusage:\n%s", label, differences)
	}
}

// plainCopilotValue turns an ordered record back into a plain map for
// marshalling.
func plainCopilotValue(value any) any {
	if record, ok := value.(ccusage.OrderedObject); ok {
		out := make(map[string]any, len(record.Keys()))
		for _, key := range record.Keys() {
			child, _ := record.Get(key)
			out[key] = plainCopilotValue(child)
		}
		return out
	}
	if list, ok := value.([]any); ok {
		out := make([]any, len(list))
		for index, child := range list {
			out[index] = plainCopilotValue(child)
		}
		return out
	}
	return value
}

func mustMarshal(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal the native report: %v", err)
	}
	return encoded
}

func decodeCopilotTree(t *testing.T, label string, data []byte) any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("%s is not valid JSON: %v\n%s", label, err, data)
	}
	return normalizeCopilotTree(value)
}

func normalizeCopilotTree(value any) any {
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
			out[key] = normalizeCopilotTree(child)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, child := range typed {
			out[index] = normalizeCopilotTree(child)
		}
		return out
	default:
		return value
	}
}

func diffCopilotTrees(path string, want, got any, limit int) string {
	differences := []string{}
	var walk func(path string, want, got any)
	walk = func(path string, want, got any) {
		if len(differences) >= limit {
			return
		}
		switch wantTyped := want.(type) {
		case map[string]any:
			gotTyped, ok := got.(map[string]any)
			if !ok {
				differences = append(differences, fmt.Sprintf("%s: golden %v, port %v", path, want, got))
				return
			}
			keys := make([]string, 0, len(wantTyped)+len(gotTyped))
			for key := range wantTyped {
				keys = append(keys, key)
			}
			for key := range gotTyped {
				if _, present := wantTyped[key]; !present {
					keys = append(keys, key)
				}
			}
			sort.Strings(keys)
			for _, key := range keys {
				child := key
				if path != "" {
					child = path + "." + key
				}
				wantChild, wantOK := wantTyped[key]
				gotChild, gotOK := gotTyped[key]
				switch {
				case !wantOK:
					differences = append(differences, fmt.Sprintf("%s: golden <absent>, port %v", child, gotChild))
				case !gotOK:
					differences = append(differences, fmt.Sprintf("%s: golden %v, port <absent>", child, wantChild))
				default:
					walk(child, wantChild, gotChild)
				}
			}
		case []any:
			gotTyped, ok := got.([]any)
			if !ok {
				differences = append(differences, fmt.Sprintf("%s: golden %v, port %v", path, want, got))
				return
			}
			if len(wantTyped) != len(gotTyped) {
				differences = append(differences,
					fmt.Sprintf("%s.length: golden %d, port %d", path, len(wantTyped), len(gotTyped)))
				return
			}
			for index := range wantTyped {
				walk(fmt.Sprintf("%s[%d]", path, index), wantTyped[index], gotTyped[index])
			}
		default:
			wantFloat, wantIsFloat := want.(float64)
			gotFloat, gotIsFloat := got.(float64)
			same := false
			if wantIsFloat || gotIsFloat {
				same = wantIsFloat && gotIsFloat && math.Float64bits(wantFloat) == math.Float64bits(gotFloat)
			} else {
				same = reflect.DeepEqual(want, got)
			}
			if !same {
				differences = append(differences, fmt.Sprintf("%s: golden %v, port %v", path, want, got))
			}
		}
	}
	walk(path, want, got)
	text := ""
	for _, line := range differences {
		text += "  " + line + "\n"
	}
	return text
}

// TestCopilotRunnerHonoursTheModeFlag pins the --mode handling the goldens rely
// on: the flag reaches the adapter (the reconciliation output and the missing
// pricing marker differ between calculate and display), and --mode display
// bills every row at its reported cost: Copilot reports none per model row, so
// every token row bills $0 and the display total is only the credits the
// fixture's gap rows report (0.08), not calculate's full token pricing.
func TestCopilotRunnerHonoursTheModeFlag(t *testing.T) {
	home := copilotFixtureHome(t)
	prepared, err := pricing.Prepare(pricing.PrepareInput{StateDir: t.TempDir(), Stderr: func(string) {}})
	if err != nil {
		t.Fatalf("prepare pricing: %v", err)
	}
	runner := newNativeToolRunner(prepared, home, nil, nil)
	runner.overrides = map[string]string{
		"COPILOT_HOME":                    home,
		"COPILOT_OTEL_FILE_EXPORTER_PATH": "",
	}
	argv := []string{"copilot", "session", "--json", "--timezone", "UTC",
		"--since", "20260101", "--until", "20260228"}
	run := func(mode string) map[string]any {
		t.Helper()
		got, err := runner.Run(t.Context(), "ccusage", append(append([]string{}, argv...), "--mode", mode), ccusage.CommandOptions{})
		if err != nil {
			t.Fatalf("--mode %s: %v", mode, err)
		}
		return plainCopilotValue(got).(map[string]any)
	}
	calculate, display := run("calculate"), run("display")
	if totals := calculate["totals"].(map[string]any); totals["totalCost"] == 0.0 {
		t.Fatalf("calculate totals = %v, want the token-derived cost", totals)
	}
	displayTotals := display["totals"].(map[string]any)
	displayCost, err := displayTotals["totalCost"].(json.Number).Float64()
	if err != nil {
		t.Fatalf("display totalCost = %v: %v", displayTotals["totalCost"], err)
	}
	if !copilotCostNear(displayCost, 0.08) {
		t.Fatalf("display totalCost = %v, want only the gap rows' reported 0.08", displayTotals["totalCost"])
	}
	if _, unpriced := displayTotals["unpricedModels"]; unpriced {
		t.Fatalf("display totals carry unpricedModels: %v", displayTotals)
	}
	if _, err := runner.Run(t.Context(), "ccusage", append(append([]string{}, argv...), "--mode", "bogus"), ccusage.CommandOptions{}); err == nil {
		t.Fatal("an unknown mode must fail")
	}
}
