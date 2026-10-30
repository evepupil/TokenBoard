package ccusage

import (
	"os"
	"strings"
)

// credentialEnvKeys are the variables a ccusage child must never inherit.
//
// ccusage runs as a child process, and on a machine with no bundled binary it is
// fetched and executed through the package runner (`npx`, `pnpm dlx`, `bunx`). A
// downloaded package must not be handed the upload token: that token authorizes
// writes as this device, so a compromised or merely careless third-party build
// could read it from its own environment and upload as the user.
//
// The client never passes the token to a child for any other reason — ccusage
// prices usage from its own catalogue and has no use for it — so the fix is to
// strip credentials from the child environment rather than to add a new channel.
//
// TOKENBOARD_PAIRING_CODE is included for the same reason: it is a short-lived
// credential that redeems a device, and nothing ccusage does needs it.
//
// TOKENBOARD_RELEASE_BASE_URL can carry `user:token@host` — install-collector
// documents exactly that shape for a private feed — so it is scrubbed too. The
// client reads it itself when updating; the child never has a use for it.
//
// TOKENBOARD_REPO_URL is the same shape for a private checkout mirror. The
// collector has no use for it either: only the skill's install and upgrade
// steps consume it, and they do so in their own process.
var credentialEnvKeys = map[string]bool{
	"TOKENBOARD_UPLOAD_TOKEN":     true,
	"TOKENBOARD_PAIRING_CODE":     true,
	"TOKENBOARD_RELEASE_BASE_URL": true,
	"TOKENBOARD_REPO_URL":         true,
}

// scrubCredentialEnv returns env with credential-bearing entries removed. A nil
// or empty env means "inherit the process environment", which is what
// exec.Cmd does; that inherited environment is the one that carries the token,
// so it is materialized here and scrubbed rather than left implicit.
func scrubCredentialEnv(env []string) []string {
	source := env
	if len(source) == 0 {
		source = os.Environ()
	}
	out := make([]string, 0, len(source))
	for _, entry := range source {
		name, _, _ := strings.Cut(entry, "=")
		if credentialEnvKeys[name] {
			continue
		}
		out = append(out, entry)
	}
	return out
}
