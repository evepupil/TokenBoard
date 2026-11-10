package runner

import (
	"strings"
	"testing"
)

// acquireEnv is the same stub the acquire tests use.
func acquireEnv(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestConfigArgsPreferDynamicThenExplicitAndRejectMissingFiles(t *testing.T) {
	env := acquireEnv(map[string]string{
		"TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG": "/state/dynamic.json",
		"TOKENBOARD_CCUSAGE_CONFIG":         "/checkout/static.json",
	})
	args, err := ConfigArgs(env, func(path string) bool { return path == "/state/dynamic.json" })
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 2 || args[0] != "--config" || args[1] != "/state/dynamic.json" {
		t.Errorf("args = %v", args)
	}

	args, err = ConfigArgs(acquireEnv(map[string]string{
		"TOKENBOARD_CCUSAGE_CONFIG": "/checkout/static.json",
	}), func(path string) bool { return path == "/checkout/static.json" })
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 2 || args[1] != "/checkout/static.json" {
		t.Errorf("args = %v", args)
	}

	if _, err := ConfigArgs(acquireEnv(map[string]string{
		"TOKENBOARD_CCUSAGE_CONFIG": "/absent.json",
	}), func(string) bool { return false }); err == nil ||
		!strings.Contains(err.Error(), "TOKENBOARD_CCUSAGE_CONFIG does not exist: /absent.json") {
		t.Fatalf("err = %v", err)
	}

	args, err = ConfigArgs(acquireEnv(nil), func(string) bool { return false })
	if err != nil || args != nil {
		t.Errorf("no config vars must produce no args: %v, %v", args, err)
	}
}

// serverURL reconstructs the test server origin for responses that must name
// it (the handler cannot see its own URL).
