package codex

import (
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
	"sort"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/collate"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionfile"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionwalk"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/state"
)

// Port of codex-hook-profiles.ts: Codex hook collection across one or more
// profile homes. Each home keeps its own cursor (scoped by the home path), and
// a legacy single-home cursor is migrated into the profile cursors the first
// time the plan turns multi-profile.

// HookKey is one (usageDate, model) pair, aliased so callers of this package
// do not need to import sessioncursor for it.
type HookKey = sessioncursor.HookKey

// cursorLockTimeout matches the TS cursor lock's 35s acquisition window.
const cursorLockTimeout = 35 * time.Second

// maxSafeInteger (Number.MAX_SAFE_INTEGER) is declared in cost_projection.go
// and shared by every JS-integer check in this package.

// acquireCursorLock takes the same lock the TS withCursorLock takes around a
// cursor file. A lock that cannot be acquired in time is an error here: the
// migration runs inside a sync that already holds the run lock, so contention
// means a peer collector is actively rewriting this cursor.
func acquireCursorLock(cursorPath string) (func(), error) {
	lock, err := state.Acquire(cursorPath+".lock", cursorLockTimeout)
	if err != nil {
		return nil, err
	}
	if lock == nil {
		return nil, errors.New("could not acquire the Codex cursor lock")
	}
	return func() { _ = lock.Release() }, nil
}

// HookProfileInput configures one Codex hook collection.
type HookProfileInput struct {
	CodexHomes               []string
	CodexSymlinkRoots        []string
	StateDir                 string
	Stderr                   func(line string)
	Timezone                 string
	CollectedAt              string
	ForcePendingUploadRescan bool
	// ContextPricingMarker stamps pending snapshots with the rule set the
	// provider resolved for this run; nil keeps the package-level default.
	ContextPricingMarker func([]sessioncursor.Snapshot) []sessioncursor.Snapshot
}

// AcknowledgedFile is one file the run may acknowledge after upload.
type AcknowledgedFile struct {
	RelativePath string
	SHA256       string
}

// AcknowledgedFilesByCursorScope groups the acknowledged files by profile.
type AcknowledgedFilesByCursorScope struct {
	// CursorScope is the profile home; empty for the unscopped cursor.
	CursorScope string
	Files       []AcknowledgedFile
}

// HookProfilesResult is the merged outcome of the per-profile runs.
type HookProfilesResult struct {
	Changed                   bool
	RangeArgs                 []string
	ChangedDates              []string
	ChangedKeys               []sessioncursor.HookKey
	CachedSnapshots           []contract.Snapshot
	ReusablePendingSnapshots  []contract.Snapshot
	UnresolvedContextPricing  []contract.Snapshot
	AcknowledgedByCursorScope []AcknowledgedFilesByCursorScope
}

// HookCursorPlan is which cursor each home uses.
type HookCursorPlan struct {
	CursorNames        []string
	CursorScopes       []string
	UsesProfileCursors bool
}

