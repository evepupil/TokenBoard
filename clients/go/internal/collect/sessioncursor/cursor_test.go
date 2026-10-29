package sessioncursor

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionfile"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// A realistic cursor produced by the TS collector (shape taken from a live
// antigravity-cli cursor; content trimmed). Go must parse it, re-serialize
// it, and lose nothing the TS validator would have kept.
const tsCursorFixture = `{
  "version": 1,
  "source": "antigravity-cli",
  "antigravityCliMeteringVersion": 3,
  "antigravityCliHistoryComplete": true,
  "antigravityCliHistoryCompacted": true,
  "antigravityCliHistoryCompactedThroughDate": "2026-06-20",
  "antigravityDbFileScan": {"nextSequence": 65, "files": {"c71d62777a159cec520e4398361086231fe461e27a6605757f852b8cef5c8ffc": {"mtimeMs": 1785452424196.7156, "size": 208896, "hasDatabaseFile": true, "checkedSequence": 64}}},
  "files": {
    "aggregate 3c57847bb04f5600b4dadb22ffc57f564ca44b8f1c6b901969": {
      "size": 1234,
      "mtimeMs": 1751430000000.5,
      "sha256": "3c57847bb04f5600b4dadb22ffc57f564ca44b8f1c6b90196900112233445566",
      "snapshots": [
        {
          "source": "antigravity-cli",
          "usageDate": "2026-07-02",
          "timezone": "Asia/Shanghai",
          "model": "claude-sonnet-4-6",
          "inputTokens": 266941,
          "outputTokens": 29026,
          "cacheCreationTokens": 0,
          "cacheReadTokens": 1694106,
          "totalTokens": 1990073,
          "costUsd": 0,
          "sessionCount": 4
        }
      ],
      "missingCost": false,
      "pendingUpload": true,
      "updatedAt": "2026-07-02T10:00:00.000Z"
    },
    "statusline-scan since:2026-07-22@Asia%2FShanghai": {
      "size": 10,
      "mtimeMs": 1753200000000,
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "contentHashAlgo": "v2-lines",
      "snapshots": [],
      "missingCost": true,
      "statuslineClaimed": true,
      "updatedAt": "2026-07-22T00:00:00.000Z"
    }
  }
}`

func writeTemp(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cursor.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestReadTSCursorFixture(t *testing.T) {
	path := writeTemp(t, tsCursorFixture)
	state, err := Read(path, "antigravity-cli")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if state.Version != 1 || state.Source != "antigravity-cli" || len(state.Files) != 2 {
		t.Fatalf("unexpected state: %+v", state)
	}
	aggregate := state.Files["aggregate 3c57847bb04f5600b4dadb22ffc57f564ca44b8f1c6b901969"]
	if len(aggregate.Snapshots) != 1 || aggregate.Snapshots[0].TotalTokens != 1990073 {
		t.Fatalf("snapshot not carried: %+v", aggregate)
	}
	if aggregate.PendingUpload == nil || !*aggregate.PendingUpload {
		t.Error("pendingUpload lost")
	}
	scan := state.Files["statusline-scan since:2026-07-22@Asia%2FShanghai"]
	if scan.StatuslineClaimed == nil || !*scan.StatuslineClaimed {
		t.Error("statuslineClaimed lost")
	}
	if scan.ContentHashAlgo != "v2-lines" {
		t.Error("contentHashAlgo lost")
	}
}

func TestRoundTripPreservesUnknownAndValidatedFields(t *testing.T) {
	path := writeTemp(t, tsCursorFixture)
	state, err := Read(path, "antigravity-cli")
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "rewritten.json")
	if err := Write(out, state); err != nil {
		t.Fatal(err)
	}

	orig := mustJSON(t, tsCursorFixture)
	rewritten := mustFileJSON(t, out)
	// Semantic compare on the parsed object: whitespace/ordering may differ,
	// values may not.
	if !reflect.DeepEqual(stripNewline(orig), rewritten) {
		t.Errorf("round-trip lost data\norig:  %v\nre:    %v", orig, rewritten)
	}
}

