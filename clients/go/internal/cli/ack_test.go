package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/upload"
)

// Port of the TS shouldAckCursor contract: the Antigravity sources always
// acknowledge, the session-file sources only in hook mode.

func hookAckFixture(t *testing.T, stateDir string) contract.Snapshot {
	t.Helper()
	snapshot := contract.Snapshot{
		Source:       contract.SourceClaudeCode,
		UsageDate:    "2026-05-22",
		Timezone:     "Asia/Shanghai",
		Model:        "claude-sonnet-4-5",
		InputTokens:  8,
		OutputTokens: 13,
		TotalTokens:  21,
		CollectedAt:  "2026-05-22T10:00:00.000Z",
	}
	writeClaudeAckCursorForSnapshot(t, stateDir, snapshot)
	return snapshot
}

// writeClaudeAckCursorForSnapshot seeds the unscoped claude-code cursor with one
// pending file whose snapshots mirror the given row.
func writeClaudeAckCursorForSnapshot(t *testing.T, stateDir string, snapshot contract.Snapshot) {
	t.Helper()
	pending := true
	cursor := sessioncursor.NewState("claude-code")
	cursor.Files["project-a/session.jsonl"] = sessioncursor.Entry{
		Size:    10,
		MtimeMs: 1,
		SHA256:  "abc",
		Snapshots: []sessioncursor.Snapshot{{
			Source:       "claude-code",
			UsageDate:    snapshot.UsageDate,
			Timezone:     snapshot.Timezone,
			Model:        snapshot.Model,
			InputTokens:  float64(snapshot.InputTokens),
			OutputTokens: float64(snapshot.OutputTokens),
			TotalTokens:  float64(snapshot.TotalTokens),
		}},
		MissingCost:   false,
		PendingUpload: &pending,
		UpdatedAt:     "2026-05-22T10:00:00.000Z",
	}
	cursorPath := filepath.Join(stateDir, sessioncursor.FileName(contract.SourceClaudeCode, ""))
	if err := sessioncursor.Write(cursorPath, cursor); err != nil {
		t.Fatal(err)
	}
}

func readHookAckCursor(t *testing.T, stateDir string) sessioncursor.Entry {
	t.Helper()
	cursor, err := sessioncursor.Read(
		filepath.Join(stateDir, sessioncursor.FileName(contract.SourceClaudeCode, "")), "claude-code")
	if err != nil {
		t.Fatal(err)
	}
	return cursor.Files["project-a/session.jsonl"]
}

func TestAcknowledgeUploadCursorsClearsPendingClaudeEntriesInHookMode(t *testing.T) {
	stateDir := t.TempDir()
	snapshot := hookAckFixture(t, stateDir)
	env := func(key string) string {
		if key == "TOKENBOARD_HOOK_MODE" {
			return "1"
		}
		return ""
	}
	if err := acknowledgeUploadCursors(stateDir, collection{
		collectedSources: []contract.Source{contract.SourceClaudeCode},
		snapshots:        []contract.Snapshot{snapshot},
	}, upload.Result{Delivered: []contract.Snapshot{snapshot}}, Options{}, "", env); err != nil {
		t.Fatal(err)
	}
	entry := readHookAckCursor(t, stateDir)
	if entry.PendingUpload == nil || *entry.PendingUpload {
		t.Errorf("pending upload must be cleared: %+v", entry)
	}
}

// The endpoint origin scopes the *Antigravity* cursors only. The session-file
// sources write the unscoped `claude-code-cursor.json`, and reading a missing
// cursor is not an error — so passing the origin here silently acknowledged
// nothing, and every hook run re-uploaded everything it had already sent.
func TestAcknowledgeUploadCursorsIgnoresTheEndpointScopeForClaudeCode(t *testing.T) {
	stateDir := t.TempDir()
	snapshot := hookAckFixture(t, stateDir)
	env := func(key string) string {
		if key == "TOKENBOARD_HOOK_MODE" {
			return "1"
		}
		return ""
	}
	if err := acknowledgeUploadCursors(stateDir, collection{
		collectedSources: []contract.Source{contract.SourceClaudeCode},
		snapshots:        []contract.Snapshot{snapshot},
	}, upload.Result{Delivered: []contract.Snapshot{snapshot}}, Options{}, "https://tokenboard.example.com", env); err != nil {
		t.Fatal(err)
	}
	entry := readHookAckCursor(t, stateDir)
	if entry.PendingUpload == nil || *entry.PendingUpload {
		t.Errorf("pending upload must be cleared: %+v", entry)
	}
	if _, err := os.Stat(filepath.Join(stateDir,
		sessioncursor.FileName(contract.SourceClaudeCode, "https://tokenboard.example.com"))); err == nil {
		t.Errorf("acknowledgement must not write a scoped claude-code cursor")
	}
}

