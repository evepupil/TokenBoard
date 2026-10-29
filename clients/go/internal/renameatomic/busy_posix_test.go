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
