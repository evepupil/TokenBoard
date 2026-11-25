//go:build darwin

package codex

import (
	"golang.org/x/sys/unix"
)

// defaultCloneSessionFile snapshots the source with clonefile(2), so the frozen scope's copy
// is a copy-on-write sibling rather than a second set of blocks. A busy machine keeps GB of
// Codex history (3.1 GB of sessions on the machine this was measured on), and every hook run
// that touches a changed date re-copies its scoped files; before this the Go client reported
// the clone as unavailable and paid for a full duplicate every time.
//
// clonefile creates the target exclusively — "The named file dst must not exist for the call to
// be successful" (clonefile(2)), EEXIST when it does — and the clone is a single APFS metadata
// transaction, so a failed call never leaves a partial target behind. There is therefore no
// destination to clean up: removing the target on a non-EEXIST error would destroy a pre-existing
// frozen copy. Verified on this machine: with the source gone and the target present, clonefile
// returns ENOENT and the target is untouched. The caller's standard copy opens with O_EXCL, so a
// genuinely absent target is the only state it expects, and clonefile failure leaves it that way.
func defaultCloneSessionFile(source, target string) error {
	return unix.Clonefile(source, target, 0)
}
