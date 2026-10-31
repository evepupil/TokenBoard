package codex

// Port of codex-subagent-usage-cache.ts: the on-disk cache of per-date child
// usage the correction subtracts.
//
// Reading a child session is the expensive half of the correction, and a hook
// sync re-runs it on every turn. The cache keys each result by the file's stat
// identity plus a hash of its tail, so a hit is only reused for byte-identical
// content: a session that was appended to, rewritten in place with its mtime
// restored, or swapped atomically all miss. The file lives next to the cursor,
// shares its lock protocol, and is written 0600 inside a 0700 directory.
//
// Two kinds of entry are deliberately absent from the persisted form:
// per-event identities (they are meaningful only within one profile's read) and
// anything the child read did not project. Only usage dates and counters are
// stored, so the cache cannot leak prompt content even if it is copied.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/collate"
	"github.com/MisonL/TokenBoard/clients/go/internal/renameatomic"
	"github.com/MisonL/TokenBoard/clients/go/internal/state"
)

const (
	codexSubagentUsageCacheFileName = "codex-subagent-usage-cache.json"
	codexSubagentUsageCacheVersion  = 1
	codexSubagentCacheRetentionMs   = 90 * 24 * 60 * 60 * 1000
	codexSubagentCacheMaxEntries    = 2_000
	codexSubagentCacheMaxBytes      = 8 * 1024 * 1024
	codexSubagentStableReadAttempts = 2
)

// ReadChildUsageByDate is the date-aggregated child read the cache wraps.
type ReadChildUsageByDate func(
	filePath string,
	timestamp string,
	timezone string,
	stderr func(string),
	sourceFilePath string,
) ([]DatedUsage, error)

// ReadChildUsageEvents is the event-level child read the cache wraps.
type ReadChildUsageEvents func(
	filePath string,
	timestamp string,
	timezone string,
	stderr func(string),
	sourceFilePath string,
) ([]ChildUsageEvent, error)

// CodexSubagentUsageCacheFile maps a frozen copy to the session it came from.
// A hook sync freezes the sessions it needs and must look the cached result up
// under the original path, not the temporary copy's.
type CodexSubagentUsageCacheFile struct {
	SourceFile        string
	SourceFingerprint CodexSessionFileFingerprint
}

// CodexSubagentUsageCacheReader is the read surface a cache transaction
// exposes.
type CodexSubagentUsageCacheReader struct {
	Read       ReadChildUsageByDate
	ReadEvents ReadChildUsageEvents
}

// CodexSubagentUsageCacheInput describes one cache transaction.
type CodexSubagentUsageCacheInput struct {
	// StateDir empty disables caching entirely; the callback then receives the
	// uncached readers, exactly like the TS `if (!input.stateDir)` branch.
	StateDir             string
	Timezone             string
	ReadChildUsageByDate ReadChildUsageByDate
	ReadChildUsageEvents ReadChildUsageEvents
	CacheFiles           map[string]CodexSubagentUsageCacheFile
	Callback             func(CodexSubagentUsageCacheReader) error
}

// WithCodexSubagentUsageCache runs callback under the cache lock with the
// cache loaded, then retains and writes the entries it used.
func WithCodexSubagentUsageCache(input CodexSubagentUsageCacheInput) error {
	if input.ReadChildUsageByDate == nil {
		return errors.New("Codex subagent usage cache requires a child usage reader")
	}
	readChildUsageEvents := input.ReadChildUsageEvents
	if readChildUsageEvents == nil {
		readChildUsageEvents = func(
			filePath, timestamp, timezone string,
			stderr func(string),
			_ string,
		) ([]ChildUsageEvent, error) {
			return ReadChildLastUsageEvents(filePath, timestamp, timezone, stderr)
		}
	}
	if input.StateDir == "" {
		return input.Callback(CodexSubagentUsageCacheReader{
			Read:       input.ReadChildUsageByDate,
			ReadEvents: readChildUsageEvents,
		})
	}

	cachePath := filepath.Join(input.StateDir, codexSubagentUsageCacheFileName)
	lockPath := cachePath + ".lock"
	lock, err := state.Acquire(lockPath, cursorLockTimeout)
	if err != nil {
		return err
	}
	if lock == nil {
		return fmt.Errorf("Timed out waiting for cursor lock: %s", lockPath)
	}
	transactionErr := runSubagentCacheTransaction(input, cachePath, lockPath, lock, readChildUsageEvents)
	releaseErr := lock.Release()
	if transactionErr != nil {
		return transactionErr
	}
	return releaseErr
}