// CollectHookProfiles ports collectCodexHookProfiles.
func CollectHookProfiles(input HookProfileInput) (HookProfilesResult, error) {
	plan, err := ResolveHookCursorPlan(input.CodexHomes, input.StateDir)
	if err != nil {
		return HookProfilesResult{}, err
	}
	hasLegacyPending := false
	if plan.UsesProfileCursors {
		hasLegacyPending, err = migrateLegacyHookCursor(input)
		if err != nil {
			return HookProfilesResult{}, err
		}
	}

	incrementals := make([]sessioncursor.HookIncrementalResult, 0, len(input.CodexHomes)+1)
	scoped := make([]struct {
		cursorScope string
		incremental sessioncursor.HookIncrementalResult
	}, 0, len(input.CodexHomes)+1)
	for index, codexHome := range input.CodexHomes {
		incremental, err := sessioncursor.CollectHookIncremental(sessioncursor.HookInput{
			Source:                           contract.SourceCodex,
			SessionsDir:                      filepath.Join(codexHome, "sessions"),
			SessionDirs:                      []string{filepath.Join(codexHome, "sessions"), filepath.Join(codexHome, "archived_sessions")},
			AllowedRootSymlinks:              input.CodexSymlinkRoots,
			CursorName:                       plan.CursorNames[index],
			CursorProfileHash:                hookProfileHash(codexHome),
			StateDir:                         input.StateDir,
			Stderr:                           input.Stderr,
			Timezone:                         input.Timezone,
			CollectedAt:                      input.CollectedAt,
			IncludePendingSnapshotEntries:    true,
			IncludeReconciliationFileEntries: true,
			ForcePendingUploadRescan:         input.ForcePendingUploadRescan,
			ContextPricingMarker:             input.ContextPricingMarker,
		})
		if err != nil {
			return HookProfilesResult{}, err
		}
		incrementals = append(incrementals, incremental)
		scope := ""
		if plan.UsesProfileCursors {
			scope = codexHome
		}
		scoped = append(scoped, struct {
			cursorScope string
			incremental sessioncursor.HookIncrementalResult
		}{cursorScope: scope, incremental: incremental})
	}
	if hasLegacyPending {
		incremental, err := sessioncursor.CollectHookIncremental(sessioncursor.HookInput{
			Source:                           contract.SourceCodex,
			CursorName:                       "codex-cursor.json",
			StateDir:                         input.StateDir,
			Stderr:                           input.Stderr,
			Timezone:                         input.Timezone,
			CollectedAt:                      input.CollectedAt,
			IncludePendingSnapshotEntries:    true,
			IncludeReconciliationFileEntries: true,
			SkipSessionScan:                  true,
			ContextPricingMarker:             input.ContextPricingMarker,
		})
		if err != nil {
			return HookProfilesResult{}, err
		}
		incrementals = append(incrementals, incremental)
		scoped = append(scoped, struct {
			cursorScope string
			incremental sessioncursor.HookIncrementalResult
		}{incremental: incremental})
	}

	merged := mergeHookIncrementals(incrementals)
	merged.AcknowledgedByCursorScope = make([]AcknowledgedFilesByCursorScope, 0, len(scoped))
	for _, entry := range scoped {
		merged.AcknowledgedByCursorScope = append(merged.AcknowledgedByCursorScope, AcknowledgedFilesByCursorScope{
			CursorScope: entry.cursorScope,
			Files:       acknowledgeableFiles(entry.incremental),
		})
	}
	return merged, nil
}

// HookProfileCursorName ports codexHookProfileCursorName.
func HookProfileCursorName(codexHome string) string {
	return sessioncursor.FileName(contract.SourceCodex, resolvePath(codexHome))
}

// hookProfileHash is the sha256 of the resolved home, stored in the cursor so
// a renamed or moved home does not inherit another profile's state.
func hookProfileHash(codexHome string) string {
	sum := sha256.Sum256([]byte(resolvePath(codexHome)))
	return hex.EncodeToString(sum[:])
}

// ResolveHookCursorPlan ports resolveCodexHookCursorPlan.
func ResolveHookCursorPlan(codexHomes []string, stateDir string) (HookCursorPlan, error) {
	legacyCursor, err := readLegacyHookCursor(stateDir)
	if err != nil {
		return HookCursorPlan{}, err
	}
	hasProfileCursor := false
	for _, codexHome := range codexHomes {
		ok, err := isRegularFile(filepath.Join(stateDir, HookProfileCursorName(codexHome)))
		if err != nil {
			return HookCursorPlan{}, err
		}
		if ok {
			hasProfileCursor = true
			break
		}
	}
	var activeProfileHash string
	if len(codexHomes) == 1 {
		activeProfileHash = hookProfileHash(codexHomes[0])
	}
	legacyBelongsToActiveProfile := false
	if legacyCursor != nil && activeProfileHash != "" {
		value, ok := legacyCursor.ExtraValue("codexHookProfileHash")
		if ok {
			var hash string
			if err := json.Unmarshal(value, &hash); err == nil {
				legacyBelongsToActiveProfile = hash == activeProfileHash
			}
		}
	}
	usesProfileCursors := len(codexHomes) > 1 || hasProfileCursor ||
		(legacyCursor != nil && !legacyBelongsToActiveProfile)
	plan := HookCursorPlan{UsesProfileCursors: usesProfileCursors}
	if usesProfileCursors {
		for _, codexHome := range codexHomes {
			plan.CursorNames = append(plan.CursorNames, HookProfileCursorName(codexHome))
			plan.CursorScopes = append(plan.CursorScopes, codexHome)
		}
		return plan, nil
	}
	plan.CursorNames = []string{"codex-cursor.json"}
	plan.CursorScopes = []string{""}
	return plan, nil
}

