// Package mtime reproduces the millisecond timestamp Node's fs stat reports,
// for the values persisted in cursor files shared with the TypeScript
// collector.
package mtime

import (
	"math"
	"time"
)

// Millis returns t as Node's fs.Stats#mtimeMs would: whole seconds scaled to
// milliseconds first, then the sub-second part, then the two added. Dividing
// the nanosecond epoch in one step instead rounds differently in the last bit
// for present-day timestamps, and a cursor written by one client would then
// not compare equal to the same file read by the other.
func Millis(t time.Time) float64 {
	return millis(t.Unix(), t.Nanosecond())
}

// millis keeps the fused-multiply-add out of the arm64 build. sec*1e3 is exact
// for every timestamp this client can see (|sec| < 2^53/1e3, i.e. past the year
// 280000), so fusing `sec*1e3 + nsec/1e6` into FMADDD could not change the
// result - but the CI arm64 gate scans the whole tree for FMADDD with no
// exemption list, and a guarded product is cheaper than an exception that would
// silently stop covering a future call site.
//
//go:noinline
func millis(sec int64, nsec int) float64 {
	whole := float64(sec) * 1e3
	return math.Float64frombits(math.Float64bits(whole)) + float64(nsec)/1e6
}