// subagentCacheEntry is one persisted child read. Dev/Ino/CtimeMs are optional
// because entries written before file identity tracking can never match a live
// fingerprint and are recomputed on first use.
type subagentCacheEntry struct {
	Dev        *float64
	Ino        *float64
	Size       float64
	MtimeMs    float64
	CtimeMs    *float64
	TailSHA256 string
	UpdatedAt  string
	Usages     []DatedUsage
}

type subagentCacheState struct {
	Version  int
	Timezone string
	Entries  map[string]subagentCacheEntry
}

// subagentOrderedEntry pairs an entry with its cache key so the serialized
// form can keep the TS retain order (used first, then recent, newest first).
type subagentOrderedEntry struct {
	Key   string
	Entry subagentCacheEntry
}

func runSubagentCacheTransaction(
	input CodexSubagentUsageCacheInput,
	cachePath string,
	lockPath string,
	lock *state.Lock,
	readChildUsageEvents ReadChildUsageEvents,
) error {
	updatedAt := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	cache, err := readSubagentUsageCache(cachePath, input.Timezone, updatedAt)
	if err != nil {
		return err
	}
	usedKeys := map[string]bool{}
	// The TS transaction is single-threaded: mapWithConcurrency only starts
	// overlapping reads after the callback has produced the rows, and each
	// reader call awaits before touching the shared cache. The Go port runs the
	// reads on goroutines, so the cache map and the used-key set need a lock to
	// keep that same state consistent.
	var cacheMu sync.Mutex
	reader := CodexSubagentUsageCacheReader{
		Read: func(filePath, timestamp, timezone string, stderr func(string), sourceFilePath string) ([]DatedUsage, error) {
			cacheFile := subagentCacheFileFor(input.CacheFiles, filePath, sourceFilePath)
			keySource := filePath
			if cacheFile != nil {
				keySource = cacheFile.SourceFile
			} else if sourceFilePath != "" {
				keySource = sourceFilePath
			}
			key := attributionCacheKey(keySource)
			cacheMu.Lock()
			usedKeys[key] = true
			cacheMu.Unlock()

			before, err := fingerprintSubagentChildSessionFile(filePath)
			if err != nil {
				return nil, err
			}
			if cacheFile != nil {
				if err := assertFrozenSubagentCacheFile(before, cacheFile.SourceFingerprint); err != nil {
					return nil, err
				}
			}
			cacheFingerprint := before
			if cacheFile != nil {
				cacheFingerprint = cacheFile.SourceFingerprint
			}
			cacheMu.Lock()
			cached, hit := cache.entriesLookup(key)
			hit = hit && sameSubagentCacheFingerprint(cached, cacheFingerprint)
			if hit {
				cached.UpdatedAt = updatedAt
				cache.Entries[key] = cached
			}
			cacheMu.Unlock()
			if hit {
				return copyDatedUsages(cached.Usages), nil
			}

			// The TS readStableChildUsage calls the wrapped reader with four
			// arguments, so sourceFilePath never reaches it; it is only the
			// cache lookup key above. Passing an empty source keeps the two
			// paths identical for an injected reader that inspects it.
			stable, err := readStableChildUsage(
				filePath, timestamp, timezone, stderr,
				func(filePath, timestamp, timezone string, stderr func(string)) ([]DatedUsage, error) {
					return input.ReadChildUsageByDate(filePath, timestamp, timezone, stderr, "")
				},
				before,
			)
			if err != nil {
				return nil, err
			}
			if cacheFile != nil {
				if err := assertFrozenSubagentCacheFile(stable.fingerprint, cacheFile.SourceFingerprint); err != nil {
					return nil, err
				}
				matches, err := subagentSourceStillMatches(*cacheFile)
				if err != nil {
					return nil, err
				}
				if matches {
					cacheMu.Lock()
					cache.Entries[key] = subagentEntryFromFingerprint(
						cacheFile.SourceFingerprint, stable.usages, updatedAt)
					cacheMu.Unlock()
				} else {
					emitStderr(stderr,
						"Skipping stale Codex subagent usage cache write for a session that changed after copy")
				}
			} else {
				cacheMu.Lock()
				cache.Entries[key] = subagentEntryFromFingerprint(stable.fingerprint, stable.usages, updatedAt)
				cacheMu.Unlock()
			}
			return stable.usages, nil
		},
		ReadEvents: func(filePath, timestamp, timezone string, stderr func(string), sourceFilePath string) ([]ChildUsageEvent, error) {
			cacheFile := subagentCacheFileFor(input.CacheFiles, filePath, sourceFilePath)
			before, err := fingerprintSubagentChildSessionFile(filePath)
			if err != nil {
				return nil, err
			}
			if cacheFile != nil {
				if err := assertFrozenSubagentCacheFile(before, cacheFile.SourceFingerprint); err != nil {
					return nil, err
				}
			}
			// See the read closure: the wrapped event reader is called with
			// four arguments in TS.
			stable, err := readStableChildUsage(
				filePath, timestamp, timezone, stderr,
				func(filePath, timestamp, timezone string, stderr func(string)) ([]ChildUsageEvent, error) {
					return readChildUsageEvents(filePath, timestamp, timezone, stderr, "")
				},
				before,
			)
			if err != nil {
				return nil, err
			}
			if cacheFile != nil {
				if err := assertFrozenSubagentCacheFile(stable.fingerprint, cacheFile.SourceFingerprint); err != nil {
					return nil, err
				}
			}
			return copyChildUsageEvents(stable.usages), nil
		},
	}
	if err := input.Callback(reader); err != nil {
		return err
	}
	entries := RetainCodexSubagentCacheEntries(cache.Entries, usedKeys, subagentNowMillis(updatedAt))
	return writeSubagentUsageCache(cachePath, input.Timezone, entries, lockPath, lock)
}

