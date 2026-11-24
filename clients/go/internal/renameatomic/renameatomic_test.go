package renameatomic

import (
	"errors"
	"os"
	"path/filepath"
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

// IsBusy must not retry a plain missing file, and nil must never be busy.
func TestIsBusyRejectsNonTransientErrors(t *testing.T) {
	if IsBusy(os.ErrNotExist) {
		t.Fatal("ENOENT must not be retried")
	}
	if IsBusy(nil) {
		t.Fatal("nil must not be busy")
	}
}

// swapRename replaces the rename seam for the duration of the test.
func swapRename(t *testing.T, fn func(string, string) error) {
	t.Helper()
	previous := renameFunc
	renameFunc = fn
	t.Cleanup(func() { renameFunc = previous })
}

// Mirrors the TS test: two busy collisions clear, and the third rename lands.
func TestRenameRetriesBusyErrorsUntilTheDestinationFreesUp(t *testing.T) {
	attempts := 0
	swapRename(t, func(string, string) error {
		attempts++
		if attempts <= 2 {
			return testBusyErr
		}
		return nil
	})
	if err := Rename("t", "d"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if attempts != 3 {
		t.Fatalf("attempts = %d, want 3", attempts)
	}
}

// Mirrors the TS test: after the budget is spent the last busy error is returned.
func TestRenameGivesUpAfterTheRetryBudget(t *testing.T) {
	attempts := 0
	swapRename(t, func(string, string) error {
		attempts++
		return testBusyErr
	})
	err := Rename("t", "d")
	if !errors.Is(err, testBusyErr) {
		t.Fatalf("err = %v, want the busy error", err)
	}
	if want := len(Delays) + 1; attempts != want {
		t.Fatalf("attempts = %d, want %d (initial + retries)", attempts, want)
	}
}

// A non-busy error on a retry stops the loop immediately with that error.
func TestRenameStopsOnANonBusyRetryError(t *testing.T) {
	attempts := 0
	swapRename(t, func(string, string) error {
		attempts++
		if attempts == 1 {
			return testBusyErr
		}
		return os.ErrPermission
	})
	err := Rename("t", "d")
	if !errors.Is(err, os.ErrPermission) {
		t.Fatalf("err = %v, want the retry's own error", err)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want 2", attempts)
	}
}