func TestAcknowledgeUploadCursorsLeavesClaudeEntriesPendingOutsideHookMode(t *testing.T) {
	stateDir := t.TempDir()
	snapshot := hookAckFixture(t, stateDir)
	env := func(string) string { return "" }
	if err := acknowledgeUploadCursors(stateDir, collection{
		collectedSources: []contract.Source{contract.SourceClaudeCode},
		snapshots:        []contract.Snapshot{snapshot},
	}, upload.Result{Delivered: []contract.Snapshot{snapshot}}, Options{}, "", env); err != nil {
		t.Fatal(err)
	}
	entry := readHookAckCursor(t, stateDir)
	if entry.PendingUpload == nil || !*entry.PendingUpload {
		t.Errorf("a range-mode run must not acknowledge the hook cursor: %+v", entry)
	}
}

// An entry whose snapshot was not part of the uploaded groups stays pending:
// acknowledging it would drop usage the server never accepted.
func TestAcknowledgeUploadCursorsKeepsUnacknowledgedEntriesPending(t *testing.T) {
	stateDir := t.TempDir()
	hookAckFixture(t, stateDir)
	env := func(key string) string {
		if key == "TOKENBOARD_HOOK_MODE" {
			return "1"
		}
		return ""
	}
	// The uploaded snapshot belongs to a different day, so it cannot cover the
	// pending entry.
	other := contract.Snapshot{
		Source:       contract.SourceClaudeCode,
		UsageDate:    "2026-05-23",
		Timezone:     "Asia/Shanghai",
		Model:        "claude-sonnet-4-5",
		InputTokens:  8,
		OutputTokens: 13,
		TotalTokens:  21,
		CollectedAt:  "2026-05-23T10:00:00.000Z",
	}
	if err := acknowledgeUploadCursors(stateDir, collection{
		collectedSources: []contract.Source{contract.SourceClaudeCode},
		snapshots:        []contract.Snapshot{other},
	}, upload.Result{Delivered: []contract.Snapshot{other}}, Options{}, "", env); err != nil {
		t.Fatal(err)
	}
	entry := readHookAckCursor(t, stateDir)
	if entry.PendingUpload == nil || !*entry.PendingUpload {
		t.Errorf("unacknowledged entry must stay pending: %+v", entry)
	}
}

// A row the uploader dropped for an out-of-window usageDate never reached the
// server, so its group must not appear in the acknowledgement: clearing the
// entry would make the pending row disappear for good instead of being retried
// once the clock is right again. The uploader reports what it delivered, and
// that — not the collection — is what the acknowledgement reads.
func TestAcknowledgeUploadCursorsSkipsRowsTheUploadDropped(t *testing.T) {
	stateDir := t.TempDir()
	snapshot := hookAckFixture(t, stateDir)
	env := func(key string) string {
		if key == "TOKENBOARD_HOOK_MODE" {
			return "1"
		}
		return ""
	}
	if err := acknowledgeUploadCursors(stateDir, collection{
		collectedSources: []contract.Source{contract.SourceClaudeCode},
		snapshots:        []contract.Snapshot{snapshot},
	}, upload.Result{RejectedUsageDates: 1}, Options{}, "", env); err != nil {
		t.Fatal(err)
	}
	entry := readHookAckCursor(t, stateDir)
	if entry.PendingUpload == nil || !*entry.PendingUpload {
		t.Errorf("a row the upload dropped must stay pending: %+v", entry)
	}
}

