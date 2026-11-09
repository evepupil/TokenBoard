package tools

// The Hermes adapter, ported from ccusage v20.0.33 (commit 1308c416):
// rust/adapters/hermes/src/{paths,parser,loader}.rs.
//
// Hermes keeps one state.db per installation under HERMES_HOME. A row of its
// sessions table is one billing record: token buckets, the estimated and actual
// USD Hermes recorded, and a reasoning-token count. Three rules make the port
// non-obvious:
//
//   - a session id is the dedup key across databases, and the first database in
//     path order keeps it (loader.rs:31-38);
//   - reasoning tokens are reported as extra tokens but billed as output
//     (parser.rs:194-200);
//   - the cost is the recorded one when it is positive, and otherwise the
//     tokens are priced - whatever --mode says, because the adapter derives the
//     cost itself and the mode never reaches it (parser.rs:186-201).

import (
	"database/sql"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

const hermesStateDBFileName = "state.db"

// hermesSessionColumnCount is the number of projected columns; the row reader
// indexes them positionally like the Rust statement.read call sites.
const hermesSessionColumnCount = 12

// hermesSessionQuery is loader.rs:62-81.
const hermesSessionQuery = `
	SELECT
		id,
		model,
		billing_provider,
		started_at,
		message_count,
		input_tokens,
		output_tokens,
		cache_read_tokens,
		cache_write_tokens,
		reasoning_tokens,
		estimated_cost_usd,
		actual_cost_usd
	FROM sessions
	WHERE model IS NOT NULL
		AND TRIM(model) != ''
`

// openReadOnlyToolDB opens one of a tool's own SQLite databases read-only.
//
// The DSN is the one internal/collect/sqlite builds (sqlite.go:179
// readOnlyDSN): a URI with mode=ro, so the adapter can never mutate the tool's
// store or change its journal mode, and '?', '#' and '%' - which SQLite's URI
// parser treats as delimiters - are escaped.
//
// The shared sqlite package is deliberately not used here: its row projection
// narrows every INTEGER column to float64 and drops blobs, while Hermes and
// Goose read each column with the type SQLite actually stored (read::<i64>,
// read::<f64>, read::<String>), so a REAL and an INTEGER must stay
// distinguishable.
func openReadOnlyToolDB(dbFile string) (*sql.DB, error) {
	escaped := strings.NewReplacer("%", "%25", "?", "%3F", "#", "%23").Replace(filepath.ToSlash(dbFile))
	return sql.Open("sqlite", "file:"+escaped+"?mode=ro")
}

// LoadHermes reads every Hermes state database, dedups its sessions across
// databases and returns the priced entries in timestamp order.
func LoadHermes(o Options) ([]Entry, error) {
	dbPaths, err := hermesStateDBPaths(o)
	if err != nil {
		return nil, err
	}
	// Each state database is read on its own connection; the session dedup then
	// runs over the original path order, so the surviving session is the one a
	// single-threaded read would keep (loader.rs:24-40).
	loaded := make([][]hermesSessionRow, len(dbPaths))
	for index, dbPath := range dbPaths {
		loaded[index] = loadHermesStateDB(dbPath, o)
	}
	entries := []Entry{}
	seen := make(map[string]bool, len(loaded))
	for _, rows := range loaded {
		for _, row := range rows {
			if seen[row.sessionID] {
				continue
			}
			seen[row.sessionID] = true
			entries = append(entries, hermesEntry(row, o))
		}
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Timestamp < entries[j].Timestamp })
	return entries, nil
}

// hermesStateDBPaths is hermes_state_db_paths (paths.rs:7-31): HERMES_HOME is a
// comma list of homes when set (a set-but-empty value means zero roots, never a
// fallback), otherwise ~/.hermes, and only a home whose state.db is a regular
// file contributes.
func hermesStateDBPaths(o Options) ([]string, error) {
	var homes []string
	if raw, ok := o.envLookup()("HERMES_HOME"); ok {
		homes = SplitEnvList(raw)
	} else {
		home, err := o.homeDir()
		if err != nil {
			return nil, err
		}
		homes = []string{filepath.Join(home, ".hermes")}
	}
	paths := make([]string, 0, len(homes))
	for _, home := range homes {
		candidate := filepath.Join(home, hermesStateDBFileName)
		if hermesIsFile(candidate) {
			paths = append(paths, candidate)
		}
	}
	return DedupePaths(paths), nil
}

func hermesIsFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// hermesSessionRow is one usable row of the sessions table: the fields the
// parser keeps after the blank-model, timestamp and all-zero gates.
type hermesSessionRow struct {
	timestamp    int64
	sessionID    string
	model        string
	provider     string
	usage        Usage // Extra carries the reasoning tokens
	messageCount uint64
	costUSD      *float64
}

