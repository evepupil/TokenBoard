//go:build linux

package codex

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// FICLONE support depends on the filesystem under the test's temp dir (ext4/xfs/btrfs: yes;
// overlayfs in some container runtimes, tmpfs: no). The clone is allowed to report the shared
// unavailable code and fall back — that is the documented behaviour — but when it reports
// success the target must be a faithful, independent copy.
func TestDefaultCloneSessionFileLinuxReflinksOrFallsBackCleanly(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source.jsonl")
	target := filepath.Join(root, "target.jsonl")
	if err := os.WriteFile(source, []byte("first\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	err := defaultCloneSessionFile(source, target)
	if errors.Is(err, errCloneFileUnavailable) {
		// The fallback contract covers this filesystem. Anchor on it explicitly so a change
		// that silently turned a real failure into "unavailable" would still be caught by the
		// cloner tests, which inject the primitives.
		t.Skipf("this filesystem cannot reflink: %v", err)
	}
	if err != nil {
		t.Fatalf("clone = %v", err)
	}
	if content, readErr := os.ReadFile(target); readErr != nil || string(content) != "first\n" {
		t.Fatalf("target = %q, %v", content, readErr)
	}

	// A write to the reflinked copy must not reach the source.
	if err := os.WriteFile(target, []byte("target-only\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if content, readErr := os.ReadFile(source); readErr != nil || string(content) != "first\n" {
		t.Fatalf("source changed after writing the clone: %q, %v", content, readErr)
	}

	// The exclusive-create contract: a second clone to the same target must fail rather than
	// overwrite the frozen copy.
	if err := defaultCloneSessionFile(source, target); err == nil {
		t.Fatal("second clone succeeded; the target must be exclusive")
	}
}
