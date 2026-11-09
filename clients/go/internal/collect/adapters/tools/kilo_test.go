package tools

// The Kilo adapter's rules, pinned against ccusage v20.0.33 (commit 1308c416):
// rust/adapters/kilo/src/{paths,parser,loader}.rs.

import (
	"database/sql"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// kiloOptions builds Options with KILO_DATA_DIR pointing at the comma-joined
// roots.
func kiloOptions(t *testing.T, roots []string, mode nativepricing.CostMode, corpus nativepricing.Corpus) Options {
	t.Helper()
	joined := strings.Join(roots, ",")
	return Options{
		Env: func(key string) (string, bool) {
			if key == "KILO_DATA_DIR" {
				return joined, true
			}
			return "", false
		},
		HomeDir:  func() (string, error) { return t.TempDir(), nil },
		Timezone: "UTC",
		Mode:     mode,
		Corpus:   corpus,
	}
}

// seedKiloMessage writes one <dir>/kilo.db with the given message rows.
func seedKiloMessage(t *testing.T, dir string, rows [][3]string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(dir, "kilo.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if _, err := database.Exec(`CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)`); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if _, err := database.Exec(`INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)`, row[0], row[1], row[2]); err != nil {
			t.Fatal(err)
		}
	}
}

// TestKiloCostModeThreeStates pins calculate_kilo_cost (parser.rs:186-199):
// display trusts the reported cost, auto prefers it, calculate always prices the
// tokens. DeepSeek V4 on 2026-01-02 predates the new schedule, so one million
// input tokens bill at the old 0.14e-6 rate.
func TestKiloCostModeThreeStates(t *testing.T) {
	root := t.TempDir()
	seedKiloMessage(t, root, [][3]string{{
		"row-1", "session-a",
		`{"id":"msg-1","role":"assistant","providerID":"deepseek","modelID":"deepseek-v4-flash","time":{"created":1767312000000},"tokens":{"input":1000000,"output":0,"cache":{"read":0,"write":0}},"cost":0.02}`,
	}})
	for name, test := range map[string]struct {
		mode nativepricing.CostMode
		want float64
	}{
		"display":   {nativepricing.ModeDisplay, 0.02},
		"auto":      {nativepricing.ModeAuto, 0.02},
		"calculate": {nativepricing.ModeCalculate, 0.14},
	} {
		t.Run(name, func(t *testing.T) {
			entries, err := LoadKilo(kiloOptions(t, []string{root}, test.mode, testCorpus(t)))
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 1 {
				t.Fatalf("entries = %+v, want one", entries)
			}
			if math.Abs(entries[0].CostUSD-test.want) > 1e-9 {
				t.Fatalf("cost = %v, want %v", entries[0].CostUSD, test.want)
			}
		})
	}
}

