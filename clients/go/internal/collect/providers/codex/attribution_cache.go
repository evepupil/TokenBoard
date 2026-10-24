package codex

// Port of codex-session-attribution-cache.ts: the persisted cache that maps a
// Codex session file to the (usage date, model) attribution its canonical
// resolution produced.
//
// Resolving attribution opens and parses session files, which is expensive for
// a large session tree; the cache keys each result by the file's stat identity
// plus a hash of its tail, so a hit is only reused for byte-identical content.
// The cache lives inside the collector state directory, next to the cursor it
// shares a lock with, and is written 0600 inside a 0700 directory: it names
// local session paths in hashed form but still records when the user was
// active.
//
// Every entry records dev/ino as optional fields. An entry written before the
// identity was persisted has neither, and can never match a live fingerprint
// (the TS comparison is `undefined === number`), so a legacy entry is
// recomputed rather than trusted.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/mtime"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionfile"
	"github.com/MisonL/TokenBoard/clients/go/internal/renameatomic"
	"github.com/MisonL/TokenBoard/clients/go/internal/state"
)

const (
	codexSessionAttributionCacheFileName  = "codex-session-attribution-cache.json"
	codexSessionAttributionCacheVersion   = 1
	codexSessionFingerprintTailBytes      = 64 * 1024
	codexSessionAttributionRetentionMs    = 180 * 24 * 60 * 60 * 1000
	codexSessionAttributionMaxEntries     = 20_000
	codexSessionAttributionMaxBytes       = 8 * 1024 * 1024
	codexSessionAttributionMaxModelLength = 512
	// codexCursorLockTimeout is the TS cursorLockTimeoutMs; the cache shares
	// the cursor lock protocol so a Go and a TS run serialize on one file.
	codexCursorLockTimeout = 35 * time.Second
)

// CodexSessionAttribution is one session file's resolved attribution.
type CodexSessionAttribution struct {
	UsageDate string
	Model     string
}

// CodexSessionFileMetadata is the stat triple a fingerprint compares first.
type CodexSessionFileMetadata struct {
	Size    float64
	MtimeMs float64
	CtimeMs float64
}

// CodexSessionFileFingerprint pins one revision of a session file.
type CodexSessionFileFingerprint struct {
	Dev        uint64
	Ino        uint64
	Size       float64
	MtimeMs    float64
	CtimeMs    float64
	TailSHA256 string
}

// CodexSessionFilePrefixFingerprint pins an immutable prefix of a session that
// may still be appended to: later bytes are allowed to grow.
type CodexSessionFilePrefixFingerprint struct {
	Dev              uint64
	Ino              uint64
	CapturedSize     float64
	PrefixSize       float64
	PrefixTailSHA256 string
}

// ComparableCodexSessionFileFingerprint is a cache entry's persisted identity.
// Dev/Ino are optional because entries written before the identity was
// persisted cannot match a live fingerprint.
type ComparableCodexSessionFileFingerprint struct {
	Dev        *float64
	Ino        *float64
	Size       float64
	MtimeMs    float64
	CtimeMs    float64
	TailSHA256 string
}

// CacheEntry is one persisted attribution plus the identity it was computed
// for.
type CacheEntry struct {
	Dev        *float64
	Ino        *float64
	Size       float64
	MtimeMs    float64
	CtimeMs    float64
	TailSHA256 string
	UsageDate  string
	Model      string
	UpdatedAt  string
}

func (entry CacheEntry) comparable() ComparableCodexSessionFileFingerprint {
	return ComparableCodexSessionFileFingerprint{
		Dev:        entry.Dev,
		Ino:        entry.Ino,
		Size:       entry.Size,
		MtimeMs:    entry.MtimeMs,
		CtimeMs:    entry.CtimeMs,
		TailSHA256: entry.TailSHA256,
	}
}

// CodexSessionAttributionLookup is one lookup result.
type CodexSessionAttributionLookup struct {
	Fingerprint CodexSessionFileFingerprint
	Attribution *CodexSessionAttribution
}

// AttributionCacheInput describes one cache transaction. StateDir is the
// collector state directory; the cache file and its lock live directly in it.
type AttributionCacheInput struct {
	StateDir string
	Timezone string
	Callback func(*CodexSessionAttributionCache) error
	// Fingerprint replaces the real fingerprint function. It exists for the
	// tests that must observe a fingerprint race deterministically, which the
	// TS suite does by mocking node:fs/promises; nil uses
	// FingerprintCodexSessionFile.
	Fingerprint func(string) (CodexSessionFileFingerprint, error)
}

// CodexSessionAttributionCache is the handle a transaction callback receives.
// It is only valid inside that callback.
type CodexSessionAttributionCache struct {
	cachePath string
	lockPath  string
	lock      *state.Lock
	timezone  string
	updatedAt string

	fingerprint   func(string) (CodexSessionFileFingerprint, error)
	entries       map[string]CacheEntry
	usedKeys      map[string]bool
	observedFiles map[string]attributionObservedFile
}

type attributionObservedFile struct {
	filePath    string
	fingerprint CodexSessionFileFingerprint
}

type attributionCacheState struct {
	Version  int
	Timezone string
	Entries  map[string]CacheEntry
}

