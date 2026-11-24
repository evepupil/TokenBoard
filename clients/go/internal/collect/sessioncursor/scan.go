package sessioncursor

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/collate"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/mtime"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionfile"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionwalk"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// DefaultSessionLineBytes is the TS defaultSessionLineBytes: a line longer
// than this is streamed through the metadata scanner instead of buffered.
const DefaultSessionLineBytes = 1024 * 1024

// DefaultScanSafetyMs re-reads a window before the last scan's high-water mark
// so a file whose mtime lands in the same instant as the previous scan is not
// skipped.
const DefaultScanSafetyMs = 60_000

const (
	highWaterKey   = "lastScanHighWaterMs"
	profileHashKey = "codexHookProfileHash"
)

// ScanInput configures one incremental scan.
type ScanInput struct {
	Source      contract.Source
	SessionsDir string
	SessionDirs []string
	CursorPath  string
	// CursorProfileHash pins the Codex profile the cursor belongs to. The
	// second field distinguishes "not supplied" from an empty hash.
	CursorProfileHash        string
	HasCursorProfileHash     bool
	ScanSinceMs              *float64
	ScanSafetyMs             float64
	MaxLineBytes             int
	AllowedRootSymlinks      []string
	ForcePendingUploadRescan bool
	// Now is injectable for tests; nil uses the wall clock.
	Now func() time.Time
}

// ChangedFile is one session file the scan found new or changed.
type ChangedFile struct {
	AbsolutePath    string
	RelativePath    string
	Size            float64
	MtimeMs         float64
	SHA256          string
	EndsWithNewline bool
	PendingUpload   bool
	AppendOnly      bool
	ReadOffsetBytes int64
	ReadLines       func(yield func(sessionfile.Line) error) error
}

// PendingSnapshotGroup is a vanished file's carried snapshots.
type PendingSnapshotGroup struct {
	RelativePath string
	Snapshots    []Snapshot
}

// PendingSnapshotEntry additionally carries the file digest, so the caller can
// acknowledge the exact revision.
type PendingSnapshotEntry struct {
	RelativePath string
	SHA256       string
	Snapshots    []Snapshot
}

// ReusablePendingFile is a Codex pending file whose content did not change and
// whose snapshots are still on disk.
type ReusablePendingFile struct {
	RelativePath string
	SHA256       string
	Snapshots    []Snapshot
}

// ScanResult is the outcome of one scan before parsing. Commit and
// MarkPendingUpload mutate the cursor the scan built.
type ScanResult struct {
	Files                         []ChangedFile
	Cursor                        State
	HasCursorCleanup              bool
	HasCursorMetadataUpdate       bool
	HasCursorProfileUpdate        bool
	HasPendingUpload              bool
	HasUnreadableChangedFile      bool
	HasUnreadablePendingUpload    bool
	MissingPendingSnapshots       []PendingSnapshotGroup
	MissingPendingSnapshotEntries []PendingSnapshotEntry
	ReusablePendingFiles          []ReusablePendingFile

	hasReadFailure     bool
	unreadChangedFiles map[string]bool
	cursorPath         string
	initial            State
}

// MarkPendingUpload flags the changed files as awaiting upload. A nil paths
// slice flags every file the scan found; an empty non-nil slice flags none.
func (r *ScanResult) MarkPendingUpload(paths []string) {
	var allowed map[string]bool
	if paths != nil {
		allowed = make(map[string]bool, len(paths))
		for _, path := range paths {
			allowed[path] = true
		}
	}
	for _, file := range r.Files {
		if allowed != nil && !allowed[file.RelativePath] {
			continue
		}
		entry := r.Cursor.Files[file.RelativePath]
		pending := true
		entry.PendingUpload = &pending
		r.Cursor.Files[file.RelativePath] = entry
	}
}