func (s subagentCacheState) entriesLookup(key string) (subagentCacheEntry, bool) {
	entry, ok := s.Entries[key]
	return entry, ok
}

func subagentCacheFileFor(
	cacheFiles map[string]CodexSubagentUsageCacheFile,
	filePath string,
	sourceFilePath string,
) *CodexSubagentUsageCacheFile {
	if cacheFiles != nil {
		if file, ok := cacheFiles[filePath]; ok {
			return &file
		}
		if sourceFilePath != "" {
			if file, ok := cacheFiles[sourceFilePath]; ok {
				return &file
			}
		}
	}
	return nil
}

func assertFrozenSubagentCacheFile(frozen CodexSessionFileFingerprint, source CodexSessionFileFingerprint) error {
	if frozen.Size != source.Size || frozen.TailSHA256 != source.TailSHA256 {
		return errors.New("Codex frozen child session does not match its copy-time fingerprint")
	}
	return nil
}

// subagentSourceStillMatches reports whether the original session still
// describes the frozen copy. A source that vanished after the copy is stale,
// not an error: the copy is still the data this run is correcting from.
func subagentSourceStillMatches(cacheFile CodexSubagentUsageCacheFile) (bool, error) {
	current, err := FingerprintCodexSessionFile(cacheFile.SourceFile)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	return SameCodexSessionFileFingerprint(comparableOfFingerprint(cacheFile.SourceFingerprint), current), nil
}

type subagentStableRead[T any] struct {
	fingerprint CodexSessionFileFingerprint
	usages      []T
}

// readStableChildUsage reads a file and only trusts the result when the file's
// identity did not move across the read. A file caught mid-append is read
// again once; a file that keeps changing fails the sync instead of uploading
// a partial correction.
func readStableChildUsage[T any](
	filePath string,
	timestamp string,
	timezone string,
	stderr func(string),
	read func(filePath, timestamp, timezone string, stderr func(string)) ([]T, error),
	firstFingerprint CodexSessionFileFingerprint,
) (subagentStableRead[T], error) {
	before := firstFingerprint
	for attempt := 0; attempt < codexSubagentStableReadAttempts; attempt++ {
		usages, err := read(filePath, timestamp, timezone, stderr)
		if err != nil {
			return subagentStableRead[T]{}, err
		}
		after, err := fingerprintSubagentChildSessionFile(filePath)
		if err != nil {
			return subagentStableRead[T]{}, err
		}
		if sameSubagentFingerprint(before, after) {
			return subagentStableRead[T]{fingerprint: after, usages: usages}, nil
		}
		before = after
	}
	return subagentStableRead[T]{}, errors.New("Codex child session changed while correcting; retry the sync")
}

