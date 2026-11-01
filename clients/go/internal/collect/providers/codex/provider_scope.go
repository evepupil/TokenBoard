package codex

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// The session-row and attribution half of codex.ts: resolving which session
// file a ccusage row describes, and replacing the bounded report's model with
// the canonical attribution the session file proves.

// tagSessionRow returns a copy of row carrying the home index, the way the TS
// spread adds __tokenboardCodexHomeIndex. The runner decodes rows as ordered
// records, so the copy must preserve that shape: a plain map copy would both
// lose the document order and fail every later ordered lookup, silently
// dropping the tag.
func tagSessionRow(row any, homeIndex int) any {
	if tagged, ok := ccusage.RecordWith(row, codexHomeIndexKey, float64(homeIndex)); ok {
		return tagged
	}
	if record, ok := row.(map[string]any); ok {
		copied := make(map[string]any, len(record)+1)
		for key, value := range record {
			copied[key] = value
		}
		copied[codexHomeIndexKey] = float64(homeIndex)
		return copied
	}
	return row
}

// rowHomeIndex reads the tagged home index. It returns -1 when the row is not
// tagged or the tag is not a safe integer, matching the TS check.
func rowHomeIndex(row any) int {
	value, ok := ccusage.RecordGet(row, codexHomeIndexKey)
	if !ok {
		return -1
	}
	number, ok := value.(float64)
	if !ok || number != float64(int64(number)) || number < 0 || number > maxSafeInteger {
		return -1
	}
	return int(number)
}

// resolveSessionFileFromRow ports resolveSessionFileFromRow.
func resolveSessionFileFromRow(row any, root string) (string, bool) {
	directory, sessionFile, sessionID, ok := ccusage.ReadSessionFileRow(row)
	if !ok {
		return "", false
	}
	name := sessionFile
	if name == "" {
		name = sessionID
	}
	if name == "" || !isSafeSessionDirectory(directory) {
		return "", false
	}
	filename := name
	if !strings.HasSuffix(filename, ".jsonl") {
		filename += ".jsonl"
	}
	file := filepath.Join(root, filepath.FromSlash(directory), filename)
	if !filepathIsInside(root, file) {
		return "", false
	}
	return file, true
}

// isSafeSessionDirectory ports isSafeSessionDirectory.
func isSafeSessionDirectory(directory string) bool {
	if filepath.IsAbs(directory) {
		return false
	}
	for _, segment := range strings.FieldsFunc(directory, func(r rune) bool { return r == '\\' || r == '/' }) {
		if segment == ".." {
			return false
		}
	}
	return true
}

// resolveScopedSessionSourceFile ports resolveScopedSessionSourceFile. A
// homeIndex of -1 means "not supplied": the row's own tag decides, falling
// back to every home.
func resolveScopedSessionSourceFile(row any, scope *SessionScope, homeIndex int) (string, bool) {
	resolvedHomeIndex := homeIndex
	if resolvedHomeIndex < 0 {
		resolvedHomeIndex = rowHomeIndex(row)
	}
	codexHomes := scope.CodexHomes
	if resolvedHomeIndex >= 0 {
		if resolvedHomeIndex >= len(scope.CodexHomes) {
			return "", false
		}
		codexHomes = []string{scope.CodexHomes[resolvedHomeIndex]}
	}
	for _, codexHome := range codexHomes {
		if codexHome == "" {
			continue
		}
		for _, directory := range []string{"sessions", "archived_sessions"} {
			file, ok := resolveSessionFileFromRow(row, filepath.Join(codexHome, directory))
			if !ok {
				continue
			}
			if sourceFile, ok := scope.SourceFiles[file]; ok {
				return sourceFile, true
			}
		}
	}
	return "", false
}

