package runner

import (
	"fmt"
	"os"
	"strings"
)

// ConfigArgs appends the `--config` pair every ccusage invocation carries.
//
// The dynamic config (generated from the server catalogue) wins over an
// explicit one; a configured path that does not exist is an error, not a
// silently dropped flag — ccusage would otherwise fall back to its built-in
// prices and report costs the catalogue never approved.
func ConfigArgs(env func(string) string, fileExists func(string) bool) ([]string, error) {
	if env == nil {
		env = os.Getenv
	}
	if fileExists == nil {
		fileExists = func(path string) bool {
			info, err := os.Stat(path)
			return err == nil && info.Mode().IsRegular()
		}
	}
	dynamic := strings.TrimSpace(env("TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG"))
	explicit := strings.TrimSpace(env("TOKENBOARD_CCUSAGE_CONFIG"))
	configPath := dynamic
	variable := "TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG"
	if configPath == "" {
		configPath = explicit
		variable = "TOKENBOARD_CCUSAGE_CONFIG"
	}
	if configPath == "" {
		return nil, nil
	}
	if !fileExists(configPath) {
		return nil, fmt.Errorf("%s does not exist: %s", variable, configPath)
	}
	return []string{"--config", configPath}, nil
}