// WithCodexSessionAttributionCache runs callback under the cache lock with the
// cache loaded, then asserts that every file it observed is unchanged and
// writes the retained entries back.
func WithCodexSessionAttributionCache(input AttributionCacheInput) error {
	if input.Callback == nil {
		return errors.New("Codex session attribution cache requires a callback")
	}
	cachePath := filepath.Join(input.StateDir, codexSessionAttributionCacheFileName)
	lockPath := cachePath + ".lock"
	lock, err := state.Acquire(lockPath, codexCursorLockTimeout)
	if err != nil {
		return err
	}
	if lock == nil {
		return fmt.Errorf("Timed out waiting for cursor lock: %s", lockPath)
	}
	transactionErr := runAttributionCacheTransaction(input, cachePath, lockPath, lock)
	releaseErr := lock.Release()
	if transactionErr != nil {
		return transactionErr
	}
	return releaseErr
}

func runAttributionCacheTransaction(
	input AttributionCacheInput,
	cachePath string,
	lockPath string,
	lock *state.Lock,
) error {
	now := time.Now().UTC()
	updatedAt := now.Format("2006-01-02T15:04:05.000Z")
	cache, err := readAttributionCache(cachePath, input.Timezone)
	if err != nil {
		return err
	}
	fingerprint := input.Fingerprint
	if fingerprint == nil {
		fingerprint = FingerprintCodexSessionFile
	}
	api := &CodexSessionAttributionCache{
		cachePath:     cachePath,
		lockPath:      lockPath,
		lock:          lock,
		timezone:      input.Timezone,
		updatedAt:     updatedAt,
		fingerprint:   fingerprint,
		entries:       cache.Entries,
		usedKeys:      map[string]bool{},
		observedFiles: map[string]attributionObservedFile{},
	}
	if err := input.Callback(api); err != nil {
		return err
	}
	if err := api.assertObservedFilesUnchanged(); err != nil {
		return err
	}
	api.entries = RetainCacheEntries(api.entries, api.usedKeys, float64(now.UnixMilli()), input.Timezone)
	return writeAttributionCache(cachePath, attributionCacheState{
		Version:  codexSessionAttributionCacheVersion,
		Timezone: input.Timezone,
		Entries:  api.entries,
	}, lockPath, lock)
}

// IsEmpty reports whether the loaded cache holds no entries.
func (cache *CodexSessionAttributionCache) IsEmpty() bool {
	return len(cache.entries) == 0
}

// Lookup fingerprints filePath and returns its attribution when the cache
// entry still matches that fingerprint. The observed file is verified again
// before the transaction commits.
func (cache *CodexSessionAttributionCache) Lookup(filePath string) (CodexSessionAttributionLookup, error) {
	key := attributionCacheKey(filePath)
	cache.usedKeys[key] = true
	fingerprint, err := cache.fingerprint(filePath)
	if err != nil {
		return CodexSessionAttributionLookup{}, err
	}
	cache.observedFiles[key] = attributionObservedFile{filePath: filePath, fingerprint: fingerprint}
	entry, ok := cache.entries[key]
	if !ok || !SameCodexSessionFileFingerprint(entry.comparable(), fingerprint) {
		return CodexSessionAttributionLookup{Fingerprint: fingerprint}, nil
	}
	entry.UpdatedAt = cache.updatedAt
	cache.entries[key] = entry
	return CodexSessionAttributionLookup{
		Fingerprint: fingerprint,
		Attribution: &CodexSessionAttribution{UsageDate: entry.UsageDate, Model: entry.Model},
	}, nil
}

// LookupByFingerprint reuses an entry that matches a fingerprint taken
// earlier, without touching the file. A file the caller already observed is
// still verified by the transaction commit.
func (cache *CodexSessionAttributionCache) LookupByFingerprint(
	filePath string,
	fingerprint CodexSessionFileFingerprint,
) *CodexSessionAttribution {
	key := attributionCacheKey(filePath)
	cache.usedKeys[key] = true
	entry, ok := cache.entries[key]
	if !ok || !SameCodexSessionFileFingerprint(entry.comparable(), fingerprint) {
		return nil
	}
	entry.UpdatedAt = cache.updatedAt
	cache.entries[key] = entry
	return &CodexSessionAttribution{UsageDate: entry.UsageDate, Model: entry.Model}
}

// Store records an attribution, failing when the file no longer matches the
// fingerprint the attribution was computed for.
func (cache *CodexSessionAttributionCache) Store(
	filePath string,
	fingerprint CodexSessionFileFingerprint,
	attribution CodexSessionAttribution,
) error {
	if err := assertAttribution(attribution); err != nil {
		return err
	}
	current, err := cache.fingerprintObserved(filePath)
	if err != nil {
		return err
	}
	if !SameCodexSessionFileFingerprint(comparableOfFingerprint(fingerprint), current) {
		return errCodexSessionAttributionRace
	}
	key := attributionCacheKey(filePath)
	cache.usedKeys[key] = true
	cache.observedFiles[key] = attributionObservedFile{filePath: filePath, fingerprint: current}
	cache.entries[key] = cache.entryFor(current, attribution)
	return nil
}

// StoreIfUnchanged is the optional prewarm write: it reports false instead of
// failing when the file vanished or raced, so a caller with a frozen copy can
// skip the write without failing the sync.
func (cache *CodexSessionAttributionCache) StoreIfUnchanged(
	filePath string,
	fingerprint CodexSessionFileFingerprint,
	attribution CodexSessionAttribution,
) (bool, error) {
	if err := assertAttribution(attribution); err != nil {
		return false, err
	}
	current, err := cache.fingerprint(filePath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, errCodexSessionFingerprintRace) {
			return false, nil
		}
		return false, err
	}
	if !SameCodexSessionFileFingerprint(comparableOfFingerprint(fingerprint), current) {
		return false, nil
	}
	key := attributionCacheKey(filePath)
	cache.usedKeys[key] = true
	cache.entries[key] = cache.entryFor(current, attribution)
	return true, nil
}

