// Package sqlite ports providers/sqlite-reader.ts: one read-only query against
// a tool's own SQLite database.
//
// The query must project scalar columns only. Callers narrow rows inside SQL
// (json_extract) rather than reading blobs into the collector, so prompt and
// path fields in a source database never enter this process.
//
// Two readers exist because the TypeScript collector has two: Node's built-in
// node:sqlite, and the `sqlite3` executable it falls back to. Go's analogue of
// the built-in is the embedded pure-Go SQLite driver, which is what a normal
// run uses; `sqlite3` remains behind TOKENBOARD_SQLITE_BIN so the environment
// contract carries over — a machine that forces the external reader keeps
// forcing it after switching a source from the TS collector to this one. Both
// paths open the database read-only, so a query can never mutate the tool's
// own store.
package sqlite

import (
	"bytes"
	"context"
	dbsql "database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/mtime"
)

// MaxOutputBytes is the default output ceiling, matching the TS reader's
// maxSqliteOutputBytes.
const MaxOutputBytes = 64 * 1024 * 1024

// AntigravityMaxOutputBytes is the larger ceiling the Antigravity sources
// carry: they project blobs as hex(data), which doubles them, and read a whole
// page of rows at a time.
const AntigravityMaxOutputBytes = 128 * 1024 * 1024

const defaultTimeout = 20 * time.Second

// RunQuery replaces both readers. Tests inject it to drive the query layer
// without a driver or a binary; it returns the query's JSON text.
type RunQuery func(dbFile, sql string) (string, error)

// StatFile is how the reader establishes a database's existence, so a caller
// can stage a missing file without touching the filesystem. Nil uses os.Stat.
type StatFile func(path string) (mtimeMs float64, err error)

// QueryOptions configures one read.
type QueryOptions struct {
	// SQLiteBin names the executable to run. Nil resolves
	// TOKENBOARD_SQLITE_BIN, then "sqlite3".
	SQLiteBin *string
	// RunQuery replaces both readers.
	RunQuery RunQuery
	// ForceExternal skips the embedded reader. Setting TOKENBOARD_SQLITE_BIN
	// also forces it, matching the TS collector — the variable is documented
	// as selecting the reader, not as changing behaviour.
	ForceExternal bool
	// Timeout bounds the external executable; zero means 20s.
	Timeout time.Duration
	// MaxOutputBytes is the output ceiling; zero means MaxOutputBytes.
	MaxOutputBytes int
	// Label names the tool in error messages, e.g. "OpenCode".
	Label string
}

// QueryJSONRows runs one read-only query and returns each result row as a
// plain object.
func QueryJSONRows(dbFile, sql string, options QueryOptions) ([]map[string]any, error) {
	if options.RunQuery != nil {
		text, err := options.RunQuery(dbFile, sql)
		if err != nil {
			return nil, err
		}
		return ParseJSONRows(text, dbFile, options.Label)
	}
	if !options.ForceExternal && !externalForced() {
		return queryEmbedded(dbFile, sql, options)
	}
	return queryExternal(dbFile, sql, options)
}

// externalForced reports whether TOKENBOARD_SQLITE_BIN is set at all. The TS
// collector tests the variable's presence rather than its value, so an empty
// value forces the external reader there too — and then fails, naming the
// empty binary.
func externalForced() bool {
	_, ok := os.LookupEnv("TOKENBOARD_SQLITE_BIN")
	return ok
}

func resolveSQLiteBin(explicit *string) string {
	if explicit != nil {
		return *explicit
	}
	if value, ok := os.LookupEnv("TOKENBOARD_SQLITE_BIN"); ok {
		return value
	}
	return "sqlite3"
}

func resolveMaxOutputBytes(options QueryOptions) int {
	if options.MaxOutputBytes != 0 {
		return options.MaxOutputBytes
	}
	return MaxOutputBytes
}

// queryEmbedded reads through the embedded driver, which ships in the binary.
//
// Columns arrive already typed, so there is no text round-trip. Integer
// columns are narrowed to float64 because a token count is far below the
// exactly-representable limit and the TS reader narrows its BigInt columns the
// same way; blob columns are dropped, since a projected token column is never
// a blob and passing one on would risk carrying opaque bytes forward.
func queryEmbedded(dbFile, sql string, options QueryOptions) ([]map[string]any, error) {
	database, err := openReadOnly(dbFile, options.Label)
	if err != nil {
		return nil, err
	}
	defer database.Close()

	rows, err := database.Query(sql)
	if err != nil {
		return nil, openError(err, dbFile, options.Label)
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		return nil, readError(err, dbFile, options.Label)
	}
	collected := []map[string]any{}
	for rows.Next() {
		values := make([]any, len(columns))
		targets := make([]any, len(columns))
		for index := range values {
			targets[index] = &values[index]
		}
		if err := rows.Scan(targets...); err != nil {
			return nil, readError(err, dbFile, options.Label)
		}
		row := make(map[string]any, len(columns))
		for index, column := range columns {
			switch value := values[index].(type) {
			case int64:
				row[column] = float64(value)
			case []byte:
				// Dropped rather than forwarded, matching the TS reader.
			default:
				row[column] = value
			}
		}
		collected = append(collected, row)
	}
	if err := rows.Err(); err != nil {
		return nil, readError(err, dbFile, options.Label)
	}
	if err := assertWithinOutputBudget(collected, options.Label, resolveMaxOutputBytes(options)); err != nil {
		return nil, err
	}
	return collected, nil
}

