// Package renameatomic ports packages/collector/src/rename-atomic.ts: an atomic
// write lands via rename, and on Windows a concurrent opener (OneDrive, Defender,
// a backup tool) can hold the destination just long enough for rename to fail
// with EPERM or EBUSY. Those errors are transient, so a short backoff retries
// them instead of failing the state write the whole sync depends on.
package renameatomic

import (
	"errors"
	"os"
	"syscall"
	"time"
)

// Delays mirror the TS implementation; each is applied before the retry it
// precedes, so a collision released in milliseconds never fails the write.
var Delays = []time.Duration{50 * time.Millisecond, 150 * time.Millisecond, 400 * time.Millisecond}

// Rename renames tempPath to destinationPath, retrying only the transient
// busy-handle errors. Any other error is returned unchanged on the first try.
func Rename(tempPath, destinationPath string) error {
	err := os.Rename(tempPath, destinationPath)
	if !IsBusy(err) {
		return err
	}
	for _, delay := range Delays {
		time.Sleep(delay)
		retryErr := os.Rename(tempPath, destinationPath)
		if retryErr == nil {
			return nil
		}
		if !IsBusy(retryErr) {
			return retryErr
		}
		err = retryErr
	}
	return err
}

// IsBusy reports whether the rename failed for a reason a retry can clear.
func IsBusy(err error) bool {
	return errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EBUSY)
}
