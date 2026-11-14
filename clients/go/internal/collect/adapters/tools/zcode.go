package tools

// The ZCode adapter, ported from ccusage v20.0.33 (commit 1308c416):
// rust/adapters/zcode/src/{paths,parser,loader}.rs.
//
// ZCode stores per-model usage rows in `<home>/cli/db/db.sqlite`. The schema is
// versioned, so the loader probes the table columns first and degrades cleanly
// when an optional column is absent; a database missing a required column is
// skipped whole. Cache buckets are inclusive of the input count, so the fresh
// input is what remains after both clamps.

import (
	"database/sql"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"

	_ "modernc.org/sqlite"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

const (
	zcodeHomeEnv        = "ZCODE_HOME"
	zcodeDBRelativePath = "cli/db/db.sqlite"
)

// zcodeRequiredModelColumns and zcodeRequiredSessionColumns are
// REQUIRED_MODEL_COLUMNS / REQUIRED_SESSION_COLUMNS (loader.rs:14-23).
var (
	zcodeRequiredModelColumns   = []string{"id", "session_id", "started_at", "model_id", "status", "input_tokens", "output_tokens"}
	zcodeRequiredSessionColumns = []string{"id", "directory"}
)

// zcodeSchema records the optional columns the database happens to have
// (loader.rs:25-48).
type zcodeSchema struct {
	hasProviderID     bool
	hasCacheCreation  bool
	hasCacheRead      bool
	hasComputedTotal  bool
	hasSessionVersion bool
}

// LoadZcode reads every completed model_usage row from each ZCODE_HOME root.
func LoadZcode(o Options) ([]Entry, error) {
	dbPaths, err := zcodeDatabasePaths(o)
	if err != nil {
		return nil, err
	}
	entries := []Entry{}
	seen := map[string]bool{}
	for _, dbPath := range dbPaths {
		for _, entry := range zcodeDatabaseEntries(dbPath, o) {
			// Cross-database first-wins dedup on model_usage.id (loader.rs:65-81).
			if seen[entry.MessageID] {
				continue
			}
			seen[entry.MessageID] = true
			entries = append(entries, entry)
		}
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Timestamp < entries[j].Timestamp })
	return entries, nil
}

// zcodeRoots is paths() (paths.rs:12-25): a set-but-empty ZCODE_HOME falls back
// to ~/.zcode, while a non-empty value that names no valid directory yields no
// roots at all.
func zcodeRoots(o Options) ([]string, error) {
	if raw, ok := o.envLookup()(zcodeHomeEnv); ok {
		configured := SplitEnvList(raw)
		if len(configured) > 0 {
			return zcodeCanonicalDirectories(configured), nil
		}
	}
	home, err := o.homeDir()
	if err != nil {
		o.debugf("Unable to resolve the default ZCode home")
		return nil, nil
	}
	return zcodeCanonicalDirectories([]string{filepath.Join(home, ".zcode")}), nil
}

// zcodeDatabasePaths is db_paths (paths.rs:27-57): each root's
// cli/db/db.sqlite, canonicalized and deduped.
func zcodeDatabasePaths(o Options) ([]string, error) {
	roots, err := zcodeRoots(o)
	if err != nil {
		return nil, err
	}
	paths := []string{}
	seen := map[string]bool{}
	for _, root := range roots {
		candidate := filepath.Join(root, zcodeDBRelativePath)
		info, err := os.Stat(candidate)
		if err != nil || !info.Mode().IsRegular() {
			o.debugf("Unable to access ZCode database " + candidate)
			continue
		}
		canonical, ok := zcodeCanonicalPath(candidate)
		if !ok {
			continue
		}
		if seen[canonical] {
			continue
		}
		seen[canonical] = true
		paths = append(paths, canonical)
	}
	return paths, nil
}

// zcodeCanonicalDirectories resolves and dedupes candidate roots
// (paths.rs:71-132): only an existing directory survives, and the surviving
// name is its canonical path.
func zcodeCanonicalDirectories(paths []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil || !info.IsDir() {
			continue
		}
		canonical, ok := zcodeCanonicalPath(path)
		if !ok {
			continue
		}
		if seen[canonical] {
			continue
		}
		seen[canonical] = true
		out = append(out, canonical)
	}
	return out
}

func zcodeCanonicalPath(path string) (string, bool) {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", false
	}
	absolute, err := filepath.Abs(resolved)
	if err != nil {
		return "", false
	}
	return absolute, true
}

