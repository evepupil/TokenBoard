package ccusage

// The report-source seam the providers call after S5 (2026-11-10). Once every
// source answers from its in-process adapter, the only caller-facing shape of
// a "ccusage run" is this: a report label, an argument list the provider built
// and the per-call budget and environment. The subprocess implementation that
// used to back the same seam (internal/ccusage/exec and its acquisition and
// package-runner layers) is gone; the types keep their TS names so every call
// site still reads like the code it ports.

import (
	"context"
	"fmt"
	"time"
)

// CommandOptions configures one report call.
type CommandOptions struct {
	Env        []string
	TimeoutMs  int
	Retries    int
	RetryDelay time.Duration
	OnRetry    func(line string)
}

// ReportCommand is the label every runner receives. It names the report shape
// (a ccusage JSON document), not a binary that runs.
const ReportCommand = "ccusage"

// CommandRunner answers one report call and returns the decoded report in the
// shape ccusage's JSON stdout had (ordered objects, json.Number numbers). The
// command string is the report label (always "ccusage"); the arguments are the
// provider's `claude daily --json --breakdown …` style list.
type CommandRunner func(ctx context.Context, command string, args []string, options CommandOptions) (any, error)

// WithConfigArgs appends the `--config` pair, the runtime equivalent of the
// ConfigArgs rule the package runner used to apply: the prepared dynamic
// config wins over an explicit one, and a configured path that does not exist
// is an error rather than a silently dropped flag (ccusage would otherwise
// fall back to its own prices).
func WithConfigArgs(args []string, env func(string) string, fileExists func(string) bool) ([]string, error) {
	configPath := ""
	variable := "TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG"
	if env != nil {
		configPath = env(variable)
	}
	if configPath == "" {
		variable = "TOKENBOARD_CCUSAGE_CONFIG"
		if env != nil {
			configPath = env(variable)
		}
	}
	if configPath == "" {
		return append([]string{}, args...), nil
	}
	if fileExists != nil && !fileExists(configPath) {
		return nil, fmt.Errorf("%s does not exist: %s", variable, configPath)
	}
	return append(append([]string{}, args...), "--config", configPath), nil
}
