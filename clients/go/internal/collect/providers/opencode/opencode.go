// Package opencode ports providers/opencode.ts: collecting OpenCode usage
// from its local SQLite database.
//
// OpenCode aggregates per-session totals on the session table, but those
// totals carry no date breakdown, so per-message rows are read and attributed
// to a local date instead.
package opencode

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sqlite"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

const (
	source = contract.SourceOpenCode
	label  = "OpenCode"
)

// UsageRowsSQL projects the token and cost columns out of message.data.
//
// Only these fields leave SQLite. message.data also holds the prompt, the
// assistant reply and a local path, so the query never selects the blob
// itself.
const UsageRowsSQL = `
SELECT
  json_extract(m.data, '$.modelID')            AS model,
  json_extract(m.data, '$.time.created')       AS createdMs,
  json_extract(m.data, '$.tokens.input')       AS inputTokens,
  json_extract(m.data, '$.tokens.output')      AS outputTokens,
  json_extract(m.data, '$.tokens.reasoning')   AS reasoningTokens,
  json_extract(m.data, '$.tokens.cache.read')  AS cacheReadTokens,
  json_extract(m.data, '$.tokens.cache.write') AS cacheWriteTokens,
  json_extract(m.data, '$.cost')               AS costUsd,
  m.session_id                                 AS sessionId
FROM message m
WHERE json_extract(m.data, '$.role') = 'assistant'
  AND json_extract(m.data, '$.tokens') IS NOT NULL
  AND json_extract(m.data, '$.time.completed') IS NOT NULL
  AND json_extract(m.data, '$.time.created') IS NOT NULL
ORDER BY createdMs
`

// Options configures one collection. Zero values fall back to the environment
// and the clock.
type Options struct {
	Timezone    string
	CollectedAt string
	Since       string
	DBPath      string
	SQLiteBin   *string
	RunQuery    sqlite.RunQuery
	StatFile    sqlite.StatFile
	// ForceExternalSQLite skips the embedded reader.
	ForceExternalSQLite bool
	Stderr              func(line string)
	// Env resolves TOKENBOARD_OPENCODE_DB, XDG_DATA_HOME and
	// TOKENBOARD_SQLITE_BIN; nil means the process environment.
	Env func(string) string
}

// usageRow is one aggregated (date, model) row before it becomes a snapshot.
type usageRow struct {
	usageDate           string
	model               string
	inputTokens         float64
	outputTokens        float64
	cacheCreationTokens float64
	cacheReadTokens     float64
	costUSD             float64
	sessions            map[string]bool
}