// zcodeDatabaseEntries reads one database (loader.rs:84-192).
func zcodeDatabaseEntries(dbPath string, o Options) []Entry {
	database, err := openToolReadOnlySQLiteDatabase(dbPath)
	if err != nil {
		o.debugf("Failed to open ZCode database: " + dbPath)
		return nil
	}
	defer database.Close()
	schema, ok := zcodeReadSchema(database, dbPath, o)
	if !ok {
		return nil
	}
	rows, err := database.Query(zcodeSelectStatement(schema))
	if err != nil {
		o.debugf("Failed to query ZCode database: " + dbPath)
		return nil
	}
	defer rows.Close()
	entries := []Entry{}
	for rows.Next() {
		values := make([]any, 12)
		targets := make([]any, len(values))
		for index := range values {
			targets[index] = &values[index]
		}
		if err := rows.Scan(targets...); err != nil {
			continue
		}
		entry, ok := zcodeRowEntry(values, o)
		if ok {
			entries = append(entries, entry)
		}
	}
	if err := rows.Err(); err != nil {
		o.debugf("Failed to read ZCode database " + dbPath + ": " + err.Error())
	}
	return entries
}

// zcodeReadSchema is read_schema (loader.rs:194-258): both tables must exist and
// carry every required column.
func zcodeReadSchema(database *sql.DB, dbPath string, o Options) (zcodeSchema, bool) {
	modelColumns, ok := zcodeTableColumns(database, "model_usage")
	if !ok {
		o.debugf("Failed to inspect ZCode model_usage schema at " + dbPath)
		return zcodeSchema{}, false
	}
	sessionColumns, ok := zcodeTableColumns(database, "session")
	if !ok {
		o.debugf("Failed to inspect ZCode session schema at " + dbPath)
		return zcodeSchema{}, false
	}
	for _, column := range zcodeRequiredModelColumns {
		if !modelColumns[column] {
			o.debugf("Unsupported ZCode SQLite schema at " + dbPath + ": model_usage is missing " + column)
			return zcodeSchema{}, false
		}
	}
	for _, column := range zcodeRequiredSessionColumns {
		if !sessionColumns[column] {
			o.debugf("Unsupported ZCode SQLite schema at " + dbPath + ": session is missing " + column)
			return zcodeSchema{}, false
		}
	}
	return zcodeSchema{
		hasProviderID:     modelColumns["provider_id"],
		hasCacheCreation:  modelColumns["cache_creation_input_tokens"],
		hasCacheRead:      modelColumns["cache_read_input_tokens"],
		hasComputedTotal:  modelColumns["computed_total_tokens"],
		hasSessionVersion: sessionColumns["version"],
	}, true
}

// zcodeTableColumns is table_columns (loader.rs:260-266): column metadata
// without materializing a row, so content columns never enter this process.
func zcodeTableColumns(database *sql.DB, table string) (map[string]bool, bool) {
	rows, err := database.Query(`SELECT * FROM "` + table + `" LIMIT 0`)
	if err != nil {
		return nil, false
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, false
	}
	set := make(map[string]bool, len(columns))
	for _, column := range columns {
		set[column] = true
	}
	return set, true
}

// zcodeSelectStatement builds the versioned query (loader.rs:132-159).
func zcodeSelectStatement(schema zcodeSchema) string {
	cacheCreation := "0"
	if schema.hasCacheCreation {
		cacheCreation = "m.cache_creation_input_tokens"
	}
	cacheRead := "0"
	if schema.hasCacheRead {
		cacheRead = "m.cache_read_input_tokens"
	}
	computedTotal := "m.input_tokens + m.output_tokens"
	if schema.hasComputedTotal {
		computedTotal = "m.computed_total_tokens"
	}
	providerID := "NULL"
	if schema.hasProviderID {
		providerID = "m.provider_id"
	}
	version := "NULL"
	if schema.hasSessionVersion {
		version = "s.version"
	}
	return "SELECT m.id, m.session_id, m.started_at, m.model_id, m.input_tokens, m.output_tokens, " +
		cacheCreation + ", " + cacheRead + ", " + computedTotal + ", " + providerID +
		", s.directory, " + version +
		" FROM model_usage m LEFT JOIN session s ON s.id = m.session_id WHERE m.status = 'completed'"
}

