//go:build !windows

package main

import (
	"context"
	"os"
	"runtime"
	"testing"
)

// rssHelperEnv switches this test binary into "be the child" mode.
const rssHelperEnv = "BENCH_COLLECT_RSS_HELPER"

// TestChildPeakRSSMeasuresTheRealChild guards the failure this harness exists to
// avoid: reading the benchmark process's own footprint instead of the ccusage
// child's. The child is this test binary re-executed in helper mode, allocating
// and touching 256 MiB. If the measurement ever degraded to RUSAGE_SELF, or to
// an empty rusage, the reported peak would be the few megabytes of Go runtime
// start-up and this fails.
//
// It also pins the live unit on whatever unix runs it: on Linux the raw rusage
// field is kilobytes, and a missing normalisation would make the assertion pass
// only because the number got 1024 times smaller.
func TestChildPeakRSSMeasuresTheRealChild(t *testing.T) {
	const allocationMiB = 256
	if os.Getenv(rssHelperEnv) == "1" {
		allocateAndTouch(allocationMiB)
		return
	}
	t.Setenv(rssHelperEnv, "1")
	sample, err := runCcusageOnce(context.Background(), os.Args[0],
		[]string{"-test.run=^TestChildPeakRSSMeasuresTheRealChild$"})
	if err != nil {
		t.Fatalf("runCcusageOnce: %v", err)
	}
	if sample.RSSSource != rssSourceWait4 {
		t.Fatalf("rss source = %q, want %q (the child's own wait4 rusage)",
			sample.RSSSource, rssSourceWait4)
	}
	minimum := uint64(allocationMiB) * 1024 * 1024
	if sample.PeakRSSBytes < minimum {
		t.Fatalf("peak RSS = %d bytes (%s), want at least %d (%s) on %s — the measurement is not reading the child",
			sample.PeakRSSBytes, formatBytes(sample.PeakRSSBytes),
			minimum, formatBytes(minimum), runtime.GOOS)
	}
	t.Logf("child peak RSS = %s on %s", formatBytes(sample.PeakRSSBytes), runtime.GOOS)
}

// allocateAndTouch makes the allocation resident: pages that are only reserved
// are not part of the resident set the measurement reads.
func allocateAndTouch(mib int) {
	buffer := make([]byte, mib*1024*1024)
	for index := 0; index < len(buffer); index += 4096 {
		buffer[index] = 1
	}
	runtime.KeepAlive(buffer)
}
