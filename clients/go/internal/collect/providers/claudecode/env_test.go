package claudecode

import "testing"

func envReader(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

// TS resolves the since chain with `||`, which treats only the empty string as
// false: a whitespace-only TOKENBOARD_SINCE is the value, and the range
// validation then rejects it. firstNonEmpty trimmed before deciding, so the
// whitespace fell through to TOKENBOARD_DEFAULT_SINCE and the run proceeded
// with a bound the operator never asked for.
func TestAWhitespaceOnlySinceIsRejectedLikeTS(t *testing.T) {
	env := envReader(map[string]string{
		"TOKENBOARD_SINCE":         "   ",
		"TOKENBOARD_DEFAULT_SINCE": "20260101",
	})
	if _, err := buildRangeArgs("", "", env); err == nil {
		t.Fatal("a whitespace-only TOKENBOARD_SINCE must be rejected, not replaced by the default")
	}
}