// zcodeRowEntry is read_usage_row plus row_to_entry (loader.rs:276-316,
// parser.rs:27-141).
func zcodeRowEntry(values []any, o Options) (Entry, bool) {
	id, ok := values[0].(string)
	if !ok {
		return Entry{}, false
	}
	sessionID, ok := values[1].(string)
	if !ok {
		return Entry{}, false
	}
	startedAt, ok := zcodeTimestampValue(values[2])
	if !ok {
		return Entry{}, false
	}
	modelID, ok := values[3].(string)
	if !ok {
		return Entry{}, false
	}
	inputTokens := zcodeTokenValue(values[4])
	outputTokens := zcodeTokenValue(values[5])
	cacheCreationTokens := zcodeTokenValue(values[6])
	cacheReadTokens := zcodeTokenValue(values[7])
	computedTotalTokens := zcodeTokenValue(values[8])
	var providerID *string
	if text, ok := zcodeOptionalString(values[9]); ok {
		providerID = &text
	}
	directory, _ := zcodeOptionalString(values[10])
	version, _ := zcodeOptionalString(values[11])

	rawModel := strings.TrimSpace(modelID)
	if strings.TrimSpace(id) == "" || strings.TrimSpace(sessionID) == "" || rawModel == "" || startedAt <= 0 {
		return Entry{}, false
	}
	cacheRead := MinU64(cacheReadTokens, inputTokens)
	cacheCreation := MinU64(cacheCreationTokens, SaturatingSubU64(inputTokens, cacheRead))
	usage := Usage{
		Input:         SaturatingSubU64(SaturatingSubU64(inputTokens, cacheRead), cacheCreation),
		Output:        outputTokens,
		CacheCreation: cacheCreation,
		CacheRead:     cacheRead,
	}
	ApplyTotalFallback(&usage, computedTotalTokens)
	if usage.Total() == 0 {
		return Entry{}, false
	}
	projectPath := "ZCode"
	if strings.TrimSpace(directory) != "" {
		projectPath = directory
	}
	entry := Entry{
		Timestamp:   startedAt,
		Date:        FormatDateTZ(startedAt, o.Timezone),
		Model:       rawModel,
		Usage:       usage,
		SessionID:   sessionID,
		MessageID:   id,
		ProjectPath: projectPath,
		Version:     version,
	}
	// zcode is a rich session source (SessionAccumulator), so LastActivity and
	// FirstActivity drive the session row's lastActivity/firstActivity.
	entry.LastActivity = startedAt
	entry.FirstActivity = startedAt
	entry.CostUSD, entry.MissingPricing = zcodeCost(o, rawModel, providerID, usage, startedAt)
	return entry, true
}

// zcodeCost models row_to_entry's cost block (parser.rs:63-111): Display never
// prices, Z.ai folds cache creation into the input bucket, and an unresolved
// model is reported missing only when the row carries tokens.
func zcodeCost(o Options, rawModel string, providerID *string, usage Usage, startedAt int64) (float64, bool) {
	if o.Mode == nativepricing.ModeDisplay {
		return 0, false
	}
	isZai := zcodeIsZaiProvider(providerID) ||
		(providerID == nil && zcodeIsZaiModel(zcodeASCIILower(rawModel)))
	costUsage := nativepricing.Usage{
		Input:         TokenCount(usage.Input),
		Output:        TokenCount(SaturatingAddU64(usage.Output, usage.Extra)),
		CacheCreate5m: TokenCount(usage.CacheCreation),
		CacheRead:     TokenCount(usage.CacheRead),
	}
	if isZai {
		// Z.ai exposes new content as a cache-creation bucket for display but
		// bills it at the model's standard input rate (parser.rs:75-93).
		costUsage.Input = TokenCount(SaturatingAddU64(usage.Input, usage.CacheCreation))
		costUsage.CacheCreate5m = 0
	}
	pricingModel, ok := zcodePricingModel(o.Corpus, rawModel, providerID)
	if !ok {
		return 0, usage.Total() > 0
	}
	pricing, found := o.Corpus.FindAt(pricingModel, startedAt)
	if !found {
		return 0, false
	}
	return nativepricing.CostFromPricing(costUsage, pricing, false), false
}

// zcodePricingCandidates is pricing_candidates (parser.rs:143-154).
func zcodePricingCandidates(rawModel string, providerID *string) []string {
	lowerModel := zcodeASCIILower(rawModel)
	candidates := []string{rawModel, lowerModel}
	if zcodeIsZaiProvider(providerID) ||
		(providerID == nil && zcodeIsZaiModel(lowerModel)) {
		candidates = append(candidates, "zai/"+rawModel, "zai/"+lowerModel)
	}
	// Vec::dedup only drops adjacent duplicates.
	out := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if len(out) > 0 && out[len(out)-1] == candidate {
			continue
		}
		out = append(out, candidate)
	}
	return out
}

