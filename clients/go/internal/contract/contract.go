// Package contract mirrors packages/usage-core: the UsageSnapshot shape, its
// fail-closed validation, and the exact serialization the server's dedup hash
// is computed over. Byte-level drift here breaks ingest dedup and burns D1
// quota, so the goldens in goldens/ are produced by the TypeScript
// implementation and must never be edited by hand (see goldens/README.md).
package contract

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	// Embedded so timezone validation works on Windows and in slim containers
	// that ship no system zone database.
	_ "time/tzdata"
)

// Source is one usage origin. The string values are wire-format: they appear
// in snapshots uploaded to the server and must stay in lockstep with
// usage-core's usageSources.
type Source string

const (
	SourceClaudeCode      Source = "claude-code"
	SourceCodex           Source = "codex"
	SourceAntigravityCLI  Source = "antigravity-cli"
	SourceAntigravity     Source = "antigravity"
	SourceAntigravityIDE  Source = "antigravity-ide"
	SourceOpenCode        Source = "opencode"
	SourcePi              Source = "pi"
	SourceGrokBuild       Source = "grok-build"
	SourceDeepSeekHarness Source = "deepseek-harness"
)

// Correction marks snapshots whose cost was re-derived from request-level
// token counts rather than taken from the tool's own cost figure.
type Correction string

const CorrectionCodexContextPricing Correction = "codex-context-pricing"

// UsageSources is the closed set of valid sources.
var usageSources = map[Source]bool{
	SourceClaudeCode: true, SourceCodex: true,
	SourceAntigravityCLI: true, SourceAntigravity: true, SourceAntigravityIDE: true,
	SourceOpenCode: true, SourcePi: true, SourceGrokBuild: true, SourceDeepSeekHarness: true,
}

// costUnavailableSources cannot report a cost: the collector uploads
// costUsd=0 and every consumer labels the cost as unavailable rather than
// "$0.00". Deriving one from a pricing table would be a guess.
var costUnavailableSources = map[Source]string{
	SourceAntigravityCLI:  "Antigravity source costs are unavailable; costUsd must be 0",
	SourceAntigravity:     "Antigravity source costs are unavailable; costUsd must be 0",
	SourceAntigravityIDE:  "Antigravity source costs are unavailable; costUsd must be 0",
	SourceGrokBuild:       "Grok Build source costs are unavailable; costUsd must be 0",
	SourceDeepSeekHarness: "DeepSeek Harness source costs are unavailable; costUsd must be 0",
}

// Ceilings mirror usage-core. Both guard server-side int64 SUMs: one extreme
// row would abort a leaderboard statement for every tenant.
const (
	MaxSnapshotTokens  = 1_000_000_000_000
	MaxSnapshotCostUSD = 1_000_000_000

	MaxUsageTimezoneLength  = 80
	MaxUsageModelNameLength = 160
)

// Snapshot is one normalized usage record. Field names follow the wire format
// (snake_case in JSON); the Go names drop the redundant Snapshot suffix.
type Snapshot struct {
	Source        Source     `json:"source"`
	UsageDate     string     `json:"usageDate"`
	Timezone      string     `json:"timezone"`
	Model         string     `json:"model"`
	InputTokens   int64      `json:"inputTokens"`
	OutputTokens  int64      `json:"outputTokens"`
	CacheCreation int64      `json:"cacheCreationTokens"`
	CacheRead     int64      `json:"cacheReadTokens"`
	TotalTokens   int64      `json:"totalTokens"`
	CostUSD       float64    `json:"costUsd"`
	SessionCount  int64      `json:"sessionCount"`
	Correction    Correction `json:"correction,omitempty"`
	CollectedAt   string     `json:"collectedAt"`
}

// allSources is the ordered source list, matching usage-core's usageSources.
var allSources = []Source{
	SourceClaudeCode, SourceCodex,
	SourceAntigravityCLI, SourceAntigravity, SourceAntigravityIDE,
	SourceOpenCode, SourcePi, SourceGrokBuild, SourceDeepSeekHarness,
}

// AllSources returns the usage sources in their canonical order.
func AllSources() []Source {
	out := make([]Source, len(allSources))
	copy(out, allSources)
	return out
}

