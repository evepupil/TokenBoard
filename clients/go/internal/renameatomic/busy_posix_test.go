//go:build !windows

package renameatomic

import (
	"syscall"
	"testing"
)

func TestIsBusyMatchesTheTransientCodes(t *testing.T) {
	if !IsBusy(syscall.EPERM) || !IsBusy(syscall.EBUSY) {
		t.Fatal("EPERM/EBUSY must be retried")
	}
}

// testBusyErr is one transient code this platform retries; the retry cases in
// renameatomic_test.go share one name so the same tests run on POSIX and Windows.
var testBusyErr = syscall.EBUSY