// Commit writes the cursor unless the scan produced no state change. It
// refuses to persist while a changed file is unread: committing then would
// record the file as processed with its snapshots missing.
func (r *ScanResult) Commit(source contract.Source) error {
	if r.hasReadFailure {
		return fmt.Errorf("%s session cursor cannot commit after a changed file read failure", source)
	}
	if len(r.unreadChangedFiles) > 0 {
		return fmt.Errorf("%s session cursor cannot commit before all changed files are read", source)
	}
	if CursorStatesEqual(r.initial, r.Cursor) {
		return nil
	}
	return Write(r.cursorPath, r.Cursor)
}

// CollectChangedSessionFiles ports collectChangedSessionFiles: it walks the
// session tree, compares each file against the cursor, and returns the files
// whose content must be parsed.
func CollectChangedSessionFiles(input ScanInput) (*ScanResult, error) {
	maxLineBytes := input.MaxLineBytes
	if maxLineBytes == 0 {
		maxLineBytes = DefaultSessionLineBytes
	}
	if maxLineBytes < 1 {
		return nil, errors.New("Invalid session line byte limit")
	}
	now := time.Now
	if input.Now != nil {
		now = input.Now
	}
	current, err := Read(input.CursorPath, string(input.Source))
	if err != nil {
		return nil, err
	}
	scanSinceMs := readEffectiveScanSinceMs(current, input.ScanSinceMs)
	next := NewState(string(input.Source))
	if input.HasCursorProfileHash {
		if err := next.SetExtra(profileHashKey, input.CursorProfileHash); err != nil {
			return nil, err
		}
	} else if hash, ok := stringExtra(current, profileHashKey); ok {
		if err := next.SetExtra(profileHashKey, hash); err != nil {
			return nil, err
		}
	}

	result := &ScanResult{
		unreadChangedFiles: map[string]bool{},
		cursorPath:         input.CursorPath,
		initial:            current,
	}
	scanState := &scanState{
		seen:               map[string]bool{},
		highWaterMs:        highWater(current),
		unreadChangedFiles: map[string]bool{},
	}
	sessionDirs := input.SessionDirs
	if len(sessionDirs) == 0 {
		sessionDirs = []string{input.SessionsDir}
	}
	// A root that will not resolve leaves the tree unread rather than empty, so an entry
	// missing from this scan proves nothing about whether its file still exists.
	allRootsResolved := true
	for _, sessionsDir := range sessionDirs {
		options := sessionwalk.Options{}
		if input.Source == contract.SourceCodex {
			options.RejectRootSymlink = true
			options.RootBoundary = filepath.Dir(sessionsDir)
			options.AllowedRootSymlinks = input.AllowedRootSymlinks
		}
		files, ok, err := sessionwalk.Resolve(sessionsDir, options)
		if err != nil {
			return nil, err
		}
		if !ok {
			allRootsResolved = false
			continue
		}
		for _, file := range files.Paths {
			logicalRelativePath := sessionwalk.NormalizeRelativePath(file)
			if scanState.seen[logicalRelativePath] {
				continue
			}
			if err := collectSessionFile(input, current, next, scanSinceMs, maxLineBytes, scanState, result, files.RootDir, file, now); err != nil {
				return nil, err
			}
		}
	}
	missing := preserveMissingCursorEntries(current, next, scanState.seen, allRootsResolved)
	result.MissingPendingSnapshots = missing.missingPendingSnapshots
	result.MissingPendingSnapshotEntries = missing.missingPendingSnapshotEntries
	result.HasCursorCleanup = missing.hasCursorCleanup
	if err := next.SetExtra(highWaterKey, scanState.highWaterMs); err != nil {
		return nil, err
	}
	result.HasCursorMetadataUpdate = scanState.hasCursorMetadataUpdate
	result.HasCursorProfileUpdate = input.HasCursorProfileHash && profileHashOf(current) != input.CursorProfileHash
	for _, entry := range next.Files {
		if entry.PendingUpload != nil && *entry.PendingUpload {
			result.HasPendingUpload = true
			break
		}
	}
	result.HasUnreadableChangedFile = scanState.hasUnreadableChangedFile
	result.HasUnreadablePendingUpload = scanState.hasUnreadablePendingUpload || missing.hasUnreadablePendingUpload
	result.ReusablePendingFiles = scanState.reusablePendingFiles
	result.Cursor = next
	result.Files = scanState.files
	sort.SliceStable(result.Files, func(i, j int) bool {
		return collate.Less(result.Files[i].RelativePath, result.Files[j].RelativePath)
	})
	for path := range scanState.unreadChangedFiles {
		result.unreadChangedFiles[path] = true
	}
	return result, nil
}

