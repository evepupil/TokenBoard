// Package antigravityhistory ports antigravity-history-db.ts: turning
// Antigravity's SQLite generator-metadata rows into usage events.
//
// The scan is bounded and resumable. A conversations directory can hold many
// databases, each with an append-only row log, so a run reads a bounded number
// of them and remembers, per database, the highest row index it acknowledged
// plus a hash of that row's blob. The hash is the continuity anchor: if a
// database is rebuilt (compacted, recreated), the row at the remembered index
// no longer hashes the same, and the run fails loudly instead of silently
// re-ingesting or skipping history.
//
// Nothing beyond token metadata leaves this package: rows are projected as
// `idx, hex(data)` inside SQL, and the parsed events carry only hashes, a
// model, a timestamp and token counts.
package antigravityhistory

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravityscan"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/collate"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/mtime"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sqlite"
)

const (
	// SQLiteTimeout bounds one metadata query.
	SQLiteTimeout = 15 * time.Second
	// DefaultMaxDbFiles is the per-run database read budget when the caller
	// does not choose one.
	DefaultMaxDbFiles = 64
	// GeneratorMetadataRowsPageSize is how many rows one query returns. A
	// short page ends the paging loop.
	GeneratorMetadataRowsPageSize = 500
	// scanLimitFloor and scanLimitCeiling bound how many database files one
	// pass is willing to stat. The budget scales with the read budget, but a
	// directory listing must never turn into an unbounded stat storm.
	scanLimitFloor   = 16
	scanLimitCeiling = 512
)