// IsValidSource reports whether the value is one of the closed set of usage
// sources. Callers validating untrusted payloads use it before switching on a
// source.
func IsValidSource(source string) bool {
	return usageSources[Source(source)]
}

// IsCostUnavailableSource reports whether the source cannot report a cost, so
// costUsd carries no meaning and must be zero.
func IsCostUnavailableSource(source Source) bool {
	_, ok := costUnavailableSources[source]
	return ok
}

// SnapshotKey builds the server's upsert lookup key: source, date and model
// joined by NUL. It excludes timezone and every counter by design — those
// describe the row, not its identity.
func SnapshotKey(source Source, usageDate, model string) string {
	return string(source) + "\x00" + usageDate + "\x00" + model
}

// AckGroupKey is the cursor-side grouping of a snapshot: the source, day,
// timezone and model. It is what an upload acknowledgement names, because the
// cursor keys its pending entries by that group rather than by snapshot key.
func (s Snapshot) AckGroupKey() string {
	return string(s.Source) + "\x00" + s.UsageDate + "\x00" + s.Timezone + "\x00" + s.Model
}

// HashPayload serializes the snapshot exactly as TypeScript's
// JSON.stringify({source, usageDate, ...}) does: fixed key order, no
// whitespace, shortest round-trip float form, omitted only when correction is
// unset (JSON.stringify drops undefined). encoding/json is deliberately not
// used: its float formatting and map handling are not guaranteed stable
// across Go versions, and a byte of drift here defeats server-side dedup.
func (s Snapshot) HashPayload() string {
	var b strings.Builder
	b.WriteString(`{"source":`)
	b.WriteString(QuoteJSONString(string(s.Source)))
	b.WriteString(`,"usageDate":`)
	b.WriteString(QuoteJSONString(s.UsageDate))
	b.WriteString(`,"timezone":`)
	b.WriteString(QuoteJSONString(s.Timezone))
	b.WriteString(`,"model":`)
	b.WriteString(QuoteJSONString(s.Model))
	b.WriteString(`,"inputTokens":`)
	b.WriteString(strconv.FormatInt(s.InputTokens, 10))
	b.WriteString(`,"outputTokens":`)
	b.WriteString(strconv.FormatInt(s.OutputTokens, 10))
	b.WriteString(`,"cacheCreationTokens":`)
	b.WriteString(strconv.FormatInt(s.CacheCreation, 10))
	b.WriteString(`,"cacheReadTokens":`)
	b.WriteString(strconv.FormatInt(s.CacheRead, 10))
	b.WriteString(`,"totalTokens":`)
	b.WriteString(strconv.FormatInt(s.TotalTokens, 10))
	b.WriteString(`,"costUsd":`)
	b.WriteString(FormatJSONFloat(s.CostUSD))
	b.WriteString(`,"sessionCount":`)
	b.WriteString(strconv.FormatInt(s.SessionCount, 10))
	if s.Correction != "" {
		b.WriteString(`,"correction":`)
		b.WriteString(QuoteJSONString(string(s.Correction)))
	}
	b.WriteString("}")
	return b.String()
}

// FormatJSONFloat emits the string JavaScript's Number#toString (and thus
// JSON.stringify) produces for the same double: the shortest round-tripping
// decimal, written in fixed notation while 1e-6 <= |x| < 1e21 and in
// exponential notation outside that range, with a signed exponent that has no
// leading zeros ("1e-7", "1e+21"). Go's own formatters use different
// thresholds and pad the exponent, which would silently drift the dedup hash.
func FormatJSONFloat(f float64) string {
	if f == 0 {
		return "0" // also covers -0, which JS prints as "0"
	}
	abs := math.Abs(f)
	if abs >= 1e-6 && abs < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	mantissa, exponent, found := strings.Cut(strconv.FormatFloat(f, 'e', -1, 64), "e")
	if !found {
		return strconv.FormatFloat(f, 'g', -1, 64)
	}
	sign := "+"
	if strings.HasPrefix(exponent, "-") {
		sign = "-"
		exponent = exponent[1:]
	}
	exponent = strings.TrimLeft(strings.TrimPrefix(exponent, "+"), "0")
	if exponent == "" {
		exponent = "0"
	}
	return mantissa + "e" + sign + exponent
}