func (cache *CodexSessionAttributionCache) entryFor(
	fingerprint CodexSessionFileFingerprint,
	attribution CodexSessionAttribution,
) CacheEntry {
	dev := float64(fingerprint.Dev)
	ino := float64(fingerprint.Ino)
	return CacheEntry{
		Dev:        &dev,
		Ino:        &ino,
		Size:       fingerprint.Size,
		MtimeMs:    fingerprint.MtimeMs,
		CtimeMs:    fingerprint.CtimeMs,
		TailSHA256: fingerprint.TailSHA256,
		UsageDate:  attribution.UsageDate,
		Model:      attribution.Model,
		UpdatedAt:  cache.updatedAt,
	}
}

func (cache *CodexSessionAttributionCache) assertObservedFilesUnchanged() error {
	for _, observed := range cache.observedFiles {
		current, err := cache.fingerprintObserved(observed.filePath)
		if err != nil {
			return err
		}
		if !SameCodexSessionFileFingerprint(comparableOfFingerprint(observed.fingerprint), current) {
			return errCodexSessionAttributionRace
		}
	}
	return nil
}

// fingerprintObserved maps a vanished file to the retryable attribution race:
// the file was observed earlier in this transaction, so its disappearance is a
// change, not a new error class.
func (cache *CodexSessionAttributionCache) fingerprintObserved(filePath string) (CodexSessionFileFingerprint, error) {
	fingerprint, err := cache.fingerprint(filePath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return CodexSessionFileFingerprint{}, errCodexSessionAttributionRace
		}
		return CodexSessionFileFingerprint{}, err
	}
	return fingerprint, nil
}

func comparableOfFingerprint(fingerprint CodexSessionFileFingerprint) ComparableCodexSessionFileFingerprint {
	dev := float64(fingerprint.Dev)
	ino := float64(fingerprint.Ino)
	return ComparableCodexSessionFileFingerprint{
		Dev:        &dev,
		Ino:        &ino,
		Size:       fingerprint.Size,
		MtimeMs:    fingerprint.MtimeMs,
		CtimeMs:    fingerprint.CtimeMs,
		TailSHA256: fingerprint.TailSHA256,
	}
}

var (
	// errCodexSessionInspect is the wrapper message for every fingerprint
	// failure that is not one of the classified ones below.
	errCodexSessionInspect         = errors.New("Unable to inspect Codex session file")
	errCodexSessionInspectSymlink  = errors.New("Unable to inspect Codex session file: symbolic links are not supported")
	errCodexSessionInspectNotFile  = errors.New("Unable to inspect Codex session file: path is not a file")
	errCodexSessionFingerprintRace = errors.New("Codex session changed while fingerprinting; retry the sync")
	errCodexSessionTruncated       = errors.New("Codex session was truncated while fingerprinting; retry the sync")
	// errCodexSessionAttributionRace is the commit-time change error: the
	// attribution resolved in this transaction no longer describes the file.
	errCodexSessionAttributionRace = errors.New("Codex session changed while resolving canonical attribution; retry the sync")
)

// codexSessionInspectError keeps the TS wrapper's exact message while still
// exposing the cause, so `errors.Is(err, fs.ErrNotExist)` sees through it the
// way the TS `error.cause` chain does.
type codexSessionInspectError struct {
	cause error
}

func (e *codexSessionInspectError) Error() string { return errCodexSessionInspect.Error() }
func (e *codexSessionInspectError) Unwrap() error { return e.cause }

// FingerprintCodexSessionFile ports fingerprintCodexSessionFile: stat, open,
// re-stat, hash the tail, re-stat, and refuse any identity change along the
// way.
func FingerprintCodexSessionFile(filePath string) (CodexSessionFileFingerprint, error) {
	fingerprint, err := fingerprintCodexSessionFileRange(filePath, nil)
	if err != nil {
		return CodexSessionFileFingerprint{}, wrapCodexSessionFingerprintError(err, false)
	}
	return fingerprint, nil
}

// FingerprintCodexSessionFilePrefix ports fingerprintCodexSessionFilePrefix:
// the same pinning for an immutable prefix of a file that may still grow.
func FingerprintCodexSessionFilePrefix(
	filePath string,
	prefixSize *float64,
) (CodexSessionFilePrefixFingerprint, error) {
	fingerprint, err := fingerprintCodexSessionFilePrefix(filePath, prefixSize)
	if err != nil {
		return CodexSessionFilePrefixFingerprint{}, wrapCodexSessionFingerprintError(err, true)
	}
	return fingerprint, nil
}

// wrapCodexSessionFingerprintError rethrows the classified errors unchanged and
// wraps everything else, exactly like the TS catch blocks.
func wrapCodexSessionFingerprintError(err error, prefix bool) error {
	if errors.Is(err, errCodexSessionInspectSymlink) ||
		errors.Is(err, errCodexSessionInspectNotFile) ||
		errors.Is(err, errCodexSessionFingerprintRace) {
		return err
	}
	if prefix && errors.Is(err, errCodexSessionTruncated) {
		return err
	}
	return &codexSessionInspectError{cause: err}
}

