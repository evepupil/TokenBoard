package tools

// The Kilo adapter, ported from ccusage v20.0.33 (commit 1308c416):
// rust/adapters/kilo/src/{paths,parser,loader}.rs.
//
// Kilo keeps every message of a session in one SQLite database (kilo.db) as a
// JSON blob, so this adapter is a thin SQL projection plus the shared message
// rules: assistant rows with tokens, cache read/write buckets, reasoning folded
// into the reported total, and a provider-qualified pricing candidate that only
// exists when the pricing table prices it exactly.

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"

	_ "modernc.org/sqlite"

	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// kiloDefaultDataDir is the default root (paths.rs:29-33).
var kiloDefaultDataDir = []string{"~/.local/share/kilo"}

// LoadKilo reads every message row of `<root>/kilo.db` under each root.
func LoadKilo(o Options) ([]Entry, error) {
	roots, err := resolveRoots(o, "KILO_DATA_DIR", kiloDefaultDataDir, isDirectory)
	if err != nil {
		return nil, err
	}
	dbPaths := []string{}
	for _, root := range roots {
		path := filepath.Join(root, "kilo.db")
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			dbPaths = append(dbPaths, path)
		}
	}
	entries := []Entry{}
	seen := map[string]bool{}
	for _, dbPath := range dbPaths {
		for _, entry := range kiloDatabaseEntries(dbPath, o) {
			// Cross-database first-wins dedup on the entry's message id
			// (loader.rs:26-43); the database order is the root order.
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

// kiloDatabaseEntries reads one database's message table (loader.rs:45-106).
func kiloDatabaseEntries(dbPath string, o Options) []Entry {
	database, err := openToolReadOnlySQLiteDatabase(dbPath)
	if err != nil {
		o.debugf("Failed to open Kilo database: " + dbPath)
		return nil
	}
	defer database.Close()
	rows, err := database.Query("SELECT id, session_id, data FROM message")
	if err != nil {
		o.debugf("Failed to read Kilo database: " + dbPath)
		return nil
	}
	defer rows.Close()
	entries := []Entry{}
	for rows.Next() {
		var idValue, sessionValue, dataValue any
		if err := rows.Scan(&idValue, &sessionValue, &dataValue); err != nil {
			continue
		}
		// rusqlite's read::<String> requires a TEXT value, so a NULL or a
		// numeric id skips the row instead of being coerced.
		rowID, ok := idValue.(string)
		if !ok {
			continue
		}
		rowSessionID, ok := sessionValue.(string)
		if !ok {
			continue
		}
		data, ok := dataValue.(string)
		if !ok {
			continue
		}
		entry, ok := kiloMessageEntry(data, rowID, rowSessionID, dbPath, o)
		if ok {
			entries = append(entries, entry)
		}
	}
	if err := rows.Err(); err != nil {
		o.debugf("Failed to query Kilo database: " + dbPath)
	}
	return entries
}

// kiloMessageEntry is message_value_to_entry (parser.rs:74-172).
func kiloMessageEntry(data, rowID, rowSessionID, dbPath string, o Options) (Entry, bool) {
	value, ok := decodeToolJSONValue([]byte(data))
	if !ok {
		return Entry{}, false
	}
	object, ok := LenientObject(value)
	if !ok {
		return Entry{}, false
	}
	// `role` is a plain Option<String> in the Rust struct, so anything but the
	// exact string "assistant" (including a non-string type) rejects the row.
	if role, _ := object["role"].(string); role != "assistant" {
		return Entry{}, false
	}
	tokens, ok := LenientObject(object["tokens"])
	if !ok {
		return Entry{}, false
	}
	cache, hasCache := LenientObject(tokens["cache"])
	usage := Usage{
		Input:  LenientU64(tokens["input"]),
		Output: LenientU64(tokens["output"]),
		// The reasoning count seeds the extra bucket before the reported total
		// fills whatever is still missing (parser.rs:88-99).
		Extra: LenientU64(tokens["reasoning"]),
	}
	if hasCache {
		usage.CacheCreation = LenientU64(cache["write"])
		usage.CacheRead = LenientU64(cache["read"])
	}
	ApplyTotalFallback(&usage, LenientU64(tokens["total"]))
	if usage.Total() == 0 {
		return Entry{}, false
	}
	model, ok := NonEmptyString(object["modelID"])
	if !ok {
		return Entry{}, false
	}
	timeObject, _ := LenientObject(object["time"])
	created, ok := kiloLenientI64(timeObject["created"])
	if !ok {
		return Entry{}, false
	}
	millis, ok := kiloNormalizeTimestamp(created)
	if !ok {
		return Entry{}, false
	}
	sessionID, ok := NonEmptyString(object["session_id"])
	if !ok {
		sessionID = rowSessionID
	}
	messageID, ok := NonEmptyString(object["id"])
	if !ok {
		messageID = dbPath + ":" + rowID
	}
	provider, _ := NonEmptyString(object["providerID"])
	entry := Entry{
		Timestamp:    millis,
		Date:         FormatDateTZ(millis, o.Timezone),
		Model:        model,
		Usage:        usage,
		ReportedCost: optionalFloat(object["cost"]),
		SessionID:    sessionID,
		MessageID:    messageID,
		ProjectPath:  "Kilo",
	}
	candidates := kiloModelCandidates(o.Corpus, model, provider)
	PriceEntry(o.Corpus, &entry, candidates, PriceAt(millis), o.Mode, LookupFindAt)
	// missing_kilo_pricing (parser.rs:225-241): a Display row is never missing,
	// a positive reported cost silences the diagnostic in every mode, and a
	// recorded zero does not - it falls through to the candidate check.
	if o.Mode == nativepricing.ModeDisplay || (entry.ReportedCost != nil && *entry.ReportedCost > 0) {
		entry.MissingPricing = false
	} else {
		entry.MissingPricing = kiloMissingPricing(o.Corpus, usage, candidates)
	}
	return entry, true
}

// kiloLenientI64 is jsonl::lenient_i64 / Value::as_i64: only an integer literal
// that fits i64, never a float or a string.
func kiloLenientI64(value any) (int64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	parsed, err := number.Int64()
	if err != nil {
		return 0, false
	}
	return parsed, true
}

// kiloNormalizeTimestamp is normalize_timestamp (parser.rs:174-184): a positive
// value below 1e12 is seconds and is scaled to milliseconds.
func kiloNormalizeTimestamp(value int64) (int64, bool) {
	if value <= 0 {
		return 0, false
	}
	if value < 1_000_000_000_000 {
		if value > math.MaxInt64/1000 {
			return 0, false
		}
		return value * 1000, true
	}
	return value, true
}

// kiloModelCandidates is model_candidates (parser.rs:243-258): the
// provider-qualified name joins the chain only when find_exact prices it, and
// the provider is normalized by replacing '-' with '_' after skipping the two
// placeholder providers.
func kiloModelCandidates(corpus nativepricing.Corpus, model, provider string) []string {
	candidates := []string{}
	if provider != "" {
		normalized := strings.ReplaceAll(provider, "-", "_")
		if normalized != "unknown" && normalized != "kilo" {
			qualified := normalized + "/" + model
			if _, ok := corpus.FindExact(qualified); ok {
				candidates = append(candidates, qualified)
			}
		}
	}
	candidates = append(candidates, model)
	seen := map[string]bool{}
	out := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if seen[candidate] {
			continue
		}
		seen[candidate] = true
		out = append(out, candidate)
	}
	return out
}

// kiloMissingPricing is missing_pricing_model_for_candidates (cost.rs:73-92):
// quiet on an empty usage, and otherwise missing only when every candidate
// misses the fuzzy lookup.
func kiloMissingPricing(corpus nativepricing.Corpus, usage Usage, candidates []string) bool {
	if usage.Total() == 0 {
		return false
	}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if _, ok := corpus.Find(candidate); ok {
			return false
		}
	}
	return true
}

// openToolReadOnlySQLiteDatabase opens one tool database read-only with the
// connection-scoped pragmas the Rust adapters set. mode=ro keeps the tool's own
// store immutable; query_only is belt and braces, and busy_timeout lets a
// concurrent writer finish instead of failing the read.
func openToolReadOnlySQLiteDatabase(path string) (*sql.DB, error) {
	escaped := strings.NewReplacer("%", "%25", "?", "%3F", "#", "%23").Replace(filepath.ToSlash(path))
	database, err := sql.Open("sqlite", "file:"+escaped+"?mode=ro&_pragma=busy_timeout(5000)&_pragma=query_only(1)")
	if err != nil {
		return nil, err
	}
	database.SetMaxOpenConns(1)
	return database, nil
}

// decodeToolJSONValue parses one JSON document the way serde_json::from_slice
// does: a whole document, a number preserved as json.Number, and trailing
// non-whitespace content rejected.
func decodeToolJSONValue(data []byte) (any, bool) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, false
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, false
	}
	return value, true
}