// Codex acknowledges per file: only the exact (path, digest) revision the
// upload covered is cleared, and the pending-correction marker goes with it.
func TestAcknowledgeUploadCursorsClearsOnlyAcknowledgedCodexFiles(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")
	home := filepath.Join(root, "codex")
	acknowledgedDigest := strings.Repeat("a", 64)
	otherDigest := strings.Repeat("b", 64)
	writeCodexAckCursor(t, filepath.Join(stateDir, "codex-cursor.json"), map[string]codexAckEntry{
		"2026/05/22/uploaded.jsonl": {digest: acknowledgedDigest, pending: true, pendingPricing: true},
		"2026/05/22/changed.jsonl":  {digest: otherDigest, pending: true},
	})
	env := func(key string) string {
		switch key {
		case "TOKENBOARD_HOOK_MODE":
			return "1"
		case "CODEX_HOME":
			return home
		}
		return ""
	}
	if err := acknowledgeUploadCursors(stateDir, collection{
		collectedSources: []contract.Source{contract.SourceCodex},
		codexAcknowledgement: []collect.CursorScopeFiles{{
			Files: []sessioncursor.AcknowledgedFile{
				{RelativePath: "2026/05/22/uploaded.jsonl", SHA256: acknowledgedDigest},
			},
		}},
	}, upload.Result{Delivered: []contract.Snapshot{codexAckSnapshot()}}, Options{}, "", env); err != nil {
		t.Fatal(err)
	}
	files := readCodexAckCursor(t, filepath.Join(stateDir, "codex-cursor.json"))
	uploaded := files["2026/05/22/uploaded.jsonl"]
	if uploaded.PendingUpload != nil && *uploaded.PendingUpload {
		t.Error("the acknowledged file must be cleared")
	}
	if len(uploaded.Snapshots) != 1 || uploaded.Snapshots[0].CodexContextPricingPending {
		t.Errorf("the pending-correction marker must be cleared: %+v", uploaded.Snapshots)
	}
	changed := files["2026/05/22/changed.jsonl"]
	if changed.PendingUpload == nil || !*changed.PendingUpload {
		t.Error("a file whose digest was not acknowledged must stay pending")
	}
}

// A stale acknowledgement (the file changed after the upload) must not clear
// the newer revision: its bytes never reached the server.
func TestAcknowledgeUploadCursorsKeepsCodexFileWhoseDigestChanged(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")
	home := filepath.Join(root, "codex")
	writeCodexAckCursor(t, filepath.Join(stateDir, "codex-cursor.json"), map[string]codexAckEntry{
		"2026/05/22/session.jsonl": {digest: strings.Repeat("b", 64), pending: true},
	})
	env := func(key string) string {
		switch key {
		case "TOKENBOARD_HOOK_MODE":
			return "1"
		case "CODEX_HOME":
			return home
		}
		return ""
	}
	if err := acknowledgeUploadCursors(stateDir, collection{
		collectedSources: []contract.Source{contract.SourceCodex},
		codexAcknowledgement: []collect.CursorScopeFiles{{
			Files: []sessioncursor.AcknowledgedFile{
				{RelativePath: "2026/05/22/session.jsonl", SHA256: strings.Repeat("a", 64)},
			},
		}},
	}, upload.Result{Delivered: []contract.Snapshot{codexAckSnapshot()}}, Options{}, "", env); err != nil {
		t.Fatal(err)
	}
	entry := readCodexAckCursor(t, filepath.Join(stateDir, "codex-cursor.json"))["2026/05/22/session.jsonl"]
	if entry.PendingUpload == nil || !*entry.PendingUpload {
		t.Error("the unacknowledged revision must stay pending")
	}
}

// The file list is metadata on the snapshots that uploaded. When the upload
// delivered no Codex row — every row's usageDate fell outside the server's
// window — there is nothing carrying that metadata, and the pending file must
// keep its flag: clearing it retires a file whose bytes never reached the
// server. This is the same fallback the TS side takes when
// readCodexHookAcknowledgement sees no tagged snapshot.
func TestAcknowledgeUploadCursorsKeepsCodexFileWhenNothingWasDelivered(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")
	home := filepath.Join(root, "codex")
	writeCodexAckCursor(t, filepath.Join(stateDir, "codex-cursor.json"), map[string]codexAckEntry{
		"2026/05/22/session.jsonl": {digest: strings.Repeat("a", 64), pending: true},
	})
	env := func(key string) string {
		switch key {
		case "TOKENBOARD_HOOK_MODE":
			return "1"
		case "CODEX_HOME":
			return home
		}
		return ""
	}
	if err := acknowledgeUploadCursors(stateDir, collection{
		collectedSources: []contract.Source{contract.SourceCodex},
		codexAcknowledgement: []collect.CursorScopeFiles{{
			Files: []sessioncursor.AcknowledgedFile{
				{RelativePath: "2026/05/22/session.jsonl", SHA256: strings.Repeat("a", 64)},
			},
		}},
	}, upload.Result{RejectedUsageDates: 1}, Options{}, "", env); err != nil {
		t.Fatal(err)
	}
	entry := readCodexAckCursor(t, filepath.Join(stateDir, "codex-cursor.json"))["2026/05/22/session.jsonl"]
	if entry.PendingUpload == nil || !*entry.PendingUpload {
		t.Error("a file whose rows were all dropped must stay pending")
	}
}

