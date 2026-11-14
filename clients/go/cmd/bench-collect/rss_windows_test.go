//go:build windows

package main

import (
	"context"
	"os"
	"runtime"
	"testing"
)

// rssHelperEnv switches this test binary into "be the child" mode. It repeats
// rss_unix_test.go's declaration because that file is build-tagged out here,
// and keeps the same literal so one env switch works on every platform.
const rssHelperEnv = "BENCH_COLLECT_RSS_HELPER"

// TestChildPeakRSSMeasuresTheRealChildWindows exists to catch the failure the
// Windows implementation is built to report instead of hide: rssSourceWindows
// means OpenProcess succeeded while the child lived and K32GetProcessMemoryInfo
// returned a non-zero PeakWorkingSetSize, while rssSourceUnavailable means the
// calls failed and nothing was measured. Only an executed test can tell those
// apart — a compile-only check proves the syscalls exist, not that they answer.
//
// The child is this test binary re-executed in helper mode, allocating and
// touching 256 MiB, so any measurement that reads something other than the
// child's working set comes back far below the floor below.
func TestChildPeakRSSMeasuresTheRealChildWindows(t *testing.T) {
	const allocationMiB = 256
	if os.Getenv(rssHelperEnv) == "1" {
		allocateAndTouch(allocationMiB)
		return
	}
	t.Setenv(rssHelperEnv, "1")
	sample, err := runCcusageOnce(context.Background(), os.Args[0],
		[]string{"-test.run=^TestChildPeakRSSMeasuresTheRealChildWindows$"})
	if err != nil {
		t.Fatalf("runCcusageOnce: %v", err)
	}
	if sample.RSSSource != rssSourceWindows {
		t.Fatalf("rss source = %q, want %q (OpenProcess + K32GetProcessMemoryInfo must actually run; "+
			"%q means the Windows path degraded and measured nothing)",
			sample.RSSSource, rssSourceWindows, rssSourceUnavailable)
	}
	// 200 MiB for a 256 MiB allocation is deliberate slack: peak working set
	// also counts the runtime image and heap metadata, and touch order leaves
	// some pages out, so a byte-exact bound would only be flaky. The floor is
	// still several times the parent test binary's own footprint (tens of MiB),
	// so a measurement that read this process instead of the child misses it.
	minimum := uint64(200) * 1024 * 1024
	if sample.PeakRSSBytes < minimum {
		t.Fatalf("peak RSS = %d bytes (%s), want at least %d (%s) on %s — the measurement is not reading the child",
			sample.PeakRSSBytes, formatBytes(sample.PeakRSSBytes),
			minimum, formatBytes(minimum), runtime.GOOS)
	}
	t.Logf("child peak RSS = %s on %s", formatBytes(sample.PeakRSSBytes), runtime.GOOS)
}

// allocateAndTouch makes the allocation resident: pages that are only reserved
// are not part of the working set the measurement reads. It repeats the
// unix-tagged helper for the same reason as rssHelperEnv.
func allocateAndTouch(mib int) {
	buffer := make([]byte, mib*1024*1024)
	for index := 0; index < len(buffer); index += 4096 {
		buffer[index] = 1
	}
	runtime.KeepAlive(buffer)
}
