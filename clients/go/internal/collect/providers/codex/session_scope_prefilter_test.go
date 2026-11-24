package codex

import "testing"

// The prefilter decodes each line with Go's json.Decoder, which rejects a
// leading U+FEFF that JSON.parse (fed line.trim()) accepts. A BOM-stamped
// token_count line must still yield its timestamp, and trailing content after
// the first value must be rejected the way JSON.parse rejects it.
func TestReadSessionScopeTokenCountTimestampParsesTheEdgesTheTSPrefilterDoes(t *testing.T) {
	line := `{"type":"event_msg","timestamp":"2026-05-09T04:24:07.234Z","payload":{"type":"token_count"}}`
	bom := string([]byte{0xef, 0xbb, 0xbf})
	rows := []struct {
		name  string
		input string
		want  bool
	}{
		{name: "a plain token_count line", input: line, want: true},
		{name: "a BOM-stamped line", input: bom + line, want: true},
		{name: "a BOM after leading whitespace", input: "  " + bom + line, want: true},
		{name: "trailing content after the value", input: line + "garbage", want: false},
		{name: "a non token_count event", input: `{"type":"event_msg","timestamp":"2026-05-09T04:24:07.234Z","payload":{"type":"other"}}`, want: false},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			_, ok := readSessionScopeTokenCountTimestamp(row.input)
			if ok != row.want {
				t.Errorf("ok = %v, want %v", ok, row.want)
			}
		})
	}
}