// The rewritten cursor must still validate under the TS collector's rules.
// This test encodes the critical invariants directly rather than running
// node: the fixture fields were chosen to exercise them.
func TestRewrittenCursorKeepsTSVisibleInvariants(t *testing.T) {
	path := writeTemp(t, tsCursorFixture)
	state, _ := Read(path, "antigravity-cli")
	out := filepath.Join(t.TempDir(), "rewritten.json")
	if err := Write(out, state); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, invariant := range []string{
		`"version": 1`,
		`"antigravityCliMeteringVersion": 3`,
		`"codexContextPricingPending"`, // absent in fixture — absence preserved
	} {
		if strings.HasPrefix(invariant, `"codexContextPricingPending"`) {
			if strings.Contains(text, invariant) {
				t.Errorf("%s must not appear when unset", invariant)
			}
			continue
		}
		if !strings.Contains(text, invariant) {
			t.Errorf("rewritten cursor lost %s", invariant)
		}
	}
}

func TestReadMissingFileIsEmptyState(t *testing.T) {
	state, err := Read(filepath.Join(t.TempDir(), "absent.json"), "pi")
	if err != nil {
		t.Fatalf("missing cursor must be empty, got %v", err)
	}
	if state.Version != 1 || state.Source != "pi" || state.Files == nil || len(state.Files) != 0 {
		t.Errorf("empty state wrong: %+v", state)
	}
}

func TestRejectInvalidCursors(t *testing.T) {
	cases := map[string]string{
		"version 2":     `{"version":2,"source":"pi","files":{}}`,
		"source drift":  `{"version":1,"source":"codex","files":{}}`,
		"path escape":   `{"version":1,"source":"pi","files":{"a/../b":{"size":1,"mtimeMs":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshots":[],"missingCost":false,"updatedAt":"x"}}}`,
		"absolute part": `{"version":1,"source":"pi","files":{"kind\u0000/db":{"size":1,"mtimeMs":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshots":[],"missingCost":false,"updatedAt":"x"}}}`,
		// A "." segment is legal in the relative-path form (the TS rule only
		// rejects empty and ".." there); it is rejected inside a synthetic
		// key's parts, which the "absolute part" case below covers.
		"dot segment in synthetic part": `{"version":1,"source":"pi","files":{"kind\u0000a/../b":{"size":1,"mtimeMs":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshots":[],"missingCost":false,"updatedAt":"x"}}}`,
		// TS only requires sha256 to be a string (blake2b512 digests are 128
		// hex), so a non-string is the shape it actually rejects.
		"bad sha":      `{"version":1,"source":"pi","files":{"ok.json":{"size":1,"mtimeMs":1,"sha256":7,"snapshots":[],"missingCost":false,"updatedAt":"x"}}}`,
		"corrupt json": `{"version":1,`,
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			path := writeTemp(t, content)
			if _, err := Read(path, "pi"); err == nil {
				t.Errorf("%s: expected rejection", name)
			}
		})
	}
}

func TestValidSyntheticKeys(t *testing.T) {
	// These mirror real keys the TS collector writes; the validator must
	// accept all of them (trailing empty part is legal for db/db-covered).
	valid := []string{
		"db\x00db\x00",
		"db-covered\x00org/model\x00",
		"relative/path/session.jsonl",
		"statusline-scan since:2026-07-22@Asia%2FShanghai",
	}
	for _, key := range valid {
		if !isValidCursorKey(key) {
			t.Errorf("%q should be a valid key", key)
		}
	}
}

func mustJSON(t *testing.T, text string) map[string]any {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func mustFileJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("rewritten cursor is not valid JSON: %v", err)
	}
	return v
}

func stripNewline(v map[string]any) map[string]any {
	// normalize: sort keys via marshal-unmarshal is unnecessary for
	// DeepEqual on maps; this exists as a hook if key-order matters later.
	_ = sort.Strings
	return v
}

