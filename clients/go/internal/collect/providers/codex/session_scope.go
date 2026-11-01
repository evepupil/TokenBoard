package codex

// Port of codex-session-scope.ts: the frozen session tree one Codex
// collection batch reads.
//
// A Codex home keeps its rollouts under sessions/ and archived_sessions/, both
// of which the running tool appends to. ccusage is pointed at a copy of just
// the files a date window needs, so the numbers it reports cannot move while
// it reads, and so a multi-gigabyte history is never handed to it whole. This
// file is the part that decides which files are in the window, copies (or
// projects) them into a temporary CODEX_HOME, and records the identity of the
// bytes it copied.
//
// The TS module is an async generator; the Go port drives the same state
// machine from callbacks. A consumer stops early by returning an error from the
// yield callback, and cleans up each scope it receives.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/jsonl"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionwalk"
)

var codexSessionRootNames = []string{"sessions", "archived_sessions"}

const (
	defaultCodexSessionFileBytes          = int64(4 * 1024 * 1024 * 1024)
	defaultCodexSessionBatchBytes         = int64(4 * 1024 * 1024 * 1024)
	defaultCodexSessionGroupBytes         = int64(8 * 1024 * 1024 * 1024)
	defaultCodexSessionPrefilterBytes     = int64(8 * 1024 * 1024)
	defaultCodexSessionPrefilterLineBytes = int64(1024 * 1024)
	codexSessionReadChunkBytes            = int64(64 * 1024)
	codexSessionPrefixFingerprintBytes    = int64(64 * 1024)
	// The projection reuses the child-session read budget the TS projection
	// passes through codexChildSessionReadLimits.
	codexSessionChildMaxLineBytes          = int64(1024 * 1024)
	codexSessionChildMaxDiscardedLineBytes = int64(64 * 1024 * 1024)
	// defaultCodexSessionBatchSize is the TS normalizeBatchSize default; the
	// cap keeps one scope from opening thousands of files at once.
	defaultCodexSessionBatchSize = 200
	maxCodexSessionBatchSize     = 1000
)

var (
	errCodexSessionChangedDuringScope = errors.New(
		"Codex session changed during scoped collection; retry the sync")
	scopeCompactDatePattern  = regexp.MustCompile(`^\d{8}$`)
	scopeISODatePattern      = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	scopeRolloutDatePattern  = regexp.MustCompile(`^rollout-(\d{4})-(\d{2})-(\d{2})T`)
	scopeFourDigitsPattern   = regexp.MustCompile(`^\d{4}$`)
	scopeTwoDigitsPattern    = regexp.MustCompile(`^\d{2}$`)
	scopeRootLstat           = os.Lstat
	scopeResolveSessionFiles = sessionwalk.Resolve
)

// SessionScopeOptions mirrors CodexSessionScopeOptions. The numeric limits and
// the batch size use zero for "not configured", which the TS options express
// with undefined.
type SessionScopeOptions struct {
	// CodexHome is the legacy single home. A nil value means "not set", so
	// the environment fallback still applies; an explicitly empty string
	// suppresses it, matching `codexHome ?? env`.
	CodexHome *string
	// CodexHomes is the multi-profile list. A nil slice means "not set" and
	// consults TOKENBOARD_CODEX_HOMES_JSON; a non-nil empty slice is an
	// explicit (empty) configuration.
	CodexHomes []string
	Since      string
	Until      string
	// Now is the scan's reference time. Zero uses time.Now().
	Now       time.Time
	BatchSize int
	// Files switches to the explicit-file scope. A non-nil slice (even empty)
	// selects it, mirroring the TS truthiness check on the array.
	Files []string

	OnMissingSessionFile   func(sessionPath string)
	OnCopyFallback         func(message string)
	OnProjectionDiagnostic func(message string)

	MaxFileBytes          int64
	MaxBatchBytes         int64
	MaxGroupBytes         int64
	MaxPrefilterBytes     int64
	MaxPrefilterLineBytes int64

	CodexSymlinkRoots []string

	// Env and HomeDir keep tests off the developer's environment. Nil Env
	// uses os.Getenv; an empty HomeDir uses os.UserHomeDir.
	Env     func(string) string
	HomeDir string

	// The remaining fields are the collaborator seams. Nil uses the package
	// implementation: the cloner above, the attribution cache's fingerprint
	// functions, and the bounded JSONL reader.
	CreateCloner          func(onFallback func()) CodexSessionCloner
	FingerprintFile       func(filePath string) (CodexSessionFileFingerprint, error)
	FingerprintFilePrefix func(filePath string, prefixSize float64) (CodexSessionFilePrefixFingerprint, error)
	ReadJSONLRecords      func(stream io.Reader, stderr func(string), limits JSONLReadLimits, yield func(UnknownRecord) error) error
}

// SessionScope is the frozen session tree one collection batch reads.
type SessionScope struct {
	// CodexHome is the comma-joined CODEX_HOME the batch runs against.
	CodexHome  string
	CodexHomes []string
	// SourceFiles maps a copied file back to the session it came from.
	SourceFiles map[string]string
	// SourceFileHomeIndexes maps that session to its Codex home index.
	SourceFileHomeIndexes map[string]int
	// SourceFileFingerprints pins the source bytes that were copied.
	SourceFileFingerprints map[string]CodexSessionFileFingerprint
	// ProjectedSourceFiles holds the sessions that were projected instead of
	// copied, and ProjectedSourceFilePrefixes their captured prefixes.
	ProjectedSourceFiles        map[string]bool
	ProjectedSourceFilePrefixes map[string]CodexSessionFilePrefixFingerprint

	cleanup func() error
}

// Cleanup removes the temporary Codex homes. It is safe to call twice.
func (scope *SessionScope) Cleanup() error {
	if scope == nil || scope.cleanup == nil {
		return nil
	}
	return scope.cleanup()
}

// SessionScopeFile is one explicitly selected session file.
type SessionScopeFile struct {
	CodexHome string
	FilePath  string
}

// SessionScopeFileGroup is one group that must be copied into a single scope.
type SessionScopeFileGroup struct {
	Files []SessionScopeFile
}

// SessionScopeFilesInput mirrors the createCodexSessionScopeBatchesForFiles
// input. Options carries the homes, limits, callbacks and seams; Files, Since,
// Until and Now are ignored.
type SessionScopeFilesInput struct {
	Options SessionScopeOptions
	Groups  []SessionScopeFileGroup
}

type sessionScopeLimits struct {
	maxFileBytes          int64
	maxBatchBytes         int64
	maxGroupBytes         int64
	maxPrefilterBytes     int64
	maxPrefilterLineBytes int64
}

type sessionRoot struct {
	name         string
	path         string
	resolvedPath string
	isSymlink    bool
	homeIndex    int
}

type sessionCandidate struct {
	root         sessionRoot
	homeIndex    int
	file         string
	sourceFile   string
	relativePath string
}

type preparedCandidateGroup struct {
	candidates       []sessionCandidate
	bytes            int64
	hasOversizedFile bool
}

type sessionScan struct {
	roots       []sessionRoot
	pathsByRoot [][]string
	includeAll  bool
	since       time.Time
	until       time.Time
	now         time.Time
	limits      sessionScopeLimits
}

type sessionScans struct {
	scans     []sessionScan
	homeCount int
	limits    sessionScopeLimits
}

// scopeRunner carries the resolved collaborators for one public call.
type scopeRunner struct {
	options           SessionScopeOptions
	env               func(string) string
	createCloner      func(onFallback func()) CodexSessionCloner
	fingerprintFile   func(string) (CodexSessionFileFingerprint, error)
	fingerprintPrefix func(string, float64) (CodexSessionFilePrefixFingerprint, error)
	readJSONL         func(io.Reader, func(string), JSONLReadLimits, func(UnknownRecord) error) error
}

