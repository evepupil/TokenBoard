package jsdate

import (
	"testing"
	"time"
)

// Every want is the output of Node's `new Date(value)` under TZ=Asia/Shanghai, probed on
// 2026-11-02. The two collectors read the same session files, so a shape one parses and the
// other does not is a row that lands on a different usageDate (the server's dedup key) or is
// dropped. The table is the contract, not Go's own idea of a valid ISO timestamp. Where a shape
// is intentionally not reproduced, the row says so and states the direction.
func TestParseMatchesTheJavaScriptDateParser(t *testing.T) {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatalf("load zone: %v", err)
	}
	previous := time.Local
	time.Local = location
	t.Cleanup(func() { time.Local = previous })

	cases := []struct {
		value string
		want  string // UTC instant, or "" for "JS reports an invalid date"
	}{
		// ======== Canonical ISO 8601 forms ========

		// Standard Z-terminated date-times.
		{"2026-05-09T04:24:07Z", "2026-05-09T04:24:07.000Z"},
		{"2026-05-09T04:24:07.234Z", "2026-05-09T04:24:07.234Z"},

		// Lowercase t/z (V8 extension).
		{"2026-05-09t04:24:07z", "2026-05-09T04:24:07.000Z"},

		// Space instead of T.
		{"2026-05-09 04:24:07Z", "2026-05-09T04:24:07.000Z"},

		// Explicit numeric offset, with and without colon.
		{"2026-05-09T04:24:07+08:00", "2026-05-08T20:24:07.000Z"},
		{"2026-05-09T04:24:07+0800", "2026-05-08T20:24:07.000Z"},
		{"2026-05-09T04:24:07-08:30", "2026-05-09T12:54:07.000Z"},

		// Omitted seconds field.
		{"2026-05-09T04:24Z", "2026-05-09T04:24:00.000Z"},

		// ======== Zone-less date-times ========
		// These are read as local time (Asia/Shanghai = UTC+8).

		{"2026-05-09T04:24", "2026-05-08T20:24:00.000Z"},
		{"2026-05-09T04:24:07", "2026-05-08T20:24:07.000Z"},
		{"2026-05-09 04:24:07", "2026-05-08T20:24:07.000Z"},

		// ======== Date-only ========

		// A bare date is UTC midnight.
		{"2026-05-09", "2026-05-09T00:00:00.000Z"},

		// ======== V8 extensions: hour 24 = following midnight ========

		{"2026-05-09T24:00Z", "2026-05-10T00:00:00.000Z"},
		{"2026-05-09T24:00:00Z", "2026-05-10T00:00:00.000Z"},
		{"2026-05-09T24:00:00.0Z", "2026-05-10T00:00:00.000Z"},
		{"2026-05-09T24:00:00.000Z", "2026-05-10T00:00:00.000Z"},
		{"2026-05-09T24:00:00+00:00", "2026-05-10T00:00:00.000Z"},
		{"2026-05-09T24:00:00-00:00", "2026-05-10T00:00:00.000Z"},
		{"2026-05-09T24:00:00+01:00", "2026-05-09T23:00:00.000Z"},

		// Hour 24 only works at exactly midnight; a sub-minute or fractional time is invalid.
		{"2026-05-09T24:30Z", ""},
		{"2026-05-09T24:00:01Z", ""},
		{"2026-05-09T24:00:00.001Z", ""},
		{"2026-05-09T24:00:00.5Z", ""},
		{"2026-05-09T24:00:00.000001Z", ""},

		// ======== Day overflow ========
		// A day past the month's length rolls forward, the way JS normalises it.

		{"2026-02-30", "2026-03-02T00:00:00.000Z"},
		{"2026-02-30T00:00:00Z", "2026-03-02T00:00:00.000Z"},
		{"2026-02-30T12:00:00", "2026-03-02T04:00:00.000Z"},
		{"2026-04-31", "2026-05-01T00:00:00.000Z"},
		{"2026-04-31T00:00:00Z", "2026-05-01T00:00:00.000Z"},
		{"0000-02-30", "0000-03-01T00:00:00.000Z"},

		// ======== Fraction precision ========
		// V8 truncates the fraction to milliseconds.

		{"2026-05-09T04:24:07.123456789Z", "2026-05-09T04:24:07.123Z"},
		{"2026-05-09T04:24:07.1Z", "2026-05-09T04:24:07.100Z"},
		{"2026-05-09T04:24:07.999999999Z", "2026-05-09T04:24:07.999Z"},
		{"2026-05-09T04:24:07.123456789+08:00", "2026-05-08T20:24:07.123Z"},

		// ======== Padding, strict layer ========
		// A "T" separator selects V8's strict ISO grammar, which does not trim, so a padded
		// "…T…" value is an invalid date there and here.

		{" 2026-05-09T04:24:07Z", ""},
		{"2026-05-09T04:24:07Z ", ""},
		{" 2026-05-09T04:24:07", ""},
		{"2026-05-09T04:24:07 ", ""},
		{"\t2026-05-09T04:24:07Z", ""},

		// ======== Padding, legacy layer ========
		// The space-separated form and the bare date go to V8's legacy parser, which does trim.
		// A trimmed bare date is *local* midnight, not the UTC midnight the unpadded form gives.

		{" 2026-05-09 04:24:07", "2026-05-08T20:24:07.000Z"},
		{"2026-05-09 04:24:07 ", "2026-05-08T20:24:07.000Z"},
		{" 2026-05-09 04:24:07 ", "2026-05-08T20:24:07.000Z"},
		{"\t2026-05-09 04:24:07", "2026-05-08T20:24:07.000Z"},
		{" 2026-05-09 04:24:07Z", "2026-05-09T04:24:07.000Z"},
		{"2026-05-09 04:24:07Z ", "2026-05-09T04:24:07.000Z"},
		{" 2026-05-09", "2026-05-08T16:00:00.000Z"},
		{"2026-05-09 ", "2026-05-08T16:00:00.000Z"},
		{" 2026-05-09 04:24:07", "2026-05-08T20:24:07.000Z"},
		{"\uFEFF2026-05-09", "2026-05-08T16:00:00.000Z"},

		// The legacy layer does not trim the two line separators or U+0085, so those stay invalid.
		{" 2026-05-09", ""},
		{"\u00852026-05-09", ""},

		// ======== Invalid offset forms ========

		// A colon-less offset with a "T" separator and an offset hour past 23 are both invalid.
		{"2026-05-09T04:24:07+08", ""},
		{"2026-05-09T00:00:00+24:00", ""},
		{"2026-05-09T00:00:00+2400", ""},
		{"2026-05-09T00:00:00+99:99", ""},
		{"2026-05-09T00:00:00+2360", ""},

		// On the space-separated form V8's legacy scanner is laxer than this port (a free-form
		// numeric offset with no hour bound). Those three shapes are rejected here, so a row
		// carrying one is dropped rather than mis-dated — the fail-closed direction. See the
		// package doc for why they are not reproduced.
		{"2026-05-09 04:24:07+08", ""},
		{"2026-05-09 04:24:07+24:00", ""},
		{"2026-05-09 04:24:07+2360", ""},

		// ======== Truly invalid dates ========

		{"2026-13-01", ""}, // month 13
		{"2026-01-32", ""}, // day 32
		{"2026-00-10", ""}, // month zero
		{"2026-05-00", ""}, // day zero
		{"2026-05-09T25:00Z", ""},
		{"2026-05-09T23:60Z", ""},
		{"2026-05-09T23:59:60Z", ""},

		// ======== Free-form legacy shapes ========
		// V8's legacy parser reads these; no machine-written timestamp uses them, and the codex
		// reader keeps its own fallback for the one it needs, so none is accepted here.

		{"20260509", ""},
		{"", ""},
		{"May 9, 2026", ""},
		{"2026/05/09", ""},
		{"2026-05-09 UTC", ""},
		{"2026-05-09T04:24:07 UTC", ""},
		{"2026-05-09T04:24:07Z UTC", ""},
	}
	for _, tc := range cases {
		parsed, ok := Parse(tc.value)
		if tc.want == "" {
			if ok {
				t.Errorf("Parse(%q) = %s, want an invalid date", tc.value, parsed.UTC().Format("2006-01-02T15:04:05.000Z"))
			}
			continue
		}
		if !ok {
			t.Errorf("Parse(%q) = invalid, want %s", tc.value, tc.want)
			continue
		}
		if got := parsed.UTC().Format("2006-01-02T15:04:05.000Z"); got != tc.want {
			t.Errorf("Parse(%q) = %s, want %s", tc.value, got, tc.want)
		}
	}
}