// With profile cursors in play, every scope is acknowledged, including the
// legacy one, and each profile only clears its own files.
func TestAcknowledgeUploadCursorsAcknowledgesEveryCodexProfileScope(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")
	firstHome := filepath.Join(root, "first")
	secondHome := filepath.Join(root, "second")
	firstDigest := strings.Repeat("a", 64)
	secondDigest := strings.Repeat("c", 64)
	writeCodexAckCursor(t, filepath.Join(stateDir, codexHookProfileCursorName(firstHome)), map[string]codexAckEntry{
		"2026/05/22/session.jsonl": {digest: firstDigest, pending: true},
	})
	writeCodexAckCursor(t, filepath.Join(stateDir, codexHookProfileCursorName(secondHome)), map[string]codexAckEntry{
		"2026/05/22/session.jsonl": {digest: secondDigest, pending: true},
	})
	env := func(key string) string {
		switch key {
		case "TOKENBOARD_HOOK_MODE":
			return "1"
		case "TOKENBOARD_CODEX_HOMES_JSON":
			return encodeJSONHomes(firstHome, secondHome)
		}
		return ""
	}
	if err := acknowledgeUploadCursors(stateDir, collection{
		collectedSources: []contract.Source{contract.SourceCodex},
		codexAcknowledgement: []collect.CursorScopeFiles{
			{CursorScope: firstHome, Files: []sessioncursor.AcknowledgedFile{
				{RelativePath: "2026/05/22/session.jsonl", SHA256: firstDigest},
			}},
			{CursorScope: secondHome, Files: []sessioncursor.AcknowledgedFile{
				{RelativePath: "2026/05/22/session.jsonl", SHA256: secondDigest},
			}},
		},
	}, upload.Result{Delivered: []contract.Snapshot{codexAckSnapshot()}}, Options{}, "", env); err != nil {
		t.Fatal(err)
	}
	for _, home := range []string{firstHome, secondHome} {
		entry := readCodexAckCursor(t, filepath.Join(stateDir, codexHookProfileCursorName(home)))["2026/05/22/session.jsonl"]
		if entry.PendingUpload != nil && *entry.PendingUpload {
			t.Errorf("%s was not acknowledged", home)
		}
	}
}

// A row the uploader dropped only for being too far in the future must keep its
// file queued. The per-file acknowledgement cannot tell which file that row came
// from, so this run falls back to the group rule — and the file still carries the
// future row's group, which the delivered snapshot does not cover.
func TestAcknowledgeUploadCursorsKeepsCodexFileHoldingATooFarFutureRow(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "state")
	home := filepath.Join(root, "codex")
	digest := strings.Repeat("a", 64)
	writeCodexAckCursor(t, filepath.Join(stateDir, "codex-cursor.json"),
		map[string]codexAckEntry{
			"2026/05/22/session.jsonl": {digest: digest, pending: true, date: "2999-01-01"},
		})
	env := func(key string) string {
		switch key {
		case "TOKENBOARD_HOOK_MODE":
			return "1"
		case "CODEX_HOME":
			return home
		}
		return ""
	}
	future := codexAckSnapshot()
	future.UsageDate = "2999-01-01"
	if err := acknowledgeUploadCursors(stateDir, collection{
		collectedSources: []contract.Source{contract.SourceCodex},
		codexAcknowledgement: []collect.CursorScopeFiles{{
			Files: []sessioncursor.AcknowledgedFile{
				{RelativePath: "2026/05/22/session.jsonl", SHA256: digest},
			},
		}},
	}, upload.Result{
		Delivered:          []contract.Snapshot{codexAckSnapshot()},
		Rejected:           []upload.RejectedSnapshot{{Snapshot: future, Issue: "too-far-future"}},
		RejectedUsageDates: 1,
	}, Options{}, "", env); err != nil {
		t.Fatal(err)
	}
	entry := readCodexAckCursor(t, filepath.Join(stateDir, "codex-cursor.json"))["2026/05/22/session.jsonl"]
	if entry.PendingUpload == nil || !*entry.PendingUpload {
		t.Error("a file holding a too-far-future row must stay pending for a later retry")
	}
}