func newScopeRunner(options SessionScopeOptions) *scopeRunner {
	runner := &scopeRunner{options: options, env: options.Env}
	if runner.env == nil {
		runner.env = os.Getenv
	}
	runner.createCloner = options.CreateCloner
	if runner.createCloner == nil {
		runner.createCloner = func(onFallback func()) CodexSessionCloner {
			return CreateCodexSessionCloner(CodexSessionClonerOptions{OnFallback: onFallback})
		}
	}
	runner.fingerprintFile = options.FingerprintFile
	if runner.fingerprintFile == nil {
		runner.fingerprintFile = FingerprintCodexSessionFile
	}
	runner.fingerprintPrefix = options.FingerprintFilePrefix
	if runner.fingerprintPrefix == nil {
		runner.fingerprintPrefix = func(filePath string, prefixSize float64) (CodexSessionFilePrefixFingerprint, error) {
			size := prefixSize
			return FingerprintCodexSessionFilePrefix(filePath, &size)
		}
	}
	runner.readJSONL = options.ReadJSONLRecords
	if runner.readJSONL == nil {
		runner.readJSONL = ReadJSONLRecordsFromStream
	}
	return runner
}

// CreateCodexSessionScope ports createCodexSessionScope. A nil scope means the
// window selected no files at all, which the caller reports as "nothing to
// collect" rather than an error.
func CreateCodexSessionScope(options SessionScopeOptions) (*SessionScope, error) {
	runner := newScopeRunner(options)
	if options.Files != nil {
		return runner.createExplicitScope()
	}
	scans, err := runner.prepareSessionScans()
	if err != nil {
		return nil, err
	}
	if scans == nil {
		return nil, nil
	}
	reportCopyFallback := newScopeCopyFallbackReporter(options.OnCopyFallback)
	scope, err := runner.createEmptyScope(scans.homeCount)
	if err != nil {
		return nil, err
	}
	copied, err := runner.copyCandidates(
		scope,
		scans.forEachCandidateAcrossHomes,
		scans.limits,
		scans.limits.maxBatchBytes,
		reportCopyFallback,
	)
	if err != nil {
		_ = scope.Cleanup()
		return nil, err
	}
	if copied == 0 {
		_ = scope.Cleanup()
		return nil, nil
	}
	return scope, nil
}

// CreateCodexSessionScopeBatches ports createCodexSessionScopeBatches: full
// scans are streamed in bounded batches, and each yielded scope must be cleaned
// up by the caller.
func CreateCodexSessionScopeBatches(options SessionScopeOptions, yield func(*SessionScope) error) error {
	runner := newScopeRunner(options)
	scans, err := runner.prepareSessionScans()
	if err != nil {
		return err
	}
	if scans == nil {
		return nil
	}
	reportCopyFallback := newScopeCopyFallbackReporter(options.OnCopyFallback)
	return runner.forEachScopeBatch(
		scans.forEachCandidateGroup,
		scans.homeCount,
		scans.limits,
		normalizeSessionScopeBatchSize(options.BatchSize),
		reportCopyFallback,
		yield,
	)
}

// CreateCodexSessionScopeBatchesForFiles ports
// createCodexSessionScopeBatchesForFiles: explicit groups of files, each kept
// together in one scope, streamed under the same batch limits.
func CreateCodexSessionScopeBatchesForFiles(input SessionScopeFilesInput, yield func(*SessionScope) error) error {
	runner := newScopeRunner(input.Options)
	limits, err := resolveSessionScopeLimits(input.Options)
	if err != nil {
		return err
	}
	codexHomes, err := runner.resolveHomes()
	if err != nil {
		return err
	}
	rootsByHome := make([][]sessionRoot, len(codexHomes))
	for homeIndex, codexHome := range codexHomes {
		roots, _, err := runner.readSessionRoots(codexHome, homeIndex)
		if err != nil {
			return err
		}
		rootsByHome[homeIndex] = roots
	}
	homeIndexes := make(map[string]int, len(codexHomes))
	for index, codexHome := range codexHomes {
		homeIndexes[codexHome] = index
	}
	candidateGroups := make([][]sessionCandidate, 0, len(input.Groups))
	for _, group := range input.Groups {
		candidates, err := selectSessionCandidateGroup(group, codexHomes, homeIndexes, rootsByHome)
		if err != nil {
			return err
		}
		candidateGroups = append(candidateGroups, candidates)
	}
	reportCopyFallback := newScopeCopyFallbackReporter(input.Options.OnCopyFallback)
	return runner.forEachScopeBatch(
		func(yieldGroup func([]sessionCandidate) error) error {
			for _, candidates := range candidateGroups {
				if err := yieldGroup(candidates); err != nil {
					return err
				}
			}
			return nil
		},
		len(codexHomes),
		limits,
		normalizeSessionScopeBatchSize(input.Options.BatchSize),
		reportCopyFallback,
		yield,
	)
}

func (runner *scopeRunner) createExplicitScope() (*SessionScope, error) {
	limits, err := resolveSessionScopeLimits(runner.options)
	if err != nil {
		return nil, err
	}
	codexHomes, err := runner.resolveHomes()
	if err != nil {
		return nil, err
	}
	if len(codexHomes) != 1 {
		return nil, errors.New("Explicit Codex session scope requires exactly one Codex home")
	}
	roots, _, err := runner.readSessionRoots(codexHomes[0], 0)
	if err != nil {
		return nil, err
	}
	if len(roots) == 0 {
		return nil, errors.New("Unable to read Codex session directories for canonical session attribution")
	}
	candidates, err := selectSessionCandidates(runner.options.Files, roots)
	if err != nil {
		return nil, err
	}
	reportCopyFallback := newScopeCopyFallbackReporter(runner.options.OnCopyFallback)
	scope, err := runner.createEmptyScope(1)
	if err != nil {
		return nil, err
	}
	copied, err := runner.copyCandidates(
		scope,
		func(yield func(sessionCandidate) error) error {
			for _, candidate := range candidates {
				if err := yield(candidate); err != nil {
					return err
				}
			}
			return nil
		},
		limits,
		limits.maxBatchBytes,
		reportCopyFallback,
	)
	if err != nil {
		_ = scope.Cleanup()
		return nil, err
	}
	if copied == 0 {
		_ = scope.Cleanup()
		return nil, nil
	}
	return scope, nil
}

// forEachScopeBatch ports createScopeBatches. The batch state machine is the
// TS one: a group that needs its own scope flushes the pending batch first, a
// group that fits is accumulated until the batch size or byte budget is
// reached.
func (runner *scopeRunner) forEachScopeBatch(
	candidateGroups func(yield func([]sessionCandidate) error) error,
	homeCount int,
	limits sessionScopeLimits,
	batchSize int,
	reportCopyFallback func(),
	yield func(*SessionScope) error,
) error {
	batch := make([]sessionCandidate, 0, batchSize)
	batchGroups := 0
	batchBytes := int64(0)
	flush := func(maxScopeBytes int64) error {
		if len(batch) == 0 {
			return nil
		}
		candidates := batch
		batch = nil
		batchGroups = 0
		batchBytes = 0
		scope, err := runner.createScope(candidates, homeCount, limits, maxScopeBytes, reportCopyFallback)
		if err != nil {
			return err
		}
		if scope == nil {
			return nil
		}
		return yield(scope)
	}
	if err := candidateGroups(func(candidates []sessionCandidate) error {
		group, err := runner.prepareCandidateGroup(candidates, limits)
		if err != nil {
			return err
		}
		if len(group.candidates) == 0 {
			return nil
		}
		if group.hasOversizedFile {
			if err := flush(limits.maxBatchBytes); err != nil {
				return err
			}
			scope, err := runner.createScope(group.candidates, homeCount, limits, limits.maxBatchBytes, reportCopyFallback)
			if err != nil {
				return err
			}
			if scope == nil {
				return nil
			}
			return yield(scope)
		}
		if group.bytes > limits.maxGroupBytes {
			return fmt.Errorf(
				"Codex session group exceeds scoped collection group byte limit (%d > %d)",
				group.bytes, limits.maxGroupBytes)
		}
		if group.bytes > limits.maxBatchBytes {
			if err := flush(limits.maxBatchBytes); err != nil {
				return err
			}
			scope, err := runner.createScope(group.candidates, homeCount, limits, group.bytes, reportCopyFallback)
			if err != nil {
				return err
			}
			if scope == nil {
				return nil
			}
			return yield(scope)
		}
		if batchGroups > 0 && (batchGroups >= batchSize || batchBytes+group.bytes > limits.maxBatchBytes) {
			if err := flush(limits.maxBatchBytes); err != nil {
				return err
			}
		}
		batch = append(batch, group.candidates...)
		batchGroups++
		batchBytes += group.bytes
		if batchGroups >= batchSize {
			return flush(limits.maxBatchBytes)
		}
		return nil
	}); err != nil {
		return err
	}
	return flush(limits.maxBatchBytes)
}