func readLegacyHookCursor(stateDir string) (*sessioncursor.State, error) {
	cursorPath := filepath.Join(stateDir, "codex-cursor.json")
	ok, err := isRegularFile(cursorPath)
	if err != nil || !ok {
		return nil, err
	}
	cursor, err := sessioncursor.Read(cursorPath, "codex")
	if err != nil {
		return nil, err
	}
	return &cursor, nil
}

// migrateLegacyHookCursor moves a legacy single-home cursor's entries into the
// profile cursors. An entry is copied to every home whose session file matches
// its recorded digest; an entry with no match is dropped unless it is still
// pending (dropping it would lose usage the server never acknowledged).
func migrateLegacyHookCursor(input HookProfileInput) (bool, error) {
	legacyCursorPath := filepath.Join(input.StateDir, "codex-cursor.json")
	ok, err := isRegularFile(legacyCursorPath)
	if err != nil || !ok {
		return false, err
	}
	lock, err := acquireCursorLock(legacyCursorPath)
	if err != nil {
		return false, err
	}
	defer lock()
	legacy, err := sessioncursor.Read(legacyCursorPath, "codex")
	if err != nil {
		return false, err
	}
	persisted, err := matchingPersistedLegacyEntries(input.CodexHomes, input.StateDir, legacy)
	if err != nil {
		return false, err
	}
	changed := false
	for _, relativePath := range sortedLegacyEntryKeys(legacy.Files) {
		entry := legacy.Files[relativePath]
		if persisted[relativePath] {
			delete(legacy.Files, relativePath)
			changed = true
			continue
		}
		homes, err := matchingCodexHomes(input.CodexHomes, relativePath, entry, input.CodexSymlinkRoots)
		if err != nil {
			return false, err
		}
		if len(homes) == 0 {
			if entry.PendingUpload == nil || !*entry.PendingUpload {
				delete(legacy.Files, relativePath)
				changed = true
			}
			continue
		}
		for _, codexHome := range homes {
			if err := copyLegacyCursorEntry(codexHome, relativePath, entry, input.StateDir); err != nil {
				return false, err
			}
		}
		delete(legacy.Files, relativePath)
		changed = true
	}
	if changed {
		if err := sessioncursor.Write(legacyCursorPath, legacy); err != nil {
			return false, err
		}
	}
	hasPending := false
	for _, entry := range legacy.Files {
		if entry.PendingUpload != nil && *entry.PendingUpload {
			hasPending = true
			break
		}
	}
	return hasPending, nil
}

func matchingPersistedLegacyEntries(codexHomes []string, stateDir string, legacy sessioncursor.State) (map[string]bool, error) {
	matches := map[string]bool{}
	for _, codexHome := range codexHomes {
		cursorPath := filepath.Join(stateDir, HookProfileCursorName(codexHome))
		ok, err := isRegularFile(cursorPath)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		release, err := acquireCursorLock(cursorPath)
		if err != nil {
			return nil, err
		}
		cursor, err := sessioncursor.Read(cursorPath, "codex")
		release()
		if err != nil {
			return nil, err
		}
		for relativePath, legacyEntry := range legacy.Files {
			if !isComparableContentDigest(legacyEntry.SHA256) {
				continue
			}
			if cursor.Files[relativePath].SHA256 == legacyEntry.SHA256 {
				matches[relativePath] = true
			}
		}
	}
	return matches, nil
}

