//go:build !darwin && !linux

package codex

// defaultCloneSessionFile reports the unavailable code on platforms with no copy-on-write
// primitive in this build (Windows included): the cloner prints the fallback diagnostic once
// and takes its bounded standard copy, which is the behaviour every platform had before the
// darwin and linux implementations were added.
func defaultCloneSessionFile(_, _ string) error {
	return errCloneFileUnavailable
}
