// Package sessioncursor reads and writes the collector's cursor JSON v1
// state files. The format is shared with the TypeScript collector
// (packages/collector/src/providers/session-cursor-store.ts): during the
// per-source migration either implementation may write a cursor the other
// must read back without semantic drift, so this file mirrors that
// validator's rules field by field.
//
// Fields Go does not interpret yet are carried as raw JSON and written back
// verbatim. A Go write must never delete state a newer TypeScript collector
// stored, and a corrupt cursor must fail loudly — silently resetting it would
// trigger a full rescan and re-upload.
package sessioncursor

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/renameatomic"
)

// Snapshot is the cursor-carried projection of a usage snapshot: everything
// except collectedAt, plus the pending-correction marker.
type Snapshot struct {
	Source                     string  `json:"source"`
	UsageDate                  string  `json:"usageDate"`
	Timezone                   string  `json:"timezone"`
	Model                      string  `json:"model"`
	InputTokens                float64 `json:"inputTokens"`
	OutputTokens               float64 `json:"outputTokens"`
	CacheCreationTokens        float64 `json:"cacheCreationTokens"`
	CacheReadTokens            float64 `json:"cacheReadTokens"`
	TotalTokens                float64 `json:"totalTokens"`
	CostUSD                    float64 `json:"costUsd"`
	SessionCount               float64 `json:"sessionCount"`
	CodexContextPricingPending bool    `json:"codexContextPricingPending,omitempty"`
}

// Entry is one tracked session file, or one synthetic key for the Antigravity
// sources. Booleans that are optional in the format are pointers so an absent
// field stays absent through a round trip.
//
// Known boundary: unmodelled fields *inside* an entry or snapshot are dropped
// on write (only top-level unknown fields are preserved, via State.extra).
// Safe today because the cursor writer only ever stores the stripCollectedAt
// projection plus the fields modelled here; if a future TypeScript collector
// adds an entry-level field, this struct must gain it too.
type Entry struct {
	Size              float64    `json:"size"`
	MtimeMs           float64    `json:"mtimeMs"`
	SHA256            string     `json:"sha256"`
	ContentHashAlgo   string     `json:"contentHashAlgo,omitempty"`
	EndsWithNewline   *bool      `json:"endsWithNewline,omitempty"`
	Snapshots         []Snapshot `json:"snapshots"`
	MissingCost       bool       `json:"missingCost"`
	PendingUpload     *bool      `json:"pendingUpload,omitempty"`
	CompactedIdentity *bool      `json:"compactedIdentity,omitempty"`
	StatuslineClaimed *bool      `json:"statuslineClaimed,omitempty"`
	AntigravityOrigin string     `json:"antigravityOrigin,omitempty"`
	UpdatedAt         string     `json:"updatedAt"`
}

// State is a whole cursor file. Scalar top-level fields Go does not model yet
// live in Extra and are re-emitted unchanged.
type State struct {
	Version int
	Source  string
	Files   map[string]Entry

	extra map[string]json.RawMessage
}

// Extra returns a copy of the unmodelled top-level fields.
func (s State) Extra() map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(s.extra))
	for k, v := range s.extra {
		out[k] = v
	}
	return out
}

// SetExtra stores an unmodelled top-level field.
func (s *State) SetExtra(key string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if s.extra == nil {
		s.extra = map[string]json.RawMessage{}
	}
	s.extra[key] = encoded
	return nil
}

// ExtraValue returns one unmodelled top-level field verbatim.
func (s State) ExtraValue(key string) (json.RawMessage, bool) {
	value, ok := s.extra[key]
	return value, ok
}

// DeleteExtra removes one unmodelled top-level field. Removing a field that
// is absent is not an error: a source deletes state it may never have written.
func (s *State) DeleteExtra(key string) {
	delete(s.extra, key)
}

// Read parses and validates a cursor file. A missing file yields an empty
// state, matching the TypeScript collector; corrupt JSON or a failed
// validation is an error.
func Read(path, source string) (State, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return NewState(source), nil
		}
		return State{}, fmt.Errorf("read cursor: %w", err)
	}
	state, err := parse(data, source)
	if err != nil {
		return State{}, fmt.Errorf("invalid cursor %s: %w", path, err)
	}
	return state, nil
}