func fingerprintCodexSessionFileRange(
	filePath string,
	prefixSize *float64,
) (CodexSessionFileFingerprint, error) {
	pathBefore, err := os.Lstat(filePath)
	if err != nil {
		return CodexSessionFileFingerprint{}, err
	}
	if err := assertAttributionSessionFileAtPath(pathBefore); err != nil {
		return CodexSessionFileFingerprint{}, err
	}
	file, err := os.Open(filePath)
	if err != nil {
		return CodexSessionFileFingerprint{}, err
	}
	defer file.Close()

	opened, err := file.Stat()
	if err != nil {
		return CodexSessionFileFingerprint{}, err
	}
	pathAfterOpen, err := os.Lstat(filePath)
	if err != nil {
		return CodexSessionFileFingerprint{}, err
	}
	if err := assertAttributionSessionFileAtPath(pathAfterOpen); err != nil {
		return CodexSessionFileFingerprint{}, err
	}
	openedStat := codexStatOf(opened)
	if !sameCodexFileStat(codexStatOf(pathBefore), openedStat) ||
		!sameCodexFileStat(codexStatOf(pathAfterOpen), openedStat) {
		return CodexSessionFileFingerprint{}, errCodexSessionFingerprintRace
	}

	tailSha256, err := hashCodexSessionTail(file, openedStat.size)
	if err != nil {
		return CodexSessionFileFingerprint{}, err
	}

	after, err := file.Stat()
	if err != nil {
		return CodexSessionFileFingerprint{}, err
	}
	pathAfterRead, err := os.Lstat(filePath)
	if err != nil {
		return CodexSessionFileFingerprint{}, err
	}
	if err := assertAttributionSessionFileAtPath(pathAfterRead); err != nil {
		return CodexSessionFileFingerprint{}, err
	}
	if !sameCodexFileStat(codexStatOf(after), openedStat) ||
		!sameCodexFileStat(codexStatOf(pathAfterRead), openedStat) {
		return CodexSessionFileFingerprint{}, errCodexSessionFingerprintRace
	}
	return CodexSessionFileFingerprint{
		Dev:        openedStat.dev,
		Ino:        openedStat.ino,
		Size:       float64(openedStat.size),
		MtimeMs:    openedStat.mtimeMs,
		CtimeMs:    openedStat.ctimeMs,
		TailSHA256: tailSha256,
	}, nil
}

func fingerprintCodexSessionFilePrefix(
	filePath string,
	prefixSize *float64,
) (CodexSessionFilePrefixFingerprint, error) {
	pathBefore, err := os.Lstat(filePath)
	if err != nil {
		return CodexSessionFilePrefixFingerprint{}, err
	}
	if err := assertAttributionSessionFileAtPath(pathBefore); err != nil {
		return CodexSessionFilePrefixFingerprint{}, err
	}
	file, err := os.Open(filePath)
	if err != nil {
		return CodexSessionFilePrefixFingerprint{}, err
	}
	defer file.Close()

	opened, err := file.Stat()
	if err != nil {
		return CodexSessionFilePrefixFingerprint{}, err
	}
	pathAfterOpen, err := os.Lstat(filePath)
	if err != nil {
		return CodexSessionFilePrefixFingerprint{}, err
	}
	if err := assertAttributionSessionFileAtPath(pathAfterOpen); err != nil {
		return CodexSessionFilePrefixFingerprint{}, err
	}
	openedStat := codexStatOf(opened)
	if !sameCodexFileIdentity(codexStatOf(pathBefore), openedStat) ||
		!sameCodexFileIdentity(codexStatOf(pathAfterOpen), openedStat) {
		return CodexSessionFilePrefixFingerprint{}, errCodexSessionFingerprintRace
	}

	capturedSize := openedStat.size
	size := capturedSize
	if prefixSize != nil {
		if _, ok := jsonlSafeInteger(*prefixSize); !ok || *prefixSize > float64(capturedSize) {
			return CodexSessionFilePrefixFingerprint{}, errCodexSessionTruncated
		}
		size = int64(*prefixSize)
	}
	prefixTailSha256, err := hashCodexSessionTail(file, size)
	if err != nil {
		return CodexSessionFilePrefixFingerprint{}, err
	}

	after, err := file.Stat()
	if err != nil {
		return CodexSessionFilePrefixFingerprint{}, err
	}
	pathAfterRead, err := os.Lstat(filePath)
	if err != nil {
		return CodexSessionFilePrefixFingerprint{}, err
	}
	if err := assertAttributionSessionFileAtPath(pathAfterRead); err != nil {
		return CodexSessionFilePrefixFingerprint{}, err
	}
	afterStat := codexStatOf(after)
	pathAfterReadStat := codexStatOf(pathAfterRead)
	if !sameCodexFileIdentity(afterStat, openedStat) ||
		!sameCodexFileIdentity(pathAfterReadStat, openedStat) ||
		pathAfterReadStat.size < capturedSize {
		return CodexSessionFilePrefixFingerprint{}, errCodexSessionFingerprintRace
	}
	return CodexSessionFilePrefixFingerprint{
		Dev:              openedStat.dev,
		Ino:              openedStat.ino,
		CapturedSize:     float64(capturedSize),
		PrefixSize:       float64(size),
		PrefixTailSHA256: prefixTailSha256,
	}, nil
}

func assertAttributionSessionFileAtPath(info os.FileInfo) error {
	if info.Mode()&os.ModeSymlink != 0 {
		return errCodexSessionInspectSymlink
	}
	if !info.Mode().IsRegular() {
		return errCodexSessionInspectNotFile
	}
	return nil
}

// hashCodexSessionTail hashes the last min(size, 64 KiB) bytes. The read loop
// fills the buffer across short reads and treats a zero-byte read as a
// truncation race, matching the TS hashOpenFileRange.
func hashCodexSessionTail(reader io.ReaderAt, size int64) (string, error) {
	length := size
	if length > codexSessionFingerprintTailBytes {
		length = codexSessionFingerprintTailBytes
	}
	if length < 0 {
		length = 0
	}
	buffer := make([]byte, length)
	start := size - length
	offset := int64(0)
	for offset < length {
		read, err := reader.ReadAt(buffer[offset:], start+offset)
		if read > 0 {
			offset += int64(read)
		}
		if err != nil && err != io.EOF {
			return "", err
		}
		if read == 0 {
			return "", errCodexSessionFingerprintRace
		}
	}
	sum := sha256.Sum256(buffer)
	return hex.EncodeToString(sum[:]), nil
}

