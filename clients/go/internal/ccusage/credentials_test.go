package ccusage

import (
	"sort"
	"strings"
	"testing"
)

// TestCredentialEnvKeysAreTheDocumentedSet pins the exact scrub list on the Go
// side. The skill's child-env.test.mjs already cross-checks the skill list
// against the TypeScript collector list, but nothing compared the Go copy, so a
// key removed or renamed here would ship a silently weaker scrub with no red
// test. This closes that half of the three-way contract AGENTS.md describes.
func TestCredentialEnvKeysAreTheDocumentedSet(t *testing.T) {
	want := []string{
		"TOKENBOARD_ARCHIVE_URL",
		"TOKENBOARD_PAIRING_CODE",
		"TOKENBOARD_RELEASE_BASE_URL",
		"TOKENBOARD_REPO_URL",
		"TOKENBOARD_UPLOAD_TOKEN",
	}
	got := make([]string, 0, len(credentialEnvKeys))
	for key := range credentialEnvKeys {
		got = append(got, key)
	}
	sort.Strings(got)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("credentialEnvKeys = %v, want %v (the key set must match the TS and skill lists)", got, want)
	}
}