func (runner *scopeRunner) createScope(
	candidates []sessionCandidate,
	homeCount int,
	limits sessionScopeLimits,
	maxScopeBytes int64,
	reportCopyFallback func(),
) (*SessionScope, error) {
	scope, err := runner.createEmptyScope(homeCount)
	if err != nil {
		return nil, err
	}
	copied, err := runner.copyCandidates(
		scope,
		func(yield func(sessionCandidate) error) error {
			for _, candidate := range candidates {
				if err := yield(candidate); err != nil {
					return err
				}
			}
			return nil
		},
		limits,
		maxScopeBytes,
		reportCopyFallback,
	)
	if err != nil {
		_ = scope.Cleanup()
		return nil, err
	}
	if copied == 0 {
		_ = scope.Cleanup()
		return nil, nil
	}
	return scope, nil
}

// copyCandidates ports copyCandidates: one cloner per scope, closed before the
// scope is handed to the caller so no helper outlives the copy.
func (runner *scopeRunner) copyCandidates(
	scope *SessionScope,
	candidates func(yield func(sessionCandidate) error) error,
	limits sessionScopeLimits,
	maxScopeBytes int64,
	reportCopyFallback func(),
) (int, error) {
	cloner := runner.createCloner(reportCopyFallback)
	copied := 0
	copiedBytes := int64(0)
	iterateErr := candidates(func(candidate sessionCandidate) error {
		bytes, ok, err := runner.copySessionCandidate(scope, cloner, candidate, limits, copiedBytes, maxScopeBytes)
		if err != nil {
			return err
		}
		if !ok {
			return nil
		}
		copied++
		copiedBytes += bytes
		return nil
	})
	closeErr := cloner.Close()
	if iterateErr != nil {
		if closeErr != nil {
			return 0, &scopeCloneCleanupError{copyErr: iterateErr, closeErr: closeErr}
		}
		return 0, iterateErr
	}
	if closeErr != nil {
		return 0, closeErr
	}
	return copied, nil
}

// scopeCloneCleanupError is the TS AggregateError: the copy failed and the
// cloner could not be closed either.
type scopeCloneCleanupError struct {
	copyErr  error
	closeErr error
}

func (e *scopeCloneCleanupError) Error() string {
	return "Codex scoped collection clone helper cleanup failed"
}

func (e *scopeCloneCleanupError) Unwrap() []error {
	return []error{e.copyErr, e.closeErr}
}

// copySessionCandidate ports copySessionCandidate. It returns the number of
// bytes added to the scope, or ok=false when the source disappeared and the
// candidate was skipped.
func (runner *scopeRunner) copySessionCandidate(
	scope *SessionScope,
	cloner CodexSessionCloner,
	candidate sessionCandidate,
	limits sessionScopeLimits,
	copiedBytes int64,
	maxScopeBytes int64,
) (int64, bool, error) {
	if candidate.homeIndex >= len(scope.CodexHomes) {
		return 0, false, errors.New("Codex scoped collection lost its profile mapping")
	}
	scopedHome := scope.CodexHomes[candidate.homeIndex]
	targetRoot := filepath.Join(scopedHome, candidate.root.name)
	target := filepath.Join(targetRoot, filepath.FromSlash(candidate.relativePath))
	fileIsInsideConfiguredRoot := isSessionScopePathInside(candidate.root.path, candidate.file)
	fileIsInsideResolvedRoot := isSessionScopePathInside(candidate.root.resolvedPath, candidate.file)
	if (!fileIsInsideConfiguredRoot && !fileIsInsideResolvedRoot) ||
		!isSessionScopePathInside(targetRoot, target) {
		return 0, false, errors.New("Invalid Codex session file path for scoped collection")
	}
	source, err := inspectScopeSessionFile(candidate.file, limits.maxFileBytes, true)
	if err != nil {
		return 0, false, err
	}
	if source == nil {
		runner.reportMissingSessionFile(candidate.relativePath)
		return 0, false, nil
	}
	if source.Size() <= limits.maxFileBytes && copiedBytes+source.Size() > maxScopeBytes {
		return 0, false, fmt.Errorf(
			"Codex scoped collection batch exceeds byte limit (%d > %d)",
			copiedBytes+source.Size(), maxScopeBytes)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		return 0, false, err
	}
	bytes, ok, err := runner.copySessionCandidateFile(scope, cloner, candidate, target, source, limits, copiedBytes, maxScopeBytes)
	if err != nil {
		// The TS catch: only a raw ENOENT can mean the source vanished while
		// it was being copied; a fingerprint or verification error keeps its
		// own message.
		if errors.Is(err, fs.ErrNotExist) {
			sourceAfterFailure, inspectErr := inspectScopeSessionFile(candidate.file, limits.maxFileBytes, true)
			if inspectErr != nil {
				return 0, false, inspectErr
			}
			if sourceAfterFailure == nil {
				runner.reportMissingSessionFile(candidate.relativePath)
				return 0, false, nil
			}
		}
		return 0, false, err
	}
	return bytes, ok, nil
}

func (runner *scopeRunner) copySessionCandidateFile(
	scope *SessionScope,
	cloner CodexSessionCloner,
	candidate sessionCandidate,
	target string,
	source os.FileInfo,
	limits sessionScopeLimits,
	copiedBytes int64,
	maxScopeBytes int64,
) (int64, bool, error) {
	if source.Size() > limits.maxFileBytes {
		return runner.copyProjectedSessionCandidate(scope, candidate, target, source, limits, copiedBytes, maxScopeBytes)
	}
	if err := cloner.Copy(candidate.file, target); err != nil {
		return 0, false, err
	}
	copiedDetails, err := os.Lstat(target)
	if err != nil {
		return 0, false, err
	}
	if copiedDetails.Mode()&os.ModeSymlink != 0 {
		_ = os.Remove(target)
		return 0, false, fmt.Errorf(
			"Unable to read Codex session file %s: symbolic links are not supported", candidate.file)
	}
	if !copiedDetails.Mode().IsRegular() {
		_ = os.Remove(target)
		return 0, false, fmt.Errorf("Unable to read Codex session file %s: path is not a file", candidate.file)
	}
	if copiedDetails.Size() > limits.maxFileBytes || copiedDetails.Size() > maxScopeBytes {
		_ = os.Remove(target)
		return 0, false, errors.New(
			"Codex session file exceeds scoped collection byte limit after copy; retry the sync")
	}
	if copiedDetails.Size() != source.Size() {
		return 0, false, errCodexSessionChangedDuringScope
	}
	sourceAfterCopy, err := inspectScopeSessionFile(candidate.file, limits.maxFileBytes, false)
	if err != nil {
		return 0, false, err
	}
	if sourceAfterCopy == nil || !sameScopeFileMetadata(source, sourceAfterCopy) {
		return 0, false, errCodexSessionChangedDuringScope
	}
	sourceFingerprint, err := runner.fingerprintFile(candidate.file)
	if err != nil {
		return 0, false, err
	}
	copiedFingerprint, err := runner.fingerprintFile(target)
	if err != nil {
		return 0, false, err
	}
	if !sameScopeMetadataWithFingerprint(sourceAfterCopy, sourceFingerprint) ||
		!sameScopeCopiedFileContent(sourceFingerprint, copiedFingerprint) {
		return 0, false, errCodexSessionChangedDuringScope
	}
	scope.SourceFiles[target] = candidate.sourceFile
	scope.SourceFileHomeIndexes[candidate.sourceFile] = candidate.homeIndex
	scope.SourceFileFingerprints[candidate.sourceFile] = sourceFingerprint
	return source.Size(), true, nil
}

