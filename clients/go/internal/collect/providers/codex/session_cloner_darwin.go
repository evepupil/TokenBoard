//go:build darwin

package codex

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// defaultCloneSessionFile snapshots the source with clonefile(2), so the frozen scope's copy
// is a copy-on-write sibling rather than a second set of blocks. A busy machine keeps GB of
// Codex history (3.1 GB of sessions on the machine this was measured on), and every hook run
// that touches a changed date re-copies its scoped files; before this the Go client reported
// the clone as unavailable and paid for a full duplicate every time.
//
// clonefile creates the target exclusively (EEXIST when it exists), which is the `Copy`
// contract. A cross-device target fails with EXDEV and the cloner's existing per-file fallback
// handles it; the other "cannot clone here" codes latch the cloner into the copy path.
func defaultCloneSessionFile(source, target string) error {
	err := unix.Clonefile(source, target, 0)
	if err == nil {
		return nil
	}
	// clonefile can leave a partial target behind on failure, and the fallback copy opens the
	// target with O_EXCL. Only a path this call created is removed — an EEXIST target belongs
	// to someone else.
	if !errors.Is(err, unix.EEXIST) {
		_ = os.Remove(target)
	}
	return err
}
