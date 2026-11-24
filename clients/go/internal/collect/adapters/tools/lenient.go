package tools

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"
)

// This file ports the lenient field readers in adapters/common/src/jsonl.rs and
// the small value helpers beside them. The rule they all share: an unexpected
// JSON type is a default value, never a parse failure, so one odd field cannot
// discard a whole line or file.

// DecodeJSONLine decodes one JSONL line into a generic value with numbers kept
// as json.Number and accepts content after the value. Use it only where the
// Rust side's reader does the same (serde_json::from_slice pulls one value and
// ignores what follows); Copilot's pipelines deserialize a whole line, so they
// use copilot.DecodeJSONLineStrict instead.
func DecodeJSONLine(line []byte) (any, bool) {
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, false
	}
	return value, true
}

// LenientU64 is lenient_u64 (jsonl.rs:75-84): serde's Value::as_u64. Floats,
// strings, negative numbers and null are all zero; only a non-negative integer
// literal reads back.
func LenientU64(value any) uint64 {
	number, ok := value.(json.Number)
	if !ok {
		return 0
	}
	parsed, err := number.Int64()
	if err != nil || parsed < 0 {
		return 0
	}
	return uint64(parsed)
}

// LenientF64 is lenient_f64 (jsonl.rs:112-118): Value::as_f64, so any JSON
// number reads back and nothing else does.
func LenientF64(value any) (float64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	parsed, err := number.Float64()
	if err != nil {
		return 0, false
	}
	return parsed, true
}

// LenientObject is lenient_object (jsonl.rs:131-141): only a JSON object reads
// back as a map; null, arrays and scalars are absent.
func LenientObject(value any) (map[string]any, bool) {
	object, ok := value.(map[string]any)
	return object, ok
}

// NonEmptyString is non_empty_json_string (jsonl.rs:196-202): non-strings and
// empty-after-trim strings are absent, and surviving strings are trimmed.
func NonEmptyString(value any) (string, bool) {
	text, ok := value.(string)
	if !ok {
		return "", false
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "", false
	}
	return trimmed, true
}

// PickU64 is pick_u64 (codebuff parser.rs:469-474): the first argument that is
// a positive u64, else zero.
func PickU64(values ...any) uint64 {
	for _, value := range values {
		if parsed := LenientU64(value); parsed > 0 {
			return parsed
		}
	}
	return 0
}

// PositiveFinite is number_field (codebuff parser.rs:461-467): a finite JSON
// number greater than zero, else zero.
func PositiveFinite(value any) float64 {
	parsed, ok := LenientF64(value)
	if !ok || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed <= 0 {
		return 0
	}
	return parsed
}

// SaturatingAddU64 adds without wrapping.
func SaturatingAddU64(left, right uint64) uint64 {
	sum := left + right
	if sum < left {
		return math.MaxUint64
	}
	return sum
}

// TokenCount hands a u64 token count to the int64 pricing engine. The adapter
// counts in u64 like Rust, and nativepricing bills int64: a raw conversion of a
// count past 2^63-1 wraps negative, which tieredCost reads as "no tokens" and
// bills at zero (and the missing-pricing total check reads as empty). Rust's
// u64 counter has no such wrap, so clamping keeps the bill on the high side
// instead of dropping it.
func TokenCount(value uint64) int64 {
	if value > math.MaxInt64 {
		return math.MaxInt64
	}
	return int64(value)
}

// SaturatingSubU64 subtracts without underflowing.
func SaturatingSubU64(left, right uint64) uint64 {
	if right > left {
		return 0
	}
	return left - right
}

// ASCIILower is Rust's str::to_ascii_lowercase: only A-Z fold, so a non-ASCII
// rune (a Turkish İ, a full-width letter) keeps its spelling exactly as the
// Rust adapters compare it. strings.ToLower performs Unicode case folding and
// would diverge there, changing which provider/model candidate gets priced.
func ASCIILower(value string) string {
	lowered := []byte(value)
	for index := range lowered {
		if lowered[index] >= 'A' && lowered[index] <= 'Z' {
			lowered[index] += 'a' - 'A'
		}
	}
	return string(lowered)
}

// MinU64 is core::cmp::min for the saturating clamp sites.
func MinU64(left, right uint64) uint64 {
	if left < right {
		return left
	}
	return right
}