func (runner *scopeRunner) copyProjectedSessionCandidate(
	scope *SessionScope,
	candidate sessionCandidate,
	target string,
	source os.FileInfo,
	limits sessionScopeLimits,
	copiedBytes int64,
	maxScopeBytes int64,
) (int64, bool, error) {
	if maxScopeBytes <= copiedBytes {
		return 0, false, fmt.Errorf(
			"Codex scoped collection batch exceeds byte limit (%d >= %d)", copiedBytes, maxScopeBytes)
	}
	prefixSize := math.Min(float64(source.Size()), float64(codexSessionPrefixFingerprintBytes))
	sourcePrefix, err := runner.fingerprintPrefix(candidate.file, prefixSize)
	if err != nil {
		return 0, false, normalizeProjectedSourceChange(err)
	}
	if sourcePrefix.CapturedSize < float64(source.Size()) {
		return 0, false, errCodexSessionChangedDuringScope
	}
	if runner.options.OnProjectionDiagnostic != nil {
		runner.options.OnProjectionDiagnostic(fmt.Sprintf(
			"Codex session file exceeds the %d-byte scoped file limit; using bounded metadata projection",
			limits.maxFileBytes))
	}
	projectedBytes, ok, err := runner.projectOversizedSessionFile(oversizedProjectionInput{
		sourceFile:     candidate.file,
		targetFile:     target,
		maxBytes:       maxScopeBytes - copiedBytes,
		maxSourceBytes: int64(sourcePrefix.CapturedSize),
		stderr:         runner.options.OnProjectionDiagnostic,
	})
	if err != nil {
		return 0, false, err
	}
	if !ok {
		return 0, false, nil
	}
	copiedDetails, err := os.Lstat(target)
	if err != nil {
		return 0, false, err
	}
	if copiedDetails.Mode()&os.ModeSymlink != 0 || !copiedDetails.Mode().IsRegular() {
		_ = os.Remove(target)
		return 0, false, fmt.Errorf(
			"Unable to read Codex session file %s: projected path is not a file", candidate.file)
	}
	sourceAfterProjection, err := runner.fingerprintPrefix(candidate.file, sourcePrefix.PrefixSize)
	if err != nil {
		return 0, false, normalizeProjectedSourceChange(err)
	}
	if sourceAfterProjection.CapturedSize < sourcePrefix.CapturedSize ||
		!SameCodexSessionFilePrefixFingerprint(sourcePrefix, sourceAfterProjection) {
		return 0, false, errCodexSessionChangedDuringScope
	}
	metadata := scopeFileMetadata(source)
	scope.SourceFiles[target] = candidate.sourceFile
	scope.SourceFileHomeIndexes[candidate.sourceFile] = candidate.homeIndex
	scope.SourceFileFingerprints[candidate.sourceFile] = CodexSessionFileFingerprint{
		Dev:        sourcePrefix.Dev,
		Ino:        sourcePrefix.Ino,
		Size:       sourcePrefix.CapturedSize,
		MtimeMs:    metadata.MtimeMs,
		CtimeMs:    metadata.CtimeMs,
		TailSHA256: sourcePrefix.PrefixTailSHA256,
	}
	scope.ProjectedSourceFiles[candidate.sourceFile] = true
	scope.ProjectedSourceFilePrefixes[candidate.sourceFile] = sourcePrefix
	return projectedBytes, true, nil
}

type oversizedProjectionInput struct {
	sourceFile     string
	targetFile     string
	maxBytes       int64
	maxSourceBytes int64
	stderr         func(string)
}

// projectOversizedSessionFile ports projectOversizedSessionFile: a session too
// large to copy is reduced to the rows that carry usage metadata, written under
// the same byte budget.
func (runner *scopeRunner) projectOversizedSessionFile(input oversizedProjectionInput) (int64, bool, error) {
	source, err := os.Open(input.sourceFile)
	if err != nil {
		return 0, false, err
	}
	defer source.Close()
	target, err := os.OpenFile(input.targetFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return 0, false, err
	}
	completed := false
	defer func() {
		if !completed {
			_ = os.Remove(input.targetFile)
		}
	}()
	defer target.Close()

	projectedBytes := int64(0)
	projectedRecords := 0
	malformedRows := 0
	report := func(message string) {
		if strings.HasPrefix(message, "Skipping malformed Codex subagent JSONL row at line ") {
			malformedRows++
		}
		if input.stderr != nil {
			input.stderr(message)
		}
	}
	limits := JSONLReadLimits{
		MaxLineBytes:             int64Pointer(codexSessionChildMaxLineBytes),
		MaxDiscardedLineBytes:    int64Pointer(codexSessionChildMaxDiscardedLineBytes),
		RelevantMetadataKeys:     []string{"total_token_usage", "last_token_usage", "subagent"},
		CodexUsageOnly:           true,
		DiscardableLineTypes:     []string{"compacted", "event_msg", "response_item", "turn_context"},
		AllowIncompleteFinalLine: true,
		OnIncompleteFinalLine: func(byteLength int64) {
			report(fmt.Sprintf(
				"Codex oversized session projection deferred %d-byte incomplete final line; "+
					"it may contain usage metadata and will be retried after the session is complete",
				byteLength))
		},
		Label: "Codex oversized session projection",
	}
	// The TS stream ends at maxSourceBytes-1: exactly the fingerprinted prefix.
	stream := io.LimitReader(source, input.maxSourceBytes)
	readErr := runner.readJSONL(stream, report, limits, func(record UnknownRecord) error {
		line, keep, err := scopeProjectionLine(record)
		if err != nil || !keep {
			return err
		}
		nextBytes := projectedBytes + int64(len(line))
		if nextBytes > input.maxBytes {
			return fmt.Errorf(
				"Codex projected session file exceeds scoped collection byte limit (%d > %d)",
				nextBytes, input.maxBytes)
		}
		if err := writeFileHandleFully(target, line); err != nil {
			return err
		}
		projectedBytes = nextBytes
		projectedRecords++
		return nil
	})
	if readErr != nil {
		return 0, false, readErr
	}
	completed = true
	if malformedRows > 0 {
		return 0, false, fmt.Errorf(
			"Codex oversized session projection encountered %d malformed JSONL row%s",
			malformedRows, scopePlural(malformedRows))
	}
	if projectedRecords == 0 {
		_ = os.Remove(input.targetFile)
		return 0, false, nil
	}
	return projectedBytes, true, nil
}

// isProjectionRecord ports isProjectionRecord: the rows that survive
// projection.
func isProjectionRecord(record UnknownRecord) bool {
	recordType, _ := record["type"].(string)
	if recordType == "session_meta" || recordType == "turn_context" {
		return true
	}
	if recordType != "event_msg" {
		return false
	}
	payload, _ := record["payload"].(map[string]any)
	payloadType, _ := payload["type"].(string)
	return payloadType == "token_count" || payloadType == "thread_settings_applied"
}

func scopeProjectionLine(record UnknownRecord) ([]byte, bool, error) {
	if !isProjectionRecord(record) {
		return nil, false, nil
	}
	line, err := scopeMarshalJSONLine(record)
	if err != nil {
		return nil, false, err
	}
	return line, true, nil
}