// Write serializes the state the way the TypeScript collector does: two-space
// indent, trailing newline, 0600 file mode inside a 0700 directory, atomic
// rename over the destination.
func Write(path string, state State) error {
	if state.Version != 1 {
		return fmt.Errorf("cursor version must be 1, got %d", state.Version)
	}
	payload, err := marshal(state)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	// The temp name carries a random suffix like the TS writer
	// (`${path}.tmp-${pid}-${hex}`): pid and clock alone can collide when a
	// pid is recycled, and two writers sharing a temp name would corrupt
	// each other's half-written file.
	tmp := fmt.Sprintf("%s.tmp-go-%d-%s", path, os.Getpid(), randomHex(8))
	if err := os.WriteFile(tmp, append(payload, '\n'), 0o600); err != nil {
		return err
	}
	if err := renameatomic.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// NewState returns the empty cursor the TypeScript collector would have
// written for a source with no history yet.
func NewState(source string) State {
	return State{Version: 1, Source: source, Files: map[string]Entry{}, extra: map[string]json.RawMessage{}}
}

// knownTopLevel are the keys parsed into typed fields; everything else is
// preserved verbatim so a future field survives a Go round trip.
var knownTopLevel = map[string]bool{"version": true, "source": true, "files": true}

func parse(data []byte, source string) (State, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return State{}, fmt.Errorf("not a JSON object: %w", err)
	}

	var version int
	if err := decode(raw["version"], &version); err != nil || version != 1 {
		return State{}, fmt.Errorf("version must be 1")
	}
	var parsedSource string
	if err := decode(raw["source"], &parsedSource); err != nil || parsedSource != source {
		return State{}, fmt.Errorf("source mismatch: cursor says %q, want %q", parsedSource, source)
	}

	state := NewState(source)
	for key, value := range raw {
		if knownTopLevel[key] {
			continue
		}
		if err := validateTopLevel(key, value); err != nil {
			return State{}, err
		}
		state.extra[key] = value
	}

	filesRaw, ok := raw["files"]
	if !ok || string(filesRaw) == "null" {
		// TS rejects a null files map loudly (`files !== null` check); Go must
		// not silently treat it as empty — that would hide corruption and
		// trigger a full rescan on overwrite.
		return State{}, fmt.Errorf("files is required")
	}
	var files map[string]json.RawMessage
	if err := json.Unmarshal(filesRaw, &files); err != nil {
		return State{}, fmt.Errorf("files must be an object")
	}
	state.Files = make(map[string]Entry, len(files))
	for key, entryRaw := range files {
		if !isValidCursorKey(key) {
			return State{}, fmt.Errorf("files: invalid key %q", key)
		}
		entry, err := parseEntry(entryRaw)
		if err != nil {
			return State{}, fmt.Errorf("files[%q]: %w", key, err)
		}
		state.Files[key] = entry
	}
	return state, nil
}

// maxSafeInteger is Number.MAX_SAFE_INTEGER: the TS validator uses
// Number.isSafeInteger, which rejects anything beyond it.
const maxSafeInteger = 1<<53 - 1

var (
	sha256Pattern         = regexp.MustCompile(`^[a-f0-9]{64}$`)
	kebabKindPattern      = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	usageDatePattern      = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	scanGenerationPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
)

// isSafeInteger mirrors Number.isSafeInteger.
func isSafeInteger(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value == math.Trunc(value) &&
		math.Abs(value) <= maxSafeInteger
}

