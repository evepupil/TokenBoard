package sqlite

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The writer must refuse bytes past the ceiling instead of growing with the
// executable's output: the post-run length check alone let a runaway result
// set allocate without bound while the query was still running.
func TestBoundedStdoutStopsAtTheCeiling(t *testing.T) {
	writer := &boundedStdout{limit: 8}
	if _, err := writer.Write([]byte("12345")); err != nil {
		t.Fatalf("write below the ceiling: %v", err)
	}
	if _, err := writer.Write([]byte("678")); err != nil {
		t.Fatalf("write up to the ceiling: %v", err)
	}
	if _, err := writer.Write([]byte("9")); err == nil {
		t.Fatal("a write past the ceiling must fail")
	}
	if writer.buffer.String() != "12345678" {
		t.Fatalf("buffer = %q, want the bytes that fit", writer.buffer.String())
	}
}

// End to end through the external reader: a reader that never stops writing
// must be cut off by the ceiling, not by the timeout, and the reported error
// must name the ceiling.
func TestRunExternalCutsOffARunawayReaderAtTheCeiling(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fixture")
	}
	script := filepath.Join(t.TempDir(), "fake-sqlite3")
	// Emit forever; the reader never finishes on its own.
	body := "#!/bin/sh\nwhile :; do printf '%01000d' 0; done\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}

	started := time.Now()
	_, err := QueryText(filepath.Join(t.TempDir(), "probe.db"), "select 1", QueryOptions{
		Label:          "Probe",
		ForceExternal:  true,
		SQLiteBin:      &script,
		MaxOutputBytes: 4096,
		Timeout:        30 * time.Second,
	})
	if err == nil || !strings.Contains(err.Error(), "Probe SQLite result exceeded 4096 bytes") {
		t.Fatalf("error = %v, want the ceiling report", err)
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("the reader ran for %s; the ceiling must stop it without waiting for the timeout", elapsed)
	}
}

// The external sqlite3 binary is a third-party program, and exec.Cmd inherits
// the whole process environment when Env is nil — upload token included. This
// is the Go-side twin of the TS reader's scrub; a stand-in reports what it saw.
func TestExternalReaderScrubsTheCredentialEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the stand-in is a POSIX shell script")
	}
	dir := t.TempDir()
	marker := filepath.Join(dir, "seen.txt")
	standIn := filepath.Join(dir, "sqlite3")
	body := "#!/bin/sh\nif [ -n \"$TOKENBOARD_UPLOAD_TOKEN\" ]; then echo LEAKED > " + marker +
		"; else echo CLEAN > " + marker + "; fi\necho '[]'\n"
	if err := os.WriteFile(standIn, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TOKENBOARD_UPLOAD_TOKEN", "tb_probe_secret")

	if _, err := QueryJSONRows(filepath.Join(dir, "unused.db"), "select 1", QueryOptions{
		SQLiteBin:     &standIn,
		ForceExternal: true,
		Label:         "OpenCode",
	}); err != nil {
		t.Fatalf("query: %v", err)
	}

	seen, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("the stand-in never ran: %v", err)
	}
	if strings.TrimSpace(string(seen)) != "CLEAN" {
		t.Fatalf("the sqlite binary inherited the upload token: %q", seen)
	}
}