// The D-series drifts the review found: Go was looser than the TS validator.
func TestRejectsValuesTSRejects(t *testing.T) {
	valid := `{"version":1,"source":"pi","files":{}}`
	cases := map[string]string{
		"files is null":                 `{"version":1,"source":"pi","files":null}`,
		"unknown snapshot source":       `{"version":1,"source":"pi","files":{"ok.json":{"size":1,"mtimeMs":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshots":[{"source":"bogus","usageDate":"2026-05-09","timezone":"UTC","model":"m","inputTokens":1,"outputTokens":1,"cacheCreationTokens":0,"cacheReadTokens":0,"totalTokens":2,"costUsd":0,"sessionCount":1}],"missingCost":false,"updatedAt":"x"}}}`,
		"negative lastScanHighWaterMs":  `{"version":1,"source":"pi","lastScanHighWaterMs":-5,"files":{}}`,
		"lastScanGeneration not 32-hex": `{"version":1,"source":"pi","lastScanGeneration":"garbage-1","files":{}}`,
		"pendingUpload false is fine":   valid, // positive control below
	}
	for name, content := range cases {
		if name == "pendingUpload false is fine" {
			continue
		}
		t.Run(name, func(t *testing.T) {
			path := writeTemp(t, content)
			if _, err := Read(path, "pi"); err == nil {
				t.Errorf("%s: expected rejection", name)
			}
		})
	}
	if _, err := Read(writeTemp(t, valid), "pi"); err != nil {
		t.Errorf("minimal valid cursor rejected: %v", err)
	}
}

func TestAcceptsLastScanGeneration32Hex(t *testing.T) {
	content := `{"version":1,"source":"pi","lastScanGeneration":"0123456789abcdef0123456789abcdef","files":{}}`
	if _, err := Read(writeTemp(t, content), "pi"); err != nil {
		t.Errorf("32-hex generation rejected: %v", err)
	}
}

// Entry-level nulls and false-valued true-only markers are what the TS
// isValidCursorEntry rejects; encoding/json alone would map null to zero
// values and let the cursor through, silently rewriting data the TS side
// considers corrupt.
func TestRejectsEntryLevelNullsAndFalseMarkers(t *testing.T) {
	entry := func(fields string) string {
		return `{"version":1,"source":"pi","files":{"ok.json":{` + fields + `}}}`
	}
	validFields := `"size":1,"mtimeMs":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshots":[],"missingCost":false,"updatedAt":"x"`
	cases := map[string]string{
		"snapshots is null":       entry(`"size":1,"mtimeMs":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshots":null,"missingCost":false,"updatedAt":"x"`),
		"size is null":            entry(`"size":null,"mtimeMs":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshots":[],"missingCost":false,"updatedAt":"x"`),
		"updatedAt is null":       entry(`"size":1,"mtimeMs":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshots":[],"missingCost":false,"updatedAt":null`),
		"missingCost is null":     entry(`"size":1,"mtimeMs":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshots":[],"missingCost":null,"updatedAt":"x"`),
		"compactedIdentity false": entry(`"size":1,"mtimeMs":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshots":[],"missingCost":false,"updatedAt":"x","compactedIdentity":false`),
		"statuslineClaimed false": entry(`"size":1,"mtimeMs":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshots":[],"missingCost":false,"updatedAt":"x","statuslineClaimed":false`),
		"compactedIdentity null":  entry(`"size":1,"mtimeMs":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshots":[],"missingCost":false,"updatedAt":"x","compactedIdentity":null`),
		"snapshot usageDate null": entry(`"size":1,"mtimeMs":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshots":[{"source":"pi","usageDate":null,"timezone":"UTC","model":"m","inputTokens":1,"outputTokens":1,"cacheCreationTokens":0,"cacheReadTokens":0,"totalTokens":2,"costUsd":0,"sessionCount":1}],"missingCost":false,"updatedAt":"x"`),
		"snapshot pending false":  entry(`"size":1,"mtimeMs":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","snapshots":[{"source":"pi","usageDate":"2026-05-09","timezone":"UTC","model":"m","inputTokens":1,"outputTokens":1,"cacheCreationTokens":0,"cacheReadTokens":0,"totalTokens":2,"costUsd":0,"sessionCount":1,"codexContextPricingPending":false}],"missingCost":false,"updatedAt":"x"`),
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Read(writeTemp(t, content), "pi"); err == nil {
				t.Errorf("%s: expected rejection", name)
			}
		})
	}
	// Positive controls: true markers and absent optionals stay valid.
	for name, content := range map[string]string{
		"minimal entry":         entry(validFields),
		"true markers":          entry(validFields + `,"compactedIdentity":true,"statuslineClaimed":true`),
		"pendingUpload false":   entry(validFields + `,"pendingUpload":false`),
		"pendingUpload true":    entry(validFields + `,"pendingUpload":true`),
		"endsWithNewline false": entry(validFields + `,"endsWithNewline":false`),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Read(writeTemp(t, content), "pi"); err != nil {
				t.Errorf("%s: valid cursor rejected: %v", name, err)
			}
		})
	}
}