// hasDuplicateScopedSessionRelativePaths ports
// hasDuplicateScopedSessionRelativePaths.
func hasDuplicateScopedSessionRelativePaths(scope *SessionScope) bool {
	seen := map[string]bool{}
	for scopedFile, sourceFile := range scope.SourceFiles {
		homeIndex, ok := scope.SourceFileHomeIndexes[sourceFile]
		if !ok {
			continue
		}
		relative, err := filepath.Rel(scope.CodexHomes[homeIndex], scopedFile)
		if err != nil {
			continue
		}
		if seen[relative] {
			return true
		}
		seen[relative] = true
	}
	return false
}

// scopedSessionHomeIndexes ports scopedSessionHomeIndexes.
func scopedSessionHomeIndexes(scope *SessionScope) []int {
	seen := map[int]bool{}
	indexes := []int{}
	for _, sourceFile := range scope.SourceFiles {
		homeIndex, ok := scope.SourceFileHomeIndexes[sourceFile]
		if !ok || seen[homeIndex] {
			continue
		}
		seen[homeIndex] = true
		indexes = append(indexes, homeIndex)
	}
	sort.Ints(indexes)
	return indexes
}

// replaceInput configures replaceScopedSessionAttributions.
type replaceInput struct {
	boundedSessions       any
	canonicalAttributions map[string]CodexSessionAttribution
	scope                 *SessionScope
	since                 string
	until                 string
}

// replaceScopedSessionAttributions ports replaceScopedSessionAttributions:
// the bounded report is authoritative about which sessions ran and when, but
// its model can lag the canonical attribution the whole session file proves.
func replaceScopedSessionAttributions(input replaceInput) (any, error) {
	since, err := dateFilterToISO(input.since, true)
	if err != nil {
		return nil, err
	}
	until, err := dateFilterToISO(input.until, false)
	if err != nil {
		return nil, err
	}
	var replaceErr error
	out := mapSessionRows(input.boundedSessions, func(row any) any {
		if replaceErr != nil {
			return row
		}
		sourceFile, ok := resolveScopedSessionSourceFile(row, input.scope, -1)
		attribution, found := input.canonicalAttributions[sourceFile]
		if !ok || !found {
			replaceErr = fmt.Errorf("Canonical Codex session attribution is missing a bounded session row; retry the sync")
			return row
		}
		updated := cloneRecord(row)
		if updated == nil {
			replaceErr = fmt.Errorf("Canonical Codex session attribution is missing a bounded session row; retry the sync")
			return row
		}
		if isDateWithinCodexRange(attribution.UsageDate, since, until) {
			updated["lastActivity"] = attribution.UsageDate
		}
		updated["models"] = map[string]any{
			attribution.Model: map[string]any{"totalTokens": float64(1)},
		}
		return updated
	})
	if replaceErr != nil {
		return nil, replaceErr
	}
	return out, nil
}

// cloneRecord copies a session row into a mutable map. Rows arrive as ordered
// records from the command runner, so the fields the replacement rewrites are
// re-read through the accessor surface.
func cloneRecord(row any) map[string]any {
	if record, ok := row.(map[string]any); ok {
		return record
	}
	directory, sessionFile, sessionID, ok := ccusage.ReadSessionFileRow(row)
	if !ok {
		return nil
	}
	updated := map[string]any{}
	if directory != "" {
		updated["directory"] = directory
	}
	if sessionFile != "" {
		updated["sessionFile"] = sessionFile
	}
	if sessionID != "" {
		updated["sessionId"] = sessionID
	}
	if lastActivity, ok := ccusage.RecordGet(row, "lastActivity"); ok {
		updated["lastActivity"] = lastActivity
	}
	if models, ok := ccusage.RecordGet(row, "models"); ok {
		updated["models"] = models
	}
	if homeIndex := rowHomeIndex(row); homeIndex >= 0 {
		updated[codexHomeIndexKey] = float64(homeIndex)
	}
	return updated
}

