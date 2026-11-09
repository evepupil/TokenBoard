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
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	loader, ok := commandLoaders[command]
	if !ok {
		return nil, fmt.Errorf("tools: no native adapter for %q", command)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	entries, err := loader(o)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return entries, nil
}

// HasNativeAdapter reports whether command has an in-process adapter.
func HasNativeAdapter(command string) bool {
	_, ok := commandLoaders[command]
	return ok
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
