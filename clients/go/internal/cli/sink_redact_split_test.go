package cli

import (
	"bytes"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/redact"
)

// TestSinkRedactsSplitChildWrites pins the stderr composition: the child's
// output enters the pricing sink as arbitrary byte chunks (the OS never
// splits writes on line boundaries), the sink reassembles complete lines, and
// only then does the line reach the redactor beneath it. A leak would need
// the account segment to cross a Write boundary *below* the line-buffering
// layer; this composition prevents it, and a reordering (redactor above the
// sink, or the sink bypassed) would fail here — including the chunk split
// exactly inside the account name.
func TestSinkRedactsSplitChildWrites(t *testing.T) {
	var out bytes.Buffer
	sink := newPricingDiagnosticSink(redact.Writer(&out))

	first := []byte("Unable to inspect session directory /Users/some")
	second := []byte("one/.claude/projects: permission denied\n")
	if _, err := sink.Write(first); err != nil {
		t.Fatal(err)
	}
	if _, err := sink.Write(second); err != nil {
		t.Fatal(err)
	}
	sink.Flush()

	got := out.String()
	if strings.Contains(got, "someone") {
		t.Fatalf("account name survived the split: %q", got)
	}
	if !strings.Contains(got, "/Users/<redacted>/.claude/projects: permission denied") {
		t.Fatalf("want the redacted path on one line, got %q", got)
	}
	// The sink re-emits with a trailing newline; a stray second write of the
	// partial during Flush would show up as a blank line.
	if strings.Contains(got, "\n\n") || got != "Unable to inspect session directory /Users/<redacted>/.claude/projects: permission denied\n" {
		t.Fatalf("want exactly one clean line, got %q", got)
	}
}