// mapSessionRows ports mapSessionRows: apply transform to every row under the
// report's row key, leaving the envelope otherwise untouched.
func mapSessionRows(input any, transform func(any) any) any {
	rows := ccusage.SessionRows(input)
	if rows == nil {
		return input
	}
	transformed := make([]any, 0, len(rows))
	for _, row := range rows {
		transformed = append(transformed, transform(row))
	}
	return map[string]any{"sessions": transformed}
}

// isDateWithinCodexRange ports isDateWithinCodexRange.
func isDateWithinCodexRange(usageDate, since, until string) bool {
	if since != "" && usageDate < since {
		return false
	}
	if until != "" && usageDate > until {
		return false
	}
	return true
}

// dateFilterToISO ports dateFilterToIso: the compact window as an ISO date.
func dateFilterToISO(value string, allowAll bool) (string, error) {
	if value == "" || (allowAll && isAllDateFilter(value)) {
		return "", nil
	}
	compact, err := normalizeDateFilter(value, "Codex bounded date")
	if err != nil {
		return "", err
	}
	if len(compact) != 8 {
		return "", fmt.Errorf("Codex bounded date must be a calendar date: %s", value)
	}
	return compact[0:4] + "-" + compact[4:6] + "-" + compact[6:8], nil
}

// scopedFileForSourceFile ports scopedFileForSourceFile.
func scopedFileForSourceFile(sourceFile string, sourceFiles map[string]string) (string, bool) {
	for scopedFile, original := range sourceFiles {
		if original == sourceFile {
			return scopedFile, true
		}
	}
	return "", false
}

// canonicalModelsByScopedFile ports canonicalModelsByScopedFile.
func canonicalModelsByScopedFile(scope *SessionScope, attributions map[string]CodexSessionAttribution) CodexContextPricingFileModelHints {
	models := CodexContextPricingFileModelHints{}
	for scopedFile, sourceFile := range scope.SourceFiles {
		if attribution, ok := attributions[sourceFile]; ok {
			models[scopedFile] = attribution.Model
		}
	}
	return models
}

// canonicalModelsByScopedFileFromSessionRows ports
// canonicalModelsByScopedFileFromSessionRows.
func canonicalModelsByScopedFileFromSessionRows(sessions any, scope *SessionScope, timezone string) CodexContextPricingFileModelHints {
	models := CodexContextPricingFileModelHints{}
	for _, row := range ccusage.SessionRows(sessions) {
		sourceFile, ok := resolveScopedSessionSourceFile(row, scope, -1)
		if !ok {
			continue
		}
		scopedFile, ok := scopedFileForSourceFile(sourceFile, scope.SourceFiles)
		if !ok {
			continue
		}
		attribution, found, err := ccusage.ReadCcusageSessionAttribution(row, timezone, contract.SourceCodex)
		if err != nil || !found {
			continue
		}
		models[scopedFile] = attribution.Model
	}
	return models
}

// canonicalModelsByInventoryFiles ports canonicalModelsByInventoryFiles.
func canonicalModelsByInventoryFiles(
	sessions any,
	codexHomes []string,
	inventory CodexContextPricingFileInventory,
	timezone string,
) CodexContextPricingFileModelHints {
	filesByIdentityPath := map[string]string{}
	for _, filePath := range inventory.FilePaths {
		identityPath, ok := inventory.IdentityPaths[filepath.Clean(filePath)]
		if !ok || identityPath == "" {
			continue
		}
		filesByIdentityPath[filepath.Clean(identityPath)] = filePath
	}
	models := CodexContextPricingFileModelHints{}
	for _, row := range ccusage.SessionRows(sessions) {
		attribution, found, err := ccusage.ReadCcusageSessionAttribution(row, timezone, contract.SourceCodex)
		if err != nil || !found {
			continue
		}
		directory, sessionFile, sessionID, ok := ccusage.ReadSessionFileRow(row)
		if !ok {
			continue
		}
		name := sessionFile
		if name == "" {
			name = sessionID
		}
		if name == "" || !isSafeSessionDirectory(directory) {
			continue
		}
		filename := name
		if !strings.HasSuffix(filename, ".jsonl") {
			filename += ".jsonl"
		}
		homeIndexes := []int{}
		if tagged := rowHomeIndex(row); tagged >= 0 {
			homeIndexes = []int{tagged}
		} else {
			for index := range codexHomes {
				homeIndexes = append(homeIndexes, index)
			}
		}
		for _, homeIndex := range homeIndexes {
			if homeIndex >= len(codexHomes) {
				continue
			}
			codexHome := codexHomes[homeIndex]
			if codexHome == "" {
				continue
			}
			for _, rootName := range []string{"sessions", "archived_sessions"} {
				root := filepath.Join(codexHome, rootName)
				identityPath := filepath.Join(root, filepath.FromSlash(directory), filename)
				if !filepathIsInside(root, identityPath) {
					continue
				}
				if filePath, ok := filesByIdentityPath[filepath.Clean(identityPath)]; ok {
					models[filepath.Clean(filePath)] = attribution.Model
				}
			}
		}
	}
	return models
}