func sameSubagentFingerprint(left CodexSessionFileFingerprint, right CodexSessionFileFingerprint) bool {
	return sameCodexFileStat(
		codexFileStat{
			dev: left.Dev, ino: left.Ino, size: int64(left.Size),
			mtimeMs: left.MtimeMs, ctimeMs: left.CtimeMs,
		},
		codexFileStat{
			dev: right.Dev, ino: right.Ino, size: int64(right.Size),
			mtimeMs: right.MtimeMs, ctimeMs: right.CtimeMs,
		},
	) && left.TailSHA256 == right.TailSHA256
}

func sameSubagentCacheFingerprint(entry subagentCacheEntry, right CodexSessionFileFingerprint) bool {
	if entry.Dev == nil || entry.Ino == nil || entry.CtimeMs == nil {
		return false
	}
	return *entry.Dev == float64(right.Dev) &&
		*entry.Ino == float64(right.Ino) &&
		entry.Size == right.Size &&
		entry.MtimeMs == right.MtimeMs &&
		*entry.CtimeMs == right.CtimeMs &&
		entry.TailSHA256 == right.TailSHA256
}

func subagentEntryFromFingerprint(
	fingerprint CodexSessionFileFingerprint,
	usages []DatedUsage,
	updatedAt string,
) subagentCacheEntry {
	dev := float64(fingerprint.Dev)
	ino := float64(fingerprint.Ino)
	ctimeMs := fingerprint.CtimeMs
	return subagentCacheEntry{
		Dev:        &dev,
		Ino:        &ino,
		Size:       fingerprint.Size,
		MtimeMs:    fingerprint.MtimeMs,
		CtimeMs:    &ctimeMs,
		TailSHA256: fingerprint.TailSHA256,
		UpdatedAt:  updatedAt,
		Usages:     copyDatedUsages(usages),
	}
}

func copyDatedUsages(usages []DatedUsage) []DatedUsage {
	out := make([]DatedUsage, len(usages))
	copy(out, usages)
	return out
}

func copyChildUsageEvents(events []ChildUsageEvent) []ChildUsageEvent {
	out := make([]ChildUsageEvent, len(events))
	copy(out, events)
	return out
}

func readSubagentUsageCache(cachePath string, timezone string, fallbackUpdatedAt string) (subagentCacheState, error) {
	content, ok, err := readBoundedSubagentCacheFile(cachePath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return emptySubagentCache(timezone), nil
		}
		return subagentCacheState{}, err
	}
	// An oversized cache is stale by definition: discarding it loses only
	// recomputable corrections, while failing here would wedge every hook sync
	// until an operator deleted the file by hand.
	if !ok {
		return emptySubagentCache(timezone), nil
	}
	// Node decodes the buffer with TextDecoder's default replacement
	// behaviour, so invalid UTF-8 becomes U+FFFD before JSON.parse sees it.
	text := strings.ToValidUTF8(string(content), "�")
	if !json.Valid([]byte(text)) {
		return subagentCacheState{}, errors.New("Invalid Codex subagent usage cache JSON")
	}
	value, err := decodeSubagentCacheJSON(text)
	if err != nil {
		return subagentCacheState{}, errors.New("Invalid Codex subagent usage cache JSON")
	}
	parsed, valid := parseSubagentCacheState(value)
	if !valid {
		return subagentCacheState{}, errors.New("Invalid Codex subagent usage cache")
	}
	if parsed.Timezone != timezone {
		return emptySubagentCache(timezone), nil
	}
	for key, entry := range parsed.Entries {
		if entry.UpdatedAt == "" {
			entry.UpdatedAt = fallbackUpdatedAt
			parsed.Entries[key] = entry
		}
	}
	return parsed, nil
}

// readBoundedSubagentCacheFile returns (content, false, nil) when the file
// exceeds the byte budget; its content is then never read into memory.
func readBoundedSubagentCacheFile(cachePath string) ([]byte, bool, error) {
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
		return nil, false, errors.New("Invalid Codex subagent usage cache")
	}
	if before.Size() > codexSubagentCacheMaxBytes {
		return nil, false, nil
	}
	buffer := make([]byte, before.Size())
	if _, err := io.ReadFull(file, buffer); err != nil {
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			return nil, false, errors.New("Codex subagent usage cache changed while reading; retry the sync")
		}
		return nil, false, err
	}
	after, err := file.Stat()
	if err != nil {
		return nil, false, err
	}
	beforeStat := codexStatOf(before)
	afterStat := codexStatOf(after)
	if beforeStat.size != afterStat.size || beforeStat.mtimeMs != afterStat.mtimeMs || beforeStat.ctimeMs != afterStat.ctimeMs {
		return nil, false, errors.New("Codex subagent usage cache changed while reading; retry the sync")
	}
	return buffer, true, nil
}