// SameCodexSessionFilePrefixFingerprint ports the prefix comparison.
func SameCodexSessionFilePrefixFingerprint(
	left CodexSessionFilePrefixFingerprint,
	right CodexSessionFilePrefixFingerprint,
) bool {
	return left.Dev == right.Dev &&
		left.Ino == right.Ino &&
		left.PrefixSize == right.PrefixSize &&
		left.PrefixTailSHA256 == right.PrefixTailSHA256
}

// SameCodexSessionFileMetadata ports sameCodexSessionFileMetadata.
func SameCodexSessionFileMetadata(left CodexSessionFileMetadata, right CodexSessionFileMetadata) bool {
	return left.Size == right.Size && left.MtimeMs == right.MtimeMs && left.CtimeMs == right.CtimeMs
}

// SameCodexSessionFileFingerprint ports sameCodexSessionFileFingerprint. An
// entry without persisted dev/ino never matches.
func SameCodexSessionFileFingerprint(
	left ComparableCodexSessionFileFingerprint,
	right CodexSessionFileFingerprint,
) bool {
	if left.Dev == nil || left.Ino == nil {
		return false
	}
	return *left.Dev == float64(right.Dev) &&
		*left.Ino == float64(right.Ino) &&
		SameCodexSessionFileMetadata(
			CodexSessionFileMetadata{Size: left.Size, MtimeMs: left.MtimeMs, CtimeMs: left.CtimeMs},
			CodexSessionFileMetadata{Size: right.Size, MtimeMs: right.MtimeMs, CtimeMs: right.CtimeMs},
		) &&
		left.TailSHA256 == right.TailSHA256
}

// RetainCacheEntries ports retainCacheEntries: used keys first, then entries
// updated inside the retention window, newest first within each group, capped
// by entry count and serialized size.
func RetainCacheEntries(
	entries map[string]CacheEntry,
	usedKeys map[string]bool,
	nowMs float64,
	timezone string,
) map[string]CacheEntry {
	cutoffMs := nowMs - codexSessionAttributionRetentionMs
	used := make([]attributionRetainedEntry, 0, len(entries))
	recent := make([]attributionRetainedEntry, 0, len(entries))
	for key, entry := range entries {
		updatedAtMs, parsed := attributionParseMillis(entry.UpdatedAt)
		item := attributionRetainedEntry{key: key, entry: entry, updatedAtMs: updatedAtMs, parsed: parsed}
		if usedKeys[key] {
			used = append(used, item)
			continue
		}
		if parsed && updatedAtMs >= cutoffMs {
			recent = append(recent, item)
		}
	}
	attributionSortNewestFirst(used)
	attributionSortNewestFirst(recent)

	usedCount := len(used)
	if usedCount > codexSessionAttributionMaxEntries {
		usedCount = codexSessionAttributionMaxEntries
	}
	recentBudget := codexSessionAttributionMaxEntries - usedCount
	if recentBudget < 0 {
		recentBudget = 0
	}
	recentCount := len(recent)
	if recentCount > recentBudget {
		recentCount = recentBudget
	}
	selected := make([]attributionRetainedEntry, 0, usedCount+recentCount)
	selected = append(selected, used[:usedCount]...)
	selected = append(selected, recent[:recentCount]...)
	return trimAttributionEntriesToSerializedSize(selected, timezone, codexSessionAttributionMaxBytes)
}

type attributionRetainedEntry struct {
	key         string
	entry       CacheEntry
	updatedAtMs float64
	parsed      bool
}

// attributionSortNewestFirst orders by updatedAt descending, then by key
// ascending. An entry whose updatedAt does not parse sorts by key alone, which
// is how the TS comparator's NaN result falls through to localeCompare; for
// hex keys localeCompare and byte order agree.
func attributionSortNewestFirst(items []attributionRetainedEntry) {
	sort.SliceStable(items, func(left, right int) bool {
		a, b := items[left], items[right]
		if a.parsed && b.parsed && a.updatedAtMs != b.updatedAtMs {
			return a.updatedAtMs > b.updatedAtMs
		}
		return a.key < b.key
	})
}

func trimAttributionEntriesToSerializedSize(
	items []attributionRetainedEntry,
	timezone string,
	budgetBytes int,
) map[string]CacheEntry {
	type sizedEntry struct {
		item  attributionRetainedEntry
		bytes int
	}
	sized := make([]sizedEntry, len(items))
	serializedBytes := len(`{"version":1,"timezone":` + attributionJSONString(timezone) + `,"entries":{` + "}}\n")
	for index, item := range items {
		sized[index] = sizedEntry{
			item: item,
			// `"key":entry` in the TS accounting.
			bytes: len(attributionJSONString(item.key)) + 1 + len(encodeAttributionCacheEntry(item.entry)),
		}
		serializedBytes += sized[index].bytes
	}
	if len(sized) > 1 {
		serializedBytes += len(sized) - 1
	}
	for serializedBytes > budgetBytes && len(sized) > 0 {
		removed := sized[len(sized)-1]
		sized = sized[:len(sized)-1]
		serializedBytes -= removed.bytes
		if len(sized) > 0 {
			serializedBytes--
		}
	}
	out := make(map[string]CacheEntry, len(sized))
	for _, item := range sized {
		out[item.item.key] = item.item.entry
	}
	return out
}