// zcodePricingModel is pricing_model (parser.rs:156-185).
//
// The candidate chain's user-override check runs first, before the provider
// guard: a custom provider id normally makes the row unpriced, but a
// pricingOverrides record for one of its candidate spellings still prices it.
// In the native client the server overrides are folded into the corpus
// (Corpus.WithOverrides), so the check is HasOverride over the same candidates,
// and the override's own rate is found under the candidate id.
func zcodePricingModel(corpus nativepricing.Corpus, rawModel string, providerID *string) (string, bool) {
	candidates := zcodePricingCandidates(rawModel, providerID)
	for _, candidate := range candidates {
		if corpus.HasOverride(candidate) {
			return candidate, true
		}
	}
	if providerID != nil && !zcodeIsZaiProvider(providerID) {
		return "", false
	}
	for _, candidate := range candidates {
		if !strings.HasPrefix(candidate, "zai/") {
			continue
		}
		if _, ok := corpus.Find(candidate); ok {
			return candidate, true
		}
	}
	for _, candidate := range candidates {
		if strings.HasPrefix(candidate, "zai/") {
			continue
		}
		if _, ok := corpus.Find(candidate); ok {
			return candidate, true
		}
	}
	return "", false
}

// zcodeIsZaiProvider is is_zai_provider (parser.rs:187-201).
func zcodeIsZaiProvider(providerID *string) bool {
	if providerID == nil {
		return false
	}
	normalized := zcodeASCIILower(strings.TrimSpace(*providerID))
	switch normalized {
	case "zai", "z.ai", "zai-coding-plan", "builtin:zai-coding-plan", "builtin:bigmodel-coding-plan":
		return true
	}
	return strings.HasPrefix(normalized, "account:zai-") || strings.HasPrefix(normalized, "builtin:zai-")
}

// zcodeIsZaiModel is is_zai_model (parser.rs:203-205).
func zcodeIsZaiModel(model string) bool {
	return strings.HasPrefix(model, "glm-") || strings.HasPrefix(model, "glm/")
}

// zcodeASCIILower is to_ascii_lowercase: only the ASCII range folds, so a model
// id keeps its non-ASCII spelling.
func zcodeASCIILower(value string) string {
	lowered := []byte(value)
	for index := range lowered {
		if lowered[index] >= 'A' && lowered[index] <= 'Z' {
			lowered[index] += 'a' - 'A'
		}
	}
	return string(lowered)
}

// zcodeTimestampValue is read_timestamp_ms (loader.rs:309-316): an integer, or
// a finite real inside the i64 range rounded to the nearest millisecond. A real
// outside that range is rejected - read_timestamp_ms returns None and the row
// is skipped - so this never saturates.
func zcodeTimestampValue(value any) (int64, bool) {
	switch typed := value.(type) {
	case int64:
		return typed, true
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		// The range gate is `i64::MIN..=i64::MAX` evaluated as f64, so the
		// bounds are +-2^63: anything beyond them returns None. A value that
		// rounds to exactly 2^63 saturates to MaxInt64, which is what Rust's
		// `round() as i64` produces.
		if typed < float64(math.MinInt64) || typed > float64(math.MaxInt64) {
			return 0, false
		}
		rounded := math.Round(typed)
		if rounded >= float64(math.MaxInt64) {
			return math.MaxInt64, true
		}
		return int64(rounded), true
	}
	return 0, false
}

// zcodeTokenValue is read_token_column (loader.rs:293-307): a non-negative
// integer as-is, a positive finite real rounded, everything else zero.
func zcodeTokenValue(value any) uint64 {
	switch typed := value.(type) {
	case int64:
		if typed <= 0 {
			return 0
		}
		return uint64(typed)
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) || typed <= 0 {
			return 0
		}
		if typed >= float64(math.MaxUint64) {
			return math.MaxUint64
		}
		return uint64(math.Round(typed))
	}
	return 0
}

// zcodeOptionalString is read::<Option<String>>: NULL and non-text values read
// as absent.
func zcodeOptionalString(value any) (string, bool) {
	text, ok := value.(string)
	return text, ok
}
