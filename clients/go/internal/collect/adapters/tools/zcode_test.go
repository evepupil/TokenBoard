package tools

// The ZCode adapter's rules, pinned against ccusage v20.0.33 (commit 1308c416):
// rust/adapters/zcode/src/{paths,parser,loader}.rs.

import (
	"database/sql"
	"math"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// zcodeCurrentSchema is the session-versioned layout (loader.rs:341-352).
const zcodeCurrentSchema = `CREATE TABLE model_usage (
	id TEXT PRIMARY KEY, session_id TEXT, started_at INTEGER, model_id TEXT,
	provider_id TEXT, status TEXT, input_tokens INTEGER, output_tokens INTEGER,
	cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
	computed_total_tokens INTEGER)`

const zcodeCurrentSession = `CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, version TEXT)`

// zcodeLegacySchema drops every optional column (loader.rs:327-340).
const zcodeLegacySchema = `CREATE TABLE model_usage (
	id TEXT PRIMARY KEY, session_id TEXT, started_at INTEGER, model_id TEXT,
	status TEXT, input_tokens INTEGER, output_tokens INTEGER,
	cache_read_input_tokens INTEGER, computed_total_tokens INTEGER)`

const zcodeLegacySession = `CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)`

// zcodeOptions builds Options with ZCODE_HOME (when env is non-nil) and a
// caller-chosen home directory.
func zcodeOptions(t *testing.T, home string, env *string, mode nativepricing.CostMode, corpus nativepricing.Corpus) Options {
	t.Helper()
	return Options{
		Env: func(key string) (string, bool) {
			if key == "ZCODE_HOME" && env != nil {
				return *env, true
			}
			return "", false
		},
		HomeDir:  func() (string, error) { return home, nil },
		Timezone: "UTC",
		Mode:     mode,
		Corpus:   corpus,
	}
}

// seedZcodeDatabase writes <root>/cli/db/db.sqlite and runs the statements.
func seedZcodeDatabase(t *testing.T, root string, statements ...string) {
	t.Helper()
	dir := filepath.Join(root, "cli", "db")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(dir, "db.sqlite")))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	for _, statement := range statements {
		if _, err := database.Exec(statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
}

func zcodeDefaultHome(t *testing.T) string {
	t.Helper()
	return t.TempDir()
}

// TestZcodeFreshInputSubtractsCache pins row_to_entry's bucket split
// (parser.rs:42-56): cache_read is clamped to input, cache_creation to what is
// left, and only the fresh remainder stays as input.
func TestZcodeFreshInputSubtractsCache(t *testing.T) {
	root := t.TempDir()
	seedZcodeDatabase(t, root,
		zcodeCurrentSchema, zcodeCurrentSession,
		`INSERT INTO session VALUES ('session-1', '/workspace/project', '0.16.3')`,
		`INSERT INTO model_usage VALUES ('usage-1','session-1',1786909042666,'GLM-5.3','builtin:zai-coding-plan','completed',100,10,15,25,110)`,
		`INSERT INTO model_usage VALUES ('usage-2','session-1',1786909042666,'GLM-5.3','builtin:zai-coding-plan','running',100,10,15,25,110)`,
	)
	entries, err := LoadZcode(zcodeOptions(t, zcodeDefaultHome(t), &root, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want only the completed row", entries)
	}
	entry := entries[0]
	if entry.Usage.Input != 60 || entry.Usage.Output != 10 ||
		entry.Usage.CacheCreation != 15 || entry.Usage.CacheRead != 25 || entry.Usage.Extra != 0 {
		t.Fatalf("usage = %+v, want the fresh input split", entry.Usage)
	}
	if entry.SessionID != "session-1" || entry.MessageID != "usage-1" || entry.Model != "GLM-5.3" {
		t.Fatalf("entry = %+v", entry)
	}
	if entry.ProjectPath != "/workspace/project" || entry.Version != "0.16.3" || entry.Date != "2026-08-16" {
		t.Fatalf("entry = %+v", entry)
	}
	if entry.CostUSD != 0 || entry.MissingPricing {
		t.Fatalf("display cost = %v missing = %v, want zero and no missing", entry.CostUSD, entry.MissingPricing)
	}
}

// TestZcodeMissingRequiredColumnSkipsDatabase pins read_schema (loader.rs:194-258):
// a table missing a required column skips the whole database without an error.
func TestZcodeMissingRequiredColumnSkipsDatabase(t *testing.T) {
	root := t.TempDir()
	seedZcodeDatabase(t, root,
		`CREATE TABLE model_usage (id TEXT PRIMARY KEY, session_id TEXT, started_at INTEGER, model_id TEXT, input_tokens INTEGER, output_tokens INTEGER)`,
		zcodeLegacySession,
		`INSERT INTO session VALUES ('session-1', '/project')`,
		`INSERT INTO model_usage VALUES ('usage-1','session-1',1786909042666,'GLM-5.3',100,10)`,
	)
	entries, err := LoadZcode(zcodeOptions(t, zcodeDefaultHome(t), &root, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("entries = %+v, want none for an unsupported schema", entries)
	}
}

// TestZcodeComputedTotalFallsBackToInputPlusOutput pins the optional
// computed_total_tokens column (loader.rs:142-146): without it the SQL total is
// input + output, and a reported total above the buckets lands in extra.
func TestZcodeComputedTotalFallsBackToInputPlusOutput(t *testing.T) {
	legacyRoot := t.TempDir()
	seedZcodeDatabase(t, legacyRoot,
		zcodeLegacySchema, zcodeLegacySession,
		`INSERT INTO session VALUES ('session-legacy', '')`,
		`INSERT INTO model_usage VALUES ('usage-legacy','session-legacy',1786909042666,'custom-model','completed',100,10,25,110)`,
	)
	entries, err := LoadZcode(zcodeOptions(t, zcodeDefaultHome(t), &legacyRoot, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want one", entries)
	}
	if entries[0].Usage.Input != 75 || entries[0].Usage.CacheRead != 25 || entries[0].Usage.Extra != 0 {
		t.Fatalf("legacy usage = %+v, want the computed fallback to add no extra", entries[0].Usage)
	}
	if entries[0].ProjectPath != "ZCode" {
		t.Fatalf("project path = %q, want the fixed literal", entries[0].ProjectPath)
	}

	extraRoot := t.TempDir()
	seedZcodeDatabase(t, extraRoot,
		zcodeCurrentSchema, zcodeCurrentSession,
		`INSERT INTO session VALUES ('session-1', '/project', '0.16.3')`,
		`INSERT INTO model_usage VALUES ('usage-1','session-1',1786909042666,'GLM-5.3','builtin:zai-coding-plan','completed',100,10,15,25,123)`,
	)
	entries, err = LoadZcode(zcodeOptions(t, zcodeDefaultHome(t), &extraRoot, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Usage.Extra != 13 || entries[0].Usage.Output != 10 {
		t.Fatalf("entries = %+v, want 13 extra tokens", entries)
	}
}

// TestZcodeUnknownProviderIsNotZai pins pricing_model/pricing_candidates
// (parser.rs:143-201): an opaque custom provider suppresses pricing entirely,
// while a Z.ai plan id (or a missing provider naming a GLM model) prices
// through the zai/ prefix.
func TestZcodeUnknownProviderIsNotZai(t *testing.T) {
	rows := map[string]struct {
		provider string
		model    string
		wantCost float64
		wantMiss bool
	}{
		"custom provider": {
			"847d13c9-0568-4f2f-818e-8bd498e5d920", "deepseek-v4-flash", 0, true,
		},
		"zai plan provider": {
			"builtin:zai-coding-plan", "GLM-5.3", 0.0001555, false,
		},
		"missing provider with a GLM model": {
			"", "glm-5.3", 0.0001555, false,
		},
		"missing provider with a non-GLM model": {
			"", "definitely-not-a-model", 0, true,
		},
	}
	for name, test := range rows {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			provider := "NULL"
			if test.provider != "" {
				provider = "'" + test.provider + "'"
			}
			seedZcodeDatabase(t, root,
				zcodeCurrentSchema, zcodeCurrentSession,
				`INSERT INTO session VALUES ('session-1', '/project', '0.16.3')`,
				`INSERT INTO model_usage VALUES ('usage-1','session-1',1786909042666,'`+test.model+`',`+provider+`,'completed',100,10,15,25,110)`,
			)
			entries, err := LoadZcode(zcodeOptions(t, zcodeDefaultHome(t), &root, nativepricing.ModeCalculate, testCorpus(t)))
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 1 {
				t.Fatalf("entries = %+v, want one", entries)
			}
			if math.Abs(entries[0].CostUSD-test.wantCost) > 1e-12 {
				t.Fatalf("cost = %v, want %v", entries[0].CostUSD, test.wantCost)
			}
			if entries[0].MissingPricing != test.wantMiss {
				t.Fatalf("missing = %v, want %v", entries[0].MissingPricing, test.wantMiss)
			}
		})
	}
}

// TestZcodeUserOverrideBeatsTheCustomProviderGuard pins pricing_model's
// ordering (parser.rs:161-171): the candidate-override check runs before the
// "unknown provider is not Z.ai" guard, so a custom provider id with a
// pricingOverrides record still bills at the override's rate instead of
// reporting missing pricing.
func TestZcodeUserOverrideBeatsTheCustomProviderGuard(t *testing.T) {
	root := t.TempDir()
	seedZcodeDatabase(t, root,
		zcodeCurrentSchema, zcodeCurrentSession,
		`INSERT INTO session VALUES ('session-1', '/project', '0.16.3')`,
		`INSERT INTO model_usage VALUES ('usage-1','session-1',1786909042666,'deepseek-v4-flash','custom-provider-id','completed',1000000,0,0,0,1000000)`,
	)
	corpus := testCorpus(t)
	overridden, err := corpus.WithOverrides(map[string]any{
		"deepseek-v4-flash": map[string]any{
			"inputCostPerToken":  9e-6,
			"outputCostPerToken": 10e-6,
		},
	})
	if err != nil {
		t.Fatalf("WithOverrides: %v", err)
	}
	entries, err := LoadZcode(zcodeOptions(t, zcodeDefaultHome(t), &root, nativepricing.ModeCalculate, overridden))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want one", entries)
	}
	if entries[0].MissingPricing {
		t.Fatal("a row whose candidate carries a user override must be priced")
	}
	// The override only moves the base rate; this model's above-200k band keeps
	// the scheduled rate, so the exact total is not the flat 1M x override.
	// Rust's own fixture asserts the same weaker property (cost > 0.0 with no
	// missing_pricing_model): parser.rs "honors_raw_model_overrides_for_custom_providers".
	if got := entries[0].CostUSD; !(got > 0) {
		t.Fatalf("cost = %v, want a positive cost from the override", got)
	}
}

// TestZcodeBillsZaiCacheCreationAsInput pins the Z.ai cost adjustment
// (parser.rs:75-93): the display keeps the cache-creation bucket, but the
// billed usage folds it into input at the standard input rate.
func TestZcodeBillsZaiCacheCreationAsInput(t *testing.T) {
	root := t.TempDir()
	seedZcodeDatabase(t, root,
		zcodeCurrentSchema, zcodeCurrentSession,
		`INSERT INTO session VALUES ('session-1', '/project', '0.16.3')`,
		// 60 fresh + 15 cache creation bill as 75 input; 25 cache read and 10
		// output add their own rates.
		`INSERT INTO model_usage VALUES ('usage-1','session-1',1786909042666,'GLM-5.3','builtin:zai-coding-plan','completed',100,10,15,25,110)`,
	)
	entries, err := LoadZcode(zcodeOptions(t, zcodeDefaultHome(t), &root, nativepricing.ModeCalculate, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want one", entries)
	}
	if entries[0].Usage.Input != 60 || entries[0].Usage.CacheCreation != 15 {
		t.Fatalf("display usage = %+v, want the buckets preserved", entries[0].Usage)
	}
	if math.Abs(entries[0].CostUSD-0.0001555) > 1e-12 {
		t.Fatalf("cost = %v, want cache creation billed as input", entries[0].CostUSD)
	}
}

// TestZcodeOpensReadOnlyWithoutChangingJournalMode pins the connection setup
// (loader.rs:100-113): the database is opened read-only and its journal mode is
// never rewritten.
func TestZcodeOpensReadOnlyWithoutChangingJournalMode(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "cli", "db")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "db.sqlite")
	database, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`PRAGMA journal_mode = WAL`,
		zcodeCurrentSchema, zcodeCurrentSession,
		`INSERT INTO session VALUES ('session-1', '/project', '0.16.3')`,
		`INSERT INTO model_usage VALUES ('usage-1','session-1',1786909042666,'GLM-5.3','builtin:zai-coding-plan','completed',100,10,15,25,110)`,
	} {
		if _, err := database.Exec(statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	entries, err := LoadZcode(zcodeOptions(t, zcodeDefaultHome(t), &root, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want the WAL database to be readable", entries)
	}

	verify, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	defer verify.Close()
	var journalMode string
	if err := verify.QueryRow(`PRAGMA journal_mode`).Scan(&journalMode); err != nil {
		t.Fatal(err)
	}
	if journalMode != "wal" {
		t.Fatalf("journal_mode = %q, want the source mode untouched", journalMode)
	}
	var count int
	if err := verify.QueryRow(`SELECT COUNT(*) FROM model_usage`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("rows = %d, want the source rows untouched", count)
	}
}

// TestZcodeDedupAcrossDatabasesByModelUsageID pins the loader's first-wins
// dedup on model_usage.id across roots (loader.rs:65-81).
func TestZcodeDedupAcrossDatabasesByModelUsageID(t *testing.T) {
	first := t.TempDir()
	second := t.TempDir()
	seedZcodeDatabase(t, first,
		zcodeCurrentSchema, zcodeCurrentSession,
		`INSERT INTO session VALUES ('session-1', '/project', '0.16.3')`,
		`INSERT INTO model_usage VALUES ('usage-1','session-1',1786909042666,'GLM-5.3','builtin:zai-coding-plan','completed',100,10,0,0,110)`,
	)
	seedZcodeDatabase(t, second,
		zcodeCurrentSchema, zcodeCurrentSession,
		`INSERT INTO session VALUES ('session-1', '/project', '0.16.3')`,
		`INSERT INTO model_usage VALUES ('usage-1','session-1',1786909042666,'GLM-5.3','builtin:zai-coding-plan','completed',200,10,0,0,210)`,
		`INSERT INTO model_usage VALUES ('usage-2','session-1',1786909043666,'GLM-5.3','builtin:zai-coding-plan','completed',50,5,0,0,55)`,
	)
	roots := first + "," + second
	entries, err := LoadZcode(zcodeOptions(t, zcodeDefaultHome(t), &roots, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want two", entries)
	}
	if entries[0].MessageID != "usage-1" || entries[0].Usage.Input != 100 {
		t.Fatalf("entries = %+v, want the first root's usage-1", entries)
	}
	if entries[1].MessageID != "usage-2" {
		t.Fatalf("entries = %+v, want usage-2 second", entries)
	}
}

// TestZcodeConfiguredRootsDoNotFallBack pins paths() (paths.rs:12-25): a
// non-empty ZCODE_HOME that names no valid root yields nothing even when the
// default home has a database, while a set-but-empty value falls back.
func TestZcodeConfiguredRootsDoNotFallBack(t *testing.T) {
	home := t.TempDir()
	seedZcodeDatabase(t, filepath.Join(home, ".zcode"),
		zcodeCurrentSchema, zcodeCurrentSession,
		`INSERT INTO session VALUES ('session-1', '/project', '0.16.3')`,
		`INSERT INTO model_usage VALUES ('usage-1','session-1',1786909042666,'GLM-5.3','builtin:zai-coding-plan','completed',100,10,0,0,110)`,
	)
	missing := filepath.Join(home, "missing")
	entries, err := LoadZcode(zcodeOptions(t, home, &missing, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("entries = %+v, want no fallback to the default home", entries)
	}

	empty := ""
	entries, err = LoadZcode(zcodeOptions(t, home, &empty, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want the default home to answer", entries)
	}
}

// TestZcodeSessionRowsCarryActivityAndDirectory pins the rich session metadata
// (parser.rs:70-141 with SessionAccumulator, summary.rs:126-170): the session
// row's projectPath is the nearest-to-last entry's directory and
// first/lastActivity span the entries.
func TestZcodeSessionRowsCarryActivityAndDirectory(t *testing.T) {
	root := t.TempDir()
	seedZcodeDatabase(t, root,
		zcodeCurrentSchema, zcodeCurrentSession,
		`INSERT INTO session VALUES ('session-1', '/workspace/project', '0.16.3')`,
		`INSERT INTO model_usage VALUES ('usage-1','session-1',1786909042666,'GLM-5.3','builtin:zai-coding-plan','completed',100,10,0,0,110)`,
		`INSERT INTO model_usage VALUES ('usage-2','session-1',1786909100000,'GLM-5.3','builtin:zai-coding-plan','completed',50,5,0,0,55)`,
	)
	entries, err := LoadZcode(zcodeOptions(t, zcodeDefaultHome(t), &root, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want two", entries)
	}
	rows, _ := Summarize(entries, Session)
	if len(rows) != 1 {
		t.Fatalf("rows = %+v, want one session row", rows)
	}
	row := rows[0]
	if row.Key != "session-1" || row.ProjectPath != "/workspace/project" {
		t.Fatalf("row = %+v", row)
	}
	if row.FirstActivity != 1786909042666 || row.LastActivity != 1786909100000 {
		t.Fatalf("activity = %d..%d, want the entry span", row.FirstActivity, row.LastActivity)
	}
}

// TestZcodeClampsCacheBucketsToInput pins the saturating clamps
// (parser.rs:42-52): cache read may not exceed input, and cache creation only
// claims what cache read left.
func TestZcodeClampsCacheBucketsToInput(t *testing.T) {
	root := t.TempDir()
	seedZcodeDatabase(t, root,
		zcodeCurrentSchema, zcodeCurrentSession,
		`INSERT INTO session VALUES ('session-1', '/project', '0.16.3')`,
		`INSERT INTO model_usage VALUES ('usage-1','session-1',1786909042666,'GLM-5.3',NULL,'completed',100,10,500,500,110)`,
	)
	entries, err := LoadZcode(zcodeOptions(t, zcodeDefaultHome(t), &root, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want one", entries)
	}
	if entries[0].Usage.Input != 0 || entries[0].Usage.CacheRead != 100 || entries[0].Usage.CacheCreation != 0 {
		t.Fatalf("usage = %+v, want both buckets clamped to input", entries[0].Usage)
	}
}

// TestZcodeOutOfRangeRealTimestampDropsTheRow pins read_timestamp_ms
// (loader.rs:311-316): a REAL beyond the i64 range is rejected, so the row is
// skipped. Go's float-to-int conversion saturates instead, which would keep a
// 1e20-millisecond row and date it in year 3,170,887.
func TestZcodeOutOfRangeRealTimestampDropsTheRow(t *testing.T) {
	root := t.TempDir()
	schema := `CREATE TABLE model_usage (
	id TEXT PRIMARY KEY, session_id TEXT, started_at REAL, model_id TEXT,
	provider_id TEXT, status TEXT, input_tokens INTEGER, output_tokens INTEGER,
	cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
	computed_total_tokens INTEGER)`
	seedZcodeDatabase(t, root,
		schema, zcodeCurrentSession,
		`INSERT INTO session VALUES ('session-1', '/project', NULL)`,
		`INSERT INTO model_usage VALUES ('ok','session-1',1786909042666.0,'GLM-5.3','zai','completed',100,0,0,0,100)`,
		`INSERT INTO model_usage VALUES ('far','session-1',1e20,'GLM-5.3','zai','completed',100,0,0,0,100)`,
		`INSERT INTO model_usage VALUES ('near','session-1',1e19,'GLM-5.3','zai','completed',100,0,0,0,100)`,
	)
	entries, err := LoadZcode(zcodeOptions(t, zcodeDefaultHome(t), &root, nativepricing.ModeDisplay, testCorpus(t)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].MessageID != "ok" {
		t.Fatalf("entries = %+v, want only the in-range row", entries)
	}
}
