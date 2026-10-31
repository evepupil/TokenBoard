//go:build windows

package renameatomic

import (
	"errors"
	"syscall"
)

// Windows error codes a concurrent opener produces. os.Rename goes through
// MoveFileEx, which reports the raw Win32 code, and Node's libuv maps exactly
// these three onto the EPERM/EBUSY the TS collector retries:
//
//	ERROR_ACCESS_DENIED (5)      -> EPERM  (a reader without FILE_SHARE_DELETE)
//	ERROR_SHARING_VIOLATION (32) -> EBUSY  (an open handle blocks the rename)
//	ERROR_LOCK_VIOLATION (33)    -> EBUSY  (a byte-range lock covers the file)
const (
	errorAccessDenied     syscall.Errno = 5
	errorSharingViolation syscall.Errno = 32
	errorLockViolation    syscall.Errno = 33
)

// IsBusy reports whether the rename failed for a reason a retry can clear.
//
// It must compare against the Win32 codes above, not against syscall.EPERM and
// syscall.EBUSY: on Windows those two are invented values in the
// `APPLICATION_ERROR + iota` range (>= 1<<29) that no syscall ever returns, so
// the earlier implementation retried nothing on the platform it was written for.
func IsBusy(err error) bool {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	return errno == errorAccessDenied || errno == errorSharingViolation || errno == errorLockViolation
}
