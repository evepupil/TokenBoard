package state

import (
	"strconv"
	"strings"
)

// tasklistContainsPid reads the PID column of the CSV, never a substring anywhere in the
// line. The row is `"Image","PID","Session","#","Mem"`, so a bare `contains` also matched
// the Session# column — `tasklist /FI "PID eq 1"` would report every process in session 1
// as the entry it was asked about. The TS side anchors on the second field
// (`^"[^"]+","(\d+)"(?:,|$)`); this does the same without a regex.
func tasklistContainsPid(output string, pid int) bool {
	want := strconv.Itoa(pid)
	for _, line := range strings.Split(output, "\r\n") {
		if len(line) == 0 || line[0] != '"' {
			// The localized "no tasks match" notice, or a blank trailing line.
			continue
		}
		rest := line[1:]
		endQuote := strings.IndexByte(rest, '"')
		if endQuote < 0 {
			continue
		}
		// Skip the separator between the image name and the PID field.
		rest = rest[endQuote+1:]
		if !strings.HasPrefix(rest, `,"`) {
			continue
		}
		rest = rest[2:]
		end := strings.IndexByte(rest, '"')
		if end < 0 {
			continue
		}
		if rest[:end] == want {
			return true
		}
	}
	return false
}