// scopeMarshalJSONLine serializes one projected row the way JSON.stringify
// does: compact, without HTML escaping, and terminated by a newline. Object key
// order is Go's sorted order rather than the row's original order; the
// projection is only ever parsed, never compared byte for byte.
func scopeMarshalJSONLine(record UnknownRecord) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(record); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

// writeFileHandleFully ports writeFileHandleFully: a writer that accepts fewer
// bytes than offered is retried, and a writer that reports no progress fails
// the projection instead of truncating it.
func writeFileHandleFully(writer io.Writer, data []byte) error {
	offset := 0
	for offset < len(data) {
		remaining := len(data) - offset
		written, err := writer.Write(data[offset:])
		if err != nil {
			return err
		}
		if written <= 0 || written > remaining {
			return fmt.Errorf(
				"Codex oversized session projection write made no valid progress (%d of %d bytes)",
				written, remaining)
		}
		offset += written
	}
	return nil
}

// normalizeProjectedSourceChange ports normalizeProjectedSourceChange: the
// fingerprint's two change errors become the scope's single retry message.
func normalizeProjectedSourceChange(err error) error {
	if errors.Is(err, errCodexSessionFingerprintRace) || errors.Is(err, errCodexSessionTruncated) {
		return errCodexSessionChangedDuringScope
	}
	return err
}

func (runner *scopeRunner) prepareCandidateGroup(
	candidates []sessionCandidate,
	limits sessionScopeLimits,
) (preparedCandidateGroup, error) {
	prepared := make([]sessionCandidate, 0, len(candidates))
	bytes := int64(0)
	hasOversizedFile := false
	for _, candidate := range candidates {
		details, err := inspectScopeSessionFile(candidate.file, limits.maxFileBytes, true)
		if err != nil {
			return preparedCandidateGroup{}, err
		}
		if details == nil {
			runner.reportMissingSessionFile(candidate.relativePath)
			continue
		}
		prepared = append(prepared, candidate)
		if details.Size() > limits.maxFileBytes {
			hasOversizedFile = true
			bytes += limits.maxBatchBytes
			continue
		}
		bytes += details.Size()
	}
	return preparedCandidateGroup{
		candidates:       prepared,
		bytes:            bytes,
		hasOversizedFile: hasOversizedFile,
	}, nil
}

// inspectScopeSessionFile ports inspectSessionFile. A missing file yields
// (nil, nil); everything else that is not a regular file is an error.
func inspectScopeSessionFile(file string, maxFileBytes int64, allowOverflow bool) (os.FileInfo, error) {
	details, err := os.Lstat(file)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("Unable to read Codex session file %s: %s", file, errorText(err))
	}
	if details.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("Unable to read Codex session file %s: symbolic links are not supported", file)
	}
	if !details.Mode().IsRegular() {
		return nil, fmt.Errorf("Unable to read Codex session file %s: path is not a file", file)
	}
	if !allowOverflow && details.Size() > maxFileBytes {
		return nil, fmt.Errorf(
			"Codex session file exceeds scoped collection byte limit (%d > %d)", details.Size(), maxFileBytes)
	}
	return details, nil
}

func (runner *scopeRunner) reportMissingSessionFile(relativePath string) {
	if runner.options.OnMissingSessionFile != nil {
		runner.options.OnMissingSessionFile(relativePath)
	}
}

func resolveSessionScopeLimits(options SessionScopeOptions) (sessionScopeLimits, error) {
	maxFileBytes, err := readSessionScopeByteLimit(options.MaxFileBytes, defaultCodexSessionFileBytes, "file byte limit")
	if err != nil {
		return sessionScopeLimits{}, err
	}
	maxBatchBytes, err := readSessionScopeByteLimit(options.MaxBatchBytes, defaultCodexSessionBatchBytes, "batch byte limit")
	if err != nil {
		return sessionScopeLimits{}, err
	}
	maxGroupBytes, err := readSessionScopeByteLimit(options.MaxGroupBytes, defaultCodexSessionGroupBytes, "group byte limit")
	if err != nil {
		return sessionScopeLimits{}, err
	}
	maxPrefilterBytes, err := readSessionScopeByteLimit(
		options.MaxPrefilterBytes, defaultCodexSessionPrefilterBytes, "prefilter read limit")
	if err != nil {
		return sessionScopeLimits{}, err
	}
	maxPrefilterLineBytes, err := readSessionScopeByteLimit(
		options.MaxPrefilterLineBytes, defaultCodexSessionPrefilterLineBytes, "prefilter line limit")
	if err != nil {
		return sessionScopeLimits{}, err
	}
	limits := sessionScopeLimits{
		maxFileBytes:          maxFileBytes,
		maxBatchBytes:         maxBatchBytes,
		maxGroupBytes:         maxGroupBytes,
		maxPrefilterBytes:     maxPrefilterBytes,
		maxPrefilterLineBytes: maxPrefilterLineBytes,
	}
	if limits.maxGroupBytes < limits.maxBatchBytes {
		return sessionScopeLimits{}, errors.New("Codex session group byte limit must be at least the batch byte limit")
	}
	return limits, nil
}

// readSessionScopeByteLimit ports readByteLimit. Zero means "not configured"
// (the TS undefined); a negative value is refused the way a non-safe-integer or
// sub-1 value is.
func readSessionScopeByteLimit(value, fallback int64, label string) (int64, error) {
	if value == 0 {
		return fallback, nil
	}
	if value < 1 {
		return 0, fmt.Errorf("Invalid Codex session %s", label)
	}
	return value, nil
}

func sameScopeFileMetadata(left, right os.FileInfo) bool {
	return sameCodexFileStat(codexStatOf(left), codexStatOf(right))
}

func scopeFileMetadata(info os.FileInfo) CodexSessionFileMetadata {
	stat := codexStatOf(info)
	return CodexSessionFileMetadata{
		Size:    float64(stat.size),
		MtimeMs: stat.mtimeMs,
		CtimeMs: stat.ctimeMs,
	}
}

func sameScopeMetadataWithFingerprint(info os.FileInfo, fingerprint CodexSessionFileFingerprint) bool {
	return SameCodexSessionFileMetadata(scopeFileMetadata(info), CodexSessionFileMetadata{
		Size:    fingerprint.Size,
		MtimeMs: fingerprint.MtimeMs,
		CtimeMs: fingerprint.CtimeMs,
	})
}

func sameScopeCopiedFileContent(source, copied CodexSessionFileFingerprint) bool {
	return source.Size == copied.Size && source.TailSHA256 == copied.TailSHA256
}

func newScopeCopyFallbackReporter(onCopyFallback func(string)) func() {
	reported := false
	return func() {
		if reported {
			return
		}
		reported = true
		if onCopyFallback != nil {
			onCopyFallback(CodexSessionCopyFallbackMessage)
		}
	}
}

func normalizeSessionScopeBatchSize(value int) int {
	if value < 1 {
		return defaultCodexSessionBatchSize
	}
	if value > maxCodexSessionBatchSize {
		return maxCodexSessionBatchSize
	}
	return value
}

