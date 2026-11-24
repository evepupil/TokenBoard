package redact

import (
	"bytes"
	"strings"
	"testing"
)

func TestLocalPathsRedactsTheAccountSegmentOnly(t *testing.T) {
	cases := map[string]string{
		"Unable to read /Users/alice/.claude/projects/p/session.jsonl":     "Unable to read /Users/<redacted>/.claude/projects/p/session.jsonl",
		"Unable to read /home/bob/.codex/sessions/x.jsonl: permission":     "Unable to read /home/<redacted>/.codex/sessions/x.jsonl: permission",
		`Unable to read C:\Users\carol\.tokenboard\state.json: permission`: `Unable to read C:\Users\<redacted>\.tokenboard\state.json: permission`,
		// A space ends the segment the same way the skill-side redactor treats it.
		"/Users/dave/Library/Application Support/x": "/Users/<redacted>/Library/Application Support/x",
		// Case-sensitive directory names: REST routes are not home directories.
		"GET /api/public/users/alice.json":    "GET /api/public/users/alice.json",
		"see https://example.com/Users/alice": "see https://example.com/Users/<redacted>",
		"no path here":                        "no path here",
	}
	for input, want := range cases {
		if got := LocalPaths(input); got != want {
			t.Fatalf("LocalPaths(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestLocalPathsIsIdempotent(t *testing.T) {
	once := LocalPaths("/Users/alice/.tokenboard/bin")
	if twice := LocalPaths(once); twice != once {
		t.Fatalf("second pass changed %q to %q", once, twice)
	}
}

func TestWriterRedactsEveryWrite(t *testing.T) {
	var buffer bytes.Buffer
	writer := Writer(&buffer)

	if _, err := writer.Write([]byte("one /Users/alice/a\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte("two /home/bob/b\n")); err != nil {
		t.Fatal(err)
	}

	want := "one /Users/<redacted>/a\ntwo /home/<redacted>/b\n"
	if got := buffer.String(); got != want {
		t.Fatalf("buffer = %q, want %q", got, want)
	}
	if strings.Contains(buffer.String(), "alice") || strings.Contains(buffer.String(), "bob") {
		t.Fatalf("buffer = %q, still contains an account name", buffer.String())
	}
}