// QuoteJSONString applies JSON escaping with the same rules as
// JSON.stringify: control characters as \u00XX except the short escapes,
// and the literal characters passed through unchanged. Go's
// encoding/json differs (it escapes <, >, & and U+2028/9), so strings are
// escaped by hand.
func QuoteJSONString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

var (
	isoDateRe = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})$`)
	// Zod's z.string().datetime() with no options: uppercase T and Z, an
	// optional fractional part of one or more digits, and no numeric offset
	// or missing Z (both of which Go's RFC3339 parser would happily accept).
	dateTimeUTCRe = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$`)
)

// IsValidCollectedAt mirrors Zod's datetime() exactly: UTC-only, real
// calendar date, hour/minute/second in range.
func IsValidCollectedAt(value string) bool {
	match := dateTimeUTCRe.FindStringSubmatch(value)
	if match == nil {
		return false
	}
	if !IsValidIsoDate(match[1] + "-" + match[2] + "-" + match[3]) {
		return false
	}
	hour, _ := strconv.Atoi(match[4])
	minute, _ := strconv.Atoi(match[5])
	second, _ := strconv.Atoi(match[6])
	return hour <= 23 && minute <= 59 && second <= 59
}

// IsValidIsoDate mirrors usage-core isValidIsoDate: canonical YYYY-MM-DD and
// a real calendar date.
func IsValidIsoDate(value string) bool {
	m := isoDateRe.FindStringSubmatch(value)
	if m == nil {
		return false
	}
	year, _ := strconv.Atoi(m[1])
	month, _ := strconv.Atoi(m[2])
	day, _ := strconv.Atoi(m[3])
	if month < 1 || month > 12 || day < 1 {
		return false
	}
	// daysIn: the Go idiom for "did this calendar day exist" — roll to the
	// first of the next month and step back. time.Date normalizes overflow,
	// so December 32nd becomes January 1st and would fail the round-trip.
	t := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	return t.Year() == year && t.Month() == time.Month(month) && t.Day() == day
}

var (
	timezoneMu    sync.RWMutex
	timezoneValid = map[string]bool{}
)

// offsetZonePattern is the offset zone identifier Intl accepts: a sign, two
// digits of hour, and optional two digits of minutes with or without a colon
// — ±HH, ±HHMM, ±HH:MM. Exactly what ECMA-402's TimeZoneOffsetString allows
// for hours 00-23 and minutes 00-59.
var offsetZonePattern = regexp.MustCompile(`^[+-](\d{2})(?::?(\d{2}))?$`)

// goOnlyZoneNames are zone names Go's loader resolves but Intl rejects. `local`
// is the unnamed system zone and `factory` is tzdata's placeholder; `posixrules`
// ships with tzdata as a real file and loads fine, while Intl has no such zone —
// so accepting it here would collect successfully and then fail every upload,
// because the server validates with Intl.
var goOnlyZoneNames = map[string]bool{
	"local":      true,
	"factory":    true,
	"posixrules": true,
}

// LoadLocation resolves a timezone name the way the TS side's Intl.DateTimeFormat
// does: an IANA name through the zone database, or an offset identifier as a
// fixed-offset zone. Callers that format dates must go through this rather than
// time.LoadLocation, which knows nothing about offsets.
//
// The offset form exists because Intl accepts it and the TS collector
// therefore collects under it; refusing the run here would make the two
// clients disagree on a timezone one of them supports.
func LoadLocation(name string) (*time.Location, error) {
	if match := offsetZonePattern.FindStringSubmatch(name); match != nil {
		hours, _ := strconv.Atoi(match[1])
		minutes, _ := strconv.Atoi(match[2])
		// Intl rejects +24:00 and +08:60, so a value outside these bounds is
		// not a zone this client may accept.
		if hours > 23 || minutes > 59 {
			return nil, fmt.Errorf("unknown time zone %s", name)
		}
		offset := hours*3600 + minutes*60
		if name[0] == '-' {
			offset = -offset
		}
		// Intl canonicalizes "-00:00" to "+00:00"; FixedZone keeps the name
		// as given, which is what a caller round-tripping the label expects.
		return time.FixedZone(name, offset), nil
	}
	return time.LoadLocation(name)
}

