package tools

// The Hermes adapter's rules, pinned against ccusage v20.0.33 (commit
// 1308c416): rust/adapters/hermes/src/{paths,parser,loader}.rs.

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// hermesOptions builds Options with HERMES_HOME pointing at roots (a
// comma-separated list, as the Rust adapter reads it).
func hermesOptions(t *testing.T, roots string, mode nativepricing.CostMode) Options {
	t.Helper()
	return Options{
		Env: func(key string) (string, bool) {
			if key == "HERMES_HOME" {
				return roots, true
			}
			return "", false
		},
		Timezone: "UTC",
		Mode:     mode,
		Corpus:   testCorpus(t),
	}
}

// createHermesDB writes the sessions table the Hermes adapter reads. costType
// is spliced into the two cost columns so a test can control the storage class
// SQLite gives them (REAL affinity converts integers to floats, no declared
// type keeps an integer an INTEGER).
func createHermesDB(t *testing.T, path, costType string) *sql.DB {
	t.Helper()
	database, err := sql.Open("sqlite", filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	schema := `
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    model TEXT,
    started_at REAL NOT NULL,
    message_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    billing_provider TEXT,
    estimated_cost_usd ` + costType + `,
    actual_cost_usd ` + costType + `
);`
	if _, err := database.Exec(schema); err != nil {
		t.Fatal(err)
	}
	return database
}

type hermesSessionFixture struct {
	id         string
	model      any
	provider   any
	startedAt  any
	message    any
	input      any
	output     any
	cacheRead  any
	cacheWrite any
	reasoning  any
	estimated  any
	actual     any
}

func insertHermesSession(t *testing.T, database *sql.DB, fixture hermesSessionFixture) {
	t.Helper()
	_, err := database.Exec(
		`INSERT INTO sessions (
			id, source, model, started_at, message_count, input_tokens, output_tokens,
			cache_read_tokens, cache_write_tokens, reasoning_tokens, billing_provider,
			estimated_cost_usd, actual_cost_usd
		) VALUES (?, 'cli', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		fixture.id, fixture.model, fixture.startedAt, fixture.message, fixture.input,
		fixture.output, fixture.cacheRead, fixture.cacheWrite, fixture.reasoning,
		fixture.provider, fixture.estimated, fixture.actual)
	if err != nil {
		t.Fatal(err)
	}
}

// TestHermesActualCostBeatsEstimatedWhenPositive pins the cost preference
// (parser.rs:63-64: `actual_cost.or(estimated_cost)`, then trusted when
// positive). The model has no pricing row at all, so a fall-through to
// calculation would read zero.
func TestHermesActualCostBeatsEstimatedWhenPositive(t *testing.T) {
	root := t.TempDir()
	database := createHermesDB(t, filepath.Join(root, "state.db"), "REAL")
	insertHermesSession(t, database, hermesSessionFixture{
		id:         "session-1",
		model:      "claude-sonnet-4-20250514",
		provider:   "anthropic",
		startedAt:  1_750_000_000.25,
		message:    42,
		input:      1200,
		output:     300,
		cacheRead:  50,
		cacheWrite: 20,
		reasoning:  10,
		estimated:  0.12,
		actual:     0.34,
	})

	entries, err := LoadHermes(hermesOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want one", entries)
	}
	entry := entries[0]
	if entry.CostUSD != 0.34 {
		t.Fatalf("cost = %v, want the actual cost 0.34", entry.CostUSD)
	}
	if entry.Usage.Input != 1200 || entry.Usage.Output != 300 ||
		entry.Usage.CacheRead != 50 || entry.Usage.CacheCreation != 20 || entry.Usage.Extra != 10 {
		t.Fatalf("usage = %+v, want cache_write→creation, cache_read→read, reasoning→extra", entry.Usage)
	}
	if entry.SessionID != "session-1" || entry.Model != "claude-sonnet-4-20250514" {
		t.Fatalf("entry = %+v", entry)
	}
	if entry.Date != "2025-06-15" {
		t.Fatalf("date = %q, want 2025-06-15", entry.Date)
	}
	if entry.MessageCount == nil || *entry.MessageCount != 42 {
		t.Fatalf("messageCount = %v, want 42", entry.MessageCount)
	}
	if entry.MissingPricing {
		t.Fatal("a trusted reported cost must not be flagged as missing pricing")
	}
}

// TestHermesZeroReportedCostFallsBackToPricing pins parser.rs:186-188: a
// recorded zero is not a cost, so the tokens are priced instead.
func TestHermesZeroReportedCostFallsBackToPricing(t *testing.T) {
	root := t.TempDir()
	database := createHermesDB(t, filepath.Join(root, "state.db"), "REAL")
	insertHermesSession(t, database, hermesSessionFixture{
		id:        "subscription-included",
		model:     "gpt-5.5",
		provider:  "openai",
		startedAt: 1_750_000_000.0,
		message:   72,
		input:     244_075,
		output:    10_019,
		cacheRead: 3_339_776,
		estimated: 0.0,
		actual:    0.0,
	})

	entries, err := LoadHermes(hermesOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want one", entries)
	}
	// The provider-qualified candidate is the one find_exact_with_fallback
	// answers, so the entry is billed from that row.
	corpus := testCorpus(t)
	usage := nativepricing.Usage{Input: 244_075, Output: 10_019, CacheRead: 3_339_776}
	want, _ := nativepricing.Cost(corpus, "openai/gpt-5.5", usage,
		time.UnixMilli(entries[0].Timestamp), nativepricing.ModeCalculate, false, false)
	if want <= 0 {
		t.Fatalf("expected the corpus to price openai/gpt-5.5, got %v", want)
	}
	if entries[0].CostUSD != want {
		t.Fatalf("cost = %v, want %v", entries[0].CostUSD, want)
	}
	if entries[0].MissingPricing {
		t.Fatal("a priced entry must not be flagged as missing pricing")
	}
}

// TestHermesReasoningEntersExtraAndBillingOutput pins parser.rs:194-200: the
// reasoning count is reported as extra tokens but billed as output.
func TestHermesReasoningEntersExtraAndBillingOutput(t *testing.T) {
	root := t.TempDir()
	database := createHermesDB(t, filepath.Join(root, "state.db"), "REAL")
	insertHermesSession(t, database, hermesSessionFixture{
		id:        "reasoning",
		model:     "gpt-5.5",
		provider:  "hermes",
		startedAt: 1_750_000_000.0,
		message:   1,
		input:     1_000,
		output:    300,
		reasoning: 10,
		estimated: 0.0,
		actual:    0.0,
	})

	entries, err := LoadHermes(hermesOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want one", entries)
	}
	entry := entries[0]
	if entry.Usage.Output != 300 || entry.Usage.Extra != 10 {
		t.Fatalf("usage = %+v, want output 300 and extra 10", entry.Usage)
	}
	corpus := testCorpus(t)
	usage := nativepricing.Usage{Input: 1_000, Output: 310}
	want, _ := nativepricing.Cost(corpus, "gpt-5.5", usage,
		time.UnixMilli(entry.Timestamp), nativepricing.ModeCalculate, false, false)
	if want <= 0 || entry.CostUSD != want {
		t.Fatalf("cost = %v, want %v (output billed with reasoning)", entry.CostUSD, want)
	}

	rows, totals := Summarize(entries, Daily)
	if len(rows) != 1 || rows[0].Usage.Output != 300 || rows[0].Usage.Extra != 10 ||
		rows[0].Usage.Total() != 1310 || totals.Usage.Total() != 1310 {
		t.Fatalf("rows = %+v totals = %+v, want output 300, extra 10 and total 1310", rows, totals)
	}
}

// TestHermesProviderCandidateNeedsExactFallbackHit pins parser.rs:232-241: the
// provider-qualified candidate is only offered when
// find_exact_with_fallback answers it, which has no fuzzy stage.
func TestHermesProviderCandidateNeedsExactFallbackHit(t *testing.T) {
	o := hermesOptions(t, t.TempDir(), nativepricing.ModeAuto)
	cases := []struct {
		name     string
		provider string
		model    string
		want     []string
	}{
		{
			name:     "embedded fallback hits",
			provider: "deepseek",
			model:    "deepseek-v4-flash",
			want:     []string{"deepseek/deepseek-v4-flash", "deepseek-v4-flash"},
		},
		{
			// A fuzzy Find would answer "custom/gpt-5.5" through its contained
			// gpt-5.5 key; find_exact_with_fallback must not.
			name:     "no exact row keeps the bare model only",
			provider: "custom",
			model:    "gpt-5.5",
			want:     []string{"gpt-5.5"},
		},
		{
			name:     "hermes provider never qualifies",
			provider: "hermes",
			model:    "gpt-5.5",
			want:     []string{"gpt-5.5"},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := hermesModelCandidates(o, testCase.provider, testCase.model)
			if len(got) != len(testCase.want) {
				t.Fatalf("candidates = %q, want %q", got, testCase.want)
			}
			for index := range got {
				if got[index] != testCase.want[index] {
					t.Fatalf("candidates = %q, want %q", got, testCase.want)
				}
			}
		})
	}
}

// TestHermesDedupAcrossDatabasesBySessionID pins loader.rs:31-38: the first
// database in path order keeps a session id, later ones drop it.
func TestHermesDedupAcrossDatabasesBySessionID(t *testing.T) {
	first := t.TempDir()
	second := t.TempDir()
	firstDB := createHermesDB(t, filepath.Join(first, "state.db"), "REAL")
	insertHermesSession(t, firstDB, hermesSessionFixture{
		id: "shared", model: "gpt-5.5", provider: "hermes", startedAt: 1_750_000_000.0,
		message: 1, input: 10, output: 1, estimated: 0.5, actual: 0.5,
	})
	secondDB := createHermesDB(t, filepath.Join(second, "state.db"), "REAL")
	insertHermesSession(t, secondDB, hermesSessionFixture{
		id: "shared", model: "gpt-5.5", provider: "hermes", startedAt: 1_750_000_000.0,
		message: 1, input: 10, output: 1, estimated: 9.0, actual: 9.0,
	})
	insertHermesSession(t, secondDB, hermesSessionFixture{
		id: "only-second", model: "gpt-5.5", provider: "hermes", startedAt: 1_760_000_000.0,
		message: 1, input: 10, output: 1, estimated: 2.0, actual: 2.0,
	})

	entries, err := LoadHermes(hermesOptions(t, first+","+second, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want the shared session once plus the second-only one", entries)
	}
	for _, entry := range entries {
		if entry.SessionID == "shared" && entry.CostUSD != 0.5 {
			t.Fatalf("shared session cost = %v, want 0.5 from the first database", entry.CostUSD)
		}
	}
}

// TestHermesReportedCostColumnReadsIntegerOrReal pins read_f64/read_u64
// (parser.rs:88-127): SQLite is dynamically typed, so the adapter reads the
// cost column as REAL or as INTEGER.
func TestHermesReportedCostColumnReadsIntegerOrReal(t *testing.T) {
	cases := []struct {
		name     string
		costType string
		reported any
		want     float64
	}{
		{name: "real affinity stores a float", costType: "REAL", reported: 2.5, want: 2.5},
		{name: "no declared type stores an integer", costType: "", reported: int64(2), want: 2},
		{name: "integer affinity", costType: "INTEGER", reported: int64(3), want: 3},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			root := t.TempDir()
			database := createHermesDB(t, filepath.Join(root, "state.db"), testCase.costType)
			insertHermesSession(t, database, hermesSessionFixture{
				id: "cost", model: "claude-sonnet-4-20250514", provider: "anthropic",
				startedAt: 1_750_000_000.0, message: 1, input: 10, output: 1,
				estimated: testCase.reported, actual: testCase.reported,
			})
			entries, err := LoadHermes(hermesOptions(t, root, nativepricing.ModeAuto))
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 1 || entries[0].CostUSD != testCase.want {
				t.Fatalf("entries = %+v, want cost %v", entries, testCase.want)
			}
		})
	}
}

// TestHermesIgnoresCostMode pins parser.rs:151-201: the adapter derives the
// cost itself, so --mode never reaches it.
func TestHermesIgnoresCostMode(t *testing.T) {
	root := t.TempDir()
	database := createHermesDB(t, filepath.Join(root, "state.db"), "REAL")
	insertHermesSession(t, database, hermesSessionFixture{
		id: "mode", model: "gpt-5.5", provider: "hermes", startedAt: 1_750_000_000.0,
		message: 1, input: 1_000, output: 100, estimated: 0.0, actual: 0.0,
	})
	entries, err := LoadHermes(hermesOptions(t, root, nativepricing.ModeDisplay))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].CostUSD <= 0 {
		t.Fatalf("entries = %+v, want a calculated cost even in display mode", entries)
	}
}

// TestHermesKeepsMissingPricingDiagnosticsInDisplayMode pins
// missing_hermes_pricing (parser.rs:206-217): hermes never checks the cost mode
// (unlike the PriceEntry-based adapters, whose Rust helpers return None in
// Display), so a display-mode report still lists the unknown model as unpriced.
func TestHermesKeepsMissingPricingDiagnosticsInDisplayMode(t *testing.T) {
	root := t.TempDir()
	database := createHermesDB(t, filepath.Join(root, "state.db"), "REAL")
	insertHermesSession(t, database, hermesSessionFixture{
		id: "unpriced", model: "totally-unknown-model-xyz", provider: "hermes", startedAt: 1_750_000_000.0,
		message: 1, input: 100, output: 10, estimated: 0.0, actual: 0.0,
	})
	entries, err := LoadHermes(hermesOptions(t, root, nativepricing.ModeDisplay))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || !entries[0].MissingPricing {
		t.Fatalf("entries = %+v, want a missing-pricing row", entries)
	}
	rows, totals := Summarize(entries, Daily)
	document := ReportJSON(rows, totals, Daily, false)
	unpriced, ok := document["totals"].(map[string]any)["unpricedModels"]
	if !ok {
		t.Fatal("display mode must still report unpricedModels for hermes")
	}
	if list := unpriced.([]string); len(list) != 1 || list[0] != "totally-unknown-model-xyz" {
		t.Fatalf("unpricedModels = %q", list)
	}
}

// TestHermesSkipsBlankModelAndEmptySession pins the row gate
// (parser.rs:22-27 plus the SQL filter): a blank model, an empty id or a
// missing timestamp drops the row, and the rest of the database still loads.
func TestHermesSkipsBlankModelAndEmptySession(t *testing.T) {
	root := t.TempDir()
	database := createHermesDB(t, filepath.Join(root, "state.db"), "REAL")
	insertHermesSession(t, database, hermesSessionFixture{
		id: "blank-model", model: "   ", provider: "hermes", startedAt: 1_750_000_000.0,
		message: 1, input: 10, output: 1, estimated: 1.0, actual: 1.0,
	})
	insertHermesSession(t, database, hermesSessionFixture{
		id: "", model: "gpt-5.5", provider: "hermes", startedAt: 1_750_000_000.0,
		message: 1, input: 10, output: 1, estimated: 1.0, actual: 1.0,
	})
	insertHermesSession(t, database, hermesSessionFixture{
		id: "null-model", model: nil, provider: "hermes", startedAt: 1_750_000_000.0,
		message: 1, input: 10, output: 1, estimated: 1.0, actual: 1.0,
	})
	insertHermesSession(t, database, hermesSessionFixture{
		id: "all-zero", model: "gpt-5.5", provider: "hermes", startedAt: 1_750_000_000.0,
		message: 0, input: 0, output: 0, estimated: 0.0, actual: 0.0,
	})
	insertHermesSession(t, database, hermesSessionFixture{
		id: "kept", model: "gpt-5.5", provider: "hermes", startedAt: 1_750_000_000.0,
		message: 1, input: 10, output: 1, estimated: nil, actual: 1.0,
	})

	entries, err := LoadHermes(hermesOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].SessionID != "kept" {
		t.Fatalf("entries = %+v, want only the kept session", entries)
	}
}

// TestHermesMessageCountsSumIntoTheDailyReport pins loader/parser message_count
// aggregation through the shared report layer.
func TestHermesMessageCountsSumIntoTheDailyReport(t *testing.T) {
	root := t.TempDir()
	database := createHermesDB(t, filepath.Join(root, "state.db"), "REAL")
	for index, count := range []int64{3, 4} {
		insertHermesSession(t, database, hermesSessionFixture{
			id: "session-" + string(rune('a'+index)), model: "gpt-5.5", provider: "hermes",
			startedAt: 1_750_000_000.0 + float64(index), message: count,
			input: 10, output: 1, estimated: 1.0, actual: 1.0,
		})
	}
	entries, err := LoadHermes(hermesOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	rows, totals := Summarize(entries, Daily)
	document := ReportJSON(rows, totals, Daily, false)
	daily := document["daily"].([]map[string]any)
	if len(daily) != 1 {
		t.Fatalf("daily = %+v, want one row", daily)
	}
	if count, ok := daily[0]["messageCount"].(uint64); !ok || count != 7 {
		t.Fatalf("messageCount = %v, want 7", daily[0]["messageCount"])
	}
}

// TestHermesTimestampSecondsOrMillis pins timestamp_from_number
// (parser.rs:129-137): above 1e12 the value is already milliseconds, otherwise
// it is seconds.
func TestHermesTimestampSecondsOrMillis(t *testing.T) {
	root := t.TempDir()
	database := createHermesDB(t, filepath.Join(root, "state.db"), "REAL")
	insertHermesSession(t, database, hermesSessionFixture{
		id: "seconds", model: "gpt-5.5", provider: "hermes", startedAt: 1_750_000_000.25,
		message: 1, input: 10, output: 1, estimated: 1.0, actual: 1.0,
	})
	insertHermesSession(t, database, hermesSessionFixture{
		id: "millis", model: "gpt-5.5", provider: "hermes", startedAt: 1_750_000_000_250.0,
		message: 1, input: 10, output: 1, estimated: 1.0, actual: 1.0,
	})
	insertHermesSession(t, database, hermesSessionFixture{
		id: "zero", model: "gpt-5.5", provider: "hermes", startedAt: 0.0,
		message: 1, input: 10, output: 1, estimated: 1.0, actual: 1.0,
	})

	entries, err := LoadHermes(hermesOptions(t, root, nativepricing.ModeAuto))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want the two positive timestamps", entries)
	}
	byID := map[string]Entry{}
	for _, entry := range entries {
		byID[entry.SessionID] = entry
	}
	if got := byID["seconds"].Timestamp; got != 1_750_000_000_250 {
		t.Fatalf("seconds timestamp = %d, want 1750000000250", got)
	}
	if got := byID["millis"].Timestamp; got != 1_750_000_000_250 {
		t.Fatalf("millis timestamp = %d, want 1750000000250", got)
	}
	for _, entry := range entries {
		if entry.Date != "2025-06-15" {
			t.Fatalf("date = %q, want 2025-06-15", entry.Date)
		}
	}
}