// TestKiloAutoTrustsAnExplicitZeroCost pins cost_usd.unwrap_or_else in auto
// mode: a recorded 0 is a recorded cost, not a missing one, and the row still
// reports missing pricing because the model resolves (parser.rs:225-241).
func TestKiloAutoTrustsAnExplicitZeroCost(t *testing.T) {
	root := t.TempDir()
	seedKiloMessage(t, root, [][3]string{{
		"row-1", "session-a",
		`{"id":"msg-1","role":"assistant","modelID":"deepseek-v4-flash","time":{"created":1767312000000},"tokens":{"input":1000000,"output":0},"cost":0}`,
	}})
	entries, err := LoadKilo(kiloOptions(t, []string{root}, nativepricing.ModeAuto, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].CostUSD != 0 {
		t.Fatalf("entries = %+v, want a trusted zero cost", entries)
	}
	if entries[0].ReportedCost == nil || *entries[0].ReportedCost != 0 {
		t.Fatalf("reported cost = %v, want Some(0)", entries[0].ReportedCost)
	}
}

// TestKiloCacheObjectLenientWhenNotObject pins lenient_object on tokens.cache
// (parser.rs:271-296): a scalar cache yields no cache buckets but keeps the
// record.
func TestKiloCacheObjectLenientWhenNotObject(t *testing.T) {
	root := t.TempDir()
	seedKiloMessage(t, root, [][3]string{{
		"row-1", "session-a",
		`{"id":"msg-1","role":"assistant","modelID":"gpt-5","time":{"created":1767312000000},"tokens":{"input":100,"output":10,"cache":0}}`,
	}})
	entries, err := LoadKilo(kiloOptions(t, []string{root}, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want one", entries)
	}
	if entries[0].Usage.Input != 100 || entries[0].Usage.Output != 10 ||
		entries[0].Usage.CacheCreation != 0 || entries[0].Usage.CacheRead != 0 {
		t.Fatalf("usage = %+v", entries[0].Usage)
	}
}

// TestKiloTimestampSecondsVsMillisHeuristic pins normalize_timestamp
// (parser.rs:174-184): a positive value below 1e12 is seconds and is multiplied
// by 1000; zero or negative drops the row, as does a missing time block.
func TestKiloTimestampSecondsVsMillisHeuristic(t *testing.T) {
	for name, test := range map[string]struct {
		data      string
		wantDate  string
		wantCount int
	}{
		"seconds": {
			`{"id":"m1","role":"assistant","modelID":"gpt-5","time":{"created":1767312000},"tokens":{"input":1}}`,
			"2026-01-02", 1,
		},
		"millis": {
			`{"id":"m2","role":"assistant","modelID":"gpt-5","time":{"created":1767312000000},"tokens":{"input":1}}`,
			"2026-01-02", 1,
		},
		"zero": {
			`{"id":"m3","role":"assistant","modelID":"gpt-5","time":{"created":0},"tokens":{"input":1}}`,
			"", 0,
		},
		"missing": {
			`{"id":"m4","role":"assistant","modelID":"gpt-5","tokens":{"input":1}}`,
			"", 0,
		},
	} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			seedKiloMessage(t, root, [][3]string{{"row-1", "session-a", test.data}})
			entries, err := LoadKilo(kiloOptions(t, []string{root}, nativepricing.ModeDisplay, testCorpus(t)))
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != test.wantCount {
				t.Fatalf("entries = %+v, want %d", entries, test.wantCount)
			}
			if test.wantCount == 1 && entries[0].Date != test.wantDate {
				t.Fatalf("date = %q, want %q", entries[0].Date, test.wantDate)
			}
		})
	}
}