// A row whose usageDate can never be accepted (invalid, or before the history
// window) is not retryable state: leaving it pending would rescan its file and
// repeat the warning on every run. Acknowledging it loses nothing that could
// ever have been uploaded.
func TestAcknowledgeUploadCursorsAcknowledgesAPermanentlyUndeliverableRow(t *testing.T) {
	stateDir := t.TempDir()
	snapshot := contract.Snapshot{
		Source:       contract.SourceClaudeCode,
		UsageDate:    "2020-01-01",
		Timezone:     "Asia/Shanghai",
		Model:        "claude-sonnet-4-5",
		InputTokens:  8,
		OutputTokens: 13,
		TotalTokens:  21,
		CollectedAt:  "2026-05-22T10:00:00.000Z",
	}
	writeClaudeAckCursorForSnapshot(t, stateDir, snapshot)
	env := func(key string) string {
		if key == "TOKENBOARD_HOOK_MODE" {
			return "1"
		}
		return ""
	}
	if err := acknowledgeUploadCursors(stateDir, collection{
		collectedSources: []contract.Source{contract.SourceClaudeCode},
		snapshots:        []contract.Snapshot{snapshot},
	}, upload.Result{
		Rejected:           []upload.RejectedSnapshot{{Snapshot: snapshot, Issue: "before-history-window"}},
		RejectedUsageDates: 1,
	}, Options{}, "", env); err != nil {
		t.Fatal(err)
	}
	entry := readHookAckCursor(t, stateDir)
	if entry.PendingUpload != nil && *entry.PendingUpload {
		t.Errorf("a permanently undeliverable row must be acknowledged away: %+v", entry)
	}
}

type codexAckEntry struct {
	digest         string
	pending        bool
	pendingPricing bool
	// date overrides the snapshot's usageDate; the fixtures' default day is
	// 2026-05-22.
	date string
}

// codexAckSnapshot is the row the Codex ack fixtures stand for: a delivered
// group that carries enough of a snapshot for the group fallback to match.
func codexAckSnapshot() contract.Snapshot {
	return contract.Snapshot{
		Source:       contract.SourceCodex,
		UsageDate:    "2026-05-22",
		Timezone:     "Asia/Shanghai",
		Model:        "gpt-5",
		InputTokens:  15,
		TotalTokens:  15,
		SessionCount: 1,
		CollectedAt:  "2026-05-22T10:00:00.000Z",
	}
}

func writeCodexAckCursor(t *testing.T, path string, entries map[string]codexAckEntry) {
	t.Helper()
	files := map[string]any{}
	for relativePath, input := range entries {
		date := input.date
		if date == "" {
			date = "2026-05-22"
		}
		snapshot := map[string]any{
			"source": "codex", "usageDate": date, "timezone": "Asia/Shanghai",
			"model": "gpt-5", "inputTokens": 15, "outputTokens": 0,
			"cacheCreationTokens": 0, "cacheReadTokens": 0, "totalTokens": 15,
			"costUsd": 0, "sessionCount": 1,
		}
		if input.pendingPricing {
			snapshot["codexContextPricingPending"] = true
		}
		entry := map[string]any{
			"size": 1, "mtimeMs": 1779411600000, "sha256": input.digest,
			"endsWithNewline": true, "snapshots": []any{snapshot},
			"missingCost": false, "updatedAt": "2026-05-22T10:00:00.000Z",
		}
		if input.pending {
			entry["pendingUpload"] = true
		}
		files[relativePath] = entry
	}
	document := map[string]any{"version": 1, "source": "codex", "files": files}
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readCodexAckCursor(t *testing.T, path string) map[string]sessioncursor.Entry {
	t.Helper()
	cursor, err := sessioncursor.Read(path, "codex")
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return cursor.Files
}

func codexHookProfileCursorName(home string) string {
	return sessioncursor.FileName(contract.SourceCodex, resolveCodexHome(home))
}

func resolveCodexHome(home string) string {
	absolute, err := filepath.Abs(home)
	if err != nil {
		return filepath.Clean(home)
	}
	return filepath.Clean(absolute)
}
