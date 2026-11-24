package antigravitymeta

import (
	"regexp"
	"strings"
)

// IsUnavailableLanguageServerError reports the language-server failures that
// only mean "the server is not here": the patterns the TS
// isUnavailableLanguageServerError matches. It lives here rather than in a
// provider package so the CLI's availability classifier can share it without
// an import cycle.
func IsUnavailableLanguageServerError(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "Antigravity language server exited before it was ready") ||
		strings.Contains(message, "Timed out starting Antigravity language server") ||
		strings.HasPrefix(message, "Antigravity metadata request failed for ") ||
		strings.HasPrefix(message, "Antigravity metadata request transport failed for ") ||
		strings.HasPrefix(message, "Antigravity metadata request timed out for ") ||
		IsLanguageServerNotInstalled(message) ||
		SpawnENOENTPattern.MatchString(message)
}

// LanguageServerNotInstalledPrefix opens the message for "the default install
// path holds no language server", raised from a plain stat instead of a spawn
// failure. It is a substring of every message, path included, so the CLI
// availability predicate can match it without parsing.
//
// The distinction from spawn ENOENT is deliberate: that pattern also matches a
// path the client mangled (the "path contains spaces" regression a strict-mode
// test pins), which is a client bug and must keep failing. A path the client
// built itself and stat'ed does not have that ambiguity.
const LanguageServerNotInstalledPrefix = "Antigravity language server is not installed at "

// IsLanguageServerNotInstalled reports the missing-at-default-path shape.
func IsLanguageServerNotInstalled(message string) bool {
	return strings.Contains(message, LanguageServerNotInstalledPrefix)
}

// SpawnENOENTPattern is the TS /^spawn .*(Antigravity.*language_server|tokenboard-antigravity-language-server) ENOENT/:
// a language-server binary that is not installed at the path the client tried.
var SpawnENOENTPattern = regexp.MustCompile(
	`^spawn .*(Antigravity.*language_server|tokenboard-antigravity-language-server) ENOENT`)
