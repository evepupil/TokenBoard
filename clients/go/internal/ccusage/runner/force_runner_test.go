package runner

import "testing"

// TS tests this with Boolean(value), so any non-empty string — including one
// that is only whitespace — asks for the package runner. Trimming first made
// a whitespace value mean "unset" here, which sent the collector to the local
// binary while the TS side used the package manager: different pricing and
// different output for the same environment.
func TestForcePackageRunnerIsTrueForAnyNonEmptyValue(t *testing.T) {
	for _, value := range []string{"1", "0", " ", "\t", "false"} {
		env := stubEnv(map[string]string{"TOKENBOARD_FORCE_PACKAGE_RUNNER": value})
		runner, err := ResolvePackageRunner(RunnerInput{
			Env:         env,
			Platform:    "linux",
			LocalBinary: "/opt/tokenboard/bin/ccusage",
			FileExists:  func(string) bool { return true },
		})
		if err != nil {
			t.Fatalf("%q: %v", value, err)
		}
		if runner.Command == "/opt/tokenboard/bin/ccusage" {
			t.Errorf("%q must select the package runner, not the local binary", value)
		}
	}

	env := stubEnv(map[string]string{})
	runner, err := ResolvePackageRunner(RunnerInput{
		Env:         env,
		Platform:    "linux",
		LocalBinary: "/opt/tokenboard/bin/ccusage",
		FileExists:  func(string) bool { return true },
	})
	if err != nil {
		t.Fatal(err)
	}
	if runner.Command != "/opt/tokenboard/bin/ccusage" {
		t.Errorf("unset must keep the local binary, got %q", runner.Command)
	}
}

// The same truthiness rule applies to the explicit ccusage path: TS sees a
// whitespace-only value as a set path and reports it missing.
func TestPackageRunnerTreatsAWhitespaceExplicitBinaryAsSet(t *testing.T) {
	env := stubEnv(map[string]string{
		"TOKENBOARD_CCUSAGE_BIN": " ",
	})
	if _, err := ResolvePackageRunner(RunnerInput{
		Env:        env,
		Platform:   "linux",
		FileExists: func(string) bool { return false },
	}); err == nil {
		t.Fatal("a whitespace-only TOKENBOARD_CCUSAGE_BIN must be reported missing")
	}
}