func copyLegacyCursorEntry(codexHome, relativePath string, entry sessioncursor.Entry, stateDir string) error {
	cursorPath := filepath.Join(stateDir, HookProfileCursorName(codexHome))
	release, err := acquireCursorLock(cursorPath)
	if err != nil {
		return err
	}
	defer release()
	cursor, err := sessioncursor.Read(cursorPath, "codex")
	if err != nil {
		return err
	}
	if _, exists := cursor.Files[relativePath]; exists {
		return nil
	}
	cursor.Files[relativePath] = entry
	return sessioncursor.Write(cursorPath, cursor)
}

func matchingCodexHomes(codexHomes []string, relativePath string, entry sessioncursor.Entry, symlinkRoots []string) ([]string, error) {
	if !isComparableContentDigest(entry.SHA256) {
		return nil, nil
	}
	matches := []string{}
	for _, codexHome := range codexHomes {
		sessionPaths, err := resolveLegacySessionPaths(codexHome, relativePath, symlinkRoots)
		if err != nil {
			return nil, err
		}
		// The TS picks the active path whenever it exists at all (even as a
		// symlink or directory, which matchesLegacySessionContent then refuses);
		// only a missing active path falls back to archived_sessions. Probing
		// for "is a regular file" instead would let a stale archived copy
		// override a newer active session.
		candidate := ""
		if sessionPaths[0] != "" {
			exists, err := legacySessionPathExists(sessionPaths[0])
			if err != nil {
				return nil, err
			}
			if exists {
				candidate = sessionPaths[0]
			}
		}
		if candidate == "" {
			candidate = sessionPaths[1]
		}
		if candidate == "" {
			continue
		}
		matchesContent, err := matchesLegacySessionContent(candidate, entry)
		if err != nil {
			return nil, err
		}
		if matchesContent {
			matches = append(matches, codexHome)
		}
	}
	return matches, nil
}

func legacySessionPathExists(sessionPath string) (bool, error) {
	_, err := os.Lstat(sessionPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("Unable to inspect legacy Codex session file: %s", legacyInspectErrorText(err))
	}
	return true, nil
}

func resolveLegacySessionPaths(codexHome, relativePath string, symlinkRoots []string) ([]string, error) {
	resolved := make([]string, 2)
	for index, rootName := range []string{"sessions", "archived_sessions"} {
		configuredRoot := filepath.Join(codexHome, rootName)
		resolvedRoot, ok, err := sessionwalk.ResolveRoot(configuredRoot, sessionwalk.Options{
			RejectRootSymlink:   true,
			AllowedRootSymlinks: symlinkRoots,
			RootBoundary:        codexHome,
		})
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		sessionPath := filepath.Join(resolvedRoot, relativePath)
		if !isPathInside(resolvedRoot, sessionPath) {
			return nil, errors.New("Invalid legacy Codex cursor session path")
		}
		resolved[index] = sessionPath
	}
	return resolved, nil
}

