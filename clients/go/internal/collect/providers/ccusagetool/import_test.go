package ccusagetool

// The copilot adapter registers itself from its init (adapters/copilot/register.go).
// It is imported here so the package under test - and any build of it - always
// carries that registration; production reaches the same init through this
// package's own imports of the adapters.
import _ "github.com/MisonL/TokenBoard/clients/go/internal/collect/adapters/copilot"
