package codex

import "testing"

// TS reads the batch size with Number(value), not parseInt: decimals are
// floored, exponents and 0x/0o/0b prefixes are numbers, and a trailing suffix
// makes the whole value NaN (fall back). An Atoi accepted none of those, so
// the same environment gave the two collectors different batch sizes.
func TestReadBatchSizeReadsLikeNumber(t *testing.T) {
	cases := []struct {
		value string
		want  int
	}{
		{"50", 50},
		{" 50 ", 50},
		{"12.9", 12},   // floored
		{"1e3", 1000},  // exponent, then capped
		{"0x10", 16},   // hex prefix
		{"0b11", 3},    // binary prefix
		{"0o17", 15},   // octal prefix
		{"5000", 1000}, // capped at the maximum
		{"0", DefaultBatchSize},
		{"-1", DefaultBatchSize},
		{"50abc", DefaultBatchSize}, // NaN: fall back
		{"", DefaultBatchSize},      // empty means the default
	}
	for _, tc := range cases {
		if got := readBatchSize(func(string) string { return tc.value }); got != tc.want {
			t.Errorf("readBatchSize(%q) = %d, want %d", tc.value, got, tc.want)
		}
	}
}