func readAttributionCache(cachePath, timezone string) (attributionCacheState, error) {
	content, ok, err := readBoundedAttributionCacheFile(cachePath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return emptyAttributionCache(timezone), nil
		}
		return attributionCacheState{}, err
	}
	// An oversized cache is stale by definition (the retain pass never writes
	// one), so discarding it loses only recomputable fingerprints; failing
	// here would wedge every sync until an operator deleted the file by hand.
	if !ok {
		return emptyAttributionCache(timezone), nil
	}
	value, err := decodeAttributionCacheJSON(content)
	if err != nil {
		return attributionCacheState{}, errors.New("Invalid Codex session attribution cache JSON")
	}
	parsedState, valid := parseAttributionCacheState(value)
	if !valid {
		return attributionCacheState{}, errors.New("Invalid Codex session attribution cache")
	}
	if parsedState.Timezone != timezone {
		return emptyAttributionCache(timezone), nil
	}
	return parsedState, nil
}

// readBoundedAttributionCacheFile returns (content, false, nil) when the file
// exceeds the byte budget; its content is then never read into memory.
func readBoundedAttributionCacheFile(cachePath string) ([]byte, bool, error) {
	file, err := os.Open(cachePath)
	if err != nil {
		return nil, false, err
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil {
		return nil, false, err
	}
	if !before.Mode().IsRegular() {
		return nil, false, errors.New("Invalid Codex session attribution cache")
	}
	if before.Size() > codexSessionAttributionMaxBytes {
		return nil, false, nil
	}
	buffer := make([]byte, before.Size())
	if _, err := io.ReadFull(file, buffer); err != nil {
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			return nil, false, errors.New("Codex session attribution cache changed while reading; retry the sync")
		}
		return nil, false, err
	}
	after, err := file.Stat()
	if err != nil {
		return nil, false, err
	}
	beforeStat := codexStatOf(before)
	afterStat := codexStatOf(after)
	if !SameCodexSessionFileMetadata(
		CodexSessionFileMetadata{Size: float64(beforeStat.size), MtimeMs: beforeStat.mtimeMs, CtimeMs: beforeStat.ctimeMs},
		CodexSessionFileMetadata{Size: float64(afterStat.size), MtimeMs: afterStat.mtimeMs, CtimeMs: afterStat.ctimeMs},
	) {
		return nil, false, errors.New("Codex session attribution cache changed while reading; retry the sync")
	}
	return buffer, true, nil
}

func emptyAttributionCache(timezone string) attributionCacheState {
	return attributionCacheState{
		Version:  codexSessionAttributionCacheVersion,
		Timezone: timezone,
		Entries:  map[string]CacheEntry{},
	}
}

func writeAttributionCache(
	cachePath string,
	cache attributionCacheState,
	lockPath string,
	lock *state.Lock,
) error {
	serialized := encodeAttributionCacheState(cache)
	// The retain pass already trims to the budget; a write-side overflow means
	// an external or legacy oversize slipped through the read path. Evict to
	// 75% rather than failing the sync.
	if len(serialized) > codexSessionAttributionMaxBytes {
		cache.Entries = trimAttributionEntriesToSerializedSize(
			attributionSortedEntries(cache.Entries),
			cache.Timezone,
			codexSessionAttributionMaxBytes*3/4,
		)
		serialized = encodeAttributionCacheState(cache)
		if len(serialized) > codexSessionAttributionMaxBytes {
			return fmt.Errorf("Codex session attribution cache exceeds the %d-byte limit",
				codexSessionAttributionMaxBytes)
		}
	}
	// Private like the 0600 cache file it will hold: the state directory
	// itself must not be writable by others when this call creates it.
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		return err
	}
	suffix, err := attributionRandomHex(8)
	if err != nil {
		return err
	}
	tempPath := fmt.Sprintf("%s.tmp-%d-%s", cachePath, os.Getpid(), suffix)
	if err := os.WriteFile(tempPath, serialized, 0o600); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := assertAttributionCacheLockOwnership(lockPath, lock); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := renameatomic.Rename(tempPath, cachePath); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	return nil
}

func attributionSortedEntries(entries map[string]CacheEntry) []attributionRetainedEntry {
	items := make([]attributionRetainedEntry, 0, len(entries))
	for key, entry := range entries {
		updatedAtMs, parsed := attributionParseMillis(entry.UpdatedAt)
		items = append(items, attributionRetainedEntry{key: key, entry: entry, updatedAtMs: updatedAtMs, parsed: parsed})
	}
	attributionSortNewestFirst(items)
	return items
}

// assertAttributionCacheLockOwnership is the TS assertCursorWriteOwnership:
// another process may have cleared a stale lock and taken over while this
// transaction ran, and its rename must not be overwritten.
func assertAttributionCacheLockOwnership(lockPath string, lock *state.Lock) error {
	data, err := os.ReadFile(lockPath)
	if err != nil {
		return fmt.Errorf("Cursor lock ownership changed before write: %s", lockPath)
	}
	var owner state.LockOwner
	if err := json.Unmarshal(data, &owner); err != nil {
		return fmt.Errorf("Cursor lock ownership changed before write: %s", lockPath)
	}
	if lock == nil || owner.Token != lock.Owner.Token || owner.PID != lock.Owner.PID {
		return fmt.Errorf("Cursor lock ownership changed before write: %s", lockPath)
	}
	return nil
}