type scanState struct {
	files                      []ChangedFile
	seen                       map[string]bool
	highWaterMs                float64
	hasUnreadableChangedFile   bool
	hasUnreadablePendingUpload bool
	hasCursorMetadataUpdate    bool
	unreadChangedFiles         map[string]bool
	reusablePendingFiles       []ReusablePendingFile
}

func collectSessionFile(
	input ScanInput,
	current, next State,
	scanSinceMs *float64,
	maxLineBytes int,
	state *scanState,
	result *ScanResult,
	sessionsDir, file string,
	now func() time.Time,
) error {
	absolutePath := file
	if !filepath.IsAbs(file) {
		absolutePath = filepath.Join(sessionsDir, file)
	}
	relativePath, err := filepath.Rel(sessionsDir, absolutePath)
	if err != nil {
		return err
	}
	relativePath = sessionwalk.NormalizeRelativePath(relativePath)
	fileInfo, err := os.Lstat(absolutePath)
	if err != nil {
		// A file rotated away between the walk and this stat is simply gone.
		return nil
	}
	if fileInfo.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("Unable to read %s session file %s: symbolic links are not supported", input.Source, absolutePath)
	}
	if !fileInfo.Mode().IsRegular() {
		return nil
	}
	// Clamped to the present: the mark becomes the cutoff the next scan
	// subtracts its safety window from, and a file dated in the future (clock
	// step, restored backup, touch -d) would otherwise hide files that were
	// never read from every later scan.
	fileMtime := mtime.Millis(fileInfo.ModTime())
	state.highWaterMs = maxFloat(state.highWaterMs, minFloat(fileMtime, float64(now().UnixMilli())))
	state.seen[relativePath] = true

	entry := Entry{Size: float64(fileInfo.Size()), MtimeMs: fileMtime}
	prior, hasPrior := current.Files[relativePath]
	if hasPrior && sameMetadata(prior, entry) && !isPending(prior) && prior.EndsWithNewline == nil {
		ends, err := sessionfile.FileEndsWithNewline(absolutePath, int64(entry.Size))
		if err == nil {
			updated := prior
			updated.EndsWithNewline = &ends
			next.Files[relativePath] = updated
			state.hasCursorMetadataUpdate = true
			return nil
		}
	}
	if input.Source == contract.SourceCodex && !input.ForcePendingUploadRescan && hasPrior &&
		isPending(prior) && sameMetadata(prior, entry) && len(prior.Snapshots) > 0 &&
		!hasContextPricingPending(prior.Snapshots) {
		next.Files[relativePath] = prior
		state.reusablePendingFiles = append(state.reusablePendingFiles, ReusablePendingFile{
			RelativePath: relativePath,
			SHA256:       prior.SHA256,
			Snapshots:    cloneSnapshots(prior.Snapshots),
		})
		return nil
	}
	if skipByMetadata(hasPrior, prior, entry, scanSinceMs, next, relativePath) {
		return nil
	}

	dev, ino, _ := sessionfile.FileIdentity(fileInfo)
	fingerprint := sessionfile.Fingerprint{Dev: dev, Ino: ino, Size: int64(entry.Size)}
	readLines := func(startOffset int64) func(yield func(sessionfile.Line) error) error {
		return func(yield func(sessionfile.Line) error) error {
			err := sessionfile.Read(sessionfile.ReadInput{
				FilePath:       absolutePath,
				StartOffset:    startOffset,
				EndOffset:      int64Ptr(int64(entry.Size)),
				MaxLineBytes:   maxLineBytes,
				CodexUsageOnly: input.Source == contract.SourceCodex,
				Source:         input.Source,
				Fingerprint:    &sessionfile.Fingerprint{Dev: fingerprint.Dev, Ino: fingerprint.Ino, Size: fingerprint.Size, SHA256: entry.SHA256},
			}, yield)
			// Reads happen after CollectChangedSessionFiles copied scanState
			// into the result, so both the failure flag and the unread
			// bookkeeping must land on the result itself (mirrors the TS
			// readChangedSessionJsonlLines closure).
			if err != nil {
				result.hasReadFailure = true
				return err
			}
			delete(result.unreadChangedFiles, relativePath)
			return nil
		}
	}

	if hasPrior && isAppendOnlyUpdate(prior, entry) {
		prefixSHA, fullSHA, err := sessionfile.FingerprintFileAndPrefix(absolutePath, int64(prior.Size), int64(entry.Size))
		if err != nil {
			recordUnreadableFile(hasPrior, prior, next, relativePath, state)
			return nil
		}
		ends, err := sessionfile.FileEndsWithNewline(absolutePath, int64(entry.Size))
		if err != nil {
			recordUnreadableFile(hasPrior, prior, next, relativePath, state)
			return nil
		}
		entry.SHA256 = fullSHA
		if prefixSHA == prior.SHA256 {
			next.Files[relativePath] = prior
			state.files = append(state.files, ChangedFile{
				AbsolutePath:    absolutePath,
				RelativePath:    relativePath,
				Size:            entry.Size,
				MtimeMs:         entry.MtimeMs,
				SHA256:          entry.SHA256,
				EndsWithNewline: ends,
				PendingUpload:   false,
				AppendOnly:      true,
				ReadOffsetBytes: int64(prior.Size),
				ReadLines:       readLines(int64(prior.Size)),
			})
			state.unreadChangedFiles[relativePath] = true
			return nil
		}
		next.Files[relativePath] = newCursorEntry(entry, isPending(prior), &ends, now)
		state.files = append(state.files, ChangedFile{
			AbsolutePath:    absolutePath,
			RelativePath:    relativePath,
			Size:            entry.Size,
			MtimeMs:         entry.MtimeMs,
			SHA256:          entry.SHA256,
			EndsWithNewline: ends,
			PendingUpload:   isPending(prior),
			ReadLines:       readLines(0),
		})
		state.unreadChangedFiles[relativePath] = true
		return nil
	}

	sha, _, err := sessionfile.FingerprintFile(absolutePath, int64Ptr(int64(entry.Size)))
	if err != nil {
		recordUnreadableFile(hasPrior, prior, next, relativePath, state)
		return nil
	}
	entry.SHA256 = sha
	ends, err := sessionfile.FileEndsWithNewline(absolutePath, int64(entry.Size))
	if err != nil {
		recordUnreadableFile(hasPrior, prior, next, relativePath, state)
		return nil
	}
	if hasPrior && sameFile(prior, entry) && !isPending(prior) {
		next.Files[relativePath] = prior
		return nil
	}
	next.Files[relativePath] = newCursorEntry(entry, hasPrior && isPending(prior), &ends, now)
	state.files = append(state.files, ChangedFile{
		AbsolutePath:    absolutePath,
		RelativePath:    relativePath,
		Size:            entry.Size,
		MtimeMs:         entry.MtimeMs,
		SHA256:          entry.SHA256,
		EndsWithNewline: ends,
		PendingUpload:   hasPrior && isPending(prior),
		ReadLines:       readLines(0),
	})
	state.unreadChangedFiles[relativePath] = true
	return nil
}