// matchesLegacySessionContent hashes the file with the algorithm the entry
// records and compares. An entry without contentHashAlgo predates the field and
// holds a sha256 digest; one written today holds blake2b512. Hashing with
// sha256 regardless is what made a current entry's digest never match.
//
// The read is verified the way the TS side does it: the path is lstat'ed
// before and after the open and again after the read, and every observation
// must describe the same file revision. A file swapped underneath the read
// fails the sync rather than matching the wrong profile.
func matchesLegacySessionContent(sessionPath string, entry sessioncursor.Entry) (bool, error) {
	details, err := os.Lstat(sessionPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("Unable to inspect legacy Codex session file: %s", legacyInspectErrorText(err))
	}
	if details.Mode()&os.ModeSymlink != 0 {
		return false, errors.New("Unable to inspect legacy Codex session file: symbolic links are not supported")
	}
	if !details.Mode().IsRegular() || float64(details.Size()) < entry.Size ||
		!isSafeNonNegativeInteger(entry.Size) {
		return false, nil
	}
	hasher, err := sessionfile.NewContentHasherFor(entry.ContentHashAlgo)
	if err != nil {
		return false, err
	}
	file, err := os.Open(sessionPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, errors.New("Legacy Codex session file changed while matching profile cursors; retry the sync")
		}
		return false, fmt.Errorf("Unable to inspect legacy Codex session file: %s", legacyInspectErrorText(err))
	}
	defer file.Close()

	opened, err := file.Stat()
	if err != nil {
		return false, fmt.Errorf("Unable to inspect legacy Codex session file: %s", legacyInspectErrorText(err))
	}
	pathAfterOpen, err := os.Lstat(sessionPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, errors.New("Legacy Codex session file changed while matching profile cursors; retry the sync")
		}
		return false, fmt.Errorf("Unable to inspect legacy Codex session file: %s", legacyInspectErrorText(err))
	}
	before := codexStatOf(details)
	if pathAfterOpen.Mode()&os.ModeSymlink != 0 || !pathAfterOpen.Mode().IsRegular() ||
		!sameCodexFileStat(before, codexStatOf(opened)) ||
		!sameCodexFileStat(codexStatOf(opened), codexStatOf(pathAfterOpen)) {
		return false, errors.New("Legacy Codex session file changed while matching profile cursors; retry the sync")
	}

	limit := int64(entry.Size)
	buffer := make([]byte, 64*1024)
	offset := int64(0)
	for offset < limit {
		length := int64(len(buffer))
		if remaining := limit - offset; remaining < length {
			length = remaining
		}
		read, err := file.ReadAt(buffer[:length], offset)
		if read > 0 {
			hasher.Write(buffer[:read])
			offset += int64(read)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return false, fmt.Errorf("Unable to inspect legacy Codex session file: %s", legacyInspectErrorText(err))
		}
	}
	if offset == 0 && limit > 0 {
		return false, errors.New("Legacy Codex session file changed while matching profile cursors; retry the sync")
	}
	if offset != limit {
		return false, errors.New("Legacy Codex session file changed while matching profile cursors; retry the sync")
	}

	after, err := file.Stat()
	if err != nil {
		return false, fmt.Errorf("Unable to inspect legacy Codex session file: %s", legacyInspectErrorText(err))
	}
	pathAfterRead, err := os.Lstat(sessionPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, errors.New("Legacy Codex session file changed while matching profile cursors; retry the sync")
		}
		return false, fmt.Errorf("Unable to inspect legacy Codex session file: %s", legacyInspectErrorText(err))
	}
	if pathAfterRead.Mode()&os.ModeSymlink != 0 || !pathAfterRead.Mode().IsRegular() ||
		!sameCodexFileStat(before, codexStatOf(after)) ||
		!sameCodexFileStat(codexStatOf(after), codexStatOf(pathAfterRead)) {
		return false, errors.New("Legacy Codex session file changed while matching profile cursors; retry the sync")
	}
	return hex.EncodeToString(hasher.Sum(nil)) == entry.SHA256, nil
}

// isSafeNonNegativeInteger mirrors Number.isSafeInteger plus the >= 0 check the
// TS applies to entry.size before treating it as a read length.
func isSafeNonNegativeInteger(value float64) bool {
	return value >= 0 && value <= maxSafeInteger && value == math.Trunc(value)
}

