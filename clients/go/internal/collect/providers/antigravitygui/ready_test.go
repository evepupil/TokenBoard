package antigravitygui

import (
	"math"
	"testing"
	"time"
)

// A knob value big enough to overflow the Duration conversion must saturate to
// an effectively-unbounded deadline, not wrap to a negative one that fails the
// readiness probe instantly (the same failure the claude/codex/tool budgets
// fixed). This is the third production path that turns a millisecond knob into
// a deadline.
func TestReadReadyTimeoutSaturatesAtTheDurationCeiling(t *testing.T) {
	for _, raw := range []string{"10000000000000", "99999999999999999999999"} {
		t.Setenv("TOKENBOARD_ANTIGRAVITY_READY_TIMEOUT_MS", raw)
		got := readReadyTimeout()
		if got != time.Duration(math.MaxInt64) {
			t.Fatalf("readReadyTimeout(%q) = %v, want the MaxInt64 saturation", raw, got)
		}
	}
}

// TS reads this with Number.parseInt(…, 10), so a trailing suffix still
// yields a usable timeout. Atoi rejected those and silently used the default,
// which meant a machine could wait a different amount of time per client.
func TestReadReadyTimeoutReadsLikeParseInt(t *testing.T) {
	cases := []struct {
		value string
		want  int64 // milliseconds
	}{
		{"5000", 5000},
		{"5000ms", 5000},
		{" 5000", 5000},
		{"5000.9", 5000},
		{"0", defaultReadyTimeout.Milliseconds()},
		{"-1", defaultReadyTimeout.Milliseconds()},
		{"abc", defaultReadyTimeout.Milliseconds()},
	}
	for _, tc := range cases {
		t.Setenv("TOKENBOARD_ANTIGRAVITY_READY_TIMEOUT_MS", tc.value)
		if got := readReadyTimeout().Milliseconds(); got != tc.want {
			t.Errorf("readReadyTimeout(%q) = %dms, want %dms", tc.value, got, tc.want)
		}
	}
}