// loadHermesStateDB is load_state_db_entries (loader.rs:45-98). A database that
// cannot be opened or queried is skipped with a debug line, not an error.
func loadHermesStateDB(dbPath string, o Options) []hermesSessionRow {
	database, err := openReadOnlyToolDB(dbPath)
	if err != nil {
		o.debugf("Failed to open Hermes state database: " + dbPath)
		return nil
	}
	defer database.Close()
	rows, err := database.Query(hermesSessionQuery)
	if err != nil {
		o.debugf("Failed to read Hermes state database: " + dbPath)
		return nil
	}
	defer rows.Close()

	collected := []hermesSessionRow{}
	for rows.Next() {
		values := make([]any, hermesSessionColumnCount)
		targets := make([]any, len(values))
		for index := range values {
			targets[index] = &values[index]
		}
		if err := rows.Scan(targets...); err != nil {
			// A row the driver cannot hand over is a row the Rust reader drops
			// field by field; the rest of the database still loads.
			continue
		}
		if row, ok := hermesSessionRowFromColumns(values); ok {
			collected = append(collected, row)
		}
	}
	if err := rows.Err(); err != nil {
		o.debugf("Failed to query Hermes state database: " + dbPath)
	}
	return collected
}

// hermesSessionRowFromColumns is read_session_row (parser.rs:22-79).
func hermesSessionRowFromColumns(values []any) (hermesSessionRow, bool) {
	if len(values) < hermesSessionColumnCount {
		return hermesSessionRow{}, false
	}
	sessionID, ok := values[0].(string)
	if !ok {
		return hermesSessionRow{}, false
	}
	modelText, ok := values[1].(string)
	if !ok {
		return hermesSessionRow{}, false
	}
	model := strings.TrimSpace(modelText)
	// The Rust gate is `session_id.is_empty()` on the raw value and a trimmed
	// model; it does not trim the id.
	if sessionID == "" || model == "" {
		return hermesSessionRow{}, false
	}
	providerRaw, hasProvider := values[2].(string)
	startedAt, ok := hermesF64(values[3])
	if !ok {
		return hermesSessionRow{}, false
	}
	millis, ok := hermesTimestampMillis(startedAt)
	if !ok {
		return hermesSessionRow{}, false
	}
	row := hermesSessionRow{
		timestamp: millis,
		sessionID: sessionID,
		model:     model,
		provider:  normalizeHermesProvider(providerRaw, hasProvider, model),
		// cache_read_tokens (index 7) is the read bucket and cache_write_tokens
		// (index 8) the creation bucket; reasoning_tokens (index 9) is extra.
		usage: Usage{
			Input:         hermesU64(values[5]),
			Output:        hermesU64(values[6]),
			CacheRead:     hermesU64(values[7]),
			CacheCreation: hermesU64(values[8]),
			Extra:         hermesU64(values[9]),
		},
		messageCount: hermesU64(values[4]),
	}
	estimated := hermesNonNegativeF64(values[10])
	actual := hermesNonNegativeF64(values[11])
	// `actual_cost.or(estimated_cost)`: an actual column that is present - even
	// as a reported zero - hides the estimate (parser.rs:63-64).
	if actual != nil {
		row.costUSD = actual
	} else {
		row.costUSD = estimated
	}
	if row.usage.Total() == 0 && reportedOrZero(row.costUSD) == 0 {
		return hermesSessionRow{}, false
	}
	return row, true
}

// hermesF64 is read_f64 (parser.rs:102-115): a REAL column first, then an
// INTEGER widened to float64. Any other storage class is absent.
func hermesF64(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case int64:
		return float64(typed), true
	}
	return 0, false
}

// hermesU64 is read_u64 (parser.rs:81-99): an INTEGER clamped at zero first,
// then a positive REAL truncated. A present-but-negative integer is zero and
// does not fall through to the REAL branch.
func hermesU64(value any) uint64 {
	switch typed := value.(type) {
	case int64:
		if typed < 0 {
			return 0
		}
		return uint64(typed)
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) || typed <= 0 {
			return 0
		}
		return uint64(math.Trunc(typed))
	}
	return 0
}

// hermesNonNegativeF64 is read_non_negative_f64 (parser.rs:117-119): a present
// value clamps to zero, so a negative cost is Some(0), not absent.
func hermesNonNegativeF64(value any) *float64 {
	parsed, ok := hermesF64(value)
	if !ok {
		return nil
	}
	if parsed < 0 {
		parsed = 0
	}
	return &parsed
}

// hermesTimestampMillis is timestamp_from_number (parser.rs:129-137): above
// 1e12 the number is already milliseconds, otherwise it is seconds.
func hermesTimestampMillis(value float64) (int64, bool) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	millis := value
	if !(value > 1e12) {
		millis = value * 1000
	}
	if !(millis > 0) {
		return 0, false
	}
	// Rust's `trunc() as i64` saturates on overflow; Go's float→int64
	// conversion is implementation-defined and lands on MinInt64 on amd64,
	// which would date the row in 1677 instead of 2262.
	truncated := math.Trunc(millis)
	if truncated >= float64(math.MaxInt64) {
		return math.MaxInt64, true
	}
	return int64(truncated), true
}

