package ccusage

import (
	"reflect"
	"testing"
)

// withEnv builds an env lookup from a map, the way the providers receive one.
func envOf(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func exists(path string) bool { return path == "/cfg/dynamic.json" || path == "/cfg/explicit.json" }

// The dynamic config the catalogue produced wins over the user's own file.
func TestWithConfigArgsPrefersTheDynamicConfig(t *testing.T) {
	args, err := WithConfigArgs([]string{"amp", "daily", "--json"}, envOf(map[string]string{
		"TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG": "/cfg/dynamic.json",
		"TOKENBOARD_CCUSAGE_CONFIG":         "/cfg/explicit.json",
	}), exists)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"amp", "daily", "--json", "--config", "/cfg/dynamic.json"}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("args = %v, want %v", args, want)
	}
}

// With no dynamic config the user's explicit one is used.
func TestWithConfigArgsFallsBackToTheExplicitConfig(t *testing.T) {
	args, err := WithConfigArgs([]string{"amp", "daily"}, envOf(map[string]string{
		"TOKENBOARD_CCUSAGE_CONFIG": "/cfg/explicit.json",
	}), exists)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"amp", "daily", "--config", "/cfg/explicit.json"}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("args = %v, want %v", args, want)
	}
}

// Neither set means no flag at all, and the input is copied rather than
// appended to in place: the caller reuses its base argument list for the
// session report.
func TestWithConfigArgsWithoutAConfigAddsNothing(t *testing.T) {
	base := []string{"amp", "daily"}
	args, err := WithConfigArgs(base, envOf(nil), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(args, []string{"amp", "daily"}) {
		t.Errorf("args = %v", args)
	}
	args[0] = "changed"
	if base[0] != "amp" {
		t.Error("WithConfigArgs appended into the caller's slice")
	}
}

// A configured path that does not exist is an error, not a dropped flag:
// ccusage would otherwise bill from its own prices.
func TestWithConfigArgsRejectsAMissingConfig(t *testing.T) {
	_, err := WithConfigArgs([]string{"amp", "daily"}, envOf(map[string]string{
		"TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG": "/cfg/gone.json",
		"TOKENBOARD_CCUSAGE_CONFIG":         "/cfg/explicit.json",
	}), exists)
	if err == nil {
		t.Fatal("a missing dynamic config was accepted")
	}
	if got := err.Error(); got != "TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG does not exist: /cfg/gone.json" {
		t.Errorf("err = %q", got)
	}
	_, err = WithConfigArgs([]string{"amp", "daily"}, envOf(map[string]string{
		"TOKENBOARD_CCUSAGE_CONFIG": "/cfg/gone.json",
	}), exists)
	if err == nil {
		t.Fatal("a missing explicit config was accepted")
	}
	if got := err.Error(); got != "TOKENBOARD_CCUSAGE_CONFIG does not exist: /cfg/gone.json" {
		t.Errorf("err = %q", got)
	}
}

// A variable holding only whitespace means "not set", exactly as the package
// runner's ConfigArgs read it. Treating it as a path appended `--config " "`
// and failed the run (pricing.Prepare cannot read a file named " ").
func TestWithConfigArgsIgnoresWhitespaceOnlyValues(t *testing.T) {
	args, err := WithConfigArgs([]string{"amp", "daily"}, envOf(map[string]string{
		"TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG": "  ",
		"TOKENBOARD_CCUSAGE_CONFIG":         "\t",
	}), exists)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(args, []string{"amp", "daily"}) {
		t.Errorf("args = %v, want no --config", args)
	}
}

// Surrounding whitespace is trimmed before the path is checked and passed.
func TestWithConfigArgsTrimsTheConfiguredPath(t *testing.T) {
	args, err := WithConfigArgs([]string{"amp", "daily"}, envOf(map[string]string{
		"TOKENBOARD_CCUSAGE_CONFIG": "  /cfg/explicit.json\n",
	}), exists)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"amp", "daily", "--config", "/cfg/explicit.json"}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("args = %v, want %v", args, want)
	}
}

// A whitespace-only dynamic config must not shadow a real explicit one.
func TestWithConfigArgsBlankDynamicFallsThroughToTheExplicitConfig(t *testing.T) {
	args, err := WithConfigArgs([]string{"amp", "daily"}, envOf(map[string]string{
		"TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG": " ",
		"TOKENBOARD_CCUSAGE_CONFIG":         "/cfg/explicit.json",
	}), exists)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"amp", "daily", "--config", "/cfg/explicit.json"}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("args = %v, want %v", args, want)
	}
}
