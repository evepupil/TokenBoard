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