// hasDuplicateCodexInventoryPaths ports hasDuplicateCodexInventoryPaths.
func hasDuplicateCodexInventoryPaths(codexHomes []string, inventory CodexContextPricingFileInventory) bool {
	homeByRelativePath := map[string]int{}
	for _, filePath := range inventory.FilePaths {
		identityPath, ok := inventory.IdentityPaths[filepath.Clean(filePath)]
		if !ok || identityPath == "" {
			continue
		}
		homeIndex, relativePath, ok := codexInventoryPathLocation(identityPath, codexHomes)
		if !ok {
			continue
		}
		if previous, seen := homeByRelativePath[relativePath]; seen && previous != homeIndex {
			return true
		}
		homeByRelativePath[relativePath] = homeIndex
	}
	return false
}

// codexInventoryPathLocation ports codexInventoryPathLocation.
func codexInventoryPathLocation(identityPath string, codexHomes []string) (int, string, bool) {
	resolved := filepath.Clean(identityPath)
	for homeIndex, codexHome := range codexHomes {
		if codexHome == "" {
			continue
		}
		for _, rootName := range []string{"sessions", "archived_sessions"} {
			root := filepath.Join(codexHome, rootName)
			if !filepathIsInside(root, resolved) {
				continue
			}
			relative, err := filepath.Rel(root, resolved)
			if err != nil {
				continue
			}
			return homeIndex, relative, true
		}
	}
	return 0, "", false
}

// assertCodexContextPricingInventoryStable ports
// assertCodexContextPricingInventoryStable.
func assertCodexContextPricingInventoryStable(before, after CodexContextPricingFileInventory) error {
	const message = "Codex session inventory changed during unbounded collection; retry the sync"
	if before.Overflow != after.Overflow || len(before.FilePaths) != len(after.FilePaths) {
		return fmt.Errorf("%s", message)
	}
	for _, filePath := range before.FilePaths {
		key := filepath.Clean(filePath)
		beforeFingerprint, ok := before.Fingerprints[key]
		if !ok {
			return fmt.Errorf("%s", message)
		}
		afterFingerprint, ok := after.Fingerprints[key]
		if !ok || !SameCodexSessionFileFingerprint(comparableOfFingerprint(beforeFingerprint), afterFingerprint) {
			return fmt.Errorf("%s", message)
		}
		beforeIdentity, beforeOK := before.IdentityPaths[key]
		afterIdentity, afterOK := after.IdentityPaths[key]
		if !beforeOK || !afterOK || beforeIdentity != afterIdentity {
			return fmt.Errorf("%s", message)
		}
	}
	return nil
}

// isRejectedSessionRootSymlink ports isRejectedSessionRootSymlink.
func isRejectedSessionRootSymlink(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "session directory") && strings.Contains(message, "symbolic links are not supported")
}

