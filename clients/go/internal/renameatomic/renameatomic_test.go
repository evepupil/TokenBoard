package renameatomic

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestRenameMovesTheFile(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "a")
	target := filepath.Join(dir, "b")
	if err := os.WriteFile(source, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Rename(source, target); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("target missing: %v", err)
	}
}

// A non-busy error must come back on the first attempt, not after the backoff.
func TestRenameReturnsNonBusyErrorsWithoutRetrying(t *testing.T) {
	started := time.Now()
	err := Rename(filepath.Join(t.TempDir(), "missing"), filepath.Join(t.TempDir(), "target"))
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("err = %v, want ENOENT", err)
	}
	if elapsed := time.Since(started); elapsed > Delays[0] {
		t.Fatalf("waited %v for a non-busy error", elapsed)
	}
}

func TestIsBusyMatchesTheTransientCodes(t *testing.T) {
	if !IsBusy(syscall.EPERM) || !IsBusy(syscall.EBUSY) {
		t.Fatal("EPERM/EBUSY must be retried")
	}
	if IsBusy(os.ErrNotExist) || IsBusy(nil) {
		t.Fatal("other errors must not be retried")
	}
}