func skipByMetadata(hasPrior bool, prior, entry Entry, scanSinceMs *float64, next State, relativePath string) bool {
	if (!hasPrior || !isPending(prior)) && scanSinceMs != nil && entry.MtimeMs < *scanSinceMs {
		if hasPrior {
			next.Files[relativePath] = prior
		}
		return true
	}
	if hasPrior && sameMetadata(prior, entry) && !isPending(prior) {
		next.Files[relativePath] = prior
		return true
	}
	return false
}

func recordUnreadableFile(hasPrior bool, prior Entry, next State, relativePath string, state *scanState) {
	state.hasUnreadableChangedFile = true
	if hasPrior && isPending(prior) {
		state.hasUnreadablePendingUpload = true
	}
	if hasPrior {
		next.Files[relativePath] = prior
	}
}

func newCursorEntry(entry Entry, pendingUpload bool, endsWithNewline *bool, now func() time.Time) Entry {
	result := Entry{
		Size:            entry.Size,
		MtimeMs:         entry.MtimeMs,
		SHA256:          entry.SHA256,
		ContentHashAlgo: sessionfile.ContentHashAlgorithm,
		Snapshots:       []Snapshot{},
		MissingCost:     false,
		UpdatedAt:       now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	if endsWithNewline != nil {
		result.EndsWithNewline = endsWithNewline
	}
	if pendingUpload {
		pending := true
		result.PendingUpload = &pending
	}
	return result
}

type missingEntries struct {
	hasCursorCleanup              bool
	hasUnreadablePendingUpload    bool
	missingPendingSnapshots       []PendingSnapshotGroup
	missingPendingSnapshotEntries []PendingSnapshotEntry
}

// preserveMissingCursorEntries carries forward the entries this scan did not see.
//
// allRootsResolved is what makes reclaiming safe: when every configured root listed
// successfully, an entry the walk did not produce belongs to a file that no longer
// exists, and keeping it forever is how a cursor grows without bound — one machine
// reached 15 MB with 31% of its entries pointing at deleted files, each copied back
// verbatim on every run. When a root failed to resolve the tree was unread rather than
// empty, so every entry is preserved: dropping them would make the next run re-read and
// re-upload history the server already has.
//
// A pending entry is never reclaimed regardless: it carries snapshots that have not been
// uploaded yet, and the file may be the only place they can be reconstructed from.
func preserveMissingCursorEntries(current, next State, seen map[string]bool, allRootsResolved bool) missingEntries {
	result := missingEntries{}
	for _, relativePath := range sortedEntryKeys(current.Files) {
		entry := current.Files[relativePath]
		if seen[relativePath] {
			continue
		}
		if isPending(entry) && len(entry.Snapshots) == 0 {
			result.hasCursorCleanup = true
			continue
		}
		if isPending(entry) {
			result.missingPendingSnapshots = append(result.missingPendingSnapshots, PendingSnapshotGroup{
				RelativePath: relativePath,
				Snapshots:    entry.Snapshots,
			})
			result.missingPendingSnapshotEntries = append(result.missingPendingSnapshotEntries, PendingSnapshotEntry{
				RelativePath: relativePath,
				SHA256:       entry.SHA256,
				Snapshots:    entry.Snapshots,
			})
		} else if allRootsResolved {
			// The file is gone and nothing is waiting on it: let the entry go.
			result.hasCursorCleanup = true
			continue
		}
		if _, ok := next.Files[relativePath]; !ok {
			next.Files[relativePath] = entry
		}
	}
	return result
}

// UpdateCursorFile ports updateCursorFile: the parsed snapshots replace (or,
// for an append, merge into) the entry's carried snapshots.
type ParsedFile struct {
	Snapshots             []Snapshot
	MissingCost           bool
	IgnoredUploadSafeRows int
	// ContextPricingMarker overrides the package-level hook for this file. The
	// Codex provider passes one bound to the rules derived from the running
	// catalogue; nil keeps the registered default.
	ContextPricingMarker func([]Snapshot) []Snapshot
}

func UpdateCursorFile(cursor *State, file ChangedFile, parsed ParsedFile, updatedAt string) error {
	prior, hasPrior := cursor.Files[file.RelativePath]
	hasSafeIgnoredRows := parsed.IgnoredUploadSafeRows > 0
	preservePendingSnapshots := hasPrior && isPending(prior) && len(parsed.Snapshots) == 0 &&
		hasSafeIgnoredRows && len(prior.Snapshots) > 0 && !allSyntheticZeroUsage(prior.Snapshots)
	safeIgnoredPending := hasPrior && isPending(prior) && len(parsed.Snapshots) == 0 &&
		hasSafeIgnoredRows && !preservePendingSnapshots

	var snapshots []Snapshot
	switch {
	case file.AppendOnly && hasPrior:
		combined := append([]Snapshot{}, prior.Snapshots...)
		combined = append(combined, parsed.Snapshots...)
		snapshots = mergeCursorSnapshots(combined)
	case preservePendingSnapshots:
		snapshots = prior.Snapshots
	default:
		snapshots = parsed.Snapshots
	}
	if cursor.Source == string(contract.SourceCodex) {
		marker := parsed.ContextPricingMarker
		if marker == nil {
			marker = ContextPricingMarker
		}
		if marker == nil {
			return errors.New("codex cursor update requires the context pricing marker")
		}
		snapshots = marker(snapshots)
	}
	missingCost := parsed.MissingCost
	if file.AppendOnly && hasPrior {
		missingCost = prior.MissingCost || parsed.MissingCost
	}
	ends := file.EndsWithNewline
	entry := Entry{
		Size:            file.Size,
		MtimeMs:         file.MtimeMs,
		SHA256:          file.SHA256,
		ContentHashAlgo: sessionfile.ContentHashAlgorithm,
		EndsWithNewline: &ends,
		Snapshots:       snapshots,
		MissingCost:     missingCost,
		UpdatedAt:       updatedAt,
	}
	if !safeIgnoredPending && hasPrior && isPending(prior) {
		pending := true
		entry.PendingUpload = &pending
	}
	cursor.Files[file.RelativePath] = entry
	return nil
}

func allSyntheticZeroUsage(snapshots []Snapshot) bool {
	for _, snapshot := range snapshots {
		if !isSyntheticZeroUsageSnapshot(snapshot) {
			return false
		}
	}
	return len(snapshots) > 0
}

func isSyntheticZeroUsageSnapshot(snapshot Snapshot) bool {
	return snapshot.Source == string(contract.SourceClaudeCode) &&
		snapshot.Model == "<synthetic>" &&
		snapshot.InputTokens == 0 &&
		snapshot.OutputTokens == 0 &&
		snapshot.CacheCreationTokens == 0 &&
		snapshot.CacheReadTokens == 0 &&
		snapshot.TotalTokens == 0 &&
		snapshot.CostUSD == 0
}

// mergeCursorSnapshots folds snapshots sharing a (source, date, timezone,
// model) key. Unlike mergeSnapshots, sessionCount is a max here: it counts
// sessions, not usage, and adding two counts of the same file double-counts.
func mergeCursorSnapshots(snapshots []Snapshot) []Snapshot {
	rows := map[string]*Snapshot{}
	order := []string{}
	for _, snapshot := range snapshots {
		key := CursorSnapshotGroupKey(snapshot)
		current, ok := rows[key]
		if !ok {
			copied := snapshot
			rows[key] = &copied
			order = append(order, key)
			continue
		}
		current.InputTokens += snapshot.InputTokens
		current.OutputTokens += snapshot.OutputTokens
		current.CacheCreationTokens += snapshot.CacheCreationTokens
		current.CacheReadTokens += snapshot.CacheReadTokens
		current.TotalTokens += snapshot.TotalTokens
		current.CostUSD += snapshot.CostUSD
		if snapshot.SessionCount > current.SessionCount {
			current.SessionCount = snapshot.SessionCount
		}
	}
	merged := make([]Snapshot, 0, len(order))
	for _, key := range order {
		merged = append(merged, *rows[key])
	}
	sort.Slice(merged, func(i, j int) bool {
		if merged[i].UsageDate != merged[j].UsageDate {
			return collate.Less(merged[i].UsageDate, merged[j].UsageDate)
		}
		return collate.Less(merged[i].Model, merged[j].Model)
	})
	return merged
}

func readEffectiveScanSinceMs(current State, scanSinceMs *float64) *float64 {
	safety := float64(DefaultScanSafetyMs)
	highWaterMs, hasHighWater := numericExtra(current, highWaterKey)
	if !hasHighWater {
		return scanSinceMs
	}
	previous := maxFloat(0, highWaterMs-safety)
	if scanSinceMs == nil {
		return &previous
	}
	combined := maxFloat(*scanSinceMs, previous)
	return &combined
}

func sameFile(left, right Entry) bool {
	return left.Size == right.Size && left.MtimeMs == right.MtimeMs && left.SHA256 == right.SHA256
}

func sameMetadata(left, right Entry) bool {
	return left.Size == right.Size && left.MtimeMs == right.MtimeMs
}

// isAppendOnlyUpdate mirrors the TS fast-path predicate: the file grew, the
// stored digest is comparable (same algorithm), and the previous revision
// ended on a line boundary.
func isAppendOnlyUpdate(prior, entry Entry) bool {
	if isPending(prior) || !sessionfile.IsCurrentContentHashAlgorithm(prior.ContentHashAlgo) {
		return false
	}
	if prior.SHA256 == "" || prior.Size < 0 || !isSafeInteger(prior.Size) {
		return false
	}
	if entry.Size <= prior.Size {
		return false
	}
	return prior.Size == 0 || (prior.EndsWithNewline != nil && *prior.EndsWithNewline)
}

func isPending(entry Entry) bool {
	return entry.PendingUpload != nil && *entry.PendingUpload
}

func hasContextPricingPending(snapshots []Snapshot) bool {
	for _, snapshot := range snapshots {
		if snapshot.CodexContextPricingPending {
			return true
		}
	}
	return false
}

func cloneSnapshots(snapshots []Snapshot) []Snapshot {
	out := make([]Snapshot, len(snapshots))
	copy(out, snapshots)
	return out
}

func numericExtra(state State, key string) (float64, bool) {
	raw, ok := state.ExtraValue(key)
	if !ok {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	return value, true
}

func stringExtra(state State, key string) (string, bool) {
	raw, ok := state.ExtraValue(key)
	if !ok {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

func highWater(state State) float64 {
	value, _ := numericExtra(state, highWaterKey)
	return value
}

func profileHashOf(state State) string {
	value, _ := stringExtra(state, profileHashKey)
	return value
}

func int64Ptr(value int64) *int64 {
	return &value
}

func maxFloat(left, right float64) float64 {
	if left > right {
		return left
	}
	return right
}

func minFloat(left, right float64) float64 {
	if left < right {
		return left
	}
	return right
}

// CursorStatesEqual reports whether a scan produced any state change worth
// writing: the high-water mark, the Codex profile hash, and the file map.
func CursorStatesEqual(current, next State) bool {
	if highWater(current) != highWater(next) {
		return false
	}
	if profileHashOf(current) != profileHashOf(next) {
		return false
	}
	currentFiles, err := json.Marshal(current.Files)
	if err != nil {
		return false
	}
	nextFiles, err := json.Marshal(next.Files)
	if err != nil {
		return false
	}
	return string(currentFiles) == string(nextFiles)
}

// ContextPricingMarker stamps Codex snapshots whose cost the context-pricing
// layer could not resolve yet. The Codex provider (M5) installs it; until
// then a Codex cursor cannot be written through UpdateCursorFile — silently
// skipping the marker would drop the pending-correction flag and let an
// unresolved cost upload as final.
var ContextPricingMarker func([]Snapshot) []Snapshot
