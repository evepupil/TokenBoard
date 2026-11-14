package opencode

import (
	"database/sql"
	"encoding/json"
	"io/fs"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

const (
	dbPath    = "/home/user/.local/share/opencode/opencode.db"
	fixtureTZ = "Asia/Shanghai"
	fixtureAt = "2026-05-09T10:00:00.000Z"
	// A real opencode.db row's created timestamp.
	createdMs = 1_779_755_333_700
)

func statPresent(string) (float64, error) { return 1_700_000_000_000, nil }

// usageRow mirrors the field names and value shapes of a real opencode.db row.
func dbRow(overrides map[string]any) map[string]any {
	row := map[string]any{
		"model":            "deepseek-v4-pro",
		"createdMs":        float64(createdMs),
		"inputTokens":      float64(3272),
		"outputTokens":     float64(383),
		"reasoningTokens":  float64(419),
		"cacheReadTokens":  float64(52_480),
		"cacheWriteTokens": float64(0),
		"costUsd":          0.0023113,
		"sessionId":        "ses_05c01faf7ffe6zgGkvn1d44SbX",
	}
	for key, value := range overrides {
		row[key] = value
	}
	return row
}

func runCollect(t *testing.T, rows []map[string]any, mutate func(*Options)) ([]contract.Snapshot, error) {
	t.Helper()
	options := Options{
		DBPath:      dbPath,
		StatFile:    statPresent,
		Timezone:    fixtureTZ,
		CollectedAt: fixtureAt,
		Since:       "all",
		RunQuery: func(string, string) (string, error) {
			encoded, err := json.Marshal(rows)
			if err != nil {
				t.Fatal(err)
			}
			return string(encoded), nil
		},
	}
	if mutate != nil {
		mutate(&options)
	}
	return Collect(options)
}

func mustCollect(t *testing.T, rows []map[string]any, mutate func(*Options)) []contract.Snapshot {
	t.Helper()
	snapshots, err := runCollect(t, rows, mutate)
	if err != nil {
		t.Fatal(err)
	}
	return snapshots
}

func TestNormalizesMessageRowIntoDailySnapshot(t *testing.T) {
	snapshots := mustCollect(t, []map[string]any{dbRow(nil)}, nil)

	want := contract.Snapshot{
		Source:        contract.SourceOpenCode,
		UsageDate:     "2026-05-26",
		Timezone:      fixtureTZ,
		Model:         "deepseek-v4-pro",
		InputTokens:   3272,
		OutputTokens:  802, // 383 output + 419 reasoning: reasoning is billed as output.
		CacheCreation: 0,
		CacheRead:     52_480,
		TotalTokens:   56_554,
		CostUSD:       0.0023113,
		SessionCount:  1,
		CollectedAt:   fixtureAt,
	}
	if len(snapshots) != 1 || snapshots[0] != want {
		t.Errorf("snapshots = %+v, want %+v", snapshots, want)
	}
}

func TestKeepsInputFreshSoTotalsStayDisjoint(t *testing.T) {
	snapshot := mustCollect(t, []map[string]any{dbRow(map[string]any{
		"inputTokens": 1000, "outputTokens": 200, "reasoningTokens": 0,
		"cacheReadTokens": 5000, "cacheWriteTokens": 300,
	})}, nil)[0]

	if snapshot.InputTokens != 1000 || snapshot.TotalTokens != 6500 {
		t.Errorf("snapshot = %+v, want 1000 input / 6500 total", snapshot)
	}
	if snapshot.CacheRead > snapshot.TotalTokens {
		t.Errorf("cacheRead %d exceeds total %d", snapshot.CacheRead, snapshot.TotalTokens)
	}
}

func TestAggregatesRowsByDateAndModelCountingDistinctSessions(t *testing.T) {
	snapshots := mustCollect(t, []map[string]any{
		dbRow(map[string]any{"sessionId": "ses_a"}),
		dbRow(map[string]any{"sessionId": "ses_b", "inputTokens": 1000, "outputTokens": 10,
			"reasoningTokens": 0, "cacheReadTokens": 0}),
		dbRow(map[string]any{"sessionId": "ses_a", "model": "other-model", "cacheReadTokens": 0}),
	}, nil)

	if len(snapshots) != 2 {
		t.Fatalf("snapshots = %+v, want 2", snapshots)
	}
	for _, snapshot := range snapshots {
		switch snapshot.Model {
		case "deepseek-v4-pro":
			if snapshot.InputTokens != 4272 || snapshot.SessionCount != 2 {
				t.Errorf("primary = %+v, want 4272 input across 2 sessions", snapshot)
			}
		case "other-model":
			if snapshot.SessionCount != 1 {
				t.Errorf("other-model sessionCount = %d, want 1", snapshot.SessionCount)
			}
		default:
			t.Errorf("unexpected model %q", snapshot.Model)
		}
	}
}

func TestSplitsUsageAcrossLocalDatesUsingTheConfiguredTimezone(t *testing.T) {
	// 2026-05-27T17:30:00Z is still 2026-05-27 in UTC but already 2026-05-28
	// in Shanghai.
	at := float64(1_779_903_000_000)

	shanghai := mustCollect(t, []map[string]any{dbRow(map[string]any{"createdMs": at})}, nil)
	if shanghai[0].UsageDate != "2026-05-28" {
		t.Errorf("shanghai usageDate = %q, want 2026-05-28", shanghai[0].UsageDate)
	}

	utc := mustCollect(t, []map[string]any{dbRow(map[string]any{"createdMs": at})},
		func(o *Options) { o.Timezone = "UTC" })
	if utc[0].UsageDate != "2026-05-27" {
		t.Errorf("utc usageDate = %q, want 2026-05-27", utc[0].UsageDate)
	}
}

func TestSkipsRowsWithoutUsableTokenMetadata(t *testing.T) {
	var skipped []string
	snapshots := mustCollect(t, []map[string]any{
		dbRow(map[string]any{"inputTokens": 0, "outputTokens": 0, "reasoningTokens": 0,
			"cacheReadTokens": 0, "cacheWriteTokens": 0}),
		dbRow(map[string]any{"createdMs": nil}),
		dbRow(map[string]any{"createdMs": float64(0)}),
	}, func(o *Options) {
		o.Stderr = func(line string) { skipped = append(skipped, line) }
	})

	if len(snapshots) != 0 {
		t.Errorf("snapshots = %+v, want none", snapshots)
	}
	if len(skipped) != 1 || !strings.Contains(skipped[0], "Skipped 3 OpenCode message rows") {
		t.Errorf("skipped = %v", skipped)
	}
}

func TestFallsBackToPlaceholderModelAndBoundsLongIds(t *testing.T) {
	missing := mustCollect(t, []map[string]any{dbRow(map[string]any{"model": nil})}, nil)
	if missing[0].Model != "unknown" {
		t.Errorf("null model = %q, want unknown", missing[0].Model)
	}

	blank := mustCollect(t, []map[string]any{dbRow(map[string]any{"model": "   "})}, nil)
	if blank[0].Model != "unknown" {
		t.Errorf("blank model = %q, want unknown", blank[0].Model)
	}

	long := mustCollect(t, []map[string]any{dbRow(map[string]any{"model": strings.Repeat("m", 400)})}, nil)
	if len([]rune(long[0].Model)) != 160 {
		t.Errorf("long model length = %d, want 160", len([]rune(long[0].Model)))
	}
}

func TestTreatsNegativeCountsAndCostsAsZero(t *testing.T) {
	snapshot := mustCollect(t, []map[string]any{dbRow(map[string]any{
		"inputTokens": -5, "cacheWriteTokens": -1, "costUsd": -2,
	})}, nil)[0]

	if snapshot.InputTokens != 0 || snapshot.CacheCreation != 0 || snapshot.CostUSD != 0 {
		t.Errorf("snapshot = %+v, want zeroed negatives", snapshot)
	}
}

func TestAppliesSinceWindowOnLocalDates(t *testing.T) {
	rows := []map[string]any{
		dbRow(map[string]any{"createdMs": float64(1_779_242_400_000)}), // 2026-05-20T02:00:00Z
		dbRow(map[string]any{"createdMs": float64(1_779_847_200_000)}), // 2026-05-27T02:00:00Z
	}

	if got := mustCollect(t, rows, func(o *Options) { o.Since = "2026-05-25" }); len(got) != 1 {
		t.Errorf("dashed since = %d snapshots, want 1", len(got))
	}
	if got := mustCollect(t, rows, func(o *Options) { o.Since = "20260525" }); len(got) != 1 {
		t.Errorf("compact since = %d snapshots, want 1", len(got))
	}
	if got := mustCollect(t, rows, func(o *Options) { o.Since = "all" }); len(got) != 2 {
		t.Errorf("since all = %d snapshots, want 2", len(got))
	}
	_, err := runCollect(t, rows, func(o *Options) { o.Since = "last-week" })
	if err == nil || !strings.Contains(err.Error(), "Invalid OpenCode since value") {
		t.Errorf("invalid since error = %v", err)
	}
}

func TestReportsMissingDatabaseInsteadOfEmptyUsage(t *testing.T) {
	_, err := Collect(Options{
		DBPath:   dbPath,
		StatFile: func(string) (float64, error) { return 0, &fs.PathError{Op: "stat", Path: dbPath, Err: fs.ErrNotExist} },
		RunQuery: func(string, string) (string, error) { return "[]", nil },
	})
	if err == nil || !strings.Contains(err.Error(), "OpenCode database not found: "+dbPath) {
		t.Errorf("err = %v, want 'OpenCode database not found: %s'", err, dbPath)
	}
}

func TestReportsDatabaseRemovedBetweenExistenceCheckAndOpen(t *testing.T) {
	root := t.TempDir()
	missingDB := filepath.Join(root, "opencode.db")

	// The stat claims the file is there; the reader then finds nothing to open.
	_, err := Collect(Options{
		DBPath:      missingDB,
		StatFile:    func(string) (float64, error) { return 1, nil },
		Timezone:    fixtureTZ,
		CollectedAt: fixtureAt,
		Since:       "all",
	})
	if err == nil || !strings.Contains(err.Error(), "OpenCode database not found: "+missingDB) {
		t.Errorf("err = %v, want database-not-found for %s", err, missingDB)
	}
}

func TestTreatsAnEmptyResultAsNoUsage(t *testing.T) {
	if got := mustCollect(t, []map[string]any{}, nil); len(got) != 0 {
		t.Errorf("empty rows = %+v, want none", got)
	}
	got := mustCollect(t, nil, func(o *Options) {
		o.RunQuery = func(string, string) (string, error) { return "  ", nil }
	})
	if len(got) != 0 {
		t.Errorf("blank output = %+v, want none", got)
	}
}

func TestNeverSelectsTheMessageBlobHoldingPromptsAndPaths(t *testing.T) {
	var executedSQL string
	mustCollect(t, []map[string]any{}, func(o *Options) {
		o.RunQuery = func(_ string, sql string) (string, error) {
			executedSQL = sql
			return "[]", nil
		}
	})

	if !strings.Contains(executedSQL, "json_extract(m.data") {
		t.Error("SQL does not project through json_extract")
	}
	// The only m.data reference may be inside a json_extract path expression;
	// selecting the blob itself would carry prompts and local paths forward.
	selection := regexp.MustCompile(`(?s)SELECT(.*)FROM`)
	if match := selection.FindStringSubmatch(executedSQL); match != nil {
		for _, line := range strings.Split(match[1], "\n") {
			trimmed := strings.TrimSpace(line)
			if !strings.Contains(trimmed, "json_extract(m.data") && strings.Contains(trimmed, "m.data") {
				t.Errorf("select list reads the blob directly: %q", trimmed)
			}
		}
	}
	for _, field := range []string{"$.path", "$.content", "$.parentID", "$.agent"} {
		if strings.Contains(executedSQL, field) {
			t.Errorf("SQL selects %s", field)
		}
	}
}

func TestReadsTheWALSidecarSoCheckpointLaggingWritesAreSeen(t *testing.T) {
	var statted []string
	mustCollect(t, []map[string]any{}, func(o *Options) {
		o.StatFile = func(path string) (float64, error) {
			statted = append(statted, path)
			if strings.HasSuffix(path, "-shm") {
				return 0, &fs.PathError{Op: "stat", Path: path, Err: fs.ErrNotExist}
			}
			return 1, nil
		}
	})

	joined := strings.Join(statted, "\n")
	if !strings.Contains(joined, dbPath) || !strings.Contains(joined, dbPath+"-wal") {
		t.Errorf("statted = %v, want the database and its -wal", statted)
	}
}

// Both readers must agree, so the fallback cannot drift from the default.
// Modernc's driver stands in for node:sqlite, and the real sqlite3 executable
// for the fallback; when no executable is installed the external half is
// skipped rather than faked.
func TestReadsThroughTheEmbeddedDriverAndTheExecutableIdentically(t *testing.T) {
	sqliteBin, err := exec.LookPath("sqlite3")
	if err != nil {
		t.Skip("sqlite3 executable not installed; the external reader is covered by its own error case")
	}

	root := t.TempDir()
	realDB := filepath.Join(root, "opencode.db")
	seedDatabase(t, realDB)

	base := Options{
		DBPath:      realDB,
		Timezone:    fixtureTZ,
		CollectedAt: fixtureAt,
		Since:       "all",
		SQLiteBin:   &sqliteBin,
	}
	embedded, err := Collect(base)
	if err != nil {
		t.Fatal(err)
	}
	external, err := Collect(Options{
		DBPath: base.DBPath, Timezone: base.Timezone, CollectedAt: base.CollectedAt,
		Since: base.Since, SQLiteBin: &sqliteBin, ForceExternalSQLite: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	if len(embedded) != 1 || len(external) != 1 {
		t.Fatalf("embedded = %+v, external = %+v", embedded, external)
	}
	if embedded[0] != external[0] {
		t.Errorf("readers disagree\n embedded: %+v\n external: %+v", embedded[0], external[0])
	}
	if embedded[0].InputTokens != 3272 || embedded[0].OutputTokens != 802 {
		t.Errorf("snapshot = %+v, want 3272 input / 802 output", embedded[0])
	}
	if embedded[0].CostUSD < 0.0023113-1e-12 || embedded[0].CostUSD > 0.0023113+1e-12 {
		t.Errorf("costUsd = %v, want 0.0023113", embedded[0].CostUSD)
	}
}

func TestReportsTheExecutableAsUnavailableWhenItIsMissing(t *testing.T) {
	missing := "tokenboard-sqlite3-does-not-exist"
	_, err := Collect(Options{
		DBPath:              dbPath,
		StatFile:            statPresent,
		Since:               "all",
		ForceExternalSQLite: true,
		SQLiteBin:           &missing,
	})
	if err == nil || !strings.Contains(err.Error(), "OpenCode SQLite reader unavailable") {
		t.Errorf("err = %v, want 'OpenCode SQLite reader unavailable'", err)
	}
}

// seedDatabase writes a real opencode.db: the message blob carries a prompt
// path alongside the token fields, so a reader that selected the blob would
// show it here.
func seedDatabase(t *testing.T, realDB string) {
	t.Helper()
	database, err := sql.Open("sqlite", "file:"+filepath.ToSlash(realDB))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	payload, err := json.Marshal(map[string]any{
		"role": "assistant",
		"cost": 0.0023113,
		"tokens": map[string]any{
			"input": 3272, "output": 383, "reasoning": 419,
			"cache": map[string]any{"read": 52_480, "write": 0},
		},
		"modelID": "deepseek-v4-pro",
		"path":    "/home/user/secret/project",
		"time":    map[string]any{"created": createdMs, "completed": createdMs + 17_000},
	})
	if err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)`,
		`INSERT INTO message VALUES ('m1', 'ses_a', 1, json(?))`,
		`CREATE TABLE unused (id INTEGER)`,
	}
	if _, err := database.Exec(statements[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(statements[1], string(payload)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(statements[2]); err != nil {
		t.Fatal(err)
	}
}

// TS's opencode `toSnapshot` ends in `usageSnapshotSchema.parse`, so a folded row
// beyond the contract fails this one source. The Go aggregate is the only gate
// between a corrupted message row and the upload batch: without it the server
// rejects the whole request as a non-transient failure.
func TestCollectFailsClosedWhenFoldedRowsExceedTheContract(t *testing.T) {
	_, err := runCollect(t, []map[string]any{dbRow(map[string]any{"inputTokens": 1e30})}, nil)
	if err == nil {
		t.Fatal("Collect accepted rows the server would reject")
	}
}

// An ordinary row still produces a snapshot; the gate is not over-eager.
func TestCollectStillReturnsValidSnapshots(t *testing.T) {
	snapshots := mustCollect(t, []map[string]any{dbRow(nil)}, nil)
	if len(snapshots) != 1 {
		t.Fatalf("got %d snapshots, want 1", len(snapshots))
	}
}
