package jsonl

import (
	"encoding/json"
	"regexp"
	"strings"
)

var jsonNumberPattern = regexp.MustCompile(`^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$`)

func jsonUnmarshalString(quoted []byte, target *string) error {
	return json.Unmarshal(quoted, target)
}

// TrimJSWhitespace trims a line the way JS `String#trim` does: the ECMAScript WhiteSpace and
// LineTerminator sets, which include a U+FEFF BOM, at either end. Every TS reader calls
// `line.trim()` before `JSON.parse`, so a line carrying a BOM after the value still parses on
// that side. Go's strings.TrimSpace is not the same set: it leaves U+FEFF in place (rejecting a
// line TS accepts) and it trims U+0085 NEL (accepting a line TS rejects). Both directions have
// to match, so the set is spelled out rather than taken from unicode.IsSpace.
func TrimJSWhitespace(value string) string {
	return strings.TrimFunc(value, isJSWhitespace)
}

func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		'\u00A0', '\u1680', '\u2028', '\u2029', '\u202F', '\u205F', '\u3000',
		'\uFEFF':
		return true
	}
	return r >= '\u2000' && r <= '\u200A'
}
