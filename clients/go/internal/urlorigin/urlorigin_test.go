package urlorigin

import (
	"net/url"
	"testing"
)

// Every want is the output of Node's `new URL(input).origin`, probed on
// 2026-11-01. The origin is shared state with the TS collector, so these
// values are the contract, not Go's own idea of a canonical URL.
func TestOriginMatchesTheWhatwgParser(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"https://tokenboard.example/api/v1/ingest", "https://tokenboard.example"},
		{"https://TB.Example/a/b?x=1", "https://tb.example"},
		{"https://h.example:8443/x", "https://h.example:8443"},
		{"http://h.example:80/x", "http://h.example"},
		{"https://h.example:443", "https://h.example"},
		{"https://h.example:0443/x", "https://h.example"},
		{"http://h.example:0080", "http://h.example"},
		{"https://user:pw@H.example:8443/x?q=1", "https://h.example:8443"},
		{"https://[2001:db8::1]:8443/x", "https://[2001:db8::1]:8443"},
		{"https://[2001:db8::1]/x", "https://[2001:db8::1]"},
		{"http://[::1]:80/x", "http://[::1]"},

		// Non-ASCII hosts are punycoded (UTS #46 mapping, non-transitional:
		// ß stays ß, fullwidth forms fold to ASCII).
		{"https://ünicode.example", "https://xn--nicode-2ya.example"},
		{"https://例子.测试/api", "https://xn--fsqu00a.xn--0zwm56d"},
		{"https://Bücher.EXAMPLE:443/x", "https://xn--bcher-kva.example"},
		{"https://ÉCOLE.fr:8443", "https://xn--cole-9oa.fr:8443"},
		{"https://faß.de", "https://xn--fa-hia.de"},
		{"https://ＡＢＣ.example", "https://abc.example"},
		{"https://例子.测试:8443/api", "https://xn--fsqu00a.xn--0zwm56d:8443"},
	}
	for _, tc := range cases {
		parsed, err := url.Parse(tc.input)
		if err != nil {
			t.Errorf("%q: parse: %v", tc.input, err)
			continue
		}
		got, err := Origin(parsed)
		if err != nil {
			t.Errorf("%q: %v", tc.input, err)
			continue
		}
		if got != tc.want {
			t.Errorf("%q: got %q want %q", tc.input, got, tc.want)
		}
	}
}

// Node's URL parser throws for a host UTS #46 rejects, so the TS helpers
// report no origin at all. Go has to refuse as well, not fall back to the raw
// host, or the two clients would key the same cache differently.
func TestOriginRefusesAHostTheURLParserRejects(t *testing.T) {
	for _, input := range []string{
		"https://‍.example", // lone zero-width joiner: ContextJ rule
		"https://例子.测试‍.example",
	} {
		parsed, err := url.Parse(input)
		if err != nil {
			continue // the Go parser already refuses it
		}
		if got, err := Origin(parsed); err == nil {
			t.Errorf("%q: got %q, want an error", input, got)
		}
	}
}

// An ASCII host skips IDNA entirely: Node accepts an undecodable punycode
// label and passes it through, while the idna profile would reject it.
func TestOriginKeepsAsciiHostsWithoutIdna(t *testing.T) {
	parsed, err := url.Parse("https://xn--zz.example/x")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	got, err := Origin(parsed)
	if err != nil {
		t.Fatalf("Origin: %v", err)
	}
	if got != "https://xn--zz.example" {
		t.Errorf("got %q", got)
	}
}
