package runner

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage/acquire"
)

// Port of package-runner.test.ts. The TS suite also pins the specifier against
// packages/collector/package.json; that equality is enforced by
// scripts/check-deps.sh and re-checked here from the repo checkout when present.

func stubEnv(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func platformCommand(command, platform string) string {
	if platform == "windows" {
		return command + ".cmd"
	}
	return command
}

func TestPackageSpecifierIsPinnedToTheAdaptedVersion(t *testing.T) {
	if acquire.Version != "20.0.33" {
		t.Errorf("Version = %q, want 20.0.33", acquire.Version)
	}
	if acquire.PackageSpecifier != "ccusage@20.0.33" {
		t.Errorf("acquire.PackageSpecifier = %q", acquire.PackageSpecifier)
	}
	if strings.Contains(acquire.PackageSpecifier, "latest") {
		t.Errorf("specifier must never float: %q", acquire.PackageSpecifier)
	}
}

func TestPackageSpecifierMatchesCollectorPackageJSON(t *testing.T) {
	// Walk up from this package to the repo root; absent (module vendored
	// alone) is fine, the check-deps gate covers CI.
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for depth := 0; depth < 6; depth++ {
		packageJSON := filepath.Join(dir, "packages", "collector", "package.json")
		if data, readErr := os.ReadFile(packageJSON); readErr == nil {
			text := string(data)
			if !strings.Contains(text, `"ccusage": "`+acquire.Version+`"`) {
				t.Errorf("packages/collector/package.json does not pin ccusage to %s", acquire.Version)
			}
			return
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Log("repo checkout not found; check-deps.sh covers the pin in CI")
}

func TestResolvePackageRunnerUsesNpxByDefault(t *testing.T) {
	runner, err := ResolvePackageRunner(RunnerInput{
		Env:      stubEnv(map[string]string{"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1"}),
		Platform: "linux",
	})
	if err != nil {
		t.Fatal(err)
	}
	if runner.Command != platformCommand("npx", "linux") {
		t.Errorf("command = %q", runner.Command)
	}
	args := runner.RunPackageArgs(acquire.PackageSpecifier, "ccusage", []string{"daily", "--json"})
	if !reflect.DeepEqual(args, []string{acquire.PackageSpecifier, "daily", "--json"}) {
		t.Errorf("args = %v", args)
	}
}

func TestPackageRunnerArgsAppendExplicitConfig(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "ccusage.json")
	runner, err := ResolvePackageRunner(RunnerInput{
		Env: stubEnv(map[string]string{
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
			"TOKENBOARD_CCUSAGE_CONFIG":       configPath,
		}),
		Platform: "linux",
	})
	if err != nil {
		t.Fatal(err)
	}
	args, err := runner.Args([]string{"daily", "--json"}, stubEnv(map[string]string{
		"TOKENBOARD_CCUSAGE_CONFIG": configPath,
	}), func(path string) bool { return path == configPath })
	if err != nil {
		t.Fatal(err)
	}
	want := []string{acquire.PackageSpecifier, "daily", "--json", "--config", configPath}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("args = %v, want %v", args, want)
	}
}

func TestPackageRunnerPrefersDynamicPricingConfig(t *testing.T) {
	dynamicPath := "/tmp/tokenboard/ccusage.dynamic.json"
	env := stubEnv(map[string]string{
		"TOKENBOARD_FORCE_PACKAGE_RUNNER":   "1",
		"TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG": dynamicPath,
		"TOKENBOARD_CCUSAGE_CONFIG":         "/checkout/ccusage.json",
	})
	runner, err := ResolvePackageRunner(RunnerInput{Env: env, Platform: "linux"})
	if err != nil {
		t.Fatal(err)
	}
	args, err := runner.Args([]string{"daily", "--json"}, env, func(path string) bool { return path == dynamicPath })
	if err != nil {
		t.Fatal(err)
	}
	want := []string{acquire.PackageSpecifier, "daily", "--json", "--config", dynamicPath}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("args = %v, want %v", args, want)
	}
}

func TestPackageRunnerUsesWindowsCommandShimsOnWin32(t *testing.T) {
	cases := map[string]string{
		"":     "npx.cmd",
		"npm":  "npm.cmd",
		"pnpm": "pnpm.cmd",
	}
	for manager, want := range cases {
		runner, err := ResolvePackageRunner(RunnerInput{
			Env: stubEnv(map[string]string{
				"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
				"TOKENBOARD_PACKAGE_MANAGER":      manager,
			}),
			Platform: "windows",
		})
		if err != nil {
			t.Fatal(err)
		}
		if runner.Command != want {
			t.Errorf("manager %q: command = %q, want %q", manager, runner.Command, want)
		}
	}
}