// An entry whose file is gone used to be copied back verbatim on every run: one machine's
// cursor reached 15 MB with 31% of its entries pointing at deleted files. When every
// configured root listed successfully, a file the walk did not produce is gone, so the entry
// can be reclaimed. The TS collector makes the same decision on the same signal.
func TestScanReclaimsSettledEntriesWhoseFilesAreGone(t *testing.T) {
	root := t.TempDir()
	sessionsDir := filepath.Join(root, "sessions")
	stateDir := filepath.Join(root, "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	cursorPath := filepath.Join(stateDir, "codex-cursor.json")
	kept := writeSessionFile(t, sessionsDir, "kept.jsonl", `{"type":"session"}`)
	removed := writeSessionFile(t, sessionsDir, "removed.jsonl", `{"type":"session"}`)
	_ = kept

	input := ScanInput{Source: contract.SourceCodex, SessionsDir: sessionsDir, CursorPath: cursorPath}
	first, err := CollectChangedSessionFiles(input)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range first.Files {
		if err := file.ReadLines(func(sessionfile.Line) error { return nil }); err != nil {
			t.Fatal(err)
		}
	}
	if err := first.Commit(contract.SourceCodex); err != nil {
		t.Fatal(err)
	}
	if len(first.Cursor.Files) != 2 {
		t.Fatalf("initial entries = %d, want 2", len(first.Cursor.Files))
	}

	if err := os.Remove(removed); err != nil {
		t.Fatal(err)
	}
	second, err := CollectChangedSessionFiles(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Cursor.Files) != 1 {
		t.Fatalf("entries after reclamation = %v, want only the surviving file", second.Cursor.Files)
	}
	// Reclaiming is a cursor change, so the caller has to write it out.
	if !second.HasCursorCleanup {
		t.Fatal("reclaiming an entry must set HasCursorCleanup")
	}
}

// A root that will not resolve leaves the tree unread rather than empty. Reclaiming there
// would drop every entry and make the next run re-read and re-upload the whole history.
func TestScanKeepsEveryEntryWhenARootCannotBeResolved(t *testing.T) {
	root := t.TempDir()
	sessionsDir := filepath.Join(root, "sessions")
	stateDir := filepath.Join(root, "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	cursorPath := filepath.Join(stateDir, "codex-cursor.json")
	writeSessionFile(t, sessionsDir, "a.jsonl", `{"type":"session"}`)

	input := ScanInput{Source: contract.SourceCodex, SessionsDir: sessionsDir, CursorPath: cursorPath}
	first, err := CollectChangedSessionFiles(input)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range first.Files {
		if err := file.ReadLines(func(sessionfile.Line) error { return nil }); err != nil {
			t.Fatal(err)
		}
	}
	if err := first.Commit(contract.SourceCodex); err != nil {
		t.Fatal(err)
	}

	// Point the scan at a directory that does not exist: Resolve reports !ok and the walk
	// never runs.
	missing := ScanInput{
		Source:      contract.SourceCodex,
		SessionsDir: filepath.Join(root, "gone"),
		CursorPath:  cursorPath,
	}
	second, err := CollectChangedSessionFiles(missing)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Cursor.Files) != 1 {
		t.Fatalf("entries = %v, want the untouched entry preserved", second.Cursor.Files)
	}
}