func (runner *scopeRunner) prepareSessionScans() (*sessionScans, error) {
	limits, err := resolveSessionScopeLimits(runner.options)
	if err != nil {
		return nil, err
	}
	since, err := parseSessionScopeFilterDate(runner.options.Since, "start")
	if err != nil {
		return nil, err
	}
	until, err := parseSessionScopeFilterDate(runner.options.Until, "end")
	if err != nil {
		return nil, err
	}
	includeAll := isSessionScopeAllDateFilter(runner.options.Since) && until.IsZero()
	if !includeAll && since.IsZero() && until.IsZero() {
		return nil, nil
	}

	codexHomes, err := runner.resolveHomes()
	if err != nil {
		return nil, err
	}
	now := runner.options.Now
	if now.IsZero() {
		now = time.Now()
	}
	scans := make([]sessionScan, 0, len(codexHomes))
	for homeIndex, codexHome := range codexHomes {
		roots, pathsByRoot, err := runner.readSessionRoots(codexHome, homeIndex)
		if err != nil {
			return nil, err
		}
		if len(roots) == 0 {
			continue
		}
		scans = append(scans, sessionScan{
			roots:       roots,
			pathsByRoot: pathsByRoot,
			includeAll:  includeAll,
			since:       since,
			until:       until,
			now:         now,
			limits:      limits,
		})
	}
	if len(scans) == 0 {
		return nil, nil
	}
	return &sessionScans{scans: scans, homeCount: len(codexHomes), limits: limits}, nil
}

// readSessionRoots ports readSessionRoots: resolve each session directory
// through the symlink policy, then re-read its metadata so a directory rotated
// away between resolution and the read is skipped rather than reported.
func (runner *scopeRunner) readSessionRoots(codexHome string, homeIndex int) ([]sessionRoot, [][]string, error) {
	roots := make([]sessionRoot, 0, len(codexSessionRootNames))
	pathsByRoot := make([][]string, 0, len(codexSessionRootNames))
	for _, name := range codexSessionRootNames {
		rootPath := filepath.Join(codexHome, name)
		files, ok, err := scopeResolveSessionFiles(rootPath, sessionwalk.Options{
			RejectRootSymlink:   true,
			AllowedRootSymlinks: runner.options.CodexSymlinkRoots,
			RootBoundary:        codexHome,
		})
		if err != nil {
			return nil, nil, err
		}
		if !ok {
			continue
		}
		details, err := scopeRootLstat(rootPath)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return nil, nil, fmt.Errorf("Unable to inspect session directory %s: %s", rootPath, errorText(err))
		}
		// Keep the configured path as the source identity. The resolved path
		// is used only for scanning so macOS /var aliases do not change cache
		// keys.
		roots = append(roots, sessionRoot{
			name:         name,
			path:         rootPath,
			resolvedPath: files.RootDir,
			isSymlink:    details.Mode()&os.ModeSymlink != 0,
			homeIndex:    homeIndex,
		})
		pathsByRoot = append(pathsByRoot, files.Paths)
	}
	return roots, pathsByRoot, nil
}

func (runner *scopeRunner) resolveHomes() ([]string, error) {
	options := runner.options
	input := ResolveHomesInput{ExplicitHomes: options.CodexHomes, HomeDir: options.HomeDir}
	if options.CodexHome != nil {
		input.LegacyValue = *options.CodexHome
	} else if options.CodexHomes == nil {
		input.LegacyValue = runner.env("CODEX_HOME")
	}
	if options.CodexHomes == nil && options.CodexHome == nil {
		input.JSONValue = runner.env("TOKENBOARD_CODEX_HOMES_JSON")
	}
	return ResolveHomes(input)
}

// forEachCandidateGroup ports matchingSessionCandidateGroups: a k-way merge of
// the per-home candidate streams by relative path, so the same session from
// different profiles lands in one group.
func (scans *sessionScans) forEachCandidateGroup(yield func([]sessionCandidate) error) error {
	cursors := make([]*scanCursor, len(scans.scans))
	for index := range scans.scans {
		cursors[index] = newScanCursor(&scans.scans[index])
	}
	current := make([]*sessionCandidate, len(cursors))
	for index, cursor := range cursors {
		candidate, err := cursor.next()
		if err != nil {
			return err
		}
		current[index] = candidate
	}
	for {
		smallest := ""
		found := false
		for _, candidate := range current {
			if candidate == nil {
				continue
			}
			if !found || candidate.relativePath < smallest {
				smallest = candidate.relativePath
				found = true
			}
		}
		if !found {
			return nil
		}
		group := make([]sessionCandidate, 0, len(current))
		for index, candidate := range current {
			if candidate == nil || candidate.relativePath != smallest {
				continue
			}
			group = append(group, *candidate)
			next, err := cursors[index].next()
			if err != nil {
				return err
			}
			current[index] = next
		}
		sort.SliceStable(group, func(left, right int) bool {
			if group[left].homeIndex != group[right].homeIndex {
				return group[left].homeIndex < group[right].homeIndex
			}
			return compareSessionCandidates(group[left], group[right]) < 0
		})
		if err := yield(group); err != nil {
			return err
		}
	}
}

func (scans *sessionScans) forEachCandidateAcrossHomes(yield func(sessionCandidate) error) error {
	return scans.forEachCandidateGroup(func(group []sessionCandidate) error {
		for _, candidate := range group {
			if err := yield(candidate); err != nil {
				return err
			}
		}
		return nil
	})
}

// scanCursor ports matchingSessionCandidates: a k-way merge across the session
// roots of one home, with the date prefilter applied before a candidate is
// yielded.
type scanCursor struct {
	scan  *sessionScan
	roots []scanRootCursor
}

type scanRootCursor struct {
	root  sessionRoot
	paths []string
	index int
}

func newScanCursor(scan *sessionScan) *scanCursor {
	cursor := &scanCursor{scan: scan}
	for index, root := range scan.roots {
		cursor.roots = append(cursor.roots, scanRootCursor{root: root, paths: scan.pathsByRoot[index]})
	}
	return cursor
}

func (cursor *scanCursor) next() (*sessionCandidate, error) {
	for {
		candidate, err := cursor.nextRaw()
		if err != nil || candidate == nil {
			return nil, err
		}
		if cursor.scan.includeAll {
			return candidate, nil
		}
		active, err := cursor.scan.isActiveSessionFile(*candidate)
		if err != nil {
			return nil, err
		}
		if active {
			return candidate, nil
		}
	}
}

func (cursor *scanCursor) nextRaw() (*sessionCandidate, error) {
	smallest := ""
	found := false
	for _, root := range cursor.roots {
		if root.index >= len(root.paths) {
			continue
		}
		path := root.paths[root.index]
		if !found || path < smallest {
			smallest = path
			found = true
		}
	}
	if !found {
		return nil, nil
	}
	var selected *sessionCandidate
	for index := range cursor.roots {
		root := &cursor.roots[index]
		if root.index >= len(root.paths) || root.paths[root.index] != smallest {
			continue
		}
		candidate, ok := candidateForFile(root.root, root.paths[root.index], root.root.path, root.root.resolvedPath)
		root.index++
		if !ok {
			continue
		}
		if selected == nil || compareSessionCandidates(candidate, *selected) < 0 {
			candidateCopy := candidate
			selected = &candidateCopy
		}
	}
	if selected == nil {
		// Every root's candidate for this path escaped its root, which the
		// walk cannot produce; continue with the next path rather than
		// stopping the scan.
		return cursor.nextRaw()
	}
	return selected, nil
}

func (scan *sessionScan) isActiveSessionFile(candidate sessionCandidate) (bool, error) {
	fileStat, err := inspectScopeSessionFile(candidate.file, scan.limits.maxFileBytes, true)
	if err != nil {
		return false, err
	}
	if fileStat == nil {
		return false, nil
	}
	modTime := sessionScopeModTime(fileStat)
	if isSessionScopeDateInRange(modTime, scan.since, scan.until) {
		return true, nil
	}
	sessionStart, ok := readSessionScopePathDate(candidate.relativePath)
	if ok {
		return sessionScopeDateIntervalsOverlap(sessionStart, modTime, scan.since, scan.until), nil
	}
	activity, err := scan.readTokenCountActivity(candidate.file)
	if err != nil {
		// A bounded prefilter is only an optimization. If it cannot reach a
		// conclusion within its own limits, keep the file and let the exact
		// window apply downstream.
		if strings.HasPrefix(err.Error(), "Codex session prefilter") {
			return true, nil
		}
		return false, err
	}
	return activity.hasInRangeTimestamp, nil
}