// Collect gathers OpenCode usage.
func Collect(options Options) ([]contract.Snapshot, error) {
	timezone := options.Timezone
	if timezone == "" {
		timezone = sessionusage.LocalTimezone()
	}
	collectedAt := options.CollectedAt
	if collectedAt == "" {
		collectedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	dbPath := options.DBPath
	if dbPath == "" {
		dbPath = defaultDBPath(options.Env)
	}

	// Establishes the database exists before querying, and keeps the
	// WAL-aware helper covered so a checkpoint-lagging file is never reported
	// as absent.
	if _, err := sqlite.DatabaseMtimeMs(dbPath, options.StatFile); err != nil {
		if sqlite.IsMissingFileError(err) {
			return nil, errors.New(label + " database not found: " + dbPath)
		}
		return nil, err
	}

	sinceDate, err := sessionusage.ReadSinceDate(options.Since, label)
	if err != nil {
		return nil, err
	}
	rows, err := sqlite.QueryJSONRows(dbPath, UsageRowsSQL, sqlite.QueryOptions{
		SQLiteBin:     options.SQLiteBin,
		RunQuery:      options.RunQuery,
		ForceExternal: options.ForceExternalSQLite,
		Label:         label,
	})
	if err != nil {
		return nil, err
	}

	aggregates := map[string]*usageRow{}
	skippedRows := 0
	for _, row := range rows {
		parsed, ok := parseUsageRow(row, timezone)
		if !ok {
			skippedRows++
			continue
		}
		if sinceDate != "" && parsed.usageDate < sinceDate {
			continue
		}
		mergeUsageRow(aggregates, parsed)
	}
	if skippedRows > 0 && options.Stderr != nil {
		options.Stderr(fmt.Sprintf("Skipped %d %s message rows without usable token metadata", skippedRows, label))
	}

	snapshots := make([]contract.Snapshot, 0, len(aggregates))
	for _, row := range aggregates {
		snapshot := toSnapshot(row, timezone, collectedAt)
		// TS ends `toSnapshot` in `usageSnapshotSchema.parse`; this is the same gate.
		// A row beyond the contract must fail the source here, not surface later as a
		// server-side batch rejection that pauses uploads for every source.
		if err := snapshot.Validate(); err != nil {
			return nil, fmt.Errorf("%s %s %s: %w", source, row.usageDate, row.model, err)
		}
		snapshots = append(snapshots, snapshot)
	}
	return sessioncursor.MergeSnapshots(snapshots), nil
}

func parseUsageRow(row map[string]any, timezone string) (*usageRow, bool) {
	createdMs, ok := sessionusage.ReadFiniteNumber(row["createdMs"])
	if !ok || createdMs <= 0 {
		return nil, false
	}
	createdAt := time.UnixMilli(int64(createdMs))

	inputTokens := readCount(row["inputTokens"])
	outputTokens := readCount(row["outputTokens"])
	reasoningTokens := readCount(row["reasoningTokens"])
	cacheReadTokens := readCount(row["cacheReadTokens"])
	cacheCreationTokens := readCount(row["cacheWriteTokens"])

	// Reasoning tokens are billed as output and are not a separate bucket.
	billedOutputTokens := outputTokens + reasoningTokens
	if inputTokens+billedOutputTokens+cacheReadTokens+cacheCreationTokens == 0 {
		return nil, false
	}

	costUSD, ok := sessionusage.ReadFiniteNumber(row["costUsd"])
	if !ok {
		costUSD = 0
	}
	if costUSD < 0 {
		costUSD = 0
	}
	return &usageRow{
		usageDate:           sessionusage.FormatDate(createdAt, timezone),
		model:               sessionusage.BoundedModel(row["model"]),
		inputTokens:         inputTokens,
		outputTokens:        billedOutputTokens,
		cacheCreationTokens: cacheCreationTokens,
		cacheReadTokens:     cacheReadTokens,
		costUSD:             costUSD,
		sessions:            sessionSet(row["sessionId"]),
	}, true
}

func mergeUsageRow(aggregates map[string]*usageRow, row *usageRow) {
	key := row.usageDate + "\x00" + row.model
	current, ok := aggregates[key]
	if !ok {
		aggregates[key] = row
		return
	}
	current.inputTokens += row.inputTokens
	current.outputTokens += row.outputTokens
	current.cacheCreationTokens += row.cacheCreationTokens
	current.cacheReadTokens += row.cacheReadTokens
	current.costUSD += row.costUSD
	for session := range row.sessions {
		current.sessions[session] = true
	}
}

func toSnapshot(row *usageRow, timezone, collectedAt string) contract.Snapshot {
	return contract.Snapshot{
		Source:        source,
		UsageDate:     row.usageDate,
		Timezone:      timezone,
		Model:         row.model,
		InputTokens:   int64(row.inputTokens),
		OutputTokens:  int64(row.outputTokens),
		CacheCreation: int64(row.cacheCreationTokens),
		CacheRead:     int64(row.cacheReadTokens),
		TotalTokens: int64(row.inputTokens + row.outputTokens +
			row.cacheCreationTokens + row.cacheReadTokens),
		CostUSD:      row.costUSD,
		SessionCount: int64(len(row.sessions)),
		CollectedAt:  collectedAt,
	}
}

func readCount(value any) float64 {
	parsed, ok := sessionusage.ReadFiniteNumber(value)
	if !ok || parsed <= 0 {
		return 0
	}
	// Same clamp as sessionusage.ReadTokenCount: `int64(x)` for x past int64 wraps,
	// and a wrapped count folds instead of failing validation.
	if parsed > float64(contract.MaxSnapshotTokens) {
		return float64(contract.MaxSnapshotTokens + 1)
	}
	return float64(int64(parsed))
}

func sessionSet(value any) map[string]bool {
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" {
		return map[string]bool{}
	}
	return map[string]bool{text: true}
}

func defaultDBPath(env func(string) string) string {
	if explicit := lookupEnv(env, "TOKENBOARD_OPENCODE_DB"); explicit != "" {
		return explicit
	}
	if xdgDataHome := lookupEnv(env, "XDG_DATA_HOME"); xdgDataHome != "" {
		return filepath.Join(xdgDataHome, "opencode", "opencode.db")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join("opencode", "opencode.db")
	}
	return filepath.Join(home, ".local", "share", "opencode", "opencode.db")
}

func lookupEnv(env func(string) string, key string) string {
	if env == nil {
		return os.Getenv(key)
	}
	return env(key)
}