func isFiniteNumber(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

// validateTopLevel mirrors the TypeScript validator's per-field rules for the
// fields Go does not model. A field both sides know must never bypass
// validation just because Go stores it opaquely.
func validateTopLevel(key string, value json.RawMessage) error {
	switch key {
	case "codexHookProfileHash", "lastScanPrefixSha256":
		var s string
		if err := decode(value, &s); err != nil || !sha256Pattern.MatchString(s) {
			return fmt.Errorf("%s must be a sha256 hex digest", key)
		}
	case "lastScanHighWaterMs":
		// TS isFiniteTimestampMs requires >= 0 as well as finite.
		var n float64
		if err := decode(value, &n); err != nil || !isFiniteNumber(n) || n < 0 {
			return fmt.Errorf("%s must be a finite non-negative number", key)
		}
	case "lastScanOffsetBytes":
		var n float64
		if err := decode(value, &n); err != nil || !isSafeInteger(n) || n < 0 {
			return fmt.Errorf("%s must be a non-negative safe integer", key)
		}
	case "lastScanGeneration":
		// TS: /^[a-f0-9]{32}$/, not an arbitrary slug.
		var s string
		if err := decode(value, &s); err != nil || !scanGenerationPattern.MatchString(s) {
			return fmt.Errorf("%s must be a 32-character lowercase hex string", key)
		}
	case "pendingSnapshotRetryCursor":
		var s string
		if err := decode(value, &s); err != nil || utf16Length(s) > 4096 {
			return fmt.Errorf("%s must be a string of at most 4096 UTF-16 code units", key)
		}
	case "antigravityHistoryReplayReady", "antigravityStatuslineReplayReady",
		"antigravityHistoryReplayCompacted", "antigravityStatuslineReplayCompacted",
		"antigravityCliHistoryComplete", "antigravityCliHistoryCompacted":
		var b bool
		if err := decode(value, &b); err != nil || !b {
			return fmt.Errorf("%s must be true when present", key)
		}
	case "antigravityCliHistoryCompactedThroughDate":
		var s string
		if err := decode(value, &s); err != nil || !usageDatePattern.MatchString(s) {
			return fmt.Errorf("%s must be a YYYY-MM-DD date", key)
		}
	case "antigravityCliMeteringVersion":
		var n float64
		if err := decode(value, &n); err != nil || !isSafeInteger(n) || n < 1 {
			return fmt.Errorf("%s must be a safe integer of at least 1", key)
		}
	case "antigravityDbFileScan", "antigravityCascadeFileScan":
		return validateAntigravityFileScan(key, value)
	case "antigravityHistoryAliasMtimes":
		return validateAntigravityAliasMtimes(key, value)
	}
	return nil
}

// validateAntigravityFileScan mirrors isValidAntigravityFileScanState: a safe
// non-negative nextSequence, and a files map keyed by sha256 whose entries
// carry finite non-negative mtime/size, a boolean hasDatabaseFile, and a safe
// non-negative checkedSequence.
func validateAntigravityFileScan(key string, value json.RawMessage) error {
	var shape struct {
		NextSequence *float64                   `json:"nextSequence"`
		Files        map[string]json.RawMessage `json:"files"`
	}
	if err := json.Unmarshal(value, &shape); err != nil {
		return fmt.Errorf("%s must be an object", key)
	}
	if shape.NextSequence == nil || !isSafeInteger(*shape.NextSequence) || *shape.NextSequence < 0 {
		return fmt.Errorf("%s.nextSequence must be a non-negative safe integer", key)
	}
	if shape.Files == nil {
		return fmt.Errorf("%s.files must be an object", key)
	}
	for fileKey, entryRaw := range shape.Files {
		if !sha256Pattern.MatchString(fileKey) {
			return fmt.Errorf("%s.files key %q must be a sha256 hex digest", key, fileKey)
		}
		var entry struct {
			MtimeMs         *float64 `json:"mtimeMs"`
			Size            *float64 `json:"size"`
			HasDatabaseFile *bool    `json:"hasDatabaseFile"`
			CheckedSequence *float64 `json:"checkedSequence"`
		}
		if err := json.Unmarshal(entryRaw, &entry); err != nil {
			return fmt.Errorf("%s.files[%q] must be an object", key, fileKey)
		}
		if entry.MtimeMs == nil || !isFiniteNumber(*entry.MtimeMs) || *entry.MtimeMs < 0 ||
			entry.Size == nil || !isFiniteNumber(*entry.Size) || *entry.Size < 0 ||
			entry.HasDatabaseFile == nil ||
			entry.CheckedSequence == nil || !isSafeInteger(*entry.CheckedSequence) || *entry.CheckedSequence < 0 {
			return fmt.Errorf("%s.files[%q] has an invalid entry shape", key, fileKey)
		}
	}
	return nil
}

// validateAntigravityAliasMtimes mirrors isValidAntigravityHistoryAliasMtimes:
// sha256 keys, each a non-empty-typed array of finite numbers.
func validateAntigravityAliasMtimes(key string, value json.RawMessage) error {
	var shape map[string][]float64
	if err := json.Unmarshal(value, &shape); err != nil {
		return fmt.Errorf("%s must be an object of number arrays", key)
	}
	if shape == nil {
		return fmt.Errorf("%s must not be null", key)
	}
	for aliasKey, mtimes := range shape {
		if !sha256Pattern.MatchString(aliasKey) {
			return fmt.Errorf("%s key %q must be a sha256 hex digest", key, aliasKey)
		}
		if mtimes == nil {
			return fmt.Errorf("%s[%q] must be an array of numbers", key, aliasKey)
		}
		for _, mtime := range mtimes {
			if !isFiniteNumber(mtime) {
				return fmt.Errorf("%s[%q] must contain only finite numbers", key, aliasKey)
			}
		}
	}
	return nil
}

func parseEntry(raw json.RawMessage) (Entry, error) {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil || probe == nil {
		return Entry{}, fmt.Errorf("must be an object")
	}
	// Required fields, mirroring the TS validator's typeof checks: a missing
	// key and an explicit null are equally invalid (json.Unmarshal alone
	// would silently map null to the zero value).
	for _, required := range []string{"size", "mtimeMs", "sha256", "snapshots", "missingCost", "updatedAt"} {
		value, ok := probe[required]
		if !ok || isJSONNull(value) {
			return Entry{}, fmt.Errorf("%s is required", required)
		}
	}
	// Optional fields reject null for the same reason: the TS validator's
	// `undefined || typeof ...` guards treat null as a type violation.
	for _, optional := range []string{"contentHashAlgo", "endsWithNewline", "pendingUpload", "compactedIdentity", "statuslineClaimed", "antigravityOrigin"} {
		if value, ok := probe[optional]; ok && isJSONNull(value) {
			return Entry{}, fmt.Errorf("%s must not be null", optional)
		}
	}
	// The true-only markers: present means literally true, never false.
	for _, trueOnly := range []string{"compactedIdentity", "statuslineClaimed"} {
		if value, ok := probe[trueOnly]; ok {
			var marker bool
			if err := json.Unmarshal(value, &marker); err != nil || !marker {
				return Entry{}, fmt.Errorf("%s must be true when present", trueOnly)
			}
		}
	}
	var entry Entry
	if err := json.Unmarshal(raw, &entry); err != nil {
		return Entry{}, err
	}
	if !isFiniteNumber(entry.Size) || !isFiniteNumber(entry.MtimeMs) {
		return Entry{}, fmt.Errorf("size and mtimeMs must be finite numbers")
	}
	// TS only checks `typeof candidate.sha256 === 'string'`: the digest may be a
	// blake2b512 content hash (128 hex) when contentHashAlgo says so, so a
	// 64-hex sha256 pattern here would reject valid cursors. The required-field
	// loop above enforces presence and json.Unmarshal enforces the string type.
	switch entry.AntigravityOrigin {
	case "", "database", "language-server":
	default:
		return Entry{}, fmt.Errorf("antigravityOrigin must be database or language-server")
	}
	snapshots, err := parseSnapshots(probe["snapshots"])
	if err != nil {
		return Entry{}, err
	}
	entry.Snapshots = snapshots
	return entry, nil
}

// parseSnapshots validates the snapshot array against the TS
// isValidCursorSnapshot rules: every string and counter is required and
// non-null, and codexContextPricingPending is a true-only marker.
func parseSnapshots(raw json.RawMessage) ([]Snapshot, error) {
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, fmt.Errorf("snapshots must be an array")
	}
	snapshots := make([]Snapshot, 0, len(items))
	for index, item := range items {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(item, &fields); err != nil || fields == nil {
			return nil, fmt.Errorf("snapshots[%d] must be an object", index)
		}
		for _, required := range []string{
			"source", "usageDate", "timezone", "model",
			"inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens",
			"totalTokens", "costUsd", "sessionCount",
		} {
			value, ok := fields[required]
			if !ok || isJSONNull(value) {
				return nil, fmt.Errorf("snapshots[%d].%s is required", index, required)
			}
		}
		if value, ok := fields["codexContextPricingPending"]; ok {
			var pending bool
			if err := json.Unmarshal(value, &pending); err != nil || !pending {
				return nil, fmt.Errorf("snapshots[%d].codexContextPricingPending must be true when present", index)
			}
		}
		var snapshot Snapshot
		if err := json.Unmarshal(item, &snapshot); err != nil {
			return nil, fmt.Errorf("snapshots[%d]: %w", index, err)
		}
		// TS isValidCursorSnapshot also requires the source to be one of the
		// usage sources; a cursor entry with an unknown source is corruption.
		if !contract.IsValidSource(snapshot.Source) {
			return nil, fmt.Errorf("snapshots[%d].source %q is not a usage source", index, snapshot.Source)
		}
		for _, check := range []struct {
			name  string
			value float64
		}{
			{"inputTokens", snapshot.InputTokens},
			{"outputTokens", snapshot.OutputTokens},
			{"cacheCreationTokens", snapshot.CacheCreationTokens},
			{"cacheReadTokens", snapshot.CacheReadTokens},
			{"totalTokens", snapshot.TotalTokens},
			{"costUsd", snapshot.CostUSD},
			{"sessionCount", snapshot.SessionCount},
		} {
			if !isFiniteNumber(check.value) {
				return nil, fmt.Errorf("snapshots[%d].%s must be a finite number", index, check.name)
			}
		}
		snapshots = append(snapshots, snapshot)
	}
	return snapshots, nil
}