// cascadeIDPattern mirrors antigravity-history-db.ts's cascadeIdPattern, which
// is compiled with the `i` flag: an uppercase-hex database filename is a
// conversation there, so it must be one here too.
var cascadeIDPattern = regexp.MustCompile(
	`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// StatResult is what a caller's stat reports about a database file.
type StatResult struct {
	MtimeMs float64
	Size    int64
}

// StatFile is how a candidate's freshness is established. Nil uses os.Stat.
type StatFile func(path string) (StatResult, error)

// ListFiles streams a directory's entries. It mirrors the TS side's
// AsyncIterable<AntigravityDirectoryEntry>: yielding through a callback lets
// the entry cap stop the walk. Nil reads the real directory.
type ListFiles func(directoryPath string, yield func(antigravityscan.DirectoryEntry) error) error

// ReadSQLite replaces the reader entirely. It returns the query's text output
// in the CLI's `idx|hex` rendering, not JSON. It is the same shape as the
// shared reader's RunQuery, so a caller can inject one function for both.
type ReadSQLite = sqlite.RunQuery

// Result is one scan's outcome.
type Result struct {
	// CascadeIDs holds the conversations that produced at least one event.
	CascadeIDs map[string]bool
	Events     []antigravitymeta.UsageEvent
	// CompleteDirectoryScan reports whether every eligible database was read.
	// A full-history run requires it; a bounded run may legitimately stop
	// short, which is why it is reported rather than assumed.
	CompleteDirectoryScan bool
	// KnownCascadeIDs is every conversation the directory listing named,
	// whether or not this pass read it.
	KnownCascadeIDs map[string]bool
	// LastReadRowIndexByCascade is the row cursor each read database reached,
	// keyed by conversation id (not hash) as the TS result is.
	LastReadRowIndexByCascade map[string]int64
}

// Options configures one scan.
type Options struct {
	ConversationDir string
	// SQLiteBin names the executable to run. Nil resolves
	// TOKENBOARD_SQLITE_BIN, then "sqlite3".
	SQLiteBin  *string
	ReadSQLite ReadSQLite
	// LastSeenRowIndexByCascadeHash is the acknowledged row cursor per
	// conversation hash. Nil means none, so every database is unread.
	LastSeenRowIndexByCascadeHash map[string]int64
	// MaxDbFiles is the read budget in databases per run. Nil selects
	// DefaultMaxDbFiles; a value is clamped into [1, DefaultMaxDbFiles], so a
	// caller cannot widen the bound the source is documented to keep.
	MaxDbFiles *int
	// UnboundedDbFiles reads every eligible database, which the TS side
	// spells `null`. It is only valid for a full-history run: a bounded run
	// that read everything would defeat the point of the budget. It takes
	// precedence over MaxDbFiles.
	UnboundedDbFiles bool
	StatFile         StatFile
	ListFiles        ListFiles
	// ScanState carries the bounded scan bookkeeping and the per-database row
	// anchors between runs. Nil disables both, which is what an unbounded
	// caller that does not persist state wants.
	ScanState *antigravityscan.FileScanState
	SinceDate string
	Timezone  string
	// DetectRowCursorReset turns on the continuity anchors. It is only
	// meaningful once a cursor exists: with no cursor there is nothing to
	// anchor to, and every database is read from the start anyway.
	DetectRowCursorReset bool
	// RequireCompleteDirectoryScan fails the run when any enumerated database
	// could not be read, rather than reporting it and moving on.
	RequireCompleteDirectoryScan bool
	// SourceLabel names the source in that failure message.
	SourceLabel string
	// ForceFullScanCascadeHashes are conversations whose anchor is unusable
	// and which therefore must be rebuilt from row zero.
	ForceFullScanCascadeHashes map[string]bool
}

// RowCursorResetError reports that a database's row log no longer matches the
// remembered anchor: the database was rebuilt under a cursor that still points
// into the old log. Continuing would either double-count or silently drop
// history, so the run stops and asks for a full rescan.
type RowCursorResetError struct{ DBFile string }

func (e *RowCursorResetError) Error() string {
	return fmt.Sprintf(
		"Antigravity SQLite metadata cursor reset detected for %s; rerun with --since all", e.DBFile)
}

// IsRowCursorResetError reports whether err is a cursor-reset failure.
func IsRowCursorResetError(err error) bool {
	var reset *RowCursorResetError
	return errors.As(err, &reset)
}

// metadataRow is one `idx|hex` row from gen_metadata.
type metadataRow struct {
	Index int64
	Data  []byte
}

// dbFileCandidate is one database under consideration for a read.
type dbFileCandidate struct {
	FilePath                string
	MtimeMs                 float64
	Size                    int64
	MetadataRowHighWater    *int64
	MetadataCursorRowIndex  *int64
	MetadataCursorRowSHA256 *string
}

// ReadUsageEvents scans a conversations directory and returns the usage events
// it found, plus the bookkeeping a caller needs to resume.
func ReadUsageEvents(options Options) (Result, error) {
	statFile := options.StatFile
	if statFile == nil {
		statFile = statMtimeMs
	}
	listFiles := options.ListFiles
	if listFiles == nil {
		listFiles = antigravityscan.ListDirectoryEntries
	}
	lastSeen := options.LastSeenRowIndexByCascadeHash
	if lastSeen == nil {
		lastSeen = map[string]int64{}
	}

	listing, err := listDbFiles(options, statFile, listFiles, lastSeen)
	if err != nil {
		return Result{}, err
	}
	result := Result{
		CascadeIDs:                map[string]bool{},
		Events:                    []antigravitymeta.UsageEvent{},
		CompleteDirectoryScan:     listing.completeDirectoryScan,
		KnownCascadeIDs:           listing.knownCascadeIDs,
		LastReadRowIndexByCascade: map[string]int64{},
	}

	for _, dbFile := range listing.dbFiles {
		cascadeID := strings.TrimSuffix(filepath.Base(dbFile.FilePath), ".db")
		cascadeHash := hashString(cascadeID)
		forceFullScan := options.ForceFullScanCascadeHashes[cascadeHash]
		fallbackCreatedAt := isoMillis(dbFile.MtimeMs)
		beforeCount := len(result.Events)

		var lastSeenRowIndex *int64
		if !forceFullScan {
			if value, ok := lastSeen[cascadeHash]; ok {
				lastSeenRowIndex = &value
			}
		}
		lastReadRowIndex := normalizeLastSeenRowIndex(lastSeenRowIndex)

		previousCursorMatches := dbFile.MetadataCursorRowIndex != nil &&
			*dbFile.MetadataCursorRowIndex == lastReadRowIndex
		var metadataRowHighWater *int64
		var metadataCursorRowIndex *int64
		var metadataCursorRowSHA256 *string
		if previousCursorMatches && lastReadRowIndex >= 0 {
			value := lastReadRowIndex
			metadataCursorRowIndex = &value
		}
		if previousCursorMatches {
			metadataCursorRowSHA256 = dbFile.MetadataCursorRowSHA256
		}

		pageOptions := rowPageOptions{
			sqliteBin:            resolveSQLiteBin(options.SQLiteBin),
			readSQLite:           options.ReadSQLite,
			lastSeenRowIndex:     lastSeenRowIndex,
			detectRowCursorReset: !forceFullScan && options.DetectRowCursorReset,
			previousHighWater:    dbFile.MetadataRowHighWater,
		}
		// The anchors are only meaningful when the stored cursor index names
		// the row the cursor itself acknowledges; an unpaired index would be
		// compared against a different row's blob.
		if previousCursorMatches {
			pageOptions.previousCursorRowIndex = dbFile.MetadataCursorRowIndex
			pageOptions.previousCursorRowSHA256 = dbFile.MetadataCursorRowSHA256
		}
		if options.ScanState != nil {
			pageOptions.onHighWaterMark = func(value int64) { metadataRowHighWater = &value }
			pageOptions.onLastRow = func(row metadataRow) {
				digest := hashBytes(row.Data)
				metadataCursorRowIndex = &row.Index
				metadataCursorRowSHA256 = &digest
			}
		}

		err := readGeneratorMetadataRows(dbFile.FilePath, pageOptions, func(row metadataRow) error {
			events, err := antigravitymeta.ParseGeneratorMetadataBlobEvents(row.Data, antigravitymeta.BlobOptions{
				CascadeID:         cascadeID,
				RowIndex:          row.Index,
				FallbackCreatedAt: fallbackCreatedAt,
			})
			if err != nil {
				return err
			}
			lastReadRowIndex = row.Index
			for _, event := range events {
				result.Events = append(result.Events, withLegacyCascadeAlias(event, cascadeID))
			}
			return nil
		})
		if err != nil {
			return Result{}, err
		}

		if metadataCursorRowIndex == nil && lastReadRowIndex < 0 {
			// An empty database still needs an anchor, or the next run cannot
			// tell "read and found nothing" from "never read".
			empty := int64(-1)
			digest := hashBytes(nil)
			metadataCursorRowIndex = &empty
			metadataCursorRowSHA256 = &digest
		}
		if options.ScanState != nil {
			writeMetadata(options.ScanState, cascadeID, dbFileMetadata{
				MetadataRowHighWater:    metadataRowHighWater,
				MetadataCursorRowIndex:  metadataCursorRowIndex,
				MetadataCursorRowSHA256: metadataCursorRowSHA256,
			}, &dbFile)
		}
		result.LastReadRowIndexByCascade[cascadeID] = lastReadRowIndex
		if len(result.Events) > beforeCount {
			result.CascadeIDs[cascadeID] = true
		}
	}
	return result, nil
}

// withLegacyCascadeAlias records the conversation hash the earlier
// antigravity-cli cursor used for the same conversation, so a snapshot
// collected before the hashing changed is still recognised as the same usage.
func withLegacyCascadeAlias(event antigravitymeta.UsageEvent, cascadeID string) antigravitymeta.UsageEvent {
	legacyHash := legacyConversationHash(cascadeID)
	if legacyHash == event.CascadeHash {
		return event
	}
	aliases := append([]string{}, event.CascadeHashAliases...)
	aliases = append(aliases, legacyHash)
	event.CascadeHashAliases = aliases
	return event
}

func legacyConversationHash(value string) string {
	digest := sha256.New()
	digest.Write([]byte("tokenboard-antigravity-cli\x00"))
	digest.Write([]byte(value))
	return hex.EncodeToString(digest.Sum(nil))
}

type dbListing struct {
	dbFiles               []dbFileCandidate
	completeDirectoryScan bool
	knownCascadeIDs       map[string]bool
}

func listDbFiles(options Options, statFile StatFile, listFiles ListFiles, lastSeen map[string]int64) (dbListing, error) {
	maxDbFiles := normalizeMaxDbFiles(options)
	names, err := antigravityscan.ListDirectoryEntryNames(func(yield func(antigravityscan.DirectoryEntry) error) error {
		return listFiles(options.ConversationDir, yield)
	})
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return dbListing{}, fmt.Errorf("Antigravity conversations directory not found: %s", options.ConversationDir)
		}
		return dbListing{}, err
	}
	eligible := make([]string, 0, len(names))
	for _, name := range names {
		if filepath.Ext(name) != ".db" {
			continue
		}
		if !cascadeIDPattern.MatchString(strings.TrimSuffix(name, ".db")) {
			continue
		}
		eligible = append(eligible, name)
	}

	includeFileMtime := buildFileMtimeFilter(options.SinceDate, options.Timezone)

	if maxDbFiles == nil {
		// Unbounded: every eligible database is stat'd, and a single unreadable
		// one makes the directory scan incomplete rather than invisible.
		candidates := make([]*dbFileCandidate, 0, len(eligible))
		completeDirectoryScan := true
		for _, name := range eligible {
			candidate, err := readDbFileCandidate(filepath.Join(options.ConversationDir, name), statFile)
			if err != nil {
				return dbListing{}, err
			}
			if candidate == nil {
				completeDirectoryScan = false
				candidates = append(candidates, nil)
				continue
			}
			metadata := readMetadata(options.ScanState, strings.TrimSuffix(name, ".db"))
			candidate.MetadataRowHighWater = metadata.MetadataRowHighWater
			candidate.MetadataCursorRowIndex = metadata.MetadataCursorRowIndex
			candidate.MetadataCursorRowSHA256 = metadata.MetadataCursorRowSHA256
			candidates = append(candidates, candidate)
		}
		if options.RequireCompleteDirectoryScan && !completeDirectoryScan {
			label := options.SourceLabel
			if label == "" {
				label = "Antigravity CLI"
			}
			return dbListing{}, fmt.Errorf(
				"%s full history scan could not read every enumerated SQLite database; "+
					"retry after the conversations directory is stable", label)
		}
		included := make([]dbFileCandidate, 0, len(candidates))
		for _, candidate := range candidates {
			if candidate == nil {
				continue
			}
			if shouldIncludeDbCandidate(*candidate, lastSeen, includeFileMtime, options.ForceFullScanCascadeHashes) {
				included = append(included, *candidate)
			}
		}
		known := make(map[string]bool, len(eligible))
		for _, name := range eligible {
			known[strings.TrimSuffix(name, ".db")] = true
		}
		return dbListing{
			dbFiles:               sortDbCandidates(included),
			completeDirectoryScan: completeDirectoryScan,
			knownCascadeIDs:       known,
		}, nil
	}

	// Bounded: only a slice of the directory is stat'd, chosen so that newly
	// discovered files and previously seen ones both get a turn.
	scanState := options.ScanState
	if scanState == nil {
		empty := antigravityscan.NewFileScanState()
		scanState = &empty
	}
	checkedSequence, err := antigravityscan.BeginFileScan(scanState)
	if err != nil {
		return dbListing{}, err
	}
	scanLimit := *maxDbFiles * 8
	if scanLimit < scanLimitFloor {
		scanLimit = scanLimitFloor
	}
	if scanLimit > scanLimitCeiling {
		scanLimit = scanLimitCeiling
	}
	ids := make([]string, 0, len(eligible))
	for _, name := range eligible {
		ids = append(ids, strings.TrimSuffix(name, ".db"))
	}
	antigravityscan.PruneFileScanState(scanState, ids)

	forcedIDs := make([]string, 0, len(ids))
	forcedSet := map[string]bool{}
	for _, id := range ids {
		if options.ForceFullScanCascadeHashes[hashString(id)] {
			forcedIDs = append(forcedIDs, id)
			forcedSet[id] = true
		}
	}
	selectedIDs := antigravityscan.SelectFileScanIds(ids, scanState, scanLimit)
	scanIDs := append([]string{}, forcedIDs...)
	for _, id := range selectedIDs {
		if !forcedSet[id] {
			scanIDs = append(scanIDs, id)
		}
	}

	allScannedDbFilesReadable := true
	for _, id := range scanIDs {
		filePath := filepath.Join(options.ConversationDir, id+".db")
		metadata := readMetadata(scanState, id)
		candidate, err := readDbFileCandidate(filePath, statFile)
		if err != nil {
			return dbListing{}, err
		}
		if candidate == nil {
			// The file was enumerated but vanished before it could be stat'd.
			allScannedDbFilesReadable = false
			antigravityscan.RemoveFileScanEntry(scanState, id)
			continue
		}
		antigravityscan.MarkFileScanned(scanState, id, antigravityscan.FileScanEntry{
			MtimeMs:         candidate.MtimeMs,
			Size:            candidate.Size,
			HasDatabaseFile: true,
		}, checkedSequence)
		writeMetadata(scanState, id, metadata, nil)
	}

	candidates := make([]dbFileCandidate, 0, len(ids))
	for _, id := range ids {
		entry, ok := antigravityscan.ReadFileScanEntry(scanState, id)
		if !ok {
			continue
		}
		metadata := readMetadata(scanState, id)
		candidate := dbFileCandidate{
			FilePath:                filepath.Join(options.ConversationDir, id+".db"),
			MtimeMs:                 entry.MtimeMs,
			Size:                    entry.Size,
			MetadataRowHighWater:    metadata.MetadataRowHighWater,
			MetadataCursorRowIndex:  metadata.MetadataCursorRowIndex,
			MetadataCursorRowSHA256: metadata.MetadataCursorRowSHA256,
		}
		if shouldIncludeDbCandidate(candidate, lastSeen, includeFileMtime, options.ForceFullScanCascadeHashes) {
			candidates = append(candidates, candidate)
		}
	}

	sorted := sortDbCandidates(candidates)
	var forced, unread, processed []dbFileCandidate
	for _, candidate := range sorted {
		if isForcedFullScanCandidate(candidate, options.ForceFullScanCascadeHashes) {
			forced = append(forced, candidate)
			continue
		}
		if hasDbRowCursor(candidate.FilePath, lastSeen) {
			processed = append(processed, candidate)
		} else {
			unread = append(unread, candidate)
		}
	}
	// A forced rebuild is a repair, not a routine read: it must not be pushed
	// out of the budget by the backlog it exists to fix.
	unread = append(forced, unread...)
	dbFiles := selectDbReadCandidates(unread, processed, *maxDbFiles, checkedSequence)

	return dbListing{
		dbFiles: dbFiles,
		completeDirectoryScan: allScannedDbFilesReadable &&
			len(scanIDs) == len(ids) && len(dbFiles) == len(candidates),
		knownCascadeIDs: setOf(ids),
	}, nil
}

func isForcedFullScanCandidate(candidate dbFileCandidate, forced map[string]bool) bool {
	return forced[hashString(strings.TrimSuffix(filepath.Base(candidate.FilePath), ".db"))]
}

func buildFileMtimeFilter(sinceDate, timezone string) func(float64) bool {
	if sinceDate == "" || timezone == "" {
		return func(float64) bool { return true }
	}
	return func(mtimeMs float64) bool {
		return antigravityscan.FormatDate(time.UnixMilli(int64(mtimeMs)), timezone) >= sinceDate
	}
}

// shouldIncludeDbCandidate keeps an unread database regardless of its age —
// its usage has never been collected — and applies the since filter only to
// databases that have a cursor, whose older rows were already accounted for.
func shouldIncludeDbCandidate(
	candidate dbFileCandidate,
	lastSeen map[string]int64,
	includeFileMtime func(float64) bool,
	forced map[string]bool,
) bool {
	cascadeHash := hashString(strings.TrimSuffix(filepath.Base(candidate.FilePath), ".db"))
	if forced[cascadeHash] {
		return true
	}
	return !hasDbRowCursor(candidate.FilePath, lastSeen) || includeFileMtime(candidate.MtimeMs)
}

// sortDbCandidates orders by freshness, with the path as a stable tiebreak so
// two databases written in the same millisecond still read in a fixed order.
func sortDbCandidates(candidates []dbFileCandidate) []dbFileCandidate {
	sorted := append([]dbFileCandidate{}, candidates...)
	sort.SliceStable(sorted, func(left, right int) bool {
		if sorted[left].MtimeMs != sorted[right].MtimeMs {
			return sorted[left].MtimeMs > sorted[right].MtimeMs
		}
		return collate.Less(sorted[left].FilePath, sorted[right].FilePath)
	})
	return sorted
}

// selectDbReadCandidates splits the budget between never-read databases and
// already-processed ones. Reading only the backlog would never refresh a file
// that is still being written; reading only processed ones would never pick up
// a new conversation.
func selectDbReadCandidates(unread, processed []dbFileCandidate, limit int, sequence int64) []dbFileCandidate {
	if len(unread) == 0 {
		return processed[:min(limit, len(processed))]
	}
	if len(processed) == 0 {
		return unread[:min(limit, len(unread))]
	}
	if limit == 1 {
		// One slot: alternate by sequence so neither group starves.
		if sequence%2 == 0 {
			return unread[:1]
		}
		return processed[:1]
	}
	unreadCapacity := min(len(unread), ceilDiv(limit, 2))
	processedCapacity := min(len(processed), limit-unreadCapacity)
	remaining := limit - unreadCapacity - processedCapacity
	extraUnread := min(len(unread)-unreadCapacity, remaining)
	unreadCapacity += extraUnread
	remaining -= extraUnread
	processedCapacity += min(len(processed)-processedCapacity, remaining)
	return append(append([]dbFileCandidate{}, unread[:unreadCapacity]...), processed[:processedCapacity]...)
}

func hasDbRowCursor(filePath string, lastSeen map[string]int64) bool {
	_, ok := lastSeen[hashString(strings.TrimSuffix(filepath.Base(filePath), ".db"))]
	return ok
}

func readDbFileCandidate(filePath string, statFile StatFile) (*dbFileCandidate, error) {
	info, err := statFile(filePath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	// A database in WAL mode commits into `-wal` first and only updates the
	// main file at checkpoint, so the main file's mtime can lag the data. The
	// sidecar is read through the real filesystem even when the caller injected
	// a stat: the injection exists to stage the database itself, and the TS
	// side reads its WAL the same way.
	walMtime, err := readWalMtime(filePath)
	if err != nil {
		return nil, err
	}
	mtimeMs := info.MtimeMs
	if walMtime != nil && *walMtime > mtimeMs {
		mtimeMs = *walMtime
	}
	return &dbFileCandidate{FilePath: filePath, MtimeMs: mtimeMs, Size: info.Size}, nil
}

func readWalMtime(dbFilePath string) (*float64, error) {
	info, err := os.Stat(dbFilePath + "-wal")
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	mtimeMs := mtime.Millis(info.ModTime())
	return &mtimeMs, nil
}

func statMtimeMs(path string) (StatResult, error) {
	info, err := os.Stat(path)
	if err != nil {
		return StatResult{}, err
	}
	return StatResult{
		MtimeMs: mtime.Millis(info.ModTime()),
		Size:    info.Size(),
	}, nil
}

// normalizeMaxDbFiles resolves the caller's budget. A nil result means
// unbounded; otherwise the value is clamped into [1, DefaultMaxDbFiles].
func normalizeMaxDbFiles(options Options) *int {
	if options.UnboundedDbFiles {
		return nil
	}
	defaultValue := DefaultMaxDbFiles
	if options.MaxDbFiles == nil {
		return &defaultValue
	}
	clamped := *options.MaxDbFiles
	if clamped < 1 {
		clamped = 1
	}
	if clamped > DefaultMaxDbFiles {
		clamped = DefaultMaxDbFiles
	}
	return &clamped
}

type dbFileMetadata struct {
	MetadataRowHighWater    *int64
	MetadataCursorRowIndex  *int64
	MetadataCursorRowSHA256 *string
}

// readMetadata reads the row anchors a previous run stored beside the file
// scan entry, discarding any value that is not a plausible anchor rather than
// trusting it.
func readMetadata(scanState *antigravityscan.FileScanState, cascadeID string) dbFileMetadata {
	if scanState == nil {
		return dbFileMetadata{}
	}
	entry, ok := antigravityscan.ReadFileScanEntry(scanState, cascadeID)
	if !ok {
		return dbFileMetadata{}
	}
	return dbFileMetadata{
		MetadataRowHighWater:    validMetadataRowIndex(entry.MetadataRowHighWater),
		MetadataCursorRowIndex:  validMetadataRowIndex(entry.MetadataCursorRowIndex),
		MetadataCursorRowSHA256: validMetadataRowHash(entry.MetadataCursorRowSHA256),
	}
}

// writeMetadata stores the anchors. candidate is only used to create the entry
// when the scan has not written one yet.
func writeMetadata(
	scanState *antigravityscan.FileScanState,
	cascadeID string,
	metadata dbFileMetadata,
	candidate *dbFileCandidate,
) {
	entry, ok := antigravityscan.ReadFileScanEntry(scanState, cascadeID)
	if !ok {
		if candidate == nil {
			return
		}
		entry = antigravityscan.FileScanEntry{
			MtimeMs:         candidate.MtimeMs,
			Size:            candidate.Size,
			HasDatabaseFile: true,
			CheckedSequence: scanState.NextSequence,
		}
	}
	entry.MetadataRowHighWater = metadata.MetadataRowHighWater
	entry.MetadataCursorRowIndex = metadata.MetadataCursorRowIndex
	entry.MetadataCursorRowSHA256 = metadata.MetadataCursorRowSHA256
	antigravityscan.MarkFileScanned(scanState, cascadeID, entry, entry.CheckedSequence)
}

func validMetadataRowIndex(value *int64) *int64 {
	if value == nil || *value < -1 {
		return nil
	}
	return value
}

var sha256HexPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func validMetadataRowHash(value *string) *string {
	if value == nil || !sha256HexPattern.MatchString(*value) {
		return nil
	}
	return value
}

type rowPageOptions struct {
	sqliteBin               string
	readSQLite              ReadSQLite
	lastSeenRowIndex        *int64
	detectRowCursorReset    bool
	previousHighWater       *int64
	previousCursorRowIndex  *int64
	previousCursorRowSHA256 *string
	onHighWaterMark         func(int64)
	onLastRow               func(metadataRow)
}

// readGeneratorMetadataRows pages a database's row log from the cursor
// forward, yielding each row and reporting the anchors the caller must persist.
//
// The reset detection is the reason this is not a plain loop: before
// acknowledging anything, the run proves the remembered anchor still describes
// the row it names, and proves the log has not shrunk below the cursor.
func readGeneratorMetadataRows(dbFile string, options rowPageOptions, yield func(metadataRow) error) error {
	lastSeenRowIndex := normalizeLastSeenRowIndex(options.lastSeenRowIndex)
	initialLastSeenRowIndex := lastSeenRowIndex
	anchorsChecked := false
	highWaterChecked := false
	for {
		if !anchorsChecked && options.detectRowCursorReset && initialLastSeenRowIndex >= 0 {
			hasPreviousCursorRowIndex := options.previousCursorRowIndex != nil
			hasPreviousCursorRowSHA256 := options.previousCursorRowSHA256 != nil
			if hasPreviousCursorRowIndex != hasPreviousCursorRowSHA256 {
				return &RowCursorResetError{DBFile: dbFile}
			}
			if options.onHighWaterMark != nil &&
				(options.previousHighWater == nil || options.previousCursorRowSHA256 == nil) {
				// A cursor with no continuity anchor cannot be verified, so it
				// is treated as a reset rather than trusted.
				return &RowCursorResetError{DBFile: dbFile}
			}
			if err := assertGeneratorMetadataAnchors(dbFile, options); err != nil {
				return err
			}
			anchorsChecked = true
		}

		rows, err := readGeneratorMetadataRowPage(dbFile, options.sqliteBin, options.readSQLite, lastSeenRowIndex)
		if err != nil {
			return err
		}
		shouldCheckHighWater := !highWaterChecked && options.detectRowCursorReset && initialLastSeenRowIndex >= 0
		var highestRowIndex *int64
		if shouldCheckHighWater {
			highestRowIndex, err = readHighestGeneratorMetadataRowIndex(dbFile, options.sqliteBin, options.readSQLite)
			if err != nil {
				return err
			}
		}
		highWaterChecked = true
		if options.onHighWaterMark != nil {
			options.onHighWaterMark(highWaterOrDefault(highestRowIndex, rows, lastSeenRowIndex))
		}

		if len(rows) == 0 {
			if options.detectRowCursorReset && initialLastSeenRowIndex >= 0 &&
				belowCursor(highestRowIndex, initialLastSeenRowIndex, options.previousHighWater, lastSeenRowIndex) {
				return &RowCursorResetError{DBFile: dbFile}
			}
			return nil
		}
		if options.detectRowCursorReset && initialLastSeenRowIndex >= 0 &&
			belowCursor(highestRowIndex, initialLastSeenRowIndex, options.previousHighWater, lastSeenRowIndex) {
			return &RowCursorResetError{DBFile: dbFile}
		}

		if options.onLastRow != nil {
			options.onLastRow(rows[len(rows)-1])
		}
		for _, row := range rows {
			if err := yield(row); err != nil {
				return err
			}
		}

		nextLastSeenRowIndex := rows[len(rows)-1].Index
		if len(rows) < GeneratorMetadataRowsPageSize {
			return nil
		}
		if nextLastSeenRowIndex <= lastSeenRowIndex {
			return fmt.Errorf("Antigravity SQLite metadata cursor did not advance for %s", dbFile)
		}
		lastSeenRowIndex = nextLastSeenRowIndex
	}
}

// highWaterOrDefault resolves the value to persist as the high-water mark: the
// log's true maximum when it was read, else the last row seen, else the cursor
// the run started from.
func highWaterOrDefault(highest *int64, rows []metadataRow, lastSeenRowIndex int64) int64 {
	if highest != nil {
		return *highest
	}
	if len(rows) > 0 {
		return rows[len(rows)-1].Index
	}
	return lastSeenRowIndex
}

// belowCursor reports whether the log's high-water mark has fallen below what
// the cursor already acknowledged, which means the database was rebuilt.
func belowCursor(highest *int64, initialLastSeen int64, previousHighWater *int64, lastSeenRowIndex int64) bool {
	effective := lastSeenRowIndex
	if highest != nil {
		effective = *highest
	}
	if effective < initialLastSeen {
		return true
	}
	return previousHighWater != nil && effective < *previousHighWater
}

// assertGeneratorMetadataAnchors proves the remembered row still exists at the
// remembered index with the remembered content. Without this a rebuilt
// database whose log happens to be longer than the cursor would silently pass
// the high-water check and re-ingest unrelated rows.
func assertGeneratorMetadataAnchors(dbFile string, options rowPageOptions) error {
	hasPreviousCursorRowIndex := options.previousCursorRowIndex != nil
	hasPreviousCursorRowSHA256 := options.previousCursorRowSHA256 != nil
	if hasPreviousCursorRowIndex != hasPreviousCursorRowSHA256 {
		return &RowCursorResetError{DBFile: dbFile}
	}
	if !hasPreviousCursorRowIndex {
		return nil
	}
	anchors := []int64{*options.previousCursorRowIndex}
	indexes := make([]string, 0, len(anchors))
	for _, anchor := range anchors {
		indexes = append(indexes, strconv.FormatInt(anchor, 10))
	}
	sql := fmt.Sprintf("select idx, hex(data) from gen_metadata where idx in (%s) order by idx",
		strings.Join(indexes, ", "))
	stdout, err := readSQLiteOutput(dbFile, options.sqliteBin, sql, options.readSQLite)
	if err != nil {
		return err
	}
	rows, err := parseSQLiteRows(stdout, dbFile)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if row.Index != *options.previousCursorRowIndex {
			continue
		}
		if hashBytes(row.Data) == *options.previousCursorRowSHA256 {
			return nil
		}
		break
	}
	return &RowCursorResetError{DBFile: dbFile}
}

func readGeneratorMetadataRowPage(dbFile, sqliteBin string, readSQLite ReadSQLite, lastSeenRowIndex int64) ([]metadataRow, error) {
	sql := fmt.Sprintf(
		"select idx, hex(data) from gen_metadata where idx > %d order by idx limit %d",
		lastSeenRowIndex, GeneratorMetadataRowsPageSize)
	stdout, err := readSQLiteOutput(dbFile, sqliteBin, sql, readSQLite)
	if err != nil {
		return nil, err
	}
	return parseSQLiteRows(stdout, dbFile)
}

func readHighestGeneratorMetadataRowIndex(dbFile, sqliteBin string, readSQLite ReadSQLite) (*int64, error) {
	stdout, err := readSQLiteOutput(dbFile, sqliteBin, "select max(idx) from gen_metadata", readSQLite)
	if err != nil {
		return nil, err
	}
	value := strings.TrimSpace(stdout)
	if value == "" {
		// `max()` over an empty table is NULL, which the CLI prints as an
		// empty field.
		empty := int64(-1)
		return &empty, nil
	}
	index, err := strconv.ParseInt(value, 10, 64)
	if err != nil || index < 0 || strconv.FormatInt(index, 10) != value {
		return nil, fmt.Errorf("Invalid Antigravity SQLite metadata row index in %s", dbFile)
	}
	return &index, nil
}

// readSQLiteOutput runs one metadata query and normalizes its failures.
//
// The error strings keep their original shape because the collector classifies
// sources by prefix: "reader unavailable" makes the whole source optional,
// while a read failure is a real error.
func readSQLiteOutput(dbFile, sqliteBin, sql string, readSQLite ReadSQLite) (string, error) {
	text, err := queryText(dbFile, sql, metadataQueryOptions(sqliteBin, readSQLite))
	if err != nil {
		message := err.Error()
		if strings.Contains(message, "SQLite reader unavailable") {
			return "", fmt.Errorf("Antigravity SQLite reader unavailable: %s not found", sqliteBin)
		}
		return "", fmt.Errorf("Failed to read Antigravity SQLite metadata from %s: %s", dbFile, message)
	}
	return text, nil
}

// queryText is a seam for tests: the one call site routes through it, so a
// test can observe the options the package actually passes without opening a
// database.
var queryText = sqlite.QueryText

// metadataQueryOptions builds the options for one metadata query. Every query
// the package issues goes through here, so the raised Antigravity output
// ceiling — the shared default would silently halve what a hex(data) page can
// be — is pinned in one place.
func metadataQueryOptions(sqliteBin string, readSQLite ReadSQLite) sqlite.QueryOptions {
	return sqlite.QueryOptions{
		SQLiteBin:      &sqliteBin,
		RunQuery:       readSQLite,
		Timeout:        SQLiteTimeout,
		ForceExternal:  readSQLite != nil || envSQLiteBinSet(),
		MaxOutputBytes: sqlite.AntigravityMaxOutputBytes,
		Label:          "Antigravity",
	}
}

func envSQLiteBinSet() bool {
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

// parseSQLiteRows reads the CLI's `idx|hex` list rendering.
func parseSQLiteRows(stdout, dbFile string) ([]metadataRow, error) {
	rows := []metadataRow{}
	for _, line := range strings.Split(strings.ReplaceAll(stdout, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		row, err := parseSQLiteRow(line, dbFile)
		if err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}

var (
	rowIndexPattern = regexp.MustCompile(`^[0-9]+$`)
	hexDigits       = regexp.MustCompile(`^[0-9A-F]*$`)
)

func parseSQLiteRow(line, dbFile string) (metadataRow, error) {
	invalid := func() error {
		return fmt.Errorf("Invalid Antigravity SQLite metadata row in %s", dbFile)
	}
	delimiter := strings.Index(line, "|")
	if delimiter <= 0 {
		return metadataRow{}, invalid()
	}
	rawIndex := line[:delimiter]
	encoded := line[delimiter+1:]
	if !rowIndexPattern.MatchString(rawIndex) || !hexDigits.MatchString(encoded) {
		return metadataRow{}, invalid()
	}
	index, err := strconv.ParseInt(rawIndex, 10, 64)
	if err != nil {
		// The digits-only check above passed, so this is overflow: a value the
		// TS side would have rejected as an unsafe integer.
		return metadataRow{}, invalid()
	}
	return metadataRow{Index: index, Data: decodeHex(encoded)}, nil
}

// decodeHex mirrors Buffer.from(hex, 'hex'): pairs are decoded left to right
// and an odd trailing nibble is dropped rather than rejected.
func decodeHex(value string) []byte {
	pairs := len(value) / 2
	decoded := make([]byte, pairs)
	for index := 0; index < pairs; index++ {
		high := hexNibble(value[index*2])
		low := hexNibble(value[index*2+1])
		decoded[index] = high<<4 | low
	}
	return decoded
}

func hexNibble(char byte) byte {
	switch {
	case char >= '0' && char <= '9':
		return char - '0'
	case char >= 'a' && char <= 'f':
		return char - 'a' + 10
	default:
		return char - 'A' + 10
	}
}

func normalizeLastSeenRowIndex(value *int64) int64 {
	if value == nil || *value < -1 {
		return -1
	}
	return *value
}

func hashString(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func hashBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

// isoMillis renders an instant the way Date#toISOString does: UTC, millisecond
// precision, Z suffix.
func isoMillis(mtimeMs float64) string {
	return time.UnixMilli(int64(mtimeMs)).UTC().Format("2006-01-02T15:04:05.000Z")
}

func setOf(values []string) map[string]bool {
	set := make(map[string]bool, len(values))
	for _, value := range values {
		set[value] = true
	}
	return set
}

func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func ceilDiv(value, divisor int) int {
	return (value + divisor - 1) / divisor
}