// TestKiloPositiveReportedCostSuppressesMissingPricing pins the first line of
// missing_kilo_pricing (parser.rs:225-241): a positive recorded cost silences the
// diagnostic in every mode, while a recorded zero does not.
func TestKiloPositiveReportedCostSuppressesMissingPricing(t *testing.T) {
	root := t.TempDir()
	seedKiloMessage(t, root, [][3]string{{
		"row-1", "session-a",
		`{"id":"msg-1","role":"assistant","modelID":"definitely-not-a-priced-model","time":{"created":1767312000000},"tokens":{"input":1000},"cost":0.02}`,
	}})
	for name, mode := range map[string]nativepricing.CostMode{
		"calculate": nativepricing.ModeCalculate,
		"auto":      nativepricing.ModeAuto,
		"display":   nativepricing.ModeDisplay,
	} {
		t.Run(name, func(t *testing.T) {
			entries, err := LoadKilo(kiloOptions(t, []string{root}, mode, testCorpus(t)))
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 1 {
				t.Fatalf("entries = %+v, want one", entries)
			}
			if entries[0].MissingPricing {
				t.Fatalf("missing pricing = true, want a positive reported cost to silence it")
			}
		})
	}

	zeroRoot := t.TempDir()
	seedKiloMessage(t, zeroRoot, [][3]string{{
		"row-1", "session-a",
		`{"id":"msg-1","role":"assistant","modelID":"definitely-not-a-priced-model","time":{"created":1767312000000},"tokens":{"input":1000},"cost":0}`,
	}})
	entries, err := LoadKilo(kiloOptions(t, []string{zeroRoot}, nativepricing.ModeAuto, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || !entries[0].MissingPricing {
		t.Fatalf("entries = %+v, want a recorded zero to keep the diagnostic", entries)
	}
}

// TestKiloTotalFallbackUsesReasoningAsExtra pins
// apply_total_token_fallback(usage, reasoning, total) (parser.rs:88-107):
// reasoning seeds the extra bucket before the reported total fills the gap.
func TestKiloTotalFallbackUsesReasoningAsExtra(t *testing.T) {
	root := t.TempDir()
	seedKiloMessage(t, root, [][3]string{
		{"row-1", "session-a", `{"id":"m1","role":"assistant","modelID":"gpt-5","time":{"created":1767312000000},"tokens":{"input":100,"output":50,"reasoning":5,"total":200}}`},
		{"row-2", "session-a", `{"id":"m2","role":"assistant","modelID":"gpt-5","time":{"created":1767312000000},"tokens":{"total":234}}`},
	})
	entries, err := LoadKilo(kiloOptions(t, []string{root}, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want two", entries)
	}
	first := entries[0]
	if first.Usage.Input != 100 || first.Usage.Output != 50 || first.Usage.Extra != 50 {
		t.Fatalf("reasoning usage = %+v, want extra 50", first.Usage)
	}
	second := entries[1]
	if second.Usage.Output != 234 || second.Usage.Extra != 0 {
		t.Fatalf("fallback usage = %+v, want output 234", second.Usage)
	}
}

// TestKiloProviderCandidateRequiresFindExact pins model_candidates
// (parser.rs:243-262): a provider-qualified candidate only joins the chain when
// the pricing table prices it exactly, and the provider is normalized by
// replacing '-' with '_' while "unknown" and "kilo" are skipped.
func TestKiloProviderCandidateRequiresFindExact(t *testing.T) {
	bare := nativepricing.CorpusModel{
		Input: 1e-6, Output: 2e-6, CacheRead: 1e-7, CacheCreate: 1.25e-6,
		FastMultiplier: 1, FlexMultiplier: 1, Source: nativepricing.SourceLiteLLM,
	}
	qualified := nativepricing.CorpusModel{
		Input: 9e-6, Output: 1e-5, CacheRead: 9e-7, CacheCreate: 9e-6,
		FastMultiplier: 1, FlexMultiplier: 1, Source: nativepricing.SourceLiteLLM,
	}
	data := func(provider string) string {
		return `{"id":"m1","role":"assistant","providerID":"` + provider + `","modelID":"acme-large","time":{"created":1767312000000},"tokens":{"input":1000}}`
	}
	for name, test := range map[string]struct {
		provider string
		models   map[string]nativepricing.CorpusModel
		want     float64
	}{
		"exact provider key wins": {
			"acme", map[string]nativepricing.CorpusModel{"acme-large": bare, "acme/acme-large": qualified}, 0.009,
		},
		"missing provider key falls back to the bare model": {
			// The decoy is reachable only through the fuzzy lookup: it must not
			// enter the chain, because model_candidates gates on find_exact.
			"acme", map[string]nativepricing.CorpusModel{
				"acme-large":         bare,
				"acme/acme-large-v2": qualified,
			}, 0.001,
		},
		"provider normalization maps dashes to underscores": {
			"my-provider", map[string]nativepricing.CorpusModel{"acme-large": bare, "my_provider/acme-large": qualified}, 0.009,
		},
		"kilo provider is skipped": {
			"kilo", map[string]nativepricing.CorpusModel{"acme-large": bare, "kilo/acme-large": qualified}, 0.001,
		},
		"unknown provider is skipped": {
			"unknown", map[string]nativepricing.CorpusModel{"acme-large": bare, "unknown/acme-large": qualified}, 0.001,
		},
	} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			seedKiloMessage(t, root, [][3]string{{"row-1", "session-a", data(test.provider)}})
			corpus := nativepricing.Corpus{Models: test.models}
			entries, err := LoadKilo(kiloOptions(t, []string{root}, nativepricing.ModeCalculate, corpus))
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 1 {
				t.Fatalf("entries = %+v, want one", entries)
			}
			if math.Abs(entries[0].CostUSD-test.want) > 1e-12 {
				t.Fatalf("cost = %v, want %v", entries[0].CostUSD, test.want)
			}
		})
	}
}