// isJSONNull reports whether a raw JSON value is the literal null. Without
// this check, encoding/json maps null to the zero value with no error and
// the entry would pass validation the TS side rejects.
func isJSONNull(raw json.RawMessage) bool {
	return string(bytes.TrimSpace(raw)) == "null"
}

// isValidCursorKey mirrors the TypeScript rule: either a relative path with
// no empty or ".." segments, or a synthetic `kind\0part...` identifier whose
// kind is kebab-case and whose parts cannot escape a path. A model name may
// legitimately contain "/" (org/model), so only escaping shapes are rejected.
func isValidCursorKey(key string) bool {
	separator := strings.Index(key, "\x00")
	if separator == 0 {
		return false
	}
	if separator > 0 {
		if !kebabKindPattern.MatchString(key[:separator]) {
			return false
		}
		for _, part := range strings.Split(key[separator+1:], "\x00") {
			if strings.HasPrefix(part, "/") {
				return false
			}
			for _, segment := range strings.Split(part, "/") {
				if segment == "." || segment == ".." {
					return false
				}
			}
		}
		return true
	}
	if key == "" {
		return false
	}
	for _, segment := range strings.Split(key, "/") {
		if segment == "" || segment == ".." {
			return false
		}
	}
	return true
}

func decode(raw json.RawMessage, target any) error {
	if len(raw) == 0 {
		return fmt.Errorf("missing")
	}
	return json.Unmarshal(raw, target)
}

