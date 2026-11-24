//go:build !windows

package main

import (
	"os"
	"runtime"
	"syscall"
)

// childObserver captures one child's peak RSS.
//
// On unix there is nothing to open up front: Go's os.Process.Wait performs the
// wait4 call that carries this child's own rusage, and peakRSS reads it back
// from the ProcessState. The type exists so the measurement loop is the same
// code on every platform (see rss_windows.go, which does have to hold a handle
// open while the child runs).
type childObserver struct{}

// observeChild has no unix state to capture.
func observeChild(*os.Process) childObserver { return childObserver{} }

// peakRSS returns the child's own peak RSS in bytes.
//
// This is the wait4 rusage of *this* child, which is what makes a per-round
// figure meaningful. RUSAGE_CHILDREN cannot do that on its own: its ru_maxrss is
// a monotone high-water over every child the process has reaped, so a round
// smaller than a previous one would report the earlier round's peak. It is kept
// as the fallback for the case where syscall's rusage is missing (a package
// runner wraps the real binary, or a platform that does not fill the field), and
// the report labels which one it used.
func (childObserver) peakRSS(state *os.ProcessState) (uint64, string) {
	if state == nil {
		return 0, rssSourceUnavailable
	}
	if usage, ok := state.SysUsage().(*syscall.Rusage); ok && usage != nil {
		if bytes := rusageMaxRSSBytes(usage.Maxrss, runtime.GOOS); bytes > 0 {
			return bytes, rssSourceWait4
		}
	}
	return childrenHighWaterRSS()
}

// childrenHighWaterRSS is the measured children's high-water mark, normalized to
// bytes. It is an upper bound for the current round, not that round's own peak.
func childrenHighWaterRSS() (uint64, string) {
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_CHILDREN, &usage); err != nil {
		return 0, rssSourceUnavailable
	}
	bytes := rusageMaxRSSBytes(usage.Maxrss, runtime.GOOS)
	if bytes == 0 {
		return 0, rssSourceUnavailable
	}
	return bytes, rssSourceChildren
}

// selfPeakRSS is this process's own high-water mark, which is the native side's
// measurement: the native provider runs in-process. Like RUSAGE_CHILDREN it is
// monotone across rounds, so it is labelled as such in the report.
func selfPeakRSS() (uint64, string) {
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
		return 0, rssSourceUnavailable
	}
	bytes := rusageMaxRSSBytes(usage.Maxrss, runtime.GOOS)
	if bytes == 0 {
		return 0, rssSourceUnavailable
	}
	return bytes, rssSourceSelf
}