// openReadOnly opens a database through the embedded driver with a read-only
// DSN. SQLite's URI parser treats '?' and '#' as delimiters, so a path
// containing either would truncate into query syntax without escaping.
func openReadOnly(dbFile, label string) (*dbsql.DB, error) {
	database, err := dbsql.Open("sqlite", readOnlyDSN(dbFile))
	if err != nil {
		return nil, openError(err, dbFile, label)
	}
	return database, nil
}

// readOnlyDSN builds the driver URI for a read-only open.
func readOnlyDSN(dbFile string) string {
	escaped := strings.NewReplacer("%", "%25", "?", "%3F", "#", "%23").Replace(filepath.ToSlash(dbFile))
	return "file:" + escaped + "?mode=ro"
}

// queryExternal reads through the sqlite3 executable, for the environment
// contract and for the parity test that keeps the two readers honest.
// `-readonly` keeps the tool's database immutable and `-json` avoids
// delimiter-escaping guesswork.
func queryExternal(dbFile, sql string, options QueryOptions) ([]map[string]any, error) {
	stdout, err := runExternal(dbFile, sql, true, options)
	if err != nil {
		return nil, err
	}
	return ParseJSONRows(stdout, dbFile, options.Label)
}

// runExternal runs one query through the executable and returns its stdout.
// The context bounds the whole run, not just the wait after exit: a `sqlite3`
// blocked on a locked database would otherwise hold the collector open
// indefinitely, which is what the TS side's execFile timeout prevents.
func runExternal(dbFile, sql string, jsonMode bool, options QueryOptions) (string, error) {
	sqliteBin := resolveSQLiteBin(options.SQLiteBin)
	timeout := options.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}
	arguments := []string{"-readonly"}
	if jsonMode {
		arguments = append(arguments, "-json")
	}
	arguments = append(arguments, "-batch", dbFile, sql)

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	command := exec.CommandContext(ctx, sqliteBin, arguments...)
	command.WaitDelay = timeout
	limit := resolveMaxOutputBytes(options)
	stdout := &boundedStdout{limit: limit, cancel: cancel}
	var stderr bytes.Buffer
	command.Stdout = stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		if stdout.exceeded {
			return "", fmt.Errorf("%s SQLite result exceeded %d bytes", options.Label, limit)
		}
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
			return "", fmt.Errorf("%s SQLite reader unavailable: %s not found", options.Label, sqliteBin)
		}
		if missingDatabaseError(err, stderr.String(), dbFile) {
			return "", fmt.Errorf("%s database not found: %s", options.Label, dbFile)
		}
		if ctx.Err() != nil {
			return "", fmt.Errorf("Failed to read %s SQLite data from %s: timed out after %s",
				options.Label, dbFile, timeout)
		}
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return "", fmt.Errorf("Failed to read %s SQLite data from %s: %s", options.Label, dbFile, message)
	}
	if stdout.exceeded {
		return "", fmt.Errorf("%s SQLite result exceeded %d bytes", options.Label, limit)
	}
	return stdout.buffer.String(), nil
}

// boundedStdout enforces the output ceiling while the executable is still
// running. The post-run length check alone let a runaway result set grow the
// collector's heap without bound; this writer refuses the chunk that would
// cross the ceiling and cancels the context, which kills the reader instead of
// leaving it blocked on a full pipe. The TS side gets the same behaviour from
// execFile's maxBuffer.
type boundedStdout struct {
	buffer   bytes.Buffer
	limit    int
	cancel   context.CancelFunc
	exceeded bool
}

func (w *boundedStdout) Write(p []byte) (int, error) {
	if w.buffer.Len()+len(p) > w.limit {
		w.exceeded = true
		if w.cancel != nil {
			w.cancel()
		}
		return 0, errStdoutLimitExceeded
	}
	return w.buffer.Write(p)
}

var errStdoutLimitExceeded = errors.New("SQLite output exceeded the byte ceiling")

// missingDatabaseError mirrors the TS isSqliteOpenError: the executable could
// not open the file, and the file really is gone (rather than merely locked or
// unreadable, which is a different failure).
func missingDatabaseError(runErr error, stderr string, dbFile string) bool {
	var exitErr *exec.ExitError
	if !errors.As(runErr, &exitErr) || exitErr.ExitCode() != 1 {
		return false
	}
	if !strings.Contains(strings.ToLower(stderr), "unable to open database file") {
		return false
	}
	_, statErr := os.Stat(dbFile)
	return errors.Is(statErr, fs.ErrNotExist)
}