func attributionRandomHex(byteCount int) (string, error) {
	buffer := make([]byte, byteCount)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func attributionCacheKey(filePath string) string {
	sum := sha256.Sum256([]byte(filePath))
	return hex.EncodeToString(sum[:])
}

func assertAttribution(attribution CodexSessionAttribution) error {
	if err := jsonlAssertValidCalendarDate(attribution.UsageDate, "Invalid Codex canonical session date"); err != nil {
		return err
	}
	if !codexDateOnlyPattern.MatchString(attribution.UsageDate) {
		return errors.New("Invalid Codex canonical session date")
	}
	if attribution.Model == "" || codexUTF16Length(attribution.Model) > codexSessionAttributionMaxModelLength {
		return errors.New("Invalid Codex canonical session model")
	}
	return nil
}

// codexUTF16Length mirrors JS string `.length`, which counts UTF-16 code
// units, so a 512-astral-character model would be rejected there and must be
// rejected here too.
func codexUTF16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

// decodeAttributionCacheJSON separates a JSON syntax error (its own message)
// from a structurally invalid cache, the way JSON.parse and the validator do.
func decodeAttributionCacheJSON(content []byte) (any, error) {
	if !json.Valid(content) {
		return nil, errors.New("invalid JSON")
	}
	decoder := json.NewDecoder(strings.NewReader(string(content)))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return value, nil
}

func parseAttributionCacheState(value any) (attributionCacheState, bool) {
	root, ok := value.(map[string]any)
	if !ok {
		return attributionCacheState{}, false
	}
	version, ok := attributionFiniteNumber(root["version"])
	if !ok || version != codexSessionAttributionCacheVersion {
		return attributionCacheState{}, false
	}
	timezone, ok := root["timezone"].(string)
	if !ok {
		return attributionCacheState{}, false
	}
	rawEntries, ok := root["entries"].(map[string]any)
	if !ok {
		return attributionCacheState{}, false
	}
	entries := make(map[string]CacheEntry, len(rawEntries))
	for key, rawEntry := range rawEntries {
		if !attributionHexSHA256Pattern.MatchString(key) {
			return attributionCacheState{}, false
		}
		entry, ok := parseAttributionCacheEntry(rawEntry)
		if !ok {
			return attributionCacheState{}, false
		}
		entries[key] = entry
	}
	return attributionCacheState{
		Version:  codexSessionAttributionCacheVersion,
		Timezone: timezone,
		Entries:  entries,
	}, true
}

// attributionHexSHA256Pattern is the cache-key and tail-digest shape: a
// lowercase hex sha256.
var attributionHexSHA256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func parseAttributionCacheEntry(value any) (CacheEntry, bool) {
	record, ok := value.(map[string]any)
	if !ok {
		return CacheEntry{}, false
	}
	size, ok := attributionFiniteNumber(record["size"])
	if !ok {
		return CacheEntry{}, false
	}
	var dev *float64
	if raw, present := record["dev"]; present {
		parsed, ok := attributionFiniteNumber(raw)
		if !ok {
			return CacheEntry{}, false
		}
		dev = &parsed
	}
	var ino *float64
	if raw, present := record["ino"]; present {
		parsed, ok := attributionFiniteNumber(raw)
		if !ok {
			return CacheEntry{}, false
		}
		ino = &parsed
	}
	mtimeMs, ok := attributionFiniteNumber(record["mtimeMs"])
	if !ok {
		return CacheEntry{}, false
	}
	ctimeMs, ok := attributionFiniteNumber(record["ctimeMs"])
	if !ok {
		return CacheEntry{}, false
	}
	tailSha256, ok := record["tailSha256"].(string)
	if !ok || !attributionHexSHA256Pattern.MatchString(tailSha256) {
		return CacheEntry{}, false
	}
	updatedAt, ok := record["updatedAt"].(string)
	if !ok {
		return CacheEntry{}, false
	}
	usageDate, ok := record["usageDate"].(string)
	if !ok {
		return CacheEntry{}, false
	}
	model, ok := record["model"].(string)
	if !ok {
		return CacheEntry{}, false
	}
	if err := assertAttribution(CodexSessionAttribution{UsageDate: usageDate, Model: model}); err != nil {
		return CacheEntry{}, false
	}
	if _, ok := attributionParseMillis(updatedAt); !ok {
		return CacheEntry{}, false
	}
	return CacheEntry{
		Dev:        dev,
		Ino:        ino,
		Size:       size,
		MtimeMs:    mtimeMs,
		CtimeMs:    ctimeMs,
		TailSHA256: tailSha256,
		UsageDate:  usageDate,
		Model:      model,
		UpdatedAt:  updatedAt,
	}, true
}

// attributionFiniteNumber is the TS isFiniteNumber: a finite, non-negative
// number. JSON cannot carry NaN/Inf, but a programmatic entry can.
func attributionFiniteNumber(value any) (float64, bool) {
	var number float64
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return 0, false
		}
		number = parsed
	case float64:
		number = typed
	default:
		return 0, false
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
		return 0, false
	}
	return number, true
}

// attributionParseMillis is Date.parse for the ISO timestamps this cache
// writes; a value outside that subset does not parse.
func attributionParseMillis(value string) (float64, bool) {
	parsed, ok := jsonlParseJSDate(value)
	if !ok {
		return 0, false
	}
	return float64(parsed.Unix())*1e3 + float64(parsed.Nanosecond())/1e6, true
}

