//go:build darwin

package codex

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

// The default clone is a real clonefile(2) on APFS. These tests run it for real rather than
// through the injectable seam, because the platform file is the part a stub cannot verify —
// and because "clone unavailable" on macOS is exactly the diagnostic an operator saw on
// 2026-11-24 before this existed (the fallback copy then duplicated every scoped file).
func TestDefaultCloneSessionFileDarwinClonesExclusively(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source.jsonl")
	target := filepath.Join(root, "target.jsonl")
	if err := os.WriteFile(source, []byte("first\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := defaultCloneSessionFile(source, target); err != nil {
		// A temp dir on a volume that cannot clone (a network mount, a case-sensitive foreign
		// filesystem) is an environment fact, not a defect: the cloner's fallback covers it.
		if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.EOPNOTSUPP) || errors.Is(err, unix.EXDEV) {
			t.Skipf("this volume cannot clone: %v", err)
		}
		t.Fatalf("clonefile = %v", err)
	}
	if content, err := os.ReadFile(target); err != nil || string(content) != "first\n" {
		t.Fatalf("target = %q, %v", content, err)
	}

	// The copy must be independent: a write to one side cannot leak into the other.
	if err := os.WriteFile(target, []byte("target-only\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if content, err := os.ReadFile(source); err != nil || string(content) != "first\n" {
		t.Fatalf("source changed after writing the clone: %q, %v", content, err)
	}

	// clonefile refuses an existing target, which is what makes a second `Copy` fail rather
	// than silently overwrite a frozen scope.
	err := defaultCloneSessionFile(source, target)
	if !errors.Is(err, unix.EEXIST) {
		t.Fatalf("second clone = %v, want EEXIST", err)
	}
	if content, readErr := os.ReadFile(target); readErr != nil || string(content) != "target-only\n" {
		t.Fatalf("existing target was disturbed: %q, %v", content, readErr)
	}
}

// A vanished source with a pre-existing target must leave the target alone. clonefile(2)
// answers ENOENT without touching the destination (verified on this machine), and ENOENT is
// not EEXIST — a cleanup keyed on "not EEXIST" therefore deleted a file this call never
// created. The scope runs under the sync lock, but the frozen target belongs to an earlier
// successful copy and a spurious delete would drop collected usage for the day.
func TestDefaultCloneSessionFileDarwinKeepsExistingTargetWhenSourceVanishes(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "gone.jsonl")
	target := filepath.Join(root, "target.jsonl")
	if err := os.WriteFile(target, []byte("already collected\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	err := defaultCloneSessionFile(source, target)
	if !errors.Is(err, unix.ENOENT) {
		t.Fatalf("clone with a missing source = %v, want ENOENT", err)
	}
	content, readErr := os.ReadFile(target)
	if readErr != nil || string(content) != "already collected\n" {
		t.Fatalf("the pre-existing target was disturbed: %q, %v", content, readErr)
	}
}

// The cloner must not report the fallback when the platform primitive works; this is the
// assertion that the darwin implementation actually got wired in. A volume that cannot clone
// at all is an environment fact, not a defect, and skips this test like it skips the one above.
func TestCodexSessionClonerUsesTheDarwinDefaultWithoutAFallback(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source.jsonl")
	target := filepath.Join(root, "target.jsonl")
	if err := os.WriteFile(source, []byte("first\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := defaultCloneSessionFile(source, filepath.Join(root, "probe-target.jsonl")); err != nil {
		if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.EOPNOTSUPP) || errors.Is(err, unix.EXDEV) {
			t.Skipf("this volume cannot clone: %v", err)
		}
		if errors.Is(err, errCloneFileUnavailable) {
			t.Skipf("this build reports clone as unavailable: %v", err)
		}
		t.Fatalf("clone probe = %v", err)
	}

	fallbacks := 0
	cloner := CreateCodexSessionCloner(CodexSessionClonerOptions{
		OnFallback: func() { fallbacks++ },
	})
	if err := cloner.Copy(source, target); err != nil {
		t.Fatalf("copy = %v", err)
	}
	if fallbacks != 0 {
		t.Fatalf("fallback fired %d times on a filesystem that can clone", fallbacks)
	}
}
