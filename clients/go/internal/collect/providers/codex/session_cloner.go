package codex

// Port of codex-session-cloner.ts: the frozen copy the Codex session scope
// makes of every session file it hands to ccusage.
//
// The TS cloner clones with macOS clonefile(2) through a persistent Ruby
// helper and falls back to fs.copyFile (COPYFILE_EXCL) elsewhere, reporting
// CODEX_SESSION_COPY_FALLBACK_MESSAGE once when the clone is unavailable. The
// Go cloner has no helper subprocess: `defaultCloneSessionFile` is defined per
// platform (clonefile(2) on darwin, FICLONE on linux, unavailable elsewhere),
// and a platform without a primitive reports the same fallback message and
// takes the documented bounded standard copy. CloneFile still lets a caller
// inject an implementation without changing the contract the scope relies on.
//
// Observable contract kept from the TS cloner:
//   - Copy creates the target exclusively (a second Copy to the same target
//     fails, like COPYFILE_EXCL) and leaves an independent file behind.
//   - A clone-unavailable error reports the fallback once and still copies;
//     any other clone error (a permission failure, say) is returned unchanged
//     and the copy is not attempted.
//   - EXDEV falls back without disabling the clone for the next file; the
//     other unavailable codes latch the cloner into the copy path.
//   - Close releases whatever the cloner holds; the Go cloner holds nothing,
//     so it is a no-op that reports no error.

import (
	"errors"
	"io"
	"os"
	"syscall"
)

// CodexSessionCopyFallbackMessage is CODEX_SESSION_COPY_FALLBACK_MESSAGE: the
// one diagnostic a run prints when the copy-on-write clone is unavailable.
const CodexSessionCopyFallbackMessage = "Codex copy-on-write clone is unavailable; using a bounded standard file copy"

// sessionCopyBufferBytes is the buffer the fallback copy hands to io.Copy. A
// copy between two *os.File values normally bypasses it through ReadFrom
// (copy_file_range on Linux, a plain copy elsewhere).
const sessionCopyBufferBytes = 1024 * 1024

// errCloneFileUnavailable reports that this build has no copy-on-write clone
// primitive. It is one of the TS copy-on-write-unavailable codes and therefore
// triggers the fallback diagnostic rather than failing the sync.
var errCloneFileUnavailable = errors.New("Codex copy-on-write clone is unavailable on this platform")

// CodexSessionCloner copies one session file into a frozen scope.
type CodexSessionCloner interface {
	// Copy snapshots source at target. The target is created exclusively.
	Copy(source, target string) error
	// Close releases whatever the cloner holds.
	Close() error
}

// CodexSessionClonerOptions mirrors CodexSessionClonerOptions.
type CodexSessionClonerOptions struct {
	// OnFallback runs each time a clone attempt proves unavailable. The scope
	// wraps it in a reporter that prints the message once per run.
	OnFallback func()
	// CloneFile attempts the copy-on-write clone. Nil uses the platform
	// default. Tests inject failures through it.
	CloneFile func(source, target string) error
	// CopyFile performs the exclusive fallback copy. Nil uses the bounded
	// standard copy.
	CopyFile func(source, target string) error
}

// CreateCodexSessionCloner builds a cloner.
func CreateCodexSessionCloner(options CodexSessionClonerOptions) CodexSessionCloner {
	cloneFile := options.CloneFile
	if cloneFile == nil {
		cloneFile = defaultCloneSessionFile
	}
	copyFile := options.CopyFile
	if copyFile == nil {
		copyFile = defaultCopySessionFile
	}
	return &sessionCloner{
		onFallback: options.OnFallback,
		cloneFile:  cloneFile,
		copyFile:   copyFile,
	}
}

type sessionCloner struct {
	cloneUnavailable bool
	onFallback       func()
	cloneFile        func(source, target string) error
	copyFile         func(source, target string) error
}

func (c *sessionCloner) Copy(source, target string) error {
	if c.cloneUnavailable {
		return c.copyFile(source, target)
	}
	err := c.cloneFile(source, target)
	if err == nil {
		return nil
	}
	if !isCopyOnWriteCloneUnavailable(err) {
		return err
	}
	// A cross-device clone says nothing about the next pair, so only the
	// other codes latch the cloner into the copy path (the TS rule).
	if !errors.Is(err, syscall.EXDEV) {
		c.cloneUnavailable = true
	}
	if c.onFallback != nil {
		c.onFallback()
	}
	return c.copyFile(source, target)
}

func (c *sessionCloner) Close() error {
	return nil
}

// isCopyOnWriteCloneUnavailable ports isCopyOnWriteCloneUnavailable: the codes
// that mean "this filesystem cannot clone", not "this copy failed".
func isCopyOnWriteCloneUnavailable(err error) bool {
	return errors.Is(err, errCloneFileUnavailable) ||
		errors.Is(err, syscall.ENOTSUP) ||
		errors.Is(err, syscall.EOPNOTSUPP) ||
		errors.Is(err, syscall.ENOSYS) ||
		errors.Is(err, syscall.EXDEV)
}

// defaultCopySessionFile is copyFileExclusive: an exclusive-create copy that
// removes the destination it created when the copy fails, the way libuv's
// uv_fs_copyfile does. The source mode is applied to the target and the umask
// still decides the final bits, matching Node.
func defaultCopySessionFile(source, target string) error {
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
	_, copyErr := io.CopyBuffer(targetFile, sourceFile, make([]byte, sessionCopyBufferBytes))
	closeErr := targetFile.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(target)
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	}
	return nil
}
