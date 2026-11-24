// Package providers registers every ported source provider. Importing it
// for its side effects wires the registry the CLI resolves against, so
// adding a provider edits only this list and its own package.
package providers

import (
	_ "github.com/MisonL/TokenBoard/clients/go/internal/collect/providers/antigravitycli"
	_ "github.com/MisonL/TokenBoard/clients/go/internal/collect/providers/antigravitygui"
	_ "github.com/MisonL/TokenBoard/clients/go/internal/collect/providers/ccusagetool"
	_ "github.com/MisonL/TokenBoard/clients/go/internal/collect/providers/claudecode"
	_ "github.com/MisonL/TokenBoard/clients/go/internal/collect/providers/codex"
	_ "github.com/MisonL/TokenBoard/clients/go/internal/collect/providers/deepseekharness"
	_ "github.com/MisonL/TokenBoard/clients/go/internal/collect/providers/grokbuild"
	_ "github.com/MisonL/TokenBoard/clients/go/internal/collect/providers/opencode"
	_ "github.com/MisonL/TokenBoard/clients/go/internal/collect/providers/pi"
)