func sessionScopeModTime(info os.FileInfo) time.Time {
	return time.UnixMilli(info.ModTime().UnixMilli())
}

type sessionTokenCountActivity struct {
	hasAnyTimestamp     bool
	hasInRangeTimestamp bool
}

// readTokenCountActivity ports readTokenCountActivity: a bounded scan of the
// first maxPrefilterBytes bytes for a token_count row whose timestamp is inside
// the window.
func (scan *sessionScan) readTokenCountActivity(file string) (sessionTokenCountActivity, error) {
	activity := sessionTokenCountActivity{}
	source, err := os.Open(file)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return activity, nil
		}
		return activity, fmt.Errorf("Unable to read Codex session file %s: %s", file, errorText(err))
	}
	defer source.Close()

	chunkBytes := codexSessionReadChunkBytes
	if scan.limits.maxPrefilterBytes < chunkBytes {
		chunkBytes = scan.limits.maxPrefilterBytes
	}
	readBytes := int64(0)
	var pending []byte
	for {
		buffer := make([]byte, chunkBytes)
		read, readErr := source.Read(buffer)
		if read > 0 {
			readBytes += int64(read)
			if readBytes > scan.limits.maxPrefilterBytes {
				return activity, fmt.Errorf("Codex session prefilter read limit exceeded for %s", file)
			}
			chunk := buffer[:read]
			offset := 0
			for offset < len(chunk) {
				newline := bytes.IndexByte(chunk[offset:], '\n')
				end := len(chunk)
				if newline >= 0 {
					end = offset + newline
				}
				segment := chunk[offset:end]
				if int64(len(pending)+len(segment)) > scan.limits.maxPrefilterLineBytes {
					return activity, fmt.Errorf("Codex session prefilter line limit exceeded for %s", file)
				}
				if newline < 0 {
					pending = append(pending, segment...)
					break
				}
				var line []byte
				if len(pending) > 0 {
					pending = append(pending, segment...)
					line = pending
				} else {
					line = segment
				}
				if recordSessionTokenCountActivity(&activity, string(line), scan.since, scan.until) {
					return activity, nil
				}
				pending = nil
				offset = end + 1
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			if errors.Is(readErr, fs.ErrNotExist) {
				return activity, nil
			}
			return activity, fmt.Errorf("Unable to read Codex session file %s: %s", file, errorText(readErr))
		}
	}
	if len(pending) > 0 {
		recordSessionTokenCountActivity(&activity, string(pending), scan.since, scan.until)
	}
	return activity, nil
}

func recordSessionTokenCountActivity(
	activity *sessionTokenCountActivity,
	line string,
	since time.Time,
	until time.Time,
) bool {
	timestamp, ok := readSessionScopeTokenCountTimestamp(line)
	if !ok {
		return false
	}
	activity.hasAnyTimestamp = true
	if !isSessionScopeDateInRange(timestamp, since, until) {
		return false
	}
	activity.hasInRangeTimestamp = true
	return true
}

func readSessionScopeTokenCountTimestamp(line string) (time.Time, bool) {
	// `line.trim()` on the TS side strips a U+FEFF BOM at either end, so a session file stamped
	// by an editor or a PowerShell redirect still yields its token_count timestamp there.
	// TrimJSWhitespace matches that set; Go's TrimSpace would reject the line and drop the file
	// from the window.
	trimmed := jsonl.TrimJSWhitespace(line)
	if trimmed == "" {
		return time.Time{}, false
	}
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return time.Time{}, false
	}
	// Ports `JSON.parse`: trailing non-whitespace after the first value is a
	// syntax error there, so a line like `{"a":1}garbage` must not be accepted.
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return time.Time{}, false
	}
	entry, ok := value.(map[string]any)
	if !ok {
		return time.Time{}, false
	}
	if entryType, _ := entry["type"].(string); entryType != "event_msg" {
		return time.Time{}, false
	}
	payload, ok := entry["payload"].(map[string]any)
	if !ok {
		return time.Time{}, false
	}
	if payloadType, _ := payload["type"].(string); payloadType != "token_count" {
		return time.Time{}, false
	}
	timestampValue, ok := entry["timestamp"].(string)
	if !ok {
		return time.Time{}, false
	}
	return parseSessionScopeTimestamp(timestampValue)
}

// parseSessionScopeTimestamp accepts the ISO-8601 shapes `new Date(string)`
// accepts for the timestamps Codex writes. A zone-less timestamp is local time,
// as in JavaScript; a date-only value is UTC.
func parseSessionScopeTimestamp(value string) (time.Time, bool) {
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006-01-02T15:04:05.999999999",
		"2006-01-02 15:04:05.999999999",
	} {
		if parsed, err := time.ParseInLocation(layout, value, time.Local); err == nil {
			return parsed, true
		}
	}
	if parsed, err := time.Parse("2006-01-02", value); err == nil {
		return parsed, true
	}
	return time.Time{}, false
}

func isSessionScopeDateInRange(date, since, until time.Time) bool {
	if !since.IsZero() && date.Before(since) {
		return false
	}
	if !until.IsZero() && date.After(until) {
		return false
	}
	return true
}

func sessionScopeDateIntervalsOverlap(left, right, since, until time.Time) bool {
	start, end := left, right
	if end.Before(start) {
		start, end = right, left
	}
	if !since.IsZero() && end.Before(since) {
		return false
	}
	if !until.IsZero() && start.After(until) {
		return false
	}
	return true
}

func readSessionScopePathDate(relativePath string) (time.Time, bool) {
	parts := strings.FieldsFunc(relativePath, func(value rune) bool { return value == '/' || value == '\\' })
	if len(parts) >= 4 &&
		scopeFourDigitsPattern.MatchString(parts[0]) &&
		scopeTwoDigitsPattern.MatchString(parts[1]) &&
		scopeTwoDigitsPattern.MatchString(parts[2]) {
		return createSessionScopeUTCDate(parts[0], parts[1], parts[2])
	}
	if len(parts) == 0 {
		return time.Time{}, false
	}
	match := scopeRolloutDatePattern.FindStringSubmatch(parts[len(parts)-1])
	if match == nil {
		return time.Time{}, false
	}
	return createSessionScopeUTCDate(match[1], match[2], match[3])
}

func createSessionScopeUTCDate(yearValue, monthValue, dayValue string) (time.Time, bool) {
	year, _ := strconv.Atoi(yearValue)
	month, _ := strconv.Atoi(monthValue)
	day, _ := strconv.Atoi(dayValue)
	// Date.UTC maps years 0-99 to 1900+year, so the TS round-trip check always
	// rejects them; keep that instead of accepting year 0099.
	if year < 100 {
		return time.Time{}, false
	}
	date := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	if date.Year() != year || int(date.Month()) != month || date.Day() != day {
		return time.Time{}, false
	}
	return date, true
}

func isSessionScopeAllDateFilter(value string) bool {
	return strings.TrimSpace(value) == "all"
}

// parseSessionScopeFilterDate ports parseFilterDate. The scan is only a
// timezone-agnostic prefilter: a start boundary is the previous UTC day at
// 00:00, an end boundary the next UTC day at 23:59:59.999, so a session that
// straddles local midnight is never dropped before ccusage applies the exact
// local window.
func parseSessionScopeFilterDate(value, boundary string) (time.Time, error) {
	if value == "" || isSessionScopeAllDateFilter(value) {
		return time.Time{}, nil
	}
	trimmed := strings.TrimSpace(value)
	invalid := fmt.Errorf("Invalid Codex usage date filter: %s. Expected YYYYMMDD or YYYY-MM-DD.", value)
	if !scopeCompactDatePattern.MatchString(trimmed) && !scopeISODatePattern.MatchString(trimmed) {
		return time.Time{}, invalid
	}
	compact := strings.ReplaceAll(trimmed, "-", "")
	year, _ := strconv.Atoi(compact[0:4])
	month, _ := strconv.Atoi(compact[4:6])
	day, _ := strconv.Atoi(compact[6:8])
	date := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	if date.Year() != year || int(date.Month()) != month || date.Day() != day {
		return time.Time{}, invalid
	}
	if boundary == "end" {
		return time.Date(year, time.Month(month), day, 23, 59, 59, 999*int(time.Millisecond), time.UTC).
			AddDate(0, 0, 1), nil
	}
	return date.AddDate(0, 0, -1), nil
}

