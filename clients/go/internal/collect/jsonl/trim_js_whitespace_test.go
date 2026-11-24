package jsonl

import "testing"

// The exact set ECMAScript `String#trim` removes, probed against Node on 2026-10-31. Every TS
// reader calls `line.trim()` before `JSON.parse`, so the Go ports have to trim the identical set
// or the two sides disagree about which rows are malformed. Two members matter most:
// U+FEFF (BOM) is trimmed by JS but NOT by Go's strings.TrimSpace, and U+0085 (NEL) is trimmed
// by TrimSpace but NOT by JS.
func TestTrimJSWhitespaceMatchesTheECMAScriptSet(t *testing.T) {
	trimmable := []rune{
		'\t', '\n', '\v', '\f', '\r', ' ',
		'\u00A0', '\u1680',
		'\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008',
		'\u2009', '\u200A',
		'\u2028', '\u2029', '\u202F', '\u205F', '\u3000',
		'\uFEFF',
	}
	for _, r := range trimmable {
		if got := TrimJSWhitespace(string(r) + "x" + string(r)); got != "x" {
			t.Errorf("U+%04X must be trimmed, got %q", r, got)
		}
	}

	// U+FEFF is the one strings.TrimSpace misses, and this is the whole point of the helper.
	if got := TrimJSWhitespace("\uFEFF{\"a\":1}\uFEFF"); got != `{"a":1}` {
		t.Errorf("TrimJSWhitespace(BOM-wrapped) = %q, want the bare object", got)
	}

	kept := []rune{
		'\u0085', // NEL: strings.TrimSpace trims it, JS does not.
		'\u180E', // Mongolian vowel separator: was whitespace in older JS, is not now.
		'\u200B', // zero-width space: never trimmed.
	}
	for _, r := range kept {
		if got := TrimJSWhitespace(string(r) + "x" + string(r)); got != string(r)+"x"+string(r) {
			t.Errorf("U+%04X must be kept, got %q", r, got)
		}
	}

	// A BOM between two tokens is not at either end, so it stays — and the JSON decode then
	// rejects the line, which is what JS does too.
	if got := TrimJSWhitespace("{\"a\":1}\uFEFF{\"b\":2}"); got != "{\"a\":1}\uFEFF{\"b\":2}" {
		t.Errorf("a mid-line BOM must be kept, got %q", got)
	}
}