// TestKiloDedupAcrossDatabasesByMessageID pins the loader's cross-database
// first-wins dedup on data.message.id (loader.rs:26-43): the first configured
// root survives.
func TestKiloDedupAcrossDatabasesByMessageID(t *testing.T) {
	first := t.TempDir()
	second := t.TempDir()
	seedKiloMessage(t, first, [][3]string{
		{"row-1", "session-a", `{"id":"msg-1","role":"assistant","modelID":"gpt-5","time":{"created":1767312000000},"tokens":{"input":10}}`},
	})
	seedKiloMessage(t, second, [][3]string{
		{"row-1", "session-a", `{"id":"msg-1","role":"assistant","modelID":"gpt-5","time":{"created":1767312000000},"tokens":{"input":20}}`},
		{"row-2", "session-b", `{"id":"msg-2","role":"assistant","modelID":"gpt-5","time":{"created":1767312000001},"tokens":{"input":30}}`},
	})
	entries, err := LoadKilo(kiloOptions(t, []string{first, second}, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want two", entries)
	}
	if entries[0].Usage.Input != 10 || entries[1].Usage.Input != 30 {
		t.Fatalf("entries = %+v, want the first root's msg-1 and msg-2", entries)
	}
}

// TestKiloRowIdentityFallback pins the row-level identity fallback
// (parser.rs:115-122): a missing data.id becomes "{dbpath}:{row_id}" and a
// missing data.session_id falls back to the row's session_id column.
func TestKiloRowIdentityFallback(t *testing.T) {
	root := t.TempDir()
	seedKiloMessage(t, root, [][3]string{{
		"row-7", "session-row",
		`{"role":"assistant","modelID":"gpt-5","time":{"created":1767312000000},"tokens":{"input":1}}`,
	}})
	entries, err := LoadKilo(kiloOptions(t, []string{root}, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want one", entries)
	}
	if entries[0].SessionID != "session-row" {
		t.Fatalf("session = %q, want the row column", entries[0].SessionID)
	}
	want := filepath.Join(root, "kilo.db") + ":row-7"
	if entries[0].MessageID != want {
		t.Fatalf("message id = %q, want %q", entries[0].MessageID, want)
	}
	if entries[0].ProjectPath != "Kilo" {
		t.Fatalf("project path = %q", entries[0].ProjectPath)
	}
}

// TestKiloSkipsNonAssistantAndMalformedRows pins the row gates (parser.rs:83-86,
// loader.rs:80-82): non-assistant roles, unparseable payloads and rows without a
// model are dropped without failing the database.
func TestKiloSkipsNonAssistantAndMalformedRows(t *testing.T) {
	root := t.TempDir()
	seedKiloMessage(t, root, [][3]string{
		{"row-1", "s", `{"id":"u1","role":"user","modelID":"gpt-5","time":{"created":1767312000000},"tokens":{"input":100}}`},
		{"row-2", "s", `not-json`},
		{"row-3", "s", `{"id":"m3","role":"assistant","time":{"created":1767312000000},"tokens":{"input":100}}`},
		{"row-4", "s", `{"id":"m4","role":"assistant","modelID":"gpt-5","time":{"created":1767312000000},"tokens":{"input":0}}`},
		{"row-5", "s", `{"id":"m5","role":"assistant","modelID":"gpt-5","time":{"created":1767312000000},"tokens":{"input":7}}`},
	})
	entries, err := LoadKilo(kiloOptions(t, []string{root}, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].MessageID != "m5" {
		t.Fatalf("entries = %+v, want only m5", entries)
	}
}