func encodeAttributionCacheState(state attributionCacheState) []byte {
	keys := make([]string, 0, len(state.Entries))
	for key := range state.Entries {
		keys = append(keys, key)
	}
	// The TS object preserves insertion order, which JSON consumers do not
	// observe; sorting keeps a Go rewrite deterministic.
	sort.Strings(keys)
	var builder strings.Builder
	builder.WriteString(`{"version":`)
	builder.WriteString(strconv.Itoa(state.Version))
	builder.WriteString(`,"timezone":`)
	builder.WriteString(attributionJSONString(state.Timezone))
	builder.WriteString(`,"entries":{`)
	for index, key := range keys {
		if index > 0 {
			builder.WriteByte(',')
		}
		builder.WriteString(attributionJSONString(key))
		builder.WriteByte(':')
		builder.WriteString(encodeAttributionCacheEntry(state.Entries[key]))
	}
	builder.WriteString("}}\n")
	return []byte(builder.String())
}

// encodeAttributionCacheEntry writes the fields in the order the TS object
// spread produces: the fingerprint, then the attribution, then updatedAt.
func encodeAttributionCacheEntry(entry CacheEntry) string {
	var builder strings.Builder
	builder.WriteByte('{')
	first := true
	writeField := func(name, value string) {
		if !first {
			builder.WriteByte(',')
		}
		first = false
		builder.WriteString(attributionJSONString(name))
		builder.WriteByte(':')
		builder.WriteString(value)
	}
	if entry.Dev != nil {
		writeField("dev", attributionJSONNumber(*entry.Dev))
	}
	if entry.Ino != nil {
		writeField("ino", attributionJSONNumber(*entry.Ino))
	}
	writeField("size", attributionJSONNumber(entry.Size))
	writeField("mtimeMs", attributionJSONNumber(entry.MtimeMs))
	writeField("ctimeMs", attributionJSONNumber(entry.CtimeMs))
	writeField("tailSha256", attributionJSONString(entry.TailSHA256))
	writeField("usageDate", attributionJSONString(entry.UsageDate))
	writeField("model", attributionJSONString(entry.Model))
	writeField("updatedAt", attributionJSONString(entry.UpdatedAt))
	builder.WriteByte('}')
	return builder.String()
}

// attributionJSONString is JSON.stringify for strings. Go escapes U+2028 and
// U+2029 where JS does not; both decode to the same value, so only the byte
// budget accounting could differ, and only for those characters.
func attributionJSONString(value string) string {
	var builder strings.Builder
	encoder := json.NewEncoder(&builder)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return `""`
	}
	return strings.TrimSuffix(builder.String(), "\n")
}

// attributionJSONNumber is Number#toString for the non-negative values this
// cache stores: plain decimal for 1e-6 <= |x| < 1e21, exponential otherwise,
// with JS's exponent spelling.
func attributionJSONNumber(value float64) string {
	if value == 0 {
		return "0"
	}
	absolute := math.Abs(value)
	if absolute >= 1e-6 && absolute < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	text := strconv.FormatFloat(value, 'e', -1, 64)
	index := strings.IndexByte(text, 'e')
	if index < 0 {
		return text
	}
	mantissa := text[:index]
	exponent := text[index+1:]
	sign := ""
	if len(exponent) > 0 && (exponent[0] == '+' || exponent[0] == '-') {
		sign = string(exponent[0])
		exponent = exponent[1:]
	}
	exponent = strings.TrimLeft(exponent, "0")
	if exponent == "" {
		exponent = "0"
	}
	return mantissa + "e" + sign + exponent
}

// codexFileStat is the stat identity a fingerprint pins. It is shared by the
// attribution cache and the JSONL reader so both compare the same fields.
type codexFileStat struct {
	dev     uint64
	ino     uint64
	size    int64
	mtimeMs float64
	ctimeMs float64
}

func codexStatOf(info os.FileInfo) codexFileStat {
	dev, ino, _ := sessionfile.FileIdentity(info)
	return codexFileStat{
		dev:     dev,
		ino:     ino,
		size:    info.Size(),
		mtimeMs: mtime.Millis(info.ModTime()),
		ctimeMs: codexChangeTimeMillis(info),
	}
}

func sameCodexFileStat(left, right codexFileStat) bool {
	return left.dev == right.dev &&
		left.ino == right.ino &&
		left.size == right.size &&
		left.mtimeMs == right.mtimeMs &&
		left.ctimeMs == right.ctimeMs
}

func sameCodexFileIdentity(left, right codexFileStat) bool {
	return left.dev == right.dev && left.ino == right.ino
}

// codexChangeTimeMillis reproduces Node's fs.Stats#ctimeMs. Go exposes the
// change time only through the platform stat struct, and this package may not
// add build-tagged files, so the field is located reflectively: Linux and the
// BSDs name it Ctim, Darwin Ctimespec, and Windows has no equivalent. Without
// one the mtime is used — that can only weaken change detection on a platform
// where the identity check is already weaker (os.FileInfo carries no dev/ino
// there), never invent a false change on Unix.
func codexChangeTimeMillis(info os.FileInfo) float64 {
	change, ok := codexChangeTime(info)
	if !ok {
		return mtime.Millis(info.ModTime())
	}
	return mtime.Millis(change)
}

func codexChangeTime(info os.FileInfo) (time.Time, bool) {
	value := reflect.ValueOf(info.Sys())
	if !value.IsValid() {
		return time.Time{}, false
	}
	if value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return time.Time{}, false
		}
		value = value.Elem()
	}
	if value.Kind() != reflect.Struct {
		return time.Time{}, false
	}
	for _, name := range []string{"Ctim", "Ctimespec"} {
		field := value.FieldByName(name)
		if !field.IsValid() || field.Kind() != reflect.Struct {
			continue
		}
		sec := field.FieldByName("Sec")
		nsec := field.FieldByName("Nsec")
		if !sec.IsValid() || !nsec.IsValid() || !sec.CanInt() || !nsec.CanInt() {
			continue
		}
		return time.Unix(sec.Int(), nsec.Int()), true
	}
	return time.Time{}, false
}