func isPathInside(parent, child string) bool {
	relative, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return !filepath.IsAbs(relative) && relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func legacyInspectErrorText(err error) string {
	var pathErr *fs.PathError
	if errors.As(err, &pathErr) {
		return pathErr.Err.Error()
	}
	return err.Error()
}

// sortedLegacyEntryKeys iterates the legacy cursor's files in the order the TS
// Object.entries walk visits them, so a migration that copies entries into
// several cursors is deterministic.
func sortedLegacyEntryKeys(files map[string]sessioncursor.Entry) []string {
	keys := make([]string, 0, len(files))
	for key := range files {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func isComparableContentDigest(value string) bool {
	if len(value) != 64 && len(value) != 128 {
		return false
	}
	for i := 0; i < len(value); i++ {
		if (value[i] < '0' || value[i] > '9') && (value[i] < 'a' || value[i] > 'f') {
			return false
		}
	}
	return true
}

func isRegularFile(path string) (bool, error) {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("Unable to inspect legacy Codex cursor: %s", err.Error())
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return false, errors.New("Unable to inspect legacy Codex cursor: symbolic links are not supported")
	}
	return info.Mode().IsRegular(), nil
}

// mergeHookIncrementals ports mergeCodexHookIncrementals.
func mergeHookIncrementals(incrementals []sessioncursor.HookIncrementalResult) HookProfilesResult {
	changedDates := map[string]bool{}
	changedKeys := map[string]sessioncursor.HookKey{}
	pendingEntries := []sessioncursor.HookPendingSnapshotEntry{}
	reconciliationFiles := map[string]bool{}
	reusableIDs := map[string]bool{}
	for _, incremental := range incrementals {
		for _, snapshot := range incremental.ReusablePendingSnapshots {
			reusableIDs[cachedSnapshotIdentity(snapshot)] = true
		}
		for _, date := range incremental.ChangedDates {
			changedDates[date] = true
		}
		for _, key := range incremental.ChangedKeys {
			changedKeys[snapshotKey(key.UsageDate, key.Model)] = key
		}
		pendingEntries = append(pendingEntries, incremental.PendingSnapshotEntries...)
		for _, entry := range incremental.ReconciliationFileEntries {
			reconciliationFiles[reconciliationFileKey(entry.RelativePath, entry.SHA256)] = true
		}
	}
	dates := make([]string, 0, len(changedDates))
	for date := range changedDates {
		dates = append(dates, date)
	}
	sort.Strings(dates)
	keys := make([]sessioncursor.HookKey, 0, len(changedKeys))
	for _, key := range changedKeys {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		return compareSnapshotKeys(keys[i], keys[j]) < 0
	})

	unreconciled := make([]sessioncursor.HookPendingSnapshotEntry, 0, len(pendingEntries))
	for _, entry := range pendingEntries {
		if reconciliationFiles[reconciliationFileKey(entry.RelativePath, entry.SHA256)] {
			continue
		}
		unreconciled = append(unreconciled, entry)
	}
	deduplicated := deduplicateCopiedPendingEntries(unreconciled)
	sorted := sortPendingSnapshots(deduplicated)
	reusable := make([]contract.Snapshot, 0)
	for _, snapshot := range sorted {
		if reusableIDs[cachedSnapshotIdentity(snapshot)] {
			reusable = append(reusable, snapshot)
		}
	}
	unresolved := []contract.Snapshot{}
	for _, entry := range deduplicated {
		if entry.ContextPricingPending {
			unresolved = append(unresolved, entry.Snapshot)
		}
	}
	sort.Slice(unresolved, func(i, j int) bool {
		return compareSnapshotKeys(HookKey{UsageDate: unresolved[i].UsageDate, Model: unresolved[i].Model},
			HookKey{UsageDate: unresolved[j].UsageDate, Model: unresolved[j].Model}) < 0
	})

	changed := false
	for _, incremental := range incrementals {
		if incremental.Changed {
			changed = true
			break
		}
	}
	return HookProfilesResult{
		Changed:                  changed,
		RangeArgs:                dateRangeArgs(dates),
		ChangedDates:             dates,
		ChangedKeys:              keys,
		CachedSnapshots:          sorted,
		ReusablePendingSnapshots: reusable,
		UnresolvedContextPricing: unresolved,
	}
}

func acknowledgeableFiles(incremental sessioncursor.HookIncrementalResult) []AcknowledgedFile {
	files := map[string]AcknowledgedFile{}
	for _, entry := range incremental.ReconciliationFileEntries {
		files[reconciliationFileKey(entry.RelativePath, entry.SHA256)] = AcknowledgedFile{
			RelativePath: entry.RelativePath,
			SHA256:       entry.SHA256,
		}
	}
	reconciliationFiles := map[string]bool{}
	for key := range files {
		reconciliationFiles[key] = true
	}
	unresolvedFiles := map[string]bool{}
	for _, entry := range incremental.PendingSnapshotEntries {
		if entry.ContextPricingPending {
			unresolvedFiles[reconciliationFileKey(entry.RelativePath, entry.SHA256)] = true
		}
	}
	for _, entry := range incremental.PendingSnapshotEntries {
		key := reconciliationFileKey(entry.RelativePath, entry.SHA256)
		if reconciliationFiles[key] || unresolvedFiles[key] {
			continue
		}
		files[key] = AcknowledgedFile{RelativePath: entry.RelativePath, SHA256: entry.SHA256}
	}
	out := make([]AcknowledgedFile, 0, len(files))
	for _, file := range files {
		out = append(out, file)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].RelativePath != out[j].RelativePath {
			return collate.Less(out[i].RelativePath, out[j].RelativePath)
		}
		return collate.Less(out[i].SHA256, out[j].SHA256)
	})
	return out
}

