package tools

// The Goose adapter, ported from ccusage v20.0.33 (commit 1308c416):
// rust/adapters/goose/src/{paths,parser,loader}.rs.
//
// Goose keeps one sessions.db per installation (under GOOSE_PATH_ROOT, or the
// three platform defaults). A row of its sessions table is one session with a
// per-turn and an accumulated token triple; the accumulated column wins when it
// is positive. Three rules make the port non-obvious:
//
//   - the dedup key is `dbpath:session_id`, so the same session id in two
//     installations is two rows (loader.rs:40-50);
//   - reasoning is the saturating remainder of the total and is reported as
//     extra tokens while being billed as output (parser.rs:48-54);
//   - the cost is always calculated from the pricing table, whatever --mode
//     says, and only a non-goose provider adds a provider-qualified fallback
//     candidate (parser.rs:170-195).

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

const gooseDBFileName = "sessions.db"

// gooseSessionColumnCount is the number of projected columns; the row reader
// indexes them positionally like the Rust statement.read call sites.
const gooseSessionColumnCount = 10

// gooseSessionQuery is GOOSE_SESSION_QUERY (loader.rs:11-27).
const gooseSessionQuery = `
	SELECT
		id,
		model_config_json,
		provider_name,
		created_at,
		total_tokens,
		input_tokens,
		output_tokens,
		accumulated_total_tokens,
		accumulated_input_tokens,
		accumulated_output_tokens
	FROM sessions
	WHERE model_config_json IS NOT NULL
		AND TRIM(model_config_json) != ''
`

// LoadGoose reads every Goose sessions database, dedups by database path and
// session id, and returns the priced entries in timestamp order.
func LoadGoose(o Options) ([]Entry, error) {
	dbPaths, err := gooseDBPaths(o)
	if err != nil {
		return nil, err
	}
	entries := []Entry{}
	seen := make(map[string]bool, len(dbPaths))
	for _, dbPath := range dbPaths {
		for _, entry := range loadGooseStateDB(dbPath, o) {
			key := dbPath + ":" + entry.SessionID
			if seen[key] {
				continue
			}
			seen[key] = true
			entries = append(entries, entry)
		}
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Timestamp < entries[j].Timestamp })
	return entries, nil
}

// gooseDBPaths is goose_db_paths (paths.rs:8-35). GOOSE_PATH_ROOT is a single
// root, trimmed as a whole - not a comma list like the other tools' variables -
// and an empty value falls back to the defaults. Candidates are canonicalized
// before the existence check so two roots naming the same file are read once.
func gooseDBPaths(o Options) ([]string, error) {
	var candidates []string
	root, hasRoot := o.envLookup()("GOOSE_PATH_ROOT")
	root = strings.TrimSpace(root)
	if !hasRoot || root == "" {
		defaults, err := gooseDefaultDBCandidates(o)
		if err != nil {
			return nil, err
		}
		candidates = defaults
	} else {
		candidates = []string{filepath.Join(root, "data", "sessions", gooseDBFileName)}
	}
	paths := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		// Path::canonicalize().unwrap_or(path): a missing file keeps its
		// literal path and then fails the is_file check.
		if resolved, err := filepath.EvalSymlinks(candidate); err == nil {
			candidate = resolved
		}
		if gooseIsFile(candidate) {
			paths = append(paths, candidate)
		}
	}
	return DedupePaths(paths), nil
}

// gooseDefaultDBCandidates is default_goose_db_candidates (paths.rs:37-50).
func gooseDefaultDBCandidates(o Options) ([]string, error) {
	home, err := o.homeDir()
	if err != nil {
		return nil, err
	}
	return []string{
		filepath.Join(home, ".local", "share", "goose", "sessions", gooseDBFileName),
		filepath.Join(home, "Library", "Application Support", "goose", "sessions", gooseDBFileName),
		filepath.Join(home, ".local", "share", "Block", "goose", "sessions", gooseDBFileName),
	}, nil
}

func gooseIsFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// loadGooseStateDB is load_entries_from_db (loader.rs:52-95). A database that
// cannot be opened or queried is skipped with a debug line, not an error.
func loadGooseStateDB(dbPath string, o Options) []Entry {
	database, err := openReadOnlyToolDB(dbPath)
	if err != nil {
		o.debugf("Failed to open Goose database: " + dbPath)
		return nil
	}
	defer database.Close()
	rows, err := database.Query(gooseSessionQuery)
	if err != nil {
		o.debugf("Failed to read Goose database: " + dbPath)
		return nil
	}
	defer rows.Close()

	entries := []Entry{}
	for rows.Next() {
		values := make([]any, gooseSessionColumnCount)
		targets := make([]any, len(values))
		for index := range values {
			targets[index] = &values[index]
		}
		if err := rows.Scan(targets...); err != nil {
			continue
		}
		if entry, ok := gooseEntryFromColumns(values, o); ok {
			entries = append(entries, entry)
		}
	}
	if err := rows.Err(); err != nil {
		o.debugf("Failed to query Goose database: " + dbPath)
	}
	return entries
}

// gooseEntryFromColumns is row_to_entry (parser.rs:19-95).
func gooseEntryFromColumns(values []any, o Options) (Entry, bool) {
	if len(values) < gooseSessionColumnCount {
		return Entry{}, false
	}
	id, ok := values[0].(string)
	if !ok {
		return Entry{}, false
	}
	modelConfig, ok := values[1].(string)
	if !ok {
		return Entry{}, false
	}
	providerName, hasProvider := values[2].(string)
	createdAt, ok := gooseTimestampValue(values[3])
	if !ok {
		return Entry{}, false
	}
	millis, ok := parseGooseTimestamp(createdAt)
	if !ok {
		return Entry{}, false
	}
	model, ok := gooseModelName(modelConfig)
	if !ok {
		return Entry{}, false
	}

	// The accumulated columns come first and only count when positive, then the
	// per-turn columns, then (for the total) their sum (parser.rs:37-47).
	input := goosePositiveToken(values[8])
	if input == 0 {
		input = goosePositiveToken(values[5])
	}
	output := goosePositiveToken(values[9])
	if output == 0 {
		output = goosePositiveToken(values[6])
	}
	total := goosePositiveToken(values[7])
	if total == 0 {
		total = goosePositiveToken(values[4])
	}
	if total == 0 {
		total = SaturatingAddU64(input, output)
	}
	if input == 0 && output == 0 && total == 0 {
		return Entry{}, false
	}
	reasoning := SaturatingSubU64(total, SaturatingAddU64(input, output))
	provider := normalizeGooseProvider(providerName, hasProvider, model)

	entry := Entry{
		Timestamp:   millis,
		Date:        FormatDateTZ(millis, o.Timezone),
		Model:       model,
		Usage:       Usage{Input: input, Output: output, Extra: reasoning},
		SessionID:   id,
		MessageID:   id,
		ProjectPath: "Goose",
	}
	entry.CostUSD = gooseCost(o, entry, provider)
	entry.MissingPricing = gooseMissingPricing(o, entry, provider)
	return entry, true
}

// goosePositiveToken is read_token_value (parser.rs:97-103): an INTEGER column
// that is greater than zero. Unlike Hermes there is no REAL branch, so a REAL
// column reads as absent and the next column is used.
func goosePositiveToken(value any) uint64 {
	integer, ok := value.(int64)
	if !ok || integer <= 0 {
		return 0
	}
	return uint64(integer)
}

// gooseTimestampValue is read_timestamp_value (parser.rs:105-112): a TEXT
// column as written, or an INTEGER rendered to its decimal spelling. A REAL
// column is absent.
func gooseTimestampValue(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		return typed, true
	case int64:
		return strconv.FormatInt(typed, 10), true
	}
	return "", false
}

// gooseModelName is parse_goose_model_config (parser.rs:114-117): the config
// must be a JSON object with a non-empty string model_name. serde_json's
// from_str rejects trailing content, so json.Unmarshal (not a streaming
// decoder) is the faithful read.
func gooseModelName(value string) (string, bool) {
	var config any
	if err := json.Unmarshal([]byte(value), &config); err != nil {
		return "", false
	}
	object, ok := LenientObject(config)
	if !ok {
		return "", false
	}
	return NonEmptyString(object["model_name"])
}

