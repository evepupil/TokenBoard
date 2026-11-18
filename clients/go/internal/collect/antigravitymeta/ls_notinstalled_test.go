package antigravitymeta

import (
	"errors"
	"testing"
)

// The not-installed message is the one unavailable-language-server shape that
// survives TOKENBOARD_FAIL_ON_SOURCE_ERROR — the CLI matches it by this
// substring, so the prefix constant and the predicate have to agree.
func TestIsLanguageServerNotInstalled(t *testing.T) {
	message := LanguageServerNotInstalledPrefix + "/Applications/Antigravity.app/Contents/Resources/bin/language_server"
	if !IsLanguageServerNotInstalled(message) {
		t.Fatalf("%q should read as not installed", message)
	}
	if !IsUnavailableLanguageServerError(errors.New(message)) {
		t.Fatalf("%q should still count as an unavailable language server", message)
	}
	if IsLanguageServerNotInstalled("spawn /x ENOENT") {
		t.Fatal("a spawn ENOENT is not the not-installed shape")
	}
}
