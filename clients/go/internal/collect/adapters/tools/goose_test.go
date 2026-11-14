package tools

// The Goose adapter's rules, pinned against ccusage v20.0.33 (commit
// 1308c416): rust/adapters/goose/src/{paths,parser,loader}.rs.

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// gooseOptions points the adapter at one GOOSE_PATH_ROOT.
func gooseOptions(t *testing.T, root string, mode nativepricing.CostMode) Options {
	t.Helper()
	return Options{
		Env: func(key string) (string, bool) {
			if key == "GOOSE_PATH_ROOT" {
				return root, true
			}
			return "", false
		},
		Timezone: "UTC",
		Mode:     mode,
		Corpus:   testCorpus(t),
	}
}

// gooseHomeOptions resolves the default candidates under home, so a test can
// stage several databases at once.
func gooseHomeOptions(t *testing.T, home string, mode nativepricing.CostMode) Options {
	t.Helper()
	return Options{
		Env:      func(string) (string, bool) { return "", false },
		HomeDir:  func() (string, error) { return home, nil },
		Timezone: "UTC",
		Mode:     mode,
		Corpus:   testCorpus(t),
	}
}

// createGooseDB writes the sessions table the Goose adapter reads. createdAtType
// is spliced into the created_at column so a test can control whether SQLite
// keeps an integer as an integer or converts it to text.
func createGooseDB(t *testing.T, path, createdAtType string) *sql.DB {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open("sqlite", filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	schema := `
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    model_config_json TEXT,
    provider_name TEXT,
    created_at ` + createdAtType + `,
    total_tokens INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    accumulated_total_tokens INTEGER,
    accumulated_input_tokens INTEGER,
    accumulated_output_tokens INTEGER
)`
	if _, err := database.Exec(schema); err != nil {
		t.Fatal(err)
	}
	return database
}

type gooseSessionFixture struct {
	id          string
	modelConfig any
	provider    any
	createdAt   any
	total       any
	input       any
	output      any
	accTotal    any
	accInput    any
	accOutput   any
}

func insertGooseSession(t *testing.T, database *sql.DB, fixture gooseSessionFixture) {
	t.Helper()
	_, err := database.Exec(
		`INSERT INTO sessions (
			id, model_config_json, provider_name, created_at, total_tokens, input_tokens,
			output_tokens, accumulated_total_tokens, accumulated_input_tokens,
			accumulated_output_tokens
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		fixture.id, fixture.modelConfig, fixture.provider, fixture.createdAt, fixture.total,
		fixture.input, fixture.output, fixture.accTotal, fixture.accInput, fixture.accOutput)
	if err != nil {
		t.Fatal(err)
	}
}

// TestGooseAccumulatedColumnsWinAndMustBePositive pins row_to_entry
// (parser.rs:37-47): an accumulated column wins only when it is positive, and a
// zero falls back to the per-turn column.
func TestGooseAccumulatedColumnsWinAndMustBePositive(t *testing.T) {
	root := t.TempDir()
	database := createGooseDB(t, filepath.Join(root, "data", "sessions", "sessions.db"), "TEXT")
	insertGooseSession(t, database, gooseSessionFixture{
		id:          "accumulated",
		modelConfig: `{"model_name":"claude-sonnet-4-5"}`,
		provider:    "anthropic",
		createdAt:   "2026-05-01 01:02:03",
		total:       5,
		input:       999,
		output:      7,
		accTotal:    0,
		accInput:    100,
		accOutput:   0,
	})
	insertGooseSession(t, database, gooseSessionFixture{
		id:          "fallback",
		modelConfig: `{"model_name":"claude-sonnet-4-5"}`,
		provider:    "anthropic",
		createdAt:   "2026-05-01 01:02:03",
		total:       0,
		input:       1,
		output:      2,
		accTotal:    0,
		accInput:    0,
		accOutput:   -1,
	})

	entries, err := LoadGoose(gooseOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want two", entries)
	}
	byID := map[string]Entry{}
	for _, entry := range entries {
		byID[entry.SessionID] = entry
	}
	accumulated := byID["accumulated"]
	if accumulated.Usage.Input != 100 || accumulated.Usage.Output != 7 {
		t.Fatalf("usage = %+v, want accumulated input 100 and the output column 7", accumulated.Usage)
	}
	fallback := byID["fallback"]
	if fallback.Usage.Input != 1 || fallback.Usage.Output != 2 {
		t.Fatalf("usage = %+v, want the per-turn columns", fallback.Usage)
	}
}

// TestGooseReasoningIsTotalMinusInputOutput pins parser.rs:48-54: reasoning is
// the saturating remainder of the total, reported as extra tokens.
func TestGooseReasoningIsTotalMinusInputOutput(t *testing.T) {
	root := t.TempDir()
	database := createGooseDB(t, filepath.Join(root, "data", "sessions", "sessions.db"), "TEXT")
	insertGooseSession(t, database, gooseSessionFixture{
		id:          "session-a",
		modelConfig: `{"model_name":"claude-sonnet-4-20250514"}`,
		provider:    "anthropic",
		createdAt:   "2026-05-01 01:02:03",
		total:       180,
		input:       100,
		output:      50,
		accTotal:    180,
		accInput:    100,
		accOutput:   50,
	})
	insertGooseSession(t, database, gooseSessionFixture{
		id:          "saturating",
		modelConfig: `{"model_name":"claude-sonnet-4-20250514"}`,
		provider:    "anthropic",
		createdAt:   "2026-05-01 01:02:03",
		total:       10,
		input:       100,
		output:      50,
		accTotal:    10,
		accInput:    100,
		accOutput:   50,
	})

	entries, err := LoadGoose(gooseOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]Entry{}
	for _, entry := range entries {
		byID[entry.SessionID] = entry
	}
	reasoning := byID["session-a"]
	if reasoning.Usage.Input != 100 || reasoning.Usage.Output != 50 || reasoning.Usage.Extra != 30 {
		t.Fatalf("usage = %+v, want reasoning 30 in extra", reasoning.Usage)
	}
	if saturated := byID["saturating"]; saturated.Usage.Extra != 0 {
		t.Fatalf("usage = %+v, want the negative remainder saturated to zero", saturated.Usage)
	}

	rows, totals := Summarize(entries, Daily)
	if len(rows) != 1 {
		t.Fatalf("rows = %+v, want both sessions in one day", rows)
	}
	if rows[0].Usage.Output != 100 || rows[0].Usage.Extra != 30 || rows[0].Usage.Total() != 330 {
		t.Fatalf("row = %+v, want output 100, extra 30 and total 330", rows[0])
	}
	if totals.Usage.Total() != 330 {
		t.Fatalf("totals = %+v, want every token counted once", totals.Usage)
	}
}

// TestGooseCreatedAtStringOrIntegerAndDateOnlyFallback pins
// parse_goose_timestamp (parser.rs:108-146).
func TestGooseCreatedAtStringOrIntegerAndDateOnlyFallback(t *testing.T) {
	cases := []struct {
		name       string
		columnType string
		createdAt  any
		wantMillis int64
	}{
		{name: "space separated", columnType: "TEXT", createdAt: "2026-05-01 01:02:03", wantMillis: 1_777_597_323_000},
		{name: "T separated", columnType: "TEXT", createdAt: "2026-05-01T01:02:03", wantMillis: 1_777_597_323_000},
		{name: "strict timestamp", columnType: "TEXT", createdAt: "2026-05-01T01:02:03.500Z", wantMillis: 1_777_597_323_500},
		{name: "date only", columnType: "TEXT", createdAt: "2026-05-01", wantMillis: 1_777_593_600_000},
		{name: "integer seconds", columnType: "INTEGER", createdAt: int64(1_777_597_323), wantMillis: 1_777_597_323_000},
		{name: "integer millis", columnType: "INTEGER", createdAt: int64(1_777_597_323_500), wantMillis: 1_777_597_323_500},
		{name: "integer stored as text", columnType: "TEXT", createdAt: int64(1_777_597_323), wantMillis: 1_777_597_323_000},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			root := t.TempDir()
			database := createGooseDB(t, filepath.Join(root, "data", "sessions", "sessions.db"), testCase.columnType)
			insertGooseSession(t, database, gooseSessionFixture{
				id:          "session-a",
				modelConfig: `{"model_name":"claude-sonnet-4-5"}`,
				provider:    "anthropic",
				createdAt:   testCase.createdAt,
				total:       10,
				input:       6,
				output:      4,
			})
			entries, err := LoadGoose(gooseOptions(t, root, nativepricing.ModeAuto))
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 1 {
				t.Fatalf("entries = %+v, want one", entries)
			}
			if entries[0].Timestamp != testCase.wantMillis {
				t.Fatalf("timestamp = %d, want %d", entries[0].Timestamp, testCase.wantMillis)
			}
			if entries[0].Date != "2026-05-01" {
				t.Fatalf("date = %q, want 2026-05-01", entries[0].Date)
			}
		})
	}

	t.Run("unparseable drops the row", func(t *testing.T) {
		root := t.TempDir()
		database := createGooseDB(t, filepath.Join(root, "data", "sessions", "sessions.db"), "TEXT")
		insertGooseSession(t, database, gooseSessionFixture{
			id:          "session-a",
			modelConfig: `{"model_name":"claude-sonnet-4-5"}`,
			provider:    "anthropic",
			createdAt:   "not a timestamp",
			total:       10,
			input:       6,
			output:      4,
		})
		entries, err := LoadGoose(gooseOptions(t, root, nativepricing.ModeAuto))
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 0 {
			t.Fatalf("entries = %+v, want none", entries)
		}
	})
}

// TestGooseProviderInferenceOPrefixQuirk pins normalize_provider
// (parser.rs:148-168), including the `starts_with('o')` rule that files every
// o-prefixed model under openai.
func TestGooseProviderInferenceOPrefixQuirk(t *testing.T) {
	empty := ""
	cases := []struct {
		name     string
		provider *string
		model    string
		want     string
	}{
		{name: "explicit provider keeps its case", provider: gooseStringPointer("Amazon-Bedrock"), model: "x", want: "Amazon_Bedrock"},
		{name: "explicit provider is not lowercased", provider: gooseStringPointer("Anthropic"), model: "x", want: "Anthropic"},
		{name: "blank provider falls back to inference", provider: &empty, model: "claude-sonnet-4-5", want: "anthropic"},
		{name: "claude prefix", provider: nil, model: "claude-sonnet-4-5", want: "anthropic"},
		{name: "gpt prefix", provider: nil, model: "gpt-5.5", want: "openai"},
		{name: "chatgpt prefix", provider: nil, model: "chatgpt-4o", want: "openai"},
		{name: "o prefix is openai even for opus", provider: nil, model: "opus-4", want: "openai"},
		{name: "gemini prefix", provider: nil, model: "gemini-2.5-pro", want: "google"},
		{name: "qwen is openrouter regardless of case", provider: nil, model: "Qwen3-Coder", want: "openrouter"},
		{name: "anything else is goose", provider: nil, model: "llama-3", want: "goose"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			hasProvider := testCase.provider != nil
			provider := ""
			if hasProvider {
				provider = *testCase.provider
			}
			if got := normalizeGooseProvider(provider, hasProvider, testCase.model); got != testCase.want {
				t.Fatalf("provider = %q, want %q", got, testCase.want)
			}
		})
	}
}

// TestGooseDedupKeyIncludesDbPath pins loader.rs:40-50: the dedup key is
// `dbpath:session_id`, so the same session id in two installations survives.
func TestGooseDedupKeyIncludesDbPath(t *testing.T) {
	home := t.TempDir()
	first := filepath.Join(home, ".local", "share", "goose", "sessions", "sessions.db")
	second := filepath.Join(home, "Library", "Application Support", "goose", "sessions", "sessions.db")
	firstDB := createGooseDB(t, first, "TEXT")
	insertGooseSession(t, firstDB, gooseSessionFixture{
		id: "shared", modelConfig: `{"model_name":"claude-sonnet-4-5"}`, provider: "anthropic",
		createdAt: "2026-05-01 01:02:03", total: 10, input: 6, output: 4,
	})
	secondDB := createGooseDB(t, second, "TEXT")
	insertGooseSession(t, secondDB, gooseSessionFixture{
		id: "shared", modelConfig: `{"model_name":"claude-sonnet-4-5"}`, provider: "anthropic",
		createdAt: "2026-05-02 01:02:03", total: 20, input: 12, output: 8,
	})

	entries, err := LoadGoose(gooseHomeOptions(t, home, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want both databases to survive", entries)
	}
	if entries[0].Date != "2026-05-01" || entries[1].Date != "2026-05-02" {
		t.Fatalf("entries = %+v, want timestamp order", entries)
	}
}

// TestGooseForcesCalculateIgnoringMode pins calculate_goose_cost
// (parser.rs:170-195): the adapter always prices, so --mode never reaches it.
func TestGooseForcesCalculateIgnoringMode(t *testing.T) {
	root := t.TempDir()
	database := createGooseDB(t, filepath.Join(root, "data", "sessions", "sessions.db"), "TEXT")
	insertGooseSession(t, database, gooseSessionFixture{
		id: "session-a", modelConfig: `{"model_name":"gpt-5.5"}`, provider: "openai",
		createdAt: "2026-05-01 01:02:03", total: 1100, input: 1000, output: 100,
	})
	entries, err := LoadGoose(gooseOptions(t, root, nativepricing.ModeDisplay))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].CostUSD <= 0 {
		t.Fatalf("entries = %+v, want a calculated cost even in display mode", entries)
	}
	if entries[0].MissingPricing {
		t.Fatal("a priced entry must not be flagged as missing pricing")
	}
}

// TestGooseDropsRowsWithoutUsableModelOrTimestamp pins the row gates in
// row_to_entry (parser.rs:27-35).
func TestGooseDropsRowsWithoutUsableModelOrTimestamp(t *testing.T) {
	root := t.TempDir()
	database := createGooseDB(t, filepath.Join(root, "data", "sessions", "sessions.db"), "TEXT")
	rows := []gooseSessionFixture{
		{id: "no-model-name", modelConfig: `{"model": "gpt-5.5"}`, createdAt: "2026-05-01 01:02:03", total: 10},
		{id: "blank-model-name", modelConfig: `{"model_name": "   "}`, createdAt: "2026-05-01 01:02:03", total: 10},
		{id: "non-string-model-name", modelConfig: `{"model_name": 5}`, createdAt: "2026-05-01 01:02:03", total: 10},
		{id: "not-an-object", modelConfig: `["gpt-5.5"]`, createdAt: "2026-05-01 01:02:03", total: 10},
		{id: "invalid-json", modelConfig: `{"model_name":`, createdAt: "2026-05-01 01:02:03", total: 10},
		{id: "no-tokens", modelConfig: `{"model_name":"gpt-5.5"}`, createdAt: "2026-05-01 01:02:03", total: 0, input: 0, output: 0},
		{id: "kept", modelConfig: `{"model_name":" gpt-5.5 "}`, createdAt: "2026-05-01 01:02:03", total: 10, input: 6, output: 4},
	}
	for _, row := range rows {
		insertGooseSession(t, database, row)
	}

	entries, err := LoadGoose(gooseOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].SessionID != "kept" {
		t.Fatalf("entries = %+v, want only the kept session", entries)
	}
	if entries[0].Model != "gpt-5.5" {
		t.Fatalf("model = %q, want the trimmed model_name", entries[0].Model)
	}
}

// TestGoosePricingCandidatesPutTheBareModelFirst pins the candidate chain
// (parser.rs:184-195): the bare model is priced first, and the
// provider-qualified spelling is only a fallback for a non-goose provider.
func TestGoosePricingCandidatesPutTheBareModelFirst(t *testing.T) {
	cases := []struct {
		provider string
		model    string
		want     []string
	}{
		{provider: "ByteDance", model: "Seed-2.0-code", want: []string{"Seed-2.0-code", "ByteDance/Seed-2.0-code"}},
		{provider: "goose", model: "Seed-2.0-code", want: []string{"Seed-2.0-code"}},
	}
	for _, testCase := range cases {
		got := goosePricingCandidates(testCase.model, testCase.provider)
		if len(got) != len(testCase.want) {
			t.Fatalf("candidates = %q, want %q", got, testCase.want)
		}
		for index := range got {
			if got[index] != testCase.want[index] {
				t.Fatalf("candidates = %q, want %q", got, testCase.want)
			}
		}
	}
}

func gooseStringPointer(value string) *string { return &value }