// parseGooseTimestamp is parse_goose_timestamp (parser.rs:119-146): an integer
// (seconds below 1e12, milliseconds above), the strict timestamp gate, a
// 19-character date-time given a T and a Z, or a bare date taken as midnight
// UTC.
func parseGooseTimestamp(value string) (int64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, false
	}
	if number, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
		millis := number
		if !(number > 1_000_000_000_000) {
			// checked_mul: an overflow is not a failure, just an unusable row.
			if number > math.MaxInt64/1000 || number < math.MinInt64/1000 {
				return 0, false
			}
			millis = number * 1000
		}
		if millis <= 0 {
			return 0, false
		}
		return millis, true
	}
	if millis, ok := ParseTSTimestamp(trimmed); ok {
		return millis, true
	}
	if len(trimmed) == 19 && trimmed[4] == '-' && trimmed[7] == '-' &&
		(trimmed[10] == ' ' || trimmed[10] == 'T') {
		return ParseTSTimestamp(trimmed[:10] + "T" + trimmed[11:] + "Z")
	}
	if len(trimmed) == 10 && trimmed[4] == '-' && trimmed[7] == '-' {
		return ParseTSTimestamp(trimmed + "T00:00:00Z")
	}
	return 0, false
}

// normalizeGooseProvider is normalize_provider (parser.rs:148-168). A present
// provider keeps its case and only swaps '-' for '_'; otherwise the model
// prefix decides, and the `starts_with('o')` rule files every o-prefixed model
// - opus included - under openai.
func normalizeGooseProvider(raw string, present bool, model string) string {
	if present {
		trimmed := strings.TrimSpace(raw)
		if trimmed != "" {
			return strings.ReplaceAll(trimmed, "-", "_")
		}
	}
	switch {
	case strings.HasPrefix(model, "claude-"):
		return "anthropic"
	case strings.HasPrefix(model, "gpt-") || strings.HasPrefix(model, "chatgpt-") || strings.HasPrefix(model, "o"):
		return "openai"
	case strings.HasPrefix(model, "gemini-"):
		return "google"
	case strings.HasPrefix(ASCIILower(model), "qwen"):
		return "openrouter"
	}
	return "goose"
}

// goosePricingCandidates is the candidate chain calculate_goose_cost and
// missing_goose_pricing share (parser.rs:184-195/197-211): the bare model
// first, then the provider-qualified spelling for a non-goose provider.
func goosePricingCandidates(model, provider string) []string {
	candidates := []string{model}
	if provider != "goose" {
		candidates = append(candidates, provider+"/"+model)
	}
	return candidates
}

// gooseCost is calculate_goose_cost (parser.rs:170-195): the bare model is
// priced first, and the provider-qualified name is only tried when that
// produced nothing and the provider was inferred far enough to name one.
func gooseCost(o Options, entry Entry, provider string) float64 {
	usage := goosePricingUsage(entry)
	at := PriceAt(entry.Timestamp)
	raw, _ := nativepricing.Cost(o.Corpus, entry.Model, usage, at, nativepricing.ModeCalculate, false, false)
	if raw > 0 || provider == "goose" {
		return raw
	}
	cost, _ := nativepricing.Cost(o.Corpus, provider+"/"+entry.Model, usage, at, nativepricing.ModeCalculate, false, false)
	return cost
}

// goosePricingUsage folds the reasoning tokens into the output bucket, which is
// what calculate_goose_cost bills (parser.rs:177-181).
func goosePricingUsage(entry Entry) nativepricing.Usage {
	return nativepricing.Usage{
		Input:  int64(entry.Usage.Input),
		Output: int64(entry.Usage.Output) + int64(entry.Usage.Extra),
	}
}

// gooseMissingPricing is missing_goose_pricing (parser.rs:197-211):
// missing_pricing_model_for_candidates (cost.rs:77-93) over the same chain,
// quiet only when the usage carries no tokens.
func gooseMissingPricing(o Options, entry Entry, provider string) bool {
	if entry.Usage.Total() == 0 {
		return false
	}
	for _, candidate := range goosePricingCandidates(entry.Model, provider) {
		if _, ok := o.Corpus.Find(candidate); ok {
			return false
		}
	}
	return true
}
