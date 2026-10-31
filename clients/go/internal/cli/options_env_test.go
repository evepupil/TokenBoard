package cli

import (
	"bytes"
	"strings"
	"testing"
)

// TS resolves the source with `??`, which only falls back on an unset value:
// an empty string is a value, and readSource rejects it. firstNonEmpty treated
// "" as unset and collected `all` instead, so a machine with
// `TOKENBOARD_SOURCE=` exported ran successfully here and exited with an error
// there. The two clients must agree on whether a run is well-formed.
//
// The lookup has to report the variable as set, because that is the whole
// point: only the process environment can tell an exported-but-empty variable
// from an unset one, and the exported case is the one TS rejects.
func TestExportedEmptySourceIsRejectedLikeTS(t *testing.T) {
	lookup := func(key string) (string, bool) {
		if key == "TOKENBOARD_SOURCE" {
			return "", true
		}
		return "", false
	}
	_, err := parseArgsWithLookup([]string{"preview"}, func(string) string { return "" }, lookup)
	if err == nil || !strings.Contains(err.Error(), "Invalid source") {
		t.Fatalf("err = %v, want an invalid-source error", err)
	}
}

// An unset variable still takes the default: that is the case the fallback
// exists for. A lookup returning "" for a key is indistinguishable from unset
// through this type, so the default must survive.
func TestUnsetSourceTakesTheDefault(t *testing.T) {
	// The parse resolves a timezone too, and on Windows that resolution fails
	// closed with no zone available (no /etc/timezone, no TZ). This test is
	// about the source default, so it supplies one; the timezone gate has its
	// own test.
	options, err := parseArgs([]string{"preview"}, func(key string) string {
		if key == "TOKENBOARD_TIMEZONE" {
			return "UTC"
		}
		return ""
	})
	if err != nil {
		t.Fatalf("parseArgs with nothing set: %v", err)
	}
	if options.Source != "all" {
		t.Errorf("source = %q, want all", options.Source)
	}
}

// The distinction only exists in the process environment, so this exercises
// Run rather than the injected form: an exported-but-empty variable is set,
// and TS rejects it instead of collecting everything.
func TestExportedEmptySourceIsAnError(t *testing.T) {
	t.Setenv("TOKENBOARD_STATE_DIR", t.TempDir())
	t.Setenv("TOKENBOARD_SOURCE", "")
	var stdout, stderr bytes.Buffer
	code := Run([]string{"preview"}, &stdout, &stderr)
	if code != ExitUsage {
		t.Fatalf("exit = %d, want %d; stderr: %s", code, ExitUsage, stderr.String())
	}
	if !strings.Contains(stderr.String(), "Invalid source") {
		t.Errorf("stderr = %q, want an invalid-source message", stderr.String())
	}
}

func TestExportedEmptyTimezoneIsAnError(t *testing.T) {
	t.Setenv("TOKENBOARD_STATE_DIR", t.TempDir())
	t.Setenv("TOKENBOARD_TIMEZONE", "")
	var stdout, stderr bytes.Buffer
	code := Run([]string{"preview"}, &stdout, &stderr)
	if code != ExitUsage {
		t.Fatalf("exit = %d, want %d; stderr: %s", code, ExitUsage, stderr.String())
	}
	if !strings.Contains(stderr.String(), "Invalid timezone") {
		t.Errorf("stderr = %q, want an invalid-timezone message", stderr.String())
	}
}
