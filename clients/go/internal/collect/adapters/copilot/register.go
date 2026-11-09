package copilot

import "github.com/MisonL/TokenBoard/clients/go/internal/collect/adapters/tools"

// Register installs the copilot adapter under its CLI command name. The native
// provider calls it at initialization instead of blank-importing this package:
// the copilot package imports tools for the shared readers, so tools cannot
// import it back.
func Register() {
	tools.RegisterWindowed("copilot", func(o tools.Options, window *tools.Window) ([]tools.Entry, error) {
		input := LoadInput{Options: o}
		if window != nil {
			input.Since, input.Until = window.Since, window.Until
			input.SinceMs, input.UntilMs = window.SinceMs, window.UntilMs
		}
		return Load(input)
	})
}

func init() { Register() }
