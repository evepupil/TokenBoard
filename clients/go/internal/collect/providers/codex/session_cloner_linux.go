//go:build linux

package codex

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// defaultCloneSessionFile reflinks the source into the target with FICLONE, the Linux
// equivalent of the clonefile path the TS cloner uses on macOS. The target is created
// exclusively first, matching the `Copy` contract; when the filesystem cannot reflink
// (ext4 without the feature, tmpfs, overlayfs, an old kernel) the helper reports the
// unavailable code and the cloner takes its documented bounded copy instead.
//
// EXDEV is returned as-is: a target on another filesystem says nothing about the next pair,
// and the cloner's per-file fallback covers it without latching.
func defaultCloneSessionFile(source, target string) error {
	sourceFile, err := os.Open(source)
	if err != nil {
		return err
	}
	defer sourceFile.Close()
	info, err := sourceFile.Stat()
	if err != nil {
		return err
	}
	targetFile, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
	if err != nil {
		return err
	}
	cloneErr := unix.IoctlFileClone(int(targetFile.Fd()), int(sourceFile.Fd()))
	if closeErr := targetFile.Close(); cloneErr == nil {
		cloneErr = closeErr
	}
	if cloneErr != nil {
		_ = os.Remove(target)
		if isUnsupportedReflinkError(cloneErr) {
			return errCloneFileUnavailable
		}
		return cloneErr
	}
	return nil
}

// isUnsupportedReflinkError maps "this filesystem or kernel cannot reflink" onto the shared
// unavailable code. EOPNOTSUPP is the documented answer; ENOTTY and EINVAL are what older
// kernels and some stacked filesystems return for an unknown ioctl. EXDEV is deliberately not
// included — the cloner's per-file fallback keeps the clone attempt alive for the next file.
func isUnsupportedReflinkError(err error) bool {
	return errors.Is(err, unix.EOPNOTSUPP) ||
		errors.Is(err, unix.ENOTTY) ||
		errors.Is(err, unix.EINVAL) ||
		errors.Is(err, unix.ENOSYS)
}
