package tools

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestReadToolFileStopsAtTheBudgetWithoutReportingAReadFailure pins the point of
// chunked reading: a whole-file os.ReadFile would run a multi-hundred-MB
// transcript to completion past the deadline. A read stopped by the budget must
// return no content and record nothing — it is not a broken file, and the
// adapter's next loop-top check reports the budget itself.
func TestReadToolFileStopsAtTheBudgetWithoutReportingAReadFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "big.jsonl")
	if err := os.WriteFile(path, bytes.Repeat([]byte("x"), readChunkBytes*2+1), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var readErrors []ReadError
	content, ok := readToolFile(path, "Gemini log file", Options{Context: ctx, ReadErrors: &readErrors})
	if ok || content != nil {
		t.Fatalf("readToolFile = (%d bytes, %v), want a stopped read", len(content), ok)
	}
	if len(readErrors) != 0 {
		t.Fatalf("a stopped read must not be reported as a file failure: %v", readErrors)
	}
}

// TestReadToolFileReadsWholeMultiChunkFileUnderALiveBudget guards the chunk
// loop itself: a file longer than one chunk must come back complete, including
// its final partial chunk.
func TestReadToolFileReadsWholeMultiChunkFileUnderALiveBudget(t *testing.T) {
	want := bytes.Repeat([]byte("y"), readChunkBytes*2+1)
	path := filepath.Join(t.TempDir(), "big.jsonl")
	if err := os.WriteFile(path, want, 0o600); err != nil {
		t.Fatal(err)
	}
	content, ok := readToolFile(path, "Gemini log file", Options{Context: context.Background()})
	if !ok || !bytes.Equal(content, want) {
		t.Fatalf("readToolFile = (%d bytes, %v), want the whole %d-byte file", len(content), ok, len(want))
	}
}

// TestReadToolFileReportsDistinctFilesWithTheSameBaseName pins the identity/
// line split: two unreadable files that share a base name (two `logs.json`
// under different project roots) must both reach ReadErrors and stay distinct,
// even though their printed lines — which name the base name only — are equal.
// The provider dedupes on Identity, so collapsing to the printed line would
// hide every file after the first.
func TestReadToolFileReportsDistinctFilesWithTheSameBaseName(t *testing.T) {
	root := t.TempDir()
	a := filepath.Join(root, "p1", "logs.json")
	b := filepath.Join(root, "p2", "logs.json")
	for _, path := range []string{a, b} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, 0o000); err != nil {
			t.Fatal(err)
		}
		path := path
		t.Cleanup(func() { _ = os.Chmod(path, 0o600) })
	}
	// A platform that ignores the 0o000 mode would let the read succeed and the
	// test would assert nothing meaningful.
	if content, err := os.ReadFile(a); err == nil || content != nil {
		t.Skip("filesystem does not enforce unreadable permissions for this user")
	}

	var readErrors []ReadError
	o := Options{ReadErrors: &readErrors}
	for _, path := range []string{a, b} {
		if _, ok := readToolFile(path, "Gemini log file", o); ok {
			t.Fatalf("readToolFile(%s) returned content for an unreadable file", path)
		}
	}

	if len(readErrors) != 2 {
		t.Fatalf("readErrors = %v, want two entries (distinct files, same base name)", readErrors)
	}
	if readErrors[0].Identity == readErrors[1].Identity {
		t.Fatalf("identities are equal (%q); the two files were merged", readErrors[0].Identity)
	}
	for _, entry := range readErrors {
		if !strings.Contains(entry.Line, "logs.json") {
			t.Fatalf("line = %q, want it to name logs.json", entry.Line)
		}
		if strings.Contains(entry.Line, root) {
			t.Fatalf("line = %q, must not carry the directory", entry.Line)
		}
	}
}
