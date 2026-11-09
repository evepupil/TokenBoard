package tools

import "time"

// This file ports ccusage-core/src/date_utils.rs: the strict timestamp gate, the
// fixed-width UTC formatter and the timezone-relative calendar day. The strict
// gate is load-bearing - time.RFC3339Nano would accept formats Rust rejects and
// shift entries across day boundaries.

// ParseTSTimestamp is parse_ts_timestamp (date_utils.rs:111-145). It accepts
// exactly four shapes:
//
//	len 20  YYYY-MM-DDTHH:MM:SSZ
//	len 25  YYYY-MM-DDTHH:MM:SS±HH:MM
//	len 24  YYYY-MM-DDTHH:MM:SS.mmmZ
//	len 29  YYYY-MM-DDTHH:MM:SS.mmm±HH:MM
//
// Microseconds, a space separator, a lowercase `t`, a missing zone or a bare
// date all return false.
func ParseTSTimestamp(value string) (int64, bool) {
	if !tsShape(value) {
		return 0, false
	}
	layout := "2006-01-02T15:04:05Z07:00"
	if value[19] == '.' {
		layout = "2006-01-02T15:04:05.000Z07:00"
	}
	parsed, err := time.Parse(layout, value)
	if err != nil {
		return 0, false
	}
	return parsed.UnixMilli(), true
}

func tsShape(value string) bool {
	switch len(value) {
	case 20:
		return value[19] == 'Z'
	case 24:
		return value[19] == '.' && value[23] == 'Z'
	case 25:
		return value[19] == '+' || value[19] == '-'
	case 29:
		return value[19] == '.' && (value[23] == '+' || value[23] == '-')
	default:
		return false
	}
}

// ParseCompactDate is parse_compact_date (date_utils.rs:179-188): exactly eight
// digits naming a real calendar day. Partial bounds return false.
func ParseCompactDate(value string) (time.Time, bool) {
	if len(value) != 8 {
		return time.Time{}, false
	}
	for index := 0; index < len(value); index++ {
		if value[index] < '0' || value[index] > '9' {
			return time.Time{}, false
		}
	}
	parsed, err := time.ParseInLocation("20060102", value, time.UTC)
	if err != nil {
		return time.Time{}, false
	}
	return parsed, true
}

// DateRangeBoundsMs is date_range_bounds_ms (date_utils.rs:212-225): the
// half-open window [since 00:00, the day after until 00:00) in the report
// timezone. A bound that is absent or not a full YYYYMMDD date does not narrow
// its side. A nil result means unbounded.
func DateRangeBoundsMs(since, until, tz string) (sinceMs, untilMs *int64) {
	if date, ok := ParseCompactDate(since); ok {
		millis := startOfDayMillis(date, tz)
		sinceMs = &millis
	}
	if date, ok := ParseCompactDate(until); ok {
		millis := startOfDayMillis(date.AddDate(0, 0, 1), tz)
		untilMs = &millis
	}
	return sinceMs, untilMs
}

// startOfDayMillis is start_of_day_ms (date_utils.rs:232-241): the first
// instant of the civil date in the timezone. A day whose midnight a
// spring-forward transition skips (or a fall-back transition repeats) resolves
// to time.Date's answer, which is the first instant after the gap: Go and Jiff
// both land on the transition instant, never the neighbouring day.
func startOfDayMillis(date time.Time, tz string) int64 {
	location := loadReportLocation(tz)
	return time.Date(date.Year(), date.Month(), date.Day(), 0, 0, 0, 0, location).UnixMilli()
}

// FormatRFC3339Millis is format_rfc3339_millis (date_utils.rs:356-368): always
// UTC, always three fractional digits.
func FormatRFC3339Millis(millis int64) string {
	return time.UnixMilli(millis).UTC().Format("2006-01-02T15:04:05.000Z")
}

// FormatDateTZ is format_date_tz (date_utils.rs:300-337): the calendar day of
// the instant in the report timezone. `local` and an unresolvable name both
// mean the host timezone, matching the Rust fallback.
func FormatDateTZ(millis int64, tz string) string {
	return time.UnixMilli(millis).In(loadReportLocation(tz)).Format("2006-01-02")
}

// loadReportLocation resolves a --timezone value the way parse_tz does; the CLI
// validates the name before adapters run, so the fallback only matters for
// direct callers and tests.
func loadReportLocation(tz string) *time.Location {
	if tz == "" || tz == "local" {
		return time.Local
	}
	location, err := time.LoadLocation(tz)
	if err != nil {
		return time.Local
	}
	return location
}

// DateWithinRange is date_within_range (date_utils.rs:196-203): compare the
// `-`-stripped calendar day against the bounds as strings, both ends inclusive.
// A blank bound is unbounded; partial spellings such as `2026` work because the
// comparison is lexicographic on the compacted form.
func DateWithinRange(date, since, until string) bool {
	compact := compactDate(date)
	if since != "" && compact < compactDate(since) {
		return false
	}
	if until != "" && compact > compactDate(until) {
		return false
	}
	return true
}

func compactDate(date string) string {
	out := make([]byte, 0, len(date))
	for index := 0; index < len(date); index++ {
		if date[index] != '-' {
			out = append(out, date[index])
		}
	}
	return string(out)
}
