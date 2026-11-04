// Small helpers for bench-collect: the statistics the report aggregates with,
// the RSS unit normalization, and the bounded I/O the child's streams go
// through. They take plain values, never the benchmark loop's structs, which is
// what keeps them out of the measurement path.
package main

import (
	"sort"
	"strings"
	"time"
)

// medianFloat64 returns the middle sample, or the mean of the two middle
// samples for an even count. The input slice is copied: the caller's round order
// is part of the report.
func medianFloat64(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	middle := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[middle]
	}
	return (sorted[middle-1] + sorted[middle]) / 2
}

// medianUint64 is medianFloat64 in integer arithmetic; an even count truncates
// the mean of the two middle samples.
func medianUint64(values []uint64) uint64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]uint64(nil), values...)
	sort.Slice(sorted, func(left, right int) bool { return sorted[left] < sorted[right] })
	middle := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[middle]
	}
	left, right := sorted[middle-1], sorted[middle]
	return left + (right-left)/2
}

func maxFloat64(values []float64) float64 {
	var maximum float64
	for _, value := range values {
		if value > maximum {
			maximum = value
		}
	}
	return maximum
}

func maxUint64(values []uint64) uint64 {
	var maximum uint64
	for _, value := range values {
		if value > maximum {
			maximum = value
		}
	}
	return maximum
}

// rusageMaxRSSBytes normalizes a rusage Ru_maxrss to bytes. darwin reports
// bytes; Linux and the other unix systems report kilobytes. See
// TestPeakRSSReportsBytesOnDarwinAndKilobytesOnLinux for the probe behind it.
func rusageMaxRSSBytes(raw int64, goos string) uint64 {
	if raw <= 0 {
		return 0
	}
	if goos == "darwin" {
		return uint64(raw)
	}
	return uint64(raw) * 1024
}

// millis converts a duration to milliseconds as a float, so sub-millisecond
// rounds stay distinguishable.
func millis(duration time.Duration) float64 {
	return float64(duration) / float64(time.Millisecond)
}

// countingWriter counts and discards: the child's stdout can be a hundred
// megabytes, and retaining it would inflate this process's RSS.
type countingWriter struct {
	count uint64
}

func (w *countingWriter) Write(data []byte) (int, error) {
	w.count += uint64(len(data))
	return len(data), nil
}

// cappedBuffer keeps the tail of a child's diagnostics, bounded.
type cappedBuffer struct {
	limit int
	tail  []byte
}

func newCappedBuffer(limit int) *cappedBuffer {
	return &cappedBuffer{limit: limit}
}

func (b *cappedBuffer) Write(data []byte) (int, error) {
	b.tail = append(b.tail, data...)
	if len(b.tail) > b.limit {
		b.tail = b.tail[len(b.tail)-b.limit:]
	}
	return len(data), nil
}

// suffix renders the retained diagnostics for an error message.
func (b *cappedBuffer) suffix() string {
	trimmed := strings.TrimSpace(string(b.tail))
	if trimmed == "" {
		return ""
	}
	return ": " + trimmed
}

// shortArgs names the invocation in an error without dumping a whole report.
func shortArgs(args []string) string {
	if len(args) > 3 {
		args = args[:3]
	}
	return strings.Join(args, " ")
}
