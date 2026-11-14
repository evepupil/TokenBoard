// Package collect hosts orchestration: the provider registry, source
// classification, failure semantics, and the transient-error rules.
package collect

import (
	"context"
	"errors"
	"os"
	"strings"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Options is what a provider needs to collect: the timezone to attribute
// dates by, the optional date window, and the cursor scope. The scope is the
// endpoint origin for sync runs (empty for preview and warm-hooks), so the
// cursor file a provider reads and writes is per-server — a machine pointed
// at two endpoints never mixes state. Providers derive their cursor path
// with sessioncursor.FileName(source, options.CursorScope).
type Options struct {
	Timezone    string
	Since       string
	Until       string
	CursorScope string
	// StateDir is where the source's cursor file lives. Providers that keep
	// one read and write it themselves, the way the TS providers do; the CLI
	// only owns the post-upload acknowledgement.
	StateDir string
	// HomeDir is the user's home directory, for a provider whose default
	// source location is under it. Empty resolves the process home.
	HomeDir string
	// Stderr receives per-source diagnostics (skipped paths, unreadable
	// entries). Nil discards them.
	Stderr func(line string)
	// Env resolves provider configuration (TOKENBOARD_GROK_HOME, GROK_HOME,
	// ...). The TS collection context threads its env the same way; nil
	// falls back to the process environment.
	Env func(string) string
	// HookAcknowledgement receives the per-cursor-scope file list a Codex hook
	// run produced. The TS side attaches the same metadata to the returned
	// snapshots with a symbol; Go threads it out of band because the snapshot
	// type is shared with the upload contract. Nil discards it.
	HookAcknowledgement func([]CursorScopeFiles)
}

// CursorScopeFiles is the Codex hook acknowledgement: the session files one
// cursor scope uploaded, so the CLI can acknowledge exactly those revisions
// after a successful upload. An empty CursorScope names the legacy unscopped
// cursor.
type CursorScopeFiles struct {
	CursorScope string
	Files       []sessioncursor.AcknowledgedFile
}

// EnvValue resolves a key through Options.Env, falling back to the process
// environment.
func (o Options) EnvValue(key string) string {
	if o.Env != nil {
		return o.Env(key)
	}
	return os.Getenv(key)
}

// Provider reads one source's local usage records and normalizes them. It
// never uploads or writes cursors itself — the CLI owns those.
type Provider interface {
	Collect(ctx context.Context, options Options) ([]contract.Snapshot, error)
}

// registry maps a source to its provider. Providers register themselves from
// their own files' init functions, so adding one never edits this package.
var registry = map[contract.Source]Provider{}

// Register installs a provider for a source; called from provider packages.
func Register(source contract.Source, provider Provider) {
	registry[source] = provider
}

// Lookup returns the provider for a source. Absent means the source is
// unavailable on this machine (its tool is not installed) — not a failure.
func Lookup(source contract.Source) (Provider, bool) {
	provider, ok := registry[source]
	return provider, ok
}

// nativeRegistry maps a source to its native (in-process) pricing provider.
// It is deliberately separate from registry: registry's providers mostly shell
// out to ccusage, and a parity harness that took the "native" side from it
// would compare ccusage with itself. Provider packages register their native
// implementation from an init() or from the package that owns the seam.
var nativeRegistry = map[contract.Source]Provider{}

// RegisterNative installs a native provider for a source, called from S2+
// provider packages. Until a source is registered here, parity reports it as
// "not implemented" on the native side rather than falling back to ccusage.
func RegisterNative(source contract.Source, provider Provider) {
	nativeRegistry[source] = provider
}

// LookupNative returns the native (in-process) provider for a source. A source
// nothing registered yields (nil, false), so a caller comparing native against
// ccusage must report it as "not implemented" instead of silently collecting it
// with the ccusage-backed Lookup provider.
func LookupNative(source contract.Source) (Provider, bool) {
	provider, ok := nativeRegistry[source]
	return provider, ok
}

// Unregister removes a source's provider and returns the restore function. It
// exists so a test can exercise the "not implemented in this client yet" path:
// every source in the contract has a provider, and a test that called the CLI
// directly would otherwise run a real provider over the machine's own stores.
func Unregister(source contract.Source) (restore func()) {
	previous, had := registry[source]
	delete(registry, source)
	return func() {
		if had {
			registry[source] = previous
		}
	}
}

// OverrideProvider replaces a source's provider and returns the restore
// function. It exists so tests can drive the CLI's failure contract against a
// stub without touching local stores.
func OverrideProvider(source contract.Source, provider Provider) (restore func()) {
	previous, had := registry[source]
	registry[source] = provider
	return func() {
		if had {
			registry[source] = previous
		} else {
			delete(registry, source)
		}
	}
}

// IsOptionalSourceUnavailableIgnoringLanguageServer mirrors the TS
// isOptionalSourceUnavailable: the "tool is not installed here" messages an
// all-source run skips instead of reporting as a failure. Anything else is a
// real collection failure. ignoreLanguageServerUnavailable is the TS switch of
// the same name: when set, an absent language server is "not installed here"
// too. The TS side passes TOKENBOARD_FAIL_ON_SOURCE_ERROR !== '1', so an
// operator who wants a hard failure on every source error gets one.
func IsOptionalSourceUnavailableIgnoringLanguageServer(
	source contract.Source,
	message string,
	ignoreLanguageServerUnavailable bool,
) bool {
	switch source {
	case contract.SourceOpenCode:
		return strings.Contains(message, "OpenCode database not found") ||
			strings.Contains(message, "OpenCode SQLite reader unavailable")
	case contract.SourcePi:
		return strings.Contains(message, "No Pi sessions found")
	case contract.SourceGrokBuild:
		return strings.Contains(message, "No Grok Build sessions found")
	case contract.SourceDeepSeekHarness:
		return strings.Contains(message, "No DeepSeek Harness sessions found") ||
			strings.Contains(message, "This Node.js build lacks zstd support")
	case contract.SourceAntigravityCLI, contract.SourceAntigravity, contract.SourceAntigravityIDE:
		return strings.Contains(message, "Antigravity SQLite reader unavailable") ||
			(ignoreLanguageServerUnavailable &&
				antigravitymeta.IsUnavailableLanguageServerError(errors.New(message))) ||
			strings.Contains(message, "Antigravity conversations directory not found") ||
			strings.Contains(message, "No Antigravity conversations found")
	}
	return false
}
