// Package jsdate parses a timestamp string the way the JavaScript `new Date(string)` the TS
// collector calls does, for the shapes session logs carry.
//
// The two clients read the same files, so a value one parses and the other does not lands on a
// different usageDate — the server's dedup key — or drops a row outright. Go's `time.Parse` takes
// only its own layouts, and its usual helpers trim whitespace `new Date` does not, so neither the
// layout set nor the trimming could come from the standard library. The accepted shapes are the
// ECMAScript Date Time String Format plus the V8 extensions a machine-written log line uses: a
// space instead of the "T", a lowercase "t"/"z", an offset without the colon, an omitted seconds
// field, and hour "24" meaning the following midnight.
//
// Two V8 details are reproduced because they change the result, not just whether one exists:
// a fraction is truncated to milliseconds (V8 keeps no sub-millisecond precision), and an offset
// hour is bounded at 23. V8 also carries a legacy parser for shapes the ISO grammar does not
// cover (a padded date-only value, "May 9, 2026", slash dates); that path is not reproduced.
// None of those shapes occurs in a machine-written timestamp, and the codex reader keeps its own
// fallback for the one legacy form it genuinely needs — the "… UTC" suffix V8 accepts on a
// space-separated value.
package jsdate

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	dateOnlyPattern    = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	dateTimePattern    = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?([Zz]|[+-]\d{2}:?\d{2})?$`)
	offsetWithColon    = regexp.MustCompile(`^([+-])(\d{2}):(\d{2})$`)
	offsetWithoutColon = regexp.MustCompile(`^([+-])(\d{2})(\d{2})$`)
)

// Parse reads a date-only or date-time string.
//
// A date-only value is UTC midnight and a date-time with an explicit offset (or Z) is honoured;
// a date-time without one is the local zone — which is what `new Date` does with each. The value
// is used exactly as given: no surrounding whitespace is trimmed away, so a padded timestamp this
// reports as unparseable is one V8's strict ISO parser rejects too.
func Parse(value string) (time.Time, bool) {
	if dateOnlyPattern.MatchString(value) {
		return dateOnly(value)
	}
	return parseDateTime(value)
}

// dateOnly builds UTC midnight, letting a day past the month's length roll into the next month
// the way JS normalises it ("2026-02-30" is 2026-03-02). Month and day are range-checked first:
// time.Date would otherwise roll month 13 into the next year instead of rejecting it.
func dateOnly(value string) (time.Time, bool) {
	month, day := atoi(value[5:7]), atoi(value[8:10])
	if month < 1 || month > 12 || day < 1 || day > 31 {
		return time.Time{}, false
	}
	return time.Date(atoi(value[:4]), time.Month(month), day, 0, 0, 0, 0, time.UTC), true
}

func parseDateTime(value string) (time.Time, bool) {
	match := dateTimePattern.FindStringSubmatch(value)
	if match == nil {
		return time.Time{}, false
	}
	year, month, day := atoi(match[1]), atoi(match[2]), atoi(match[3])
	hour, minute := atoi(match[4]), atoi(match[5])
	second := 0
	if match[6] != "" {
		second = atoi(match[6])
	}
	// JS keeps the fields in range rather than rolling them: "2026-13-01" and "…T25:00Z" are
	// both rejected, while hour 24 is the one documented exception.
	if month < 1 || month > 12 || day < 1 || day > 31 || minute > 59 || second > 59 || hour > 24 {
		return time.Time{}, false
	}
	nanoseconds := fractionToNanoseconds(match[7])
	if hour == 24 {
		// 24:00 is the following midnight, and only exactly midnight: V8 rejects
		// "24:30", "24:00:01", and any non-zero fraction — including one shorter than the
		// millisecond it truncates to, so the check is on the raw digits, not the nanoseconds.
		if minute != 0 || second != 0 || !isZeroFraction(match[7]) {
			return time.Time{}, false
		}
	}
	location := time.Local
	if zone := match[8]; zone != "" {
		if zone == "Z" || zone == "z" {
			location = time.UTC
		} else {
			offset, ok := parseOffset(zone)
			if !ok {
				return time.Time{}, false
			}
			location = time.FixedZone("", offset)
		}
	}
	if hour == 24 {
		// time.Date normalises day+1, so this is the next day's midnight in the same zone.
		return time.Date(year, time.Month(month), day+1, 0, 0, 0, 0, location), true
	}
	return time.Date(year, time.Month(month), day, hour, minute, second, nanoseconds, location), true
}

func parseOffset(value string) (int, bool) {
	match := offsetWithColon.FindStringSubmatch(value)
	if match == nil {
		match = offsetWithoutColon.FindStringSubmatch(value)
	}
	if match == nil {
		return 0, false
	}
	hours, minutes := atoi(match[2]), atoi(match[3])
	// V8 bounds the offset hour at 23 ("+24:00" is invalid) as well as the minute at 59.
	if hours > 23 || minutes > 59 {
		return 0, false
	}
	seconds := hours*3600 + minutes*60
	if match[1] == "-" {
		seconds = -seconds
	}
	return seconds, true
}

// fractionToNanoseconds scales the digits after the decimal point to nanoseconds. JS keeps only
// millisecond precision — "…07.123456789Z" is 123 ms there — so the digits past the third are
// dropped rather than carried into the instant.
func fractionToNanoseconds(fraction string) int {
	if fraction == "" {
		return 0
	}
	digits := fraction
	if len(digits) > 3 {
		digits = digits[:3]
	}
	for len(digits) < 3 {
		digits += "0"
	}
	value, err := strconv.Atoi(digits)
	if err != nil {
		return 0
	}
	return value * int(time.Millisecond)
}

// isZeroFraction reports whether the fractional-second digits are all "0" (or absent).
func isZeroFraction(fraction string) bool {
	for index := 0; index < len(fraction); index++ {
		if fraction[index] != '0' {
			return false
		}
	}
	return true
}

func atoi(value string) int {
	parsed, err := strconv.Atoi(strings.TrimLeft(value, "0"))
	if err != nil {
		return 0
	}
	return parsed
}