func deduplicateCopiedPendingEntries(entries []sessioncursor.HookPendingSnapshotEntry) []sessioncursor.HookPendingSnapshotEntry {
	seen := map[string]bool{}
	out := []sessioncursor.HookPendingSnapshotEntry{}
	for _, entry := range entries {
		key := copiedPendingSnapshotKey(entry)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, entry)
	}
	return out
}

func sortPendingSnapshots(entries []sessioncursor.HookPendingSnapshotEntry) []contract.Snapshot {
	out := make([]contract.Snapshot, 0, len(entries))
	for _, entry := range entries {
		out = append(out, entry.Snapshot)
	}
	sort.Slice(out, func(i, j int) bool {
		return compareSnapshotKeys(HookKey{UsageDate: out[i].UsageDate, Model: out[i].Model},
			HookKey{UsageDate: out[j].UsageDate, Model: out[j].Model}) < 0
	})
	return out
}

func cachedSnapshotIdentity(snapshot contract.Snapshot) string {
	// JSON.stringify on the same fields — %q encodes int64 ≥0x110000
	// as a rune literal ("\U0010ffff") which diverges from the TS side.
	data, err := json.Marshal([]any{
		string(snapshot.Source), snapshot.UsageDate, snapshot.Timezone, snapshot.Model,
		snapshot.InputTokens, snapshot.OutputTokens, snapshot.CacheCreation, snapshot.CacheRead,
		snapshot.TotalTokens, snapshot.CostUSD, snapshot.SessionCount,
	})
	if err != nil {
		return ""
	}
	return string(data)
}

func copiedPendingSnapshotKey(entry sessioncursor.HookPendingSnapshotEntry) string {
	snapshot := entry.Snapshot
	return strings.Join([]string{
		entry.RelativePath, entry.SHA256, string(snapshot.Source), snapshot.UsageDate, snapshot.Timezone,
		snapshot.Model, itoa64(snapshot.InputTokens), itoa64(snapshot.OutputTokens),
		itoa64(snapshot.CacheCreation), itoa64(snapshot.CacheRead), itoa64(snapshot.TotalTokens),
		fmt.Sprintf("%v", snapshot.CostUSD), itoa64(snapshot.SessionCount),
	}, "\x00")
}

func reconciliationFileKey(relativePath, sha string) string {
	return relativePath + "\x00" + sha
}

func dateRangeArgs(dates []string) []string {
	if len(dates) == 0 {
		return []string{}
	}
	return []string{"--since", strings.ReplaceAll(dates[0], "-", ""), "--until", strings.ReplaceAll(dates[len(dates)-1], "-", "")}
}

func snapshotKey(usageDate, model string) string {
	return usageDate + "\x00" + model
}

func compareSnapshotKeys(left, right sessioncursor.HookKey) int {
	if left.UsageDate != right.UsageDate {
		if collate.Less(left.UsageDate, right.UsageDate) {
			return -1
		}
		return 1
	}
	if left.Model != right.Model {
		if collate.Less(left.Model, right.Model) {
			return -1
		}
		return 1
	}
	return 0
}

func itoa64(value int64) string {
	return fmt.Sprintf("%d", value)
}
