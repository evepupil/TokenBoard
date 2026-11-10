package runner

import (
	"fmt"
	"os"
	"runtime"
	"strings"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage/acquire"
)

// Port of package-runner.ts: which command runs ccusage, and how the package
// specifier and config flag are spliced into its arguments.
//
// The Go client ships the native binary (spec §4 layer 1), so the package
// runners exist for parity with the TS collector's fallbacks: an explicit
// TOKENBOARD_PACKAGE_MANAGER still selects npx/pnpm/bun/npm exactly as the TS
// side does, and TOKENBOARD_FORCE_PACKAGE_RUNNER skips the bundled binary.

// PackageRunner builds the command and argument list for one ccusage call.
type PackageRunner struct {
	Command string
	// RunPackageArgs wraps the ccusage arguments for this runner.
	RunPackageArgs func(packageName, binaryName string, packageArgs []string) []string
}

// RunnerInput configures runner resolution.
type RunnerInput struct {
	Env func(string) string
	// FileExists is injectable for tests.
	FileExists func(string) bool
	// LocalBinary is the resolved bundled/PATH binary; empty when none.
	LocalBinary string
	Platform    string
}

// ResolvePackageRunner ports resolvePackageRunner. Resolution order:
// TOKENBOARD_CCUSAGE_BIN (validated) → resolved local binary → the package
// manager named by TOKENBOARD_PACKAGE_MANAGER (bun/npm/pnpm, else npx).
func ResolvePackageRunner(input RunnerInput) (PackageRunner, error) {
	env := input.Env
	if env == nil {
		env = os.Getenv
	}
	fileExists := input.FileExists
	if fileExists == nil {
		fileExists = func(path string) bool {
			info, err := os.Stat(path)
			return err == nil && info.Mode().IsRegular()
		}
	}
	platform := input.Platform
	if platform == "" {
		platform = runtime.GOOS
	}
	// Boolean(env.X) in TS: any non-empty value, whitespace included.
	forcePackageRunner := env("TOKENBOARD_FORCE_PACKAGE_RUNNER") != ""
	// Truthiness, not a trimmed check, for the same reason: TS sees " " as a
	// set path and reports it missing rather than falling through.
	forcedCcusage := env("TOKENBOARD_CCUSAGE_BIN")
	if !forcePackageRunner && forcedCcusage != "" {
		if !fileExists(forcedCcusage) {
			return PackageRunner{}, fmt.Errorf("TOKENBOARD_CCUSAGE_BIN does not exist: %s", forcedCcusage)
		}
		return localRunner(forcedCcusage), nil
	}
	if !forcePackageRunner && input.LocalBinary != "" && fileExists(input.LocalBinary) {
		return localRunner(input.LocalBinary), nil
	}

	packageManager := strings.TrimSpace(env("TOKENBOARD_PACKAGE_MANAGER"))
	switch packageManager {
	case "bun":
		command := strings.TrimSpace(env("TOKENBOARD_BUNX_BIN"))
		if command == "" {
			command = "bunx"
		}
		return PackageRunner{
			Command: command,
			RunPackageArgs: func(packageName, _ string, packageArgs []string) []string {
				return append([]string{packageName}, packageArgs...)
			},
		}, nil
	case "npm":
		command := strings.TrimSpace(env("TOKENBOARD_NPM_BIN"))
		if command == "" {
			command = packageCommand("npm", platform)
		}
		return PackageRunner{
			Command: command,
			RunPackageArgs: func(packageName, binaryName string, packageArgs []string) []string {
				return append([]string{"exec", "--yes", "--package", packageName, "--", binaryName}, packageArgs...)
			},
		}, nil
	case "pnpm":
		command := strings.TrimSpace(env("TOKENBOARD_PNPM_BIN"))
		if command == "" {
			command = packageCommand("pnpm", platform)
		}
		return PackageRunner{
			Command: command,
			RunPackageArgs: func(packageName, _ string, packageArgs []string) []string {
				return append([]string{"dlx", packageName}, packageArgs...)
			},
		}, nil
	}
	command := strings.TrimSpace(env("TOKENBOARD_NPX_BIN"))
	if command == "" {
		command = packageCommand("npx", platform)
	}
	return PackageRunner{
		Command: command,
		RunPackageArgs: func(packageName, _ string, packageArgs []string) []string {
			return append([]string{packageName}, packageArgs...)
		},
	}, nil
}

func localRunner(command string) PackageRunner {
	return PackageRunner{
		Command: command,
		RunPackageArgs: func(_ string, _ string, packageArgs []string) []string {
			return append([]string{}, packageArgs...)
		},
	}
}

func packageCommand(command, platform string) string {
	if platform == "windows" {
		return command + ".cmd"
	}
	return command
}

// ConfigArgsFor is ConfigArgs bound to a runner's environment, appended after
// the provider arguments exactly as appendCcusageConfig does.
func (r PackageRunner) Args(packageArgs []string, env func(string) string, fileExists func(string) bool) ([]string, error) {
	configArgs, err := ConfigArgs(env, fileExists)
	if err != nil {
		return nil, err
	}
	return r.RunPackageArgs(acquire.PackageSpecifier, "ccusage", append(packageArgs, configArgs...)), nil
}
