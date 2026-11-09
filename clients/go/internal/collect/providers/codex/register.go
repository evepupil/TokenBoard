package codex

import (
	"context"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

func init() {
	collect.Register(contract.SourceCodex, provider{})
	// The native seam is registered unconditionally, whatever useNativeCodex
	// says. The parity harness looks the native side up here; leaving it empty
	// until the switch flips would report the source as "not implemented"
	// instead of exercising the adapter.
	collect.RegisterNative(contract.SourceCodex, nativeProvider{})
}

type provider struct{}

// Collect adapts Collect to the registry's Provider interface. The Codex
// homes come from the environment (TOKENBOARD_CODEX_HOMES_JSON, then the
// legacy CODEX_HOME list), so no CLI flag is threaded here.
func (provider) Collect(ctx context.Context, options collect.Options) ([]contract.Snapshot, error) {
	return Collect(ctx, Options{
		Timezone:            options.Timezone,
		Since:               options.Since,
		Until:               options.Until,
		StateDir:            options.StateDir,
		HomeDir:             options.HomeDir,
		Stderr:              options.Stderr,
		Env:                 options.EnvValue,
		HookAcknowledgement: options.HookAcknowledgement,
	})
}
