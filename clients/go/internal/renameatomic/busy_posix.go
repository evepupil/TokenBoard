//go:build !windows

package renameatomic

import (
	"errors"
	"syscall"
)

// IsBusy reports whether the rename failed for a reason a retry can clear.
//
// On POSIX systems EPERM and EBUSY are the codes a concurrent opener produces,
// and they are real errno values that os.Rename returns as-is.
func IsBusy(err error) bool {
	return errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EBUSY)
}