// selectSessionCandidates ports selectCandidates: explicit files are matched to
// a root, deduped by relative path (the active session wins over an archived
// one) and ordered.
func selectSessionCandidates(files []string, roots []sessionRoot) ([]sessionCandidate, error) {
	selected := map[string]sessionCandidate{}
	order := make([]string, 0, len(files))
	for _, file := range files {
		candidate, ok := candidateForRoots(roots, file)
		if !ok {
			return nil, errors.New("Invalid Codex session file path for canonical session attribution")
		}
		existing, seen := selected[candidate.relativePath]
		if !seen {
			order = append(order, candidate.relativePath)
		}
		if !seen || sessionRootPriority(candidate.root) < sessionRootPriority(existing.root) {
			selected[candidate.relativePath] = candidate
		}
	}
	candidates := make([]sessionCandidate, 0, len(order))
	for _, relativePath := range order {
		candidates = append(candidates, selected[relativePath])
	}
	sort.SliceStable(candidates, func(left, right int) bool {
		return compareSessionCandidates(candidates[left], candidates[right]) < 0
	})
	return candidates, nil
}

func selectSessionCandidateGroup(
	group SessionScopeFileGroup,
	codexHomes []string,
	homeIndexes map[string]int,
	rootsByHome [][]sessionRoot,
) ([]sessionCandidate, error) {
	if len(group.Files) == 0 {
		return nil, errors.New("Explicit Codex session scope group must include at least one file")
	}
	candidates := make([]sessionCandidate, 0, len(group.Files))
	seenFiles := map[string]bool{}
	for _, source := range group.Files {
		codexHome := resolvePath(source.CodexHome)
		homeIndex, ok := homeIndexes[codexHome]
		if !ok || codexHomes[homeIndex] != codexHome {
			return nil, errors.New("Explicit Codex session scope file uses an unknown Codex home")
		}
		candidate, ok := candidateForRoots(rootsByHome[homeIndex], source.FilePath)
		if !ok {
			return nil, errors.New("Invalid Codex session file path for canonical session attribution")
		}
		if !seenFiles[candidate.file] {
			candidates = append(candidates, candidate)
			seenFiles[candidate.file] = true
		}
	}
	sort.SliceStable(candidates, func(left, right int) bool {
		if candidates[left].homeIndex != candidates[right].homeIndex {
			return candidates[left].homeIndex < candidates[right].homeIndex
		}
		return compareSessionCandidates(candidates[left], candidates[right]) < 0
	})
	return candidates, nil
}

func candidateForRoots(roots []sessionRoot, file string) (sessionCandidate, bool) {
	for _, root := range roots {
		if candidate, ok := candidateForFile(root, file, root.path, root.resolvedPath); ok {
			return candidate, true
		}
	}
	return sessionCandidate{}, false
}

// candidateForFile ports candidateForFile: an absolute path is mapped back onto
// a root, a relative path is resolved under the scan root, and the source
// identity keeps the configured root unless that root is a symlink.
func candidateForFile(root sessionRoot, file, sourceRootPath, scanRootPath string) (sessionCandidate, bool) {
	var relativePath string
	if filepath.IsAbs(file) {
		logicalFile := filepath.Clean(file)
		switch {
		case isSessionScopePathInside(root.path, logicalFile):
			relativePath = sessionScopeRelativePath(root.path, logicalFile)
		case isSessionScopePathInside(scanRootPath, logicalFile):
			relativePath = sessionScopeRelativePath(scanRootPath, logicalFile)
		default:
			return sessionCandidate{}, false
		}
	} else {
		absoluteFile := filepath.Join(scanRootPath, filepath.FromSlash(file))
		if !isSessionScopePathInside(scanRootPath, absoluteFile) {
			return sessionCandidate{}, false
		}
		relativePath = sessionScopeRelativePath(scanRootPath, absoluteFile)
	}
	if relativePath == "" || filepath.IsAbs(relativePath) {
		return sessionCandidate{}, false
	}
	absoluteFile := filepath.Join(scanRootPath, filepath.FromSlash(relativePath))
	sourceFile := filepath.Join(sourceRootPath, filepath.FromSlash(relativePath))
	if root.isSymlink {
		// An explicitly approved root symlink is read through its resolved
		// target; keep that physical path as the cache/fingerprint identity
		// too, because lstat on the configured symlink is refused.
		sourceFile = absoluteFile
	}
	return sessionCandidate{
		root:         root,
		homeIndex:    root.homeIndex,
		file:         absoluteFile,
		sourceFile:   sourceFile,
		relativePath: relativePath,
	}, true
}

func sessionScopeRelativePath(root, file string) string {
	relative, err := filepath.Rel(root, file)
	if err != nil {
		return ""
	}
	if relative == "." {
		return ""
	}
	return sessionwalk.NormalizeRelativePath(relative)
}

func compareSessionCandidates(left, right sessionCandidate) int {
	if difference := sessionRootPriority(left.root) - sessionRootPriority(right.root); difference != 0 {
		return difference
	}
	return strings.Compare(left.relativePath, right.relativePath)
}

func sessionRootPriority(root sessionRoot) int {
	if root.name == "sessions" {
		return 0
	}
	return 1
}

// isSessionScopePathInside ports isPathInside.
func isSessionScopePathInside(parent, child string) bool {
	relative, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return !filepath.IsAbs(relative) &&
		relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func (runner *scopeRunner) createEmptyScope(homeCount int) (*SessionScope, error) {
	codexHomes := make([]string, 0, homeCount)
	for index := 0; index < homeCount; index++ {
		codexHome, err := os.MkdirTemp("", "tokenboard-codex-home-")
		if err != nil {
			removeSessionScopeHomes(codexHomes)
			return nil, err
		}
		for _, name := range codexSessionRootNames {
			if err := os.MkdirAll(filepath.Join(codexHome, name), 0o777); err != nil {
				removeSessionScopeHomes(append(codexHomes, codexHome))
				return nil, err
			}
		}
		codexHomes = append(codexHomes, codexHome)
	}
	for _, codexHome := range codexHomes {
		if strings.Contains(codexHome, ",") {
			removeSessionScopeHomes(codexHomes)
			return nil, errors.New(
				"Temporary Codex session scope path contains a comma and cannot be serialized as CODEX_HOME")
		}
	}
	scope := &SessionScope{
		CodexHome:                   strings.Join(codexHomes, ","),
		CodexHomes:                  codexHomes,
		SourceFiles:                 map[string]string{},
		SourceFileHomeIndexes:       map[string]int{},
		SourceFileFingerprints:      map[string]CodexSessionFileFingerprint{},
		ProjectedSourceFiles:        map[string]bool{},
		ProjectedSourceFilePrefixes: map[string]CodexSessionFilePrefixFingerprint{},
	}
	scope.cleanup = func() error {
		var failures []error
		for _, codexHome := range codexHomes {
			if err := os.RemoveAll(codexHome); err != nil {
				failures = append(failures, err)
			}
		}
		return errors.Join(failures...)
	}
	return scope, nil
}

func removeSessionScopeHomes(codexHomes []string) {
	for _, codexHome := range codexHomes {
		_ = os.RemoveAll(codexHome)
	}
}

func int64Pointer(value int64) *int64 {
	return &value
}

func scopePlural(count int) string {
	if count == 1 {
		return ""
	}
	return "s"
}
