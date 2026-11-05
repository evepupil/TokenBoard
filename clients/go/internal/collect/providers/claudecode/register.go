package claudecode

import (
	"context"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

func init() {
	collect.Register(contract.SourceClaudeCode, provider{})
	// The native seam is registered unconditionally, whatever useNativeClaude
	// says. The parity harness looks the native side up here; leaving it empty
	// until the switch flips would report the source as "not implemented"
	// instead of exercising the adapter.
	collect.RegisterNative(contract.SourceClaudeCode, nativeProvider{})
}

type provider struct{}

// Collect adapts Collect to the registry's Provider interface.
func (provider) Collect(ctx context.Context, options collect.Options) ([]contract.Snapshot, error) {
	return Collect(ctx, Options{
		Timezone: options.Timezone,
		Since:    options.Since,
		Until:    options.Until,
		StateDir: options.StateDir,
		HomeDir:  options.HomeDir,
		Stderr:   options.Stderr,
		Env:      options.EnvValue,
	})
}
