package tools

import (
	"context"
	"fmt"
)

// LoadCommand dispatches one ccusage subcommand name to its adapter. The name
// is the CLI command (gemini, not gemini-cli), matching
// contract.CcusageToolCommand. Every loader takes Options only; the context
// wrapper below carries cancellation between files for the native provider's
// timeout budget.
func LoadCommand(ctx context.Context, command string, o Options) ([]Entry, error) {
	return LoadCommandInWindow(ctx, command, o, nil)
}

// LoadCommandInWindow is LoadCommand with the invocation's --since/--until
// handed to a windowed adapter. A nil window means unbounded.
func LoadCommandInWindow(ctx context.Context, command string, o Options, window *Window) ([]Entry, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var (
		entries []Entry
		err     error
	)
	switch {
	case commandLoaders[command] != nil:
		entries, err = commandLoaders[command](o)
	case windowedLoaders[command] != nil:
		entries, err = windowedLoaders[command](o, window)
	default:
		return nil, fmt.Errorf("tools: no native adapter for %q", command)
	}
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return entries, nil
}

// Window is the --since/--until pair one invocation carries, as the half-open
// millisecond bounds DateRangeBoundsMs derives. Only the copilot reconciliation
// reads it; every other adapter applies the window to report dates afterwards.
type Window struct {
	// Since and Until are the raw --since/--until spellings; an absent bound
	// is the empty string.
	Since, Until     string
	SinceMs, UntilMs *int64
}

// WindowedLoader is a tool adapter that lives outside this package (copilot)
// and narrows itself by the invocation window. It is registered with
// RegisterWindowed rather than listed in commandLoaders, because the copilot
// package imports this one for the shared readers.
type WindowedLoader func(Options, *Window) ([]Entry, error)

var windowedLoaders = map[string]WindowedLoader{}

// RegisterWindowed installs one out-of-package adapter under its CLI command
// name. Callers do this from an init; LoadCommand panics on a name that is
// already taken, so a double registration cannot hide a silent overwrite.
func RegisterWindowed(command string, load WindowedLoader) {
	if _, taken := windowedLoaders[command]; taken || commandLoaders[command] != nil {
		panic("tools: adapter already registered for " + command)
	}
	windowedLoaders[command] = load
}

// HasNativeAdapter reports whether command has an in-process adapter.
func HasNativeAdapter(command string) bool {
	return commandLoaders[command] != nil || windowedLoaders[command] != nil
}

var commandLoaders = map[string]func(Options) ([]Entry, error){
	"amp":      LoadAmp,
	"droid":    LoadDroid,
	"codebuff": LoadCodebuff,
	"hermes":   LoadHermes,
	"goose":    LoadGoose,
	"kilo":     LoadKilo,
	"gemini":   LoadGemini,
	"kimi":     LoadKimi,
	"qwen":     LoadQwen,
	"zcode":    LoadZcode,
	"openclaw": LoadOpenclaw,
}