// assertCodexScopeSourcesUnchanged ports assertCodexScopeSourcesUnchanged: a
// frozen copy may lag its live source (the cache layer reports that race
// independently), but a projected file is read from the live source and must
// be verified before its result is committed.
func assertCodexScopeSourcesUnchanged(scope *SessionScope) error {
	for sourceFile := range scope.ProjectedSourceFiles {
		expected, ok := scope.ProjectedSourceFilePrefixes[sourceFile]
		if !ok {
			return fmt.Errorf("Codex projected session scope lost its source-file prefix fingerprint")
		}
		current, err := fingerprintProjectedSourceFile(sourceFile, expected)
		if err != nil {
			return err
		}
		if current.CapturedSize < expected.CapturedSize ||
			!SameCodexSessionFilePrefixFingerprint(expected, current) {
			return fmt.Errorf("Codex session changed during scoped collection; retry the sync")
		}
	}
	return nil
}

// fingerprintProjectedSourceFile ports fingerprintProjectedSourceFile.
func fingerprintProjectedSourceFile(sourceFile string, expected CodexSessionFilePrefixFingerprint) (CodexSessionFilePrefixFingerprint, error) {
	prefixSize := expected.PrefixSize
	current, err := FingerprintCodexSessionFilePrefix(sourceFile, &prefixSize)
	if err != nil {
		return CodexSessionFilePrefixFingerprint{}, fmt.Errorf("Codex session changed during scoped collection; retry the sync")
	}
	if current.CapturedSize < expected.CapturedSize ||
		!SameCodexSessionFilePrefixFingerprint(expected, current) {
		return CodexSessionFilePrefixFingerprint{}, fmt.Errorf("Codex session changed during scoped collection; retry the sync")
	}
	return current, nil
}

// cacheFilesForScope ports cacheFilesForScope.
func cacheFilesForScope(scope *SessionScope) map[string]CodexSubagentUsageCacheFile {
	files := map[string]CodexSubagentUsageCacheFile{}
	for scopedFile, sourceFile := range scope.SourceFiles {
		if scope.ProjectedSourceFiles[sourceFile] {
			continue
		}
		fingerprint, ok := scope.SourceFileFingerprints[sourceFile]
		if !ok {
			continue
		}
		files[scopedFile] = CodexSubagentUsageCacheFile{SourceFile: sourceFile, SourceFingerprint: fingerprint}
	}
	return files
}

// collectHookUsage ports collectCodexHookUsage.
func (run *providerRun) collectHookUsage() ([]contract.Snapshot, error) {
	var lastErr error
	for attempt := 0; attempt < hookCodexCollectionAttempts; attempt++ {
		snapshots, err := run.collectHookUsageAttempt(attempt > 0)
		if err == nil {
			return snapshots, nil
		}
		lastErr = err
		if attempt+1 < hookCodexCollectionAttempts && isCodexReconciliationChange(err) {
			run.stderr("Codex child session changed; retrying hook reconciliation once")
			continue
		}
		return nil, err
	}
	return nil, lastErr
}