func emptySubagentCache(timezone string) subagentCacheState {
	return subagentCacheState{
		Version:  codexSubagentUsageCacheVersion,
		Timezone: timezone,
		Entries:  map[string]subagentCacheEntry{},
	}
}

// RetainCodexSubagentCacheEntries ports retainCacheEntries: entries used by
// this run first, then entries updated inside the retention window, newest
// first within each group, capped by entry count.
func RetainCodexSubagentCacheEntries(
	entries map[string]subagentCacheEntry,
	usedKeys map[string]bool,
	nowMs float64,
) []subagentOrderedEntry {
	cutoffMs := nowMs - codexSubagentCacheRetentionMs
	used := make([]subagentOrderedEntry, 0, len(entries))
	recent := make([]subagentOrderedEntry, 0, len(entries))
	for key, entry := range entries {
		item := subagentOrderedEntry{Key: key, Entry: entry}
		if usedKeys[key] {
			used = append(used, item)
			continue
		}
		if updatedMs, ok := attributionParseMillis(entry.UpdatedAt); ok && updatedMs >= cutoffMs {
			recent = append(recent, item)
		}
	}
	sortSubagentEntriesNewestFirst(used)
	sortSubagentEntriesNewestFirst(recent)

	usedCount := len(used)
	if usedCount > codexSubagentCacheMaxEntries {
		usedCount = codexSubagentCacheMaxEntries
	}
	recentBudget := codexSubagentCacheMaxEntries - usedCount
	if recentBudget < 0 {
		recentBudget = 0
	}
	recentCount := len(recent)
	if recentCount > recentBudget {
		recentCount = recentBudget
	}
	selected := make([]subagentOrderedEntry, 0, usedCount+recentCount)
	selected = append(selected, used[:usedCount]...)
	selected = append(selected, recent[:recentCount]...)
	return selected
}

// sortSubagentEntriesNewestFirst orders by updatedAt descending, then by key
// ascending. An entry whose updatedAt does not parse sorts by key alone, which
// is how the TS comparator's NaN result falls through to localeCompare.
func sortSubagentEntriesNewestFirst(items []subagentOrderedEntry) {
	sort.SliceStable(items, func(left, right int) bool {
		leftMs, leftOk := attributionParseMillis(items[left].Entry.UpdatedAt)
		rightMs, rightOk := attributionParseMillis(items[right].Entry.UpdatedAt)
		if leftOk && rightOk && leftMs != rightMs {
			return leftMs > rightMs
		}
		return collate.Less(items[left].Key, items[right].Key)
	})
}

// evictSubagentEntriesToSerializedSize ports evictToSerializedSize. The byte
// accounting deliberately mirrors the TS one, including its use of the
// `[key, entry]` pair serialization and the `index > 1` comma condition.
func evictSubagentEntriesToSerializedSize(
	entries []subagentOrderedEntry,
	budgetBytes int,
) []subagentOrderedEntry {
	ordered := make([]subagentOrderedEntry, len(entries))
	copy(ordered, entries)
	sortSubagentEntriesNewestFirst(ordered)

	bytes := len(encodeSubagentCacheEntriesObject(ordered, 0))
	index := len(ordered)
	for bytes > budgetBytes && index > 0 {
		index--
		addition := 0
		if index > 1 {
			addition = 1
		}
		bytes -= len(encodeSubagentCacheEntryPair(ordered[index])) + addition
	}
	return ordered[:index]
}

