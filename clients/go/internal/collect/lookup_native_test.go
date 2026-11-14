package collect

import (
	"context"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// ccusageTestProvider stands in for the ccusage-backed provider Lookup serves.
type ccusageTestProvider struct{}

func (ccusageTestProvider) Collect(context.Context, Options) ([]contract.Snapshot, error) {
	return nil, nil
}

// nativeTestProvider stands in for a future native provider.
type nativeTestProvider struct{}

func (nativeTestProvider) Collect(context.Context, Options) ([]contract.Snapshot, error) {
	return nil, nil
}

// TestLookupNativeWithoutRegistrationReportsNoProvider pins the seam's shape:
// a source nobody registered natively resolves to (nil, false) rather than to a
// ccusage-backed fallback. Which sources HAVE a registration is decided by the
// provider packages' init() (providers/claudecode/register.go), and this
// package's own test binary does not link them - the per-source assertion lives
// in TestRegisterNativeAlwaysInstallsTheNativeProvider there.
func TestLookupNativeWithoutRegistrationReportsNoProvider(t *testing.T) {
	for _, source := range contract.AllSources() {
		provider, ok := LookupNative(source)
		if ok || provider != nil {
			t.Fatalf("LookupNative(%q) = (%v, %v) with no registration in this test binary, want (nil, false)", source, provider, ok)
		}
	}
}

// TestLookupNativeIsSeparateFromLookup proves the two seams do not share a
// registry: a ccusage-backed provider installed through Lookup's registry must
// stay invisible to LookupNative, and a native provider must stay invisible to
// Lookup. Sharing one map would make the parity harness exec ccusage on both
// sides and pass trivially.
func TestLookupNativeIsSeparateFromLookup(t *testing.T) {
	source := contract.SourceClaudeCode

	restoreLookup := OverrideProvider(source, ccusageTestProvider{})
	defer restoreLookup()
	if _, ok := LookupNative(source); ok {
		t.Fatalf("LookupNative(%q) sees the Lookup registry entry", source)
	}

	// RegisterNative has no unregister counterpart yet: S2+ owns the native
	// registry, and only this package's tests write to it directly.
	previous, had := nativeRegistry[source]
	nativeRegistry[source] = nativeTestProvider{}
	defer func() {
		if had {
			nativeRegistry[source] = previous
			return
		}
		delete(nativeRegistry, source)
	}()

	provider, ok := LookupNative(source)
	if !ok || provider == nil {
		t.Fatalf("LookupNative(%q) = (%v, %v), want the registered native provider", source, provider, ok)
	}
	// Lookup must keep answering with the ccusage-backed provider it was given,
	// not the native one.
	lookupProvider, ok := Lookup(source)
	if !ok {
		t.Fatalf("Lookup(%q) lost its provider", source)
	}
	if _, isCcusage := lookupProvider.(ccusageTestProvider); !isCcusage {
		t.Fatalf("Lookup(%q) = %T, want the ccusage-backed provider it was given", source, lookupProvider)
	}
}