// collectHookUsageAttempt ports collectCodexHookUsageAttempt.
func (run *providerRun) collectHookUsageAttempt(forcePendingUploadRescan bool) ([]contract.Snapshot, error) {
	codexHomes, err := resolveHomesFromOptions(run.options, run.env)
	if err != nil {
		return nil, err
	}
	codexSymlinkRoots, err := resolveSymlinkRootsFromOptions(run.options, run.env)
	if err != nil {
		return nil, err
	}
	incremental, err := CollectHookProfiles(HookProfileInput{
		CodexHomes:               codexHomes,
		CodexSymlinkRoots:        codexSymlinkRoots,
		StateDir:                 run.stateDir,
		Stderr:                   run.stderr,
		Timezone:                 run.timezone,
		CollectedAt:              run.collectedAt,
		ForcePendingUploadRescan: forcePendingUploadRescan,
		ContextPricingMarker:     run.rules.MarkUnresolvedContextPricing,
	})
	if err != nil {
		return nil, err
	}
	if run.options.HookAcknowledgement != nil {
		scopes := make([]collect.CursorScopeFiles, 0, len(incremental.AcknowledgedByCursorScope))
		for _, scoped := range incremental.AcknowledgedByCursorScope {
			files := make([]sessioncursor.AcknowledgedFile, 0, len(scoped.Files))
			for _, file := range scoped.Files {
				files = append(files, sessioncursor.AcknowledgedFile{
					RelativePath: file.RelativePath,
					SHA256:       file.SHA256,
				})
			}
			scopes = append(scopes, collect.CursorScopeFiles{CursorScope: scoped.CursorScope, Files: files})
		}
		run.options.HookAcknowledgement(scopes)
	}
	if !incremental.Changed {
		return []contract.Snapshot{}, nil
	}
	snapshots := []contract.Snapshot{}
	if len(incremental.RangeArgs) > 0 {
		since, until, err := hookDateBounds(incremental.ChangedDates)
		if err != nil {
			return nil, err
		}
		snapshots, err = run.collectScopedUsage(scopedRunInput{
			rangeArgs:         incremental.RangeArgs,
			since:             since,
			until:             until,
			codexHomes:        codexHomes,
			codexSymlinkRoots: codexSymlinkRoots,
			requireScope:      true,
		})
		if err != nil {
			return nil, err
		}
		if err := sessioncursor.AssertHookReconciliationSnapshots(
			"Codex", incremental.ChangedDates, incremental.ChangedKeys, snapshots); err != nil {
			return nil, err
		}
	}
	unresolved := incremental.UnresolvedContextPricing
	run.rules.ReportUnrecoverablePendingCodexPricing(unresolved, run.stderr)
	unresolvedKeys := map[string]bool{}
	for _, snapshot := range unresolved {
		unresolvedKeys[codexSnapshotIdentity(snapshot)] = true
	}
	// A reusable pending snapshot is a partial view of a (date, model) group;
	// once ccusage reports the group whole, the cached copy is already inside
	// that figure and merging would double-count it. Only the reusable copies
	// are subject to this: a snapshot restored for a file that is gone is not
	// in the tree ccusage scanned.
	//
	// A pending snapshot whose turn carried no model id is labelled "all".
	// ccusage reports the day under concrete model ids, so an exact group-key
	// match never fires for it and the cached copy would be added on top of a
	// figure that already contains it — the normal case for real codex logs,
	// whose token_count rows carry no info.model. An "all" snapshot therefore
	// covers on (source, date, timezone) alone, the same widening
	// AssertHookReconciliationSnapshots applies when it matches an "all" key
	// against a date.
	coveredKeys := map[string]bool{}
	coveredScopes := map[string]bool{}
	for _, snapshot := range snapshots {
		coveredKeys[codexSnapshotGroupKey(snapshot)] = true
		coveredScopes[codexSnapshotScopeKey(snapshot)] = true
	}
	reusableIDs := map[string]bool{}
	for _, snapshot := range incremental.ReusablePendingSnapshots {
		reusableIDs[codexSnapshotIdentity(snapshot)] = true
	}
	cached := make([]contract.Snapshot, 0, len(incremental.CachedSnapshots))
	for _, snapshot := range incremental.CachedSnapshots {
		identity := codexSnapshotIdentity(snapshot)
		if reusableIDs[identity] && isCodexSnapshotCoveredByCcusage(snapshot, coveredKeys, coveredScopes) {
			continue
		}
		if unresolvedKeys[identity] {
			continue
		}
		if run.rules.IsUnresolvedCodexContextPricingSnapshot(CostSnapshotFromContract(snapshot)) {
			continue
		}
		cached = append(cached, snapshot)
	}
	return sessioncursor.MergeSnapshots(append(snapshots, cached...)), nil
}