// IsValidTimezone mirrors usage-core isValidTimezone: non-empty, no leading
// or trailing whitespace, within the length bound, and loadable as an IANA
// zone or an Intl offset identifier. Valid names are cached case-insensitively
// like the TS Set does.
func IsValidTimezone(value string) bool {
	timezone := strings.TrimSpace(value)
	if timezone == "" || timezone != value || utf16Length(timezone) > MaxUsageTimezoneLength {
		return false
	}
	// Go's zone loader accepts these two names (Local is the unnamed system
	// zone, Factory is tzdata's placeholder); Intl rejects every case variant
	// of both, so a value the TS side would refuse must not slip through
	// here either. The lowercase comparison matches Intl's behavior, and on
	// case-insensitive filesystems LoadLocation("factory") would otherwise
	// resolve.
	cacheKey := strings.ToLower(timezone)
	if goOnlyZoneNames[cacheKey] {
		return false
	}
	timezoneMu.RLock()
	ok, cached := timezoneValid[cacheKey]
	timezoneMu.RUnlock()
	if cached {
		return ok
	}
	_, err := LoadLocation(timezone)
	// The TS side additionally caches the resolved canonical name; LoadLocation
	// resolves the same name the same way, so caching the requested one covers it.
	timezoneMu.Lock()
	timezoneValid[cacheKey] = err == nil
	timezoneMu.Unlock()
	return err == nil
}

// UTF16Length counts UTF-16 code units, matching Zod's z.string().max() and
// String.prototype.length. Exported so the provider parsers bound strings the
// same way.
func UTF16Length(s string) int {
	return utf16Length(s)
}

// utf16Length counts UTF-16 code units, matching Zod's z.string().max(),
// which measures JavaScript String#length. Byte counts would reject
// CJK-heavy names the TS side accepts.
func utf16Length(s string) int {
	return len(utf16.Encode([]rune(s)))
}

// Validate applies the full fail-closed rule set the server's Zod schema
// enforces, with the same error messages where they are semantic
// (cost-unavailability, cross-field rules).
func (s Snapshot) Validate() error {
	if !usageSources[s.Source] {
		return fmt.Errorf("source: unknown usage source %q", string(s.Source))
	}
	if !IsValidIsoDate(s.UsageDate) {
		return fmt.Errorf("usageDate: invalid ISO date %q", s.UsageDate)
	}
	if !IsValidTimezone(s.Timezone) {
		return fmt.Errorf("timezone: invalid timezone %q", s.Timezone)
	}
	if s.Model == "" || utf16Length(s.Model) > MaxUsageModelNameLength {
		return fmt.Errorf("model: length must be 1..%d", MaxUsageModelNameLength)
	}
	for _, check := range []struct {
		name  string
		value int64
	}{
		{"inputTokens", s.InputTokens},
		{"outputTokens", s.OutputTokens},
		{"cacheCreationTokens", s.CacheCreation},
		{"cacheReadTokens", s.CacheRead},
		{"totalTokens", s.TotalTokens},
		{"sessionCount", s.SessionCount},
	} {
		if check.value < 0 || check.value > MaxSnapshotTokens {
			return fmt.Errorf("%s: must be an integer in 0..%d", check.name, MaxSnapshotTokens)
		}
	}
	if s.CostUSD < 0 || s.CostUSD > MaxSnapshotCostUSD || math.IsNaN(s.CostUSD) || math.IsInf(s.CostUSD, 0) {
		return fmt.Errorf("costUsd: must be a finite number in 0..%d", MaxSnapshotCostUSD)
	}
	if s.CacheRead > s.TotalTokens {
		return errors.New("cacheReadTokens must not exceed totalTokens")
	}
	if msg, blocked := costUnavailableSources[s.Source]; blocked && s.CostUSD > 0 {
		return errors.New(msg)
	}
	// An explicitly empty correction is not the same as absent: Zod's
	// z.literal rejects "".
	if s.Correction != "" && s.Correction != CorrectionCodexContextPricing {
		return fmt.Errorf("correction: unknown literal %q", string(s.Correction))
	}
	if !IsValidCollectedAt(s.CollectedAt) {
		return fmt.Errorf("collectedAt: must be an RFC3339 UTC timestamp (Z suffix)")
	}
	return nil
}