// normalizeHermesProvider is normalize_provider (parser.rs:139-160): a present
// provider is lowercased, '-' becomes '_', and the well-known spellings fold
// into one name; a missing one is inferred from the model.
func normalizeHermesProvider(raw string, present bool, model string) string {
	if present {
		value := strings.TrimSpace(raw)
		if value != "" {
			normalized := strings.ReplaceAll(ASCIILower(value), "-", "_")
			switch normalized {
			case "anthropic", "claude":
				return "anthropic"
			case "openai", "openai_codex":
				return "openai"
			case "google", "google_ai", "gemini", "vertex", "vertex_ai":
				return "google"
			case "openrouter":
				return "openrouter"
			case "xai":
				return "xai"
			case "groq":
				return "groq"
			}
			return normalized
		}
	}
	return inferHermesProvider(model)
}

// inferHermesProvider is infer_provider_from_model (parser.rs:162-179). The
// o-prefixed branch also demands a digit, unlike goose's looser rule.
func inferHermesProvider(model string) string {
	lower := ASCIILower(model)
	switch {
	case strings.HasPrefix(lower, "claude-") || strings.HasPrefix(lower, "claude/"):
		return "anthropic"
	case strings.HasPrefix(lower, "gpt") || strings.HasPrefix(lower, "chatgpt"):
		return "openai"
	case len(lower) > 1 && lower[0] == 'o' && lower[1] >= '0' && lower[1] <= '9':
		return "openai"
	case strings.HasPrefix(lower, "gemini-") || strings.HasPrefix(lower, "gemini/"):
		return "google"
	}
	return "hermes"
}

// hermesEntry is to_loaded_entry (parser.rs:181-230).
func hermesEntry(row hermesSessionRow, o Options) Entry {
	messageCount := row.messageCount
	entry := Entry{
		Timestamp:    row.timestamp,
		Date:         FormatDateTZ(row.timestamp, o.Timezone),
		Model:        row.model,
		Usage:        row.usage,
		ReportedCost: row.costUSD,
		SessionID:    row.sessionID,
		MessageID:    "hermes:" + row.sessionID,
		ProjectPath:  "Hermes",
		MessageCount: &messageCount,
	}
	candidates := hermesModelCandidates(o, row.provider, row.model)
	entry.CostUSD = hermesCost(o, row, candidates)
	entry.MissingPricing = hermesMissingPricing(o, row, candidates)
	return entry
}

// hermesModelCandidates is model_candidates (parser.rs:232-247): the
// provider-qualified name only when find_exact_with_fallback - which has no
// fuzzy stage - answers it, then the bare model.
func hermesModelCandidates(o Options, provider, model string) []string {
	candidates := []string{}
	if provider != "hermes" {
		qualified := provider + "/" + model
		if _, ok := LookupFindExactWithFallback(o.Corpus, qualified, time.Time{}); ok {
			candidates = append(candidates, qualified)
		}
	}
	candidates = append(candidates, model)
	return DedupePaths(candidates)
}

// hermesCost is calculate_hermes_cost (parser.rs:186-204): the recorded cost
// when positive, otherwise the first candidate that prices for more than zero.
// The mode is not consulted, and the timestamp selects the schedule in force
// when the request ran (find_at).
func hermesCost(o Options, row hermesSessionRow, candidates []string) float64 {
	if row.costUSD != nil && *row.costUSD > 0 {
		return *row.costUSD
	}
	usage := hermesPricingUsage(row)
	at := PriceAt(row.timestamp)
	for _, candidate := range candidates {
		cost, _ := nativepricing.Cost(o.Corpus, candidate, usage, at, nativepricing.ModeCalculate, false, false)
		if !math.IsNaN(cost) && !math.IsInf(cost, 0) && cost > 0 {
			return cost
		}
	}
	return 0
}

// hermesPricingUsage folds the reasoning tokens into the output bucket, which
// is what calculate_hermes_cost bills (parser.rs:194-200).
func hermesPricingUsage(row hermesSessionRow) nativepricing.Usage {
	return nativepricing.Usage{
		Input:         int64(row.usage.Input),
		Output:        int64(row.usage.Output) + int64(row.usage.Extra),
		CacheCreate5m: int64(row.usage.CacheCreation),
		CacheRead:     int64(row.usage.CacheRead),
	}
}

// hermesMissingPricing is missing_hermes_pricing (parser.rs:206-217):
// missing_pricing_model_for_candidates (cost.rs:77-93) with the same candidate
// chain, quiet only when a trusted cost exists or the usage carries no tokens.
func hermesMissingPricing(o Options, row hermesSessionRow, candidates []string) bool {
	if row.costUSD != nil && *row.costUSD > 0 {
		return false
	}
	if row.usage.Total() == 0 {
		return false
	}
	for _, candidate := range candidates {
		if _, ok := LookupFind(o.Corpus, candidate, time.Time{}); ok {
			return false
		}
	}
	return true
}
