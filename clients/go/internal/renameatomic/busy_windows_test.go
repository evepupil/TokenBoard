//go:build windows

package renameatomic

import (
	"fmt"
	"syscall"
	"testing"
)

// The Win32 codes MoveFileEx reports when another process holds the destination.
// These are the values libuv maps onto the EPERM/EBUSY the TS collector retries,
// so they are exactly what this build must treat as transient.
func TestIsBusyMatchesTheWin32CodesMoveFileExReturns(t *testing.T) {
	for _, code := range []syscall.Errno{errorAccessDenied, errorSharingViolation, errorLockViolation} {
		if !IsBusy(code) {
			t.Fatalf("Win32 error %d must be retried", code)
		}
		if !IsBusy(fmt.Errorf("rename failed: %w", code)) {
			t.Fatalf("Win32 error %d must be retried through a wrapped error", code)
		}
	}
}

// syscall.EPERM and syscall.EBUSY are invented values on Windows
// (`APPLICATION_ERROR + iota`, >= 1<<29) that no syscall returns. Treating them as
// busy — which the first implementation did — retried nothing on this platform.
func TestIsBusyDoesNotMatchTheInventedSyscallValues(t *testing.T) {
	if IsBusy(syscall.EPERM) {
		t.Fatal("syscall.EPERM is not a Win32 code and must not be treated as busy")
	}
	if IsBusy(syscall.EBUSY) {
		t.Fatal("syscall.EBUSY is not a Win32 code and must not be treated as busy")
	}
}