// openError classifies a failure to query. A database that vanished between
// the existence check and the open is reported as missing rather than as a
// read failure, which is what lets an all-source run skip it as unavailable.
func openError(err error, dbFile, label string) error {
	if missingFileError(err) {
		return fmt.Errorf("%s database not found: %s", label, dbFile)
	}
	var pathErr *fs.PathError
	if errors.As(err, &pathErr) {
		if missingFileError(pathErr.Err) {
			return fmt.Errorf("%s database not found: %s", label, dbFile)
		}
	}
	if strings.Contains(strings.ToLower(err.Error()), "unable to open database file") {
		if _, statErr := os.Stat(dbFile); errors.Is(statErr, fs.ErrNotExist) {
			return fmt.Errorf("%s database not found: %s", label, dbFile)
		}
	}
	return fmt.Errorf("Failed to read %s SQLite data from %s: %s", label, dbFile, err.Error())
}

func readError(err error, dbFile, label string) error {
	return fmt.Errorf("Failed to read %s SQLite data from %s: %s", label, dbFile, err.Error())
}

func missingFileError(err error) bool {
	return errors.Is(err, fs.ErrNotExist)
}

// assertWithinOutputBudget applies to the embedded reader the same ceiling the
// executable's own output cap applies to the external one. Without it the two
// readers disagree at the top of the range, which would make
// TOKENBOARD_SQLITE_BIN — documented as selecting the reader, not as changing
// behaviour — turn a working collection into a failing one.
//
// Rows are measured as `sqlite3 -json` would print them: the document framing
// is the two brackets, a `,\n` between each pair of rows, and a trailing
// newline, so 2n+1 bytes for a non-empty result. The check runs after the rows
// are materialised, so it bounds which result sets the reader accepts, not
// peak memory.
func assertWithinOutputBudget(rows []map[string]any, label string, maxOutputBytes int) error {
	bytes := 0
	if len(rows) > 0 {
		bytes = len(rows)*2 + 1
	}
	for _, row := range rows {
		encoded, err := marshalRow(row)
		if err != nil {
			// A value that cannot be serialised is not something this budget
			// can measure; the row is passed on and rejected by the caller's
			// own validation.
			continue
		}
		bytes += len(encoded)
		if bytes > maxOutputBytes {
			return fmt.Errorf("%s SQLite result exceeded %d bytes", label, maxOutputBytes)
		}
	}
	return nil
}

// marshalRow encodes a row the way JSON.stringify does: no HTML escaping, so a
// model id containing '<' is not inflated to a six-byte escape.
func marshalRow(row map[string]any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(row); err != nil {
		return nil, err
	}
	// Encode appends a newline JSON.stringify does not produce.
	return bytes.TrimRight(buffer.Bytes(), "\n"), nil
}

// ParseJSONRows reads the `sqlite3 -json` document shape: nothing at all for
// an empty result, a JSON array otherwise.
func ParseJSONRows(stdout, dbFile, label string) ([]map[string]any, error) {
	trimmed := strings.TrimSpace(stdout)
	if trimmed == "" {
		return []map[string]any{}, nil
	}
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	var parsed any
	if err := decoder.Decode(&parsed); err != nil {
		return nil, fmt.Errorf("Invalid %s SQLite JSON output from %s: %s", label, dbFile, err.Error())
	}
	items, ok := parsed.([]any)
	if !ok {
		return nil, fmt.Errorf("Unexpected %s SQLite JSON output from %s", label, dbFile)
	}
	rows := make([]map[string]any, 0, len(items))
	for _, item := range items {
		row, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("Unexpected %s SQLite JSON row from %s", label, dbFile)
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// DatabaseMtimeMs is the latest mtime across a SQLite database and its WAL
// sidecars. A database in WAL mode commits into `-wal` first and only updates
// the main file at checkpoint, so watching the main file alone misses usage
// written since the last checkpoint.
func DatabaseMtimeMs(dbFile string, statFile StatFile) (float64, error) {
	if statFile == nil {
		statFile = statMtimeMs
	}
	latest, err := statFile(dbFile)
	if err != nil {
		return 0, err
	}
	for _, sidecar := range []string{dbFile + "-wal", dbFile + "-shm"} {
		mtime, err := statFile(sidecar)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return 0, err
		}
		if mtime > latest {
			latest = mtime
		}
	}
	return latest, nil
}

func statMtimeMs(path string) (float64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return mtime.Millis(info.ModTime()), nil
}

// IsMissingFileError reports whether an error is a missing file, which callers
// turn into "the tool is not installed here" rather than a failure.
func IsMissingFileError(err error) bool {
	return errors.Is(err, fs.ErrNotExist)
}