// marshal emits the cursor as JSON. Key order differs from the TypeScript
// writer (Go maps sort), which both sides tolerate: each reads by key.
func marshal(state State) ([]byte, error) {
	document := make(map[string]json.RawMessage, len(state.extra)+3)
	for key, value := range state.extra {
		document[key] = value
	}
	version, err := json.Marshal(state.Version)
	if err != nil {
		return nil, err
	}
	source, err := json.Marshal(state.Source)
	if err != nil {
		return nil, err
	}
	files, err := json.Marshal(state.Files)
	if err != nil {
		return nil, err
	}
	document["version"] = version
	document["source"] = source
	document["files"] = files
	return json.MarshalIndent(document, "", "  ")
}

// FileName mirrors the TS cursorFileName: the per-source cursor file name,
// suffixed with the sha256 of the scope (the endpoint origin, or the Codex
// profile home) so a machine pointed at two servers — or two Codex homes —
// never shares one cursor. An empty scope names the unscooped legacy file.
func FileName(source contract.Source, scope string) string {
	base := string(source) + "-cursor.json"
	if source == contract.SourceClaudeCode {
		base = "claude-code-cursor.json"
	}
	if scope == "" {
		return base
	}
	sum := sha256.Sum256([]byte(scope))
	label := "server"
	if source == contract.SourceCodex {
		label = "profile"
	}
	return strings.TrimSuffix(base, ".json") + "." + label + "-" + hex.EncodeToString(sum[:]) + ".json"
}

// utf16Length counts UTF-16 code units, which is what JavaScript's
// String#length measures. A byte count would reject CJK-heavy strings the TS
// side accepts.
func utf16Length(s string) int {
	return len(utf16.Encode([]rune(s)))
}

// randomHex returns n random bytes as hex, for temp-name uniqueness.
func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		// A weak suffix still separates names; only a same-nanosecond
		// collision could match the clock alone.
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}