func writeSubagentUsageCache(
	cachePath string,
	timezone string,
	entries []subagentOrderedEntry,
	lockPath string,
	lock *state.Lock,
) error {
	serialized := encodeSubagentCacheState(timezone, entries)
	if len(serialized) > codexSubagentCacheMaxBytes {
		// The retain pass caps entries by count; a byte-size overflow still
		// means a stale or external oversize. Evict oldest-first to 75%
		// rather than failing the sync, measuring in the same pretty
		// serialization the write uses.
		entries = evictSubagentEntriesToSerializedSize(entries, codexSubagentCacheMaxBytes*3/4)
		serialized = encodeSubagentCacheState(timezone, entries)
		if len(serialized) > codexSubagentCacheMaxBytes {
			return fmt.Errorf("Codex subagent usage cache exceeds the %d-byte limit", codexSubagentCacheMaxBytes)
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

// fingerprintSubagentChildSessionFile ports fingerprintFile: stat, open,
// re-stat, hash the tail, re-stat, and refuse any identity change along the
// way. The classified failures keep the child-session message the TS emits;
// everything else is wrapped with the child-session cause so a missing file is
// still recognisable through the wrapper.
func fingerprintSubagentChildSessionFile(filePath string) (CodexSessionFileFingerprint, error) {
	fingerprint, err := fingerprintCodexSessionFileRange(filePath, nil)
	if err != nil {
		switch {
		case errors.Is(err, errCodexSessionInspectSymlink):
			return CodexSessionFileFingerprint{},
				errors.New("Unable to fingerprint Codex child session: symbolic links are not supported")
		case errors.Is(err, errCodexSessionInspectNotFile):
			return CodexSessionFileFingerprint{},
				errors.New("Unable to fingerprint Codex child session: path is not a file")
		case errors.Is(err, errCodexSessionFingerprintRace):
			return CodexSessionFileFingerprint{},
				errors.New("Codex child session changed while fingerprinting; retry the sync")
		}
		return CodexSessionFileFingerprint{}, &subagentChildFingerprintError{cause: err}
	}
	return fingerprint, nil
}

// subagentChildFingerprintError keeps the TS wrapper's exact message while
// exposing the cause, so errors.Is(err, fs.ErrNotExist) sees through it the way
// the TS `error.cause` chain does.
type subagentChildFingerprintError struct {
	cause error
}

func (e *subagentChildFingerprintError) Error() string {
	return "Unable to fingerprint Codex child session"
}
func (e *subagentChildFingerprintError) Unwrap() error { return e.cause }

// subagentNowMillis converts the transaction's ISO timestamp to epoch
// milliseconds the way Date.parse(updatedAt) would.
func subagentNowMillis(updatedAt string) float64 {
	parsed, ok := jsonlParseJSDate(updatedAt)
	if !ok {
		return 0
	}
	return float64(parsed.Unix())*1e3 + float64(parsed.Nanosecond())/1e6
}

// decodeSubagentCacheJSON ports JSON.parse: numbers as float64 (overflow to
// ±Infinity, as in JS), duplicate keys keeping the last value.
func decodeSubagentCacheJSON(text string) (any, error) {
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, errors.New("Codex subagent usage cache has trailing content")
	}
	return jsonlNormalizeJSONValue(value), nil
}

func parseSubagentCacheState(value any) (subagentCacheState, bool) {
	root, ok := value.(map[string]any)
	if !ok {
		return subagentCacheState{}, false
	}
	version, ok := subagentFiniteNumber(root["version"])
	if !ok || version != codexSubagentUsageCacheVersion {
		return subagentCacheState{}, false
	}
	timezone, ok := root["timezone"].(string)
	if !ok {
		return subagentCacheState{}, false
	}
	rawEntries, ok := root["entries"].(map[string]any)
	if !ok {
		return subagentCacheState{}, false
	}
	entries := make(map[string]subagentCacheEntry, len(rawEntries))
	for key, rawEntry := range rawEntries {
		entry, ok := parseSubagentCacheEntry(rawEntry)
		if !ok {
			return subagentCacheState{}, false
		}
		entries[key] = entry
	}
	return subagentCacheState{
		Version:  codexSubagentUsageCacheVersion,
		Timezone: timezone,
		Entries:  entries,
	}, true
}

func parseSubagentCacheEntry(value any) (subagentCacheEntry, bool) {
	record, ok := value.(map[string]any)
	if !ok {
		return subagentCacheEntry{}, false
	}
	size, ok := subagentFiniteNumber(record["size"])
	if !ok {
		return subagentCacheEntry{}, false
	}
	dev, ok := subagentOptionalFiniteNumber(record, "dev")
	if !ok {
		return subagentCacheEntry{}, false
	}
	ino, ok := subagentOptionalFiniteNumber(record, "ino")
	if !ok {
		return subagentCacheEntry{}, false
	}
	mtimeMs, ok := subagentFiniteNumber(record["mtimeMs"])
	if !ok {
		return subagentCacheEntry{}, false
	}
	ctimeMs, ok := subagentOptionalFiniteNumber(record, "ctimeMs")
	if !ok {
		return subagentCacheEntry{}, false
	}
	tailSha256, ok := record["tailSha256"].(string)
	if !ok {
		return subagentCacheEntry{}, false
	}
	updatedAt := ""
	if raw, present := record["updatedAt"]; present {
		if raw == nil {
			return subagentCacheEntry{}, false
		}
		parsed, ok := raw.(string)
		if !ok {
			return subagentCacheEntry{}, false
		}
		updatedAt = parsed
	}
	rawUsages, ok := record["usages"].([]any)
	if !ok {
		return subagentCacheEntry{}, false
	}
	usages := make([]DatedUsage, 0, len(rawUsages))
	for _, rawUsage := range rawUsages {
		usage, ok := parseSubagentSerializedDatedUsage(rawUsage)
		if !ok {
			return subagentCacheEntry{}, false
		}
		usages = append(usages, usage)
	}
	return subagentCacheEntry{
		Dev:        dev,
		Ino:        ino,
		Size:       size,
		MtimeMs:    mtimeMs,
		CtimeMs:    ctimeMs,
		TailSHA256: tailSha256,
		UpdatedAt:  updatedAt,
		Usages:     usages,
	}, true
}

func parseSubagentSerializedDatedUsage(value any) (DatedUsage, bool) {
	record, ok := value.(map[string]any)
	if !ok {
		return DatedUsage{}, false
	}
	usageDate, ok := record["usageDate"].(string)
	if !ok {
		return DatedUsage{}, false
	}
	inputTokens, ok := subagentFiniteNumber(record["inputTokens"])
	if !ok {
		return DatedUsage{}, false
	}
	outputTokens, ok := subagentFiniteNumber(record["outputTokens"])
	if !ok {
		return DatedUsage{}, false
	}
	cacheCreationTokens := 0.0
	if raw, present := record["cacheCreationTokens"]; present {
		parsed, ok := subagentFiniteNumber(raw)
		if !ok {
			return DatedUsage{}, false
		}
		cacheCreationTokens = parsed
	}
	cacheReadTokens, ok := subagentFiniteNumber(record["cacheReadTokens"])
	if !ok {
		return DatedUsage{}, false
	}
	totalTokens, ok := subagentFiniteNumber(record["totalTokens"])
	if !ok {
		return DatedUsage{}, false
	}
	return DatedUsage{
		UsageDate:           usageDate,
		InputTokens:         inputTokens,
		OutputTokens:        outputTokens,
		CacheCreationTokens: cacheCreationTokens,
		CacheReadTokens:     cacheReadTokens,
		TotalTokens:         totalTokens,
	}, true
}

func subagentOptionalFiniteNumber(record map[string]any, key string) (*float64, bool) {
	raw, present := record[key]
	if !present {
		return nil, true
	}
	number, ok := subagentFiniteNumber(raw)
	if !ok {
		return nil, false
	}
	return &number, true
}

// subagentFiniteNumber is the TS isFiniteNumber: a finite, non-negative
// number. JSON cannot carry NaN/Inf, but a programmatic value can.
func subagentFiniteNumber(value any) (float64, bool) {
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

// encodeSubagentCacheState writes `JSON.stringify(cache, null, 2) + "\n"` for
// the fixed field order the TS object spread produces.
func encodeSubagentCacheState(timezone string, entries []subagentOrderedEntry) []byte {
	var builder strings.Builder
	builder.WriteString("{\n  \"version\": ")
	builder.WriteString(strconv.Itoa(codexSubagentUsageCacheVersion))
	builder.WriteString(",\n  \"timezone\": ")
	builder.WriteString(attributionJSONString(timezone))
	builder.WriteString(",\n  \"entries\": ")
	builder.WriteString(encodeSubagentCacheEntriesObject(entries, 1))
	builder.WriteString("\n}\n")
	return []byte(builder.String())
}

// encodeSubagentCacheEntriesObject writes the entries object with its closing
// brace at baseLevel. baseLevel 0 is the standalone
// `JSON.stringify(entries, null, 2)` the eviction accounting measures;
// baseLevel 1 is the same object embedded under the cache state's "entries"
// key.
func encodeSubagentCacheEntriesObject(entries []subagentOrderedEntry, baseLevel int) string {
	if len(entries) == 0 {
		return "{}"
	}
	keyIndent := strings.Repeat("  ", baseLevel+1)
	var builder strings.Builder
	builder.WriteString("{\n")
	for index, entry := range entries {
		if index > 0 {
			builder.WriteString(",\n")
		}
		builder.WriteString(keyIndent)
		builder.WriteString(attributionJSONString(entry.Key))
		builder.WriteString(": ")
		builder.WriteString(encodeSubagentCacheEntry(entry.Entry, baseLevel+1))
	}
	builder.WriteString("\n")
	builder.WriteString(strings.Repeat("  ", baseLevel))
	builder.WriteString("}")
	return builder.String()
}

// encodeSubagentCacheEntryPair writes `JSON.stringify([key, entry], null, 2)`,
// the shape the TS eviction accounting measures.
func encodeSubagentCacheEntryPair(entry subagentOrderedEntry) string {
	var builder strings.Builder
	builder.WriteString("[\n  ")
	builder.WriteString(attributionJSONString(entry.Key))
	builder.WriteString(",\n  ")
	builder.WriteString(encodeSubagentCacheEntry(entry.Entry, 1))
	builder.WriteString("\n]")
	return builder.String()
}

// encodeSubagentCacheEntry writes one entry object with its opening brace at
// the given indentation level (2 spaces per level).
func encodeSubagentCacheEntry(entry subagentCacheEntry, level int) string {
	indent := strings.Repeat("  ", level)
	inner := strings.Repeat("  ", level+1)
	var builder strings.Builder
	builder.WriteString("{\n")
	first := true
	writeField := func(name string, value string) {
		if !first {
			builder.WriteString(",\n")
		}
		first = false
		builder.WriteString(inner)
		builder.WriteString(attributionJSONString(name))
		builder.WriteString(": ")
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
	if entry.CtimeMs != nil {
		writeField("ctimeMs", attributionJSONNumber(*entry.CtimeMs))
	}
	writeField("tailSha256", attributionJSONString(entry.TailSHA256))
	writeField("usages", encodeSubagentDatedUsages(entry.Usages, level+1))
	writeField("updatedAt", attributionJSONString(entry.UpdatedAt))
	builder.WriteString("\n")
	builder.WriteString(indent)
	builder.WriteString("}")
	return builder.String()
}

// encodeSubagentDatedUsages writes the usages array whose closing bracket sits
// at arrayLevel (the level of the "usages" key).
func encodeSubagentDatedUsages(usages []DatedUsage, arrayLevel int) string {
	if len(usages) == 0 {
		return "[]"
	}
	elementLevel := arrayLevel + 1
	elementIndent := strings.Repeat("  ", elementLevel)
	var builder strings.Builder
	builder.WriteString("[\n")
	for index, usage := range usages {
		if index > 0 {
			builder.WriteString(",\n")
		}
		builder.WriteString(elementIndent)
		builder.WriteString(encodeSubagentDatedUsage(usage, elementLevel))
	}
	builder.WriteString("\n")
	builder.WriteString(strings.Repeat("  ", arrayLevel))
	builder.WriteString("]")
	return builder.String()
}

func encodeSubagentDatedUsage(usage DatedUsage, level int) string {
	inner := strings.Repeat("  ", level+1)
	indent := strings.Repeat("  ", level)
	fields := []struct {
		name  string
		value string
	}{
		{"usageDate", attributionJSONString(usage.UsageDate)},
		{"inputTokens", attributionJSONNumber(usage.InputTokens)},
		{"outputTokens", attributionJSONNumber(usage.OutputTokens)},
		{"cacheCreationTokens", attributionJSONNumber(usage.CacheCreationTokens)},
		{"cacheReadTokens", attributionJSONNumber(usage.CacheReadTokens)},
		{"totalTokens", attributionJSONNumber(usage.TotalTokens)},
	}
	var builder strings.Builder
	builder.WriteString("{\n")
	for index, field := range fields {
		if index > 0 {
			builder.WriteString(",\n")
		}
		builder.WriteString(inner)
		builder.WriteString(attributionJSONString(field.name))
		builder.WriteString(": ")
		builder.WriteString(field.value)
	}
	builder.WriteString("\n")
	builder.WriteString(indent)
	builder.WriteString("}")
	return builder.String()
}