func TestPackageRunnerSupportsBunx(t *testing.T) {
	runner, err := ResolvePackageRunner(RunnerInput{
		Env: stubEnv(map[string]string{
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
			"TOKENBOARD_PACKAGE_MANAGER":      "bun",
			"TOKENBOARD_BUNX_BIN":             "/opt/bin/bunx",
		}),
		Platform: "linux",
	})
	if err != nil {
		t.Fatal(err)
	}
	if runner.Command != "/opt/bin/bunx" {
		t.Errorf("command = %q", runner.Command)
	}
	args := runner.RunPackageArgs(acquire.PackageSpecifier, "ccusage", []string{"codex", "session", "--json"})
	if !reflect.DeepEqual(args, []string{acquire.PackageSpecifier, "codex", "session", "--json"}) {
		t.Errorf("args = %v", args)
	}
}

func TestPackageRunnerSupportsNpmExec(t *testing.T) {
	runner, err := ResolvePackageRunner(RunnerInput{
		Env: stubEnv(map[string]string{
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
			"TOKENBOARD_PACKAGE_MANAGER":      "npm",
			"TOKENBOARD_NPM_BIN":              "/opt/bin/npm",
		}),
		Platform: "linux",
	})
	if err != nil {
		t.Fatal(err)
	}
	if runner.Command != "/opt/bin/npm" {
		t.Errorf("command = %q", runner.Command)
	}
	args := runner.RunPackageArgs(acquire.PackageSpecifier, "ccusage", []string{"daily", "--json"})
	want := []string{"exec", "--yes", "--package", acquire.PackageSpecifier, "--", "ccusage", "daily", "--json"}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("args = %v, want %v", args, want)
	}
}

func TestPackageRunnerSupportsPnpmDlx(t *testing.T) {
	runner, err := ResolvePackageRunner(RunnerInput{
		Env: stubEnv(map[string]string{
			"TOKENBOARD_FORCE_PACKAGE_RUNNER": "1",
			"TOKENBOARD_PACKAGE_MANAGER":      "pnpm",
			"TOKENBOARD_PNPM_BIN":             "/opt/bin/pnpm",
		}),
		Platform: "linux",
	})
	if err != nil {
		t.Fatal(err)
	}
	if runner.Command != "/opt/bin/pnpm" {
		t.Errorf("command = %q", runner.Command)
	}
	args := runner.RunPackageArgs(acquire.PackageSpecifier, "ccusage", []string{"daily", "--json"})
	want := []string{"dlx", acquire.PackageSpecifier, "daily", "--json"}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("args = %v, want %v", args, want)
	}
}

func TestResolvePackageRunnerUsesLocalCcusageBinaryForTheHotPath(t *testing.T) {
	runner, err := ResolvePackageRunner(RunnerInput{
		Env: stubEnv(map[string]string{
			"TOKENBOARD_PACKAGE_MANAGER": "pnpm",
			"TOKENBOARD_CCUSAGE_BIN":     "/opt/bin/ccusage",
		}),
		Platform:   "linux",
		FileExists: func(string) bool { return true },
	})
	if err != nil {
		t.Fatal(err)
	}
	if runner.Command != "/opt/bin/ccusage" {
		t.Errorf("command = %q", runner.Command)
	}
	args := runner.RunPackageArgs(acquire.PackageSpecifier, "ccusage", []string{"codex", "daily", "--json"})
	if !reflect.DeepEqual(args, []string{"codex", "daily", "--json"}) {
		t.Errorf("args = %v", args)
	}
}

func TestResolvePackageRunnerFailsWhenForcedBinaryIsMissing(t *testing.T) {
	_, err := ResolvePackageRunner(RunnerInput{
		Env:        stubEnv(map[string]string{"TOKENBOARD_CCUSAGE_BIN": "/opt/bin/missing-ccusage"}),
		Platform:   "linux",
		FileExists: func(string) bool { return false },
	})
	if err == nil || !strings.Contains(err.Error(), "TOKENBOARD_CCUSAGE_BIN does not exist: /opt/bin/missing-ccusage") {
		t.Fatalf("err = %v", err)
	}
}

func TestResolvePackageRunnerFallsBackWhenLocalBinaryIsMissing(t *testing.T) {
	runner, err := ResolvePackageRunner(RunnerInput{
		Env:         stubEnv(map[string]string{"TOKENBOARD_PACKAGE_MANAGER": "pnpm"}),
		Platform:    runtime.GOOS,
		LocalBinary: "/opt/bin/ccusage",
		FileExists:  func(string) bool { return false },
	})
	if err != nil {
		t.Fatal(err)
	}
	if runner.Command != platformCommand("pnpm", runtime.GOOS) {
		t.Errorf("command = %q", runner.Command)
	}
	args := runner.RunPackageArgs(acquire.PackageSpecifier, "ccusage", []string{"codex", "daily", "--json"})
	want := []string{"dlx", acquire.PackageSpecifier, "codex", "daily", "--json"}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("args = %v, want %v", args, want)
	}
}
