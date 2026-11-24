// Package redact keeps operator-facing diagnostics from naming the account
// directory the client ran under. The scheduled-sync log and hook stderr are
// long-lived local logs that operators paste into issues; the home layout
// reveals the machine's user name, while the file names below it are what
// debugging actually needs. Only the account segment is replaced.
package redact

import (
	"io"
	"regexp"
)

// homePattern matches the three home-path spellings the client can print:
// /Users/<name> (macOS), /home/<name> (Linux), and \Users\<name> (Windows, any
// drive letter). The directory names match case-sensitively on purpose — a
// REST route like /users/ is not a home directory. The segment ends at the
// next separator, whitespace, quote, or colon, so a path that follows the
// account name is kept as-is.
var homePattern = regexp.MustCompile(`([/\\](?:Users|home)[/\\])[^/\\\s"':]+`)

// LocalPaths rewrites the account segment of every home-directory path in a
// message. It is idempotent, so re-redacting an already-redacted message is
// harmless.
func LocalPaths(message string) string {
	return homePattern.ReplaceAllString(message, "${1}<redacted>")
}

// Writer returns w with every write passed through LocalPaths. Every CLI call
// site writes complete lines, so a path cannot be split across two writes.
func Writer(w io.Writer) io.Writer { return redactingWriter{target: w} }

type redactingWriter struct {
	target io.Writer
}

func (w redactingWriter) Write(p []byte) (int, error) {
	if _, err := io.WriteString(w.target, LocalPaths(string(p))); err != nil {
		return 0, err
	}
	return len(p), nil
}
