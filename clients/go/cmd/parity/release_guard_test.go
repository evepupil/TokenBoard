package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// devCommandPaths are the binaries that exist for development only: parity
// compares the native collectors against ccusage, bench-collect measures what
// the ccusage path costs. Neither is installed by a user and neither is run by
// the client, so shipping them would widen the release surface (and the
// archives) for no benefit.
var devCommandPaths = []string{"cmd/parity", "cmd/bench-collect"}

// releaseConfigPath resolves the GoReleaser configuration from the test
// binary's working directory. `go test` runs with cwd set to the package's
// source directory, and unlike runtime.Caller this is unaffected by -trimpath
// (which rewrites compiled file paths to module-relative names). The package
// directory is four levels below the repository root.
func releaseConfigPath(t *testing.T) string {
	t.Helper()
	directory, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd: %v", err)
	}
	return filepath.Join(directory, "..", "..", "..", "..", ".goreleaser.yaml")
}

// devCommandsInReleaseConfig reports which dev-only commands the release
// configuration mentions. Comments are dropped before matching so that a note
// explaining *why* a command stays out cannot itself fail the gate.
func devCommandsInReleaseConfig(config string) []string {
	var active []string
	for _, line := range strings.Split(config, "\n") {
		if index := strings.Index(line, "#"); index >= 0 {
			line = line[:index]
		}
		active = append(active, line)
	}
	body := strings.Join(active, "\n")

	var found []string
	for _, command := range devCommandPaths {
		if strings.Contains(body, command) {
			found = append(found, command)
		}
	}
	return found
}

// releaseMainValues returns the `main:` entry of every build in the release
// config, with comments removed. Only `builds:` entries declare `main`, and the
// file indents every build key the same way, so a trimmed prefix match is
// enough to read them without a YAML parser.
func releaseMainValues(config string) []string {
	var mains []string
	for _, line := range strings.Split(config, "\n") {
		if index := strings.Index(line, "#"); index >= 0 {
			line = line[:index]
		}
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "main:") {
			continue
		}
		mains = append(mains, strings.TrimSpace(strings.TrimPrefix(line, "main:")))
	}
	return mains
}

// TestDevCommandsAreNotInTheGoreleaserBuildList is the dev-only guarantee: the
// release config must not build cmd/parity or cmd/bench-collect. The build list
// is the only place a binary can enter a release, and GoReleaser fails the
// release when it cannot build an entry — so the failure mode this prevents is
// a dev command that suddenly ships, not one that breaks the tag.
//
// The named-path check is backed by a second assertion that the build list has
// exactly one entry, the client itself: cmd/shadow-fixtures and
// cmd/tb-shadow-antigravity are dev-only too, and neither is named above. A
// second shipped binary is a contract change (internal/release pins six
// archives of one binary), so it has to be a deliberate edit to this test.
//
// A missing or unreadable file fails the test rather than passing it: a guard
// that silently skips when its input is gone is not a guard.
func TestDevCommandsAreNotInTheGoreleaserBuildList(t *testing.T) {
	path := releaseConfigPath(t)
	config, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	// Prove the file is the configuration this test thinks it is. Both the
	// shipped binary and the build stanza are pinned here, so a path that
	// resolves to some other (or an empty) file fails instead of vacuously
	// finding no dev commands in it.
	if !strings.Contains(string(config), "main: ./cmd/tokenboard") {
		t.Fatalf("%s does not declare the tokenboard build; the path resolution is wrong", path)
	}

	if found := devCommandsInReleaseConfig(string(config)); len(found) > 0 {
		t.Fatalf("the release config builds dev-only command(s) %s: %s", strings.Join(found, ", "), path)
	}

	mains := releaseMainValues(string(config))
	if len(mains) != 1 || mains[0] != "./cmd/tokenboard" {
		t.Fatalf("the release builds %v, want exactly [./cmd/tokenboard]; every other cmd/ is dev-only", mains)
	}
}

// TestGoreleaserGuardCatchesADevCommand pins the detection itself: a config
// that does build a dev command must be reported, and the comments around it
// must not change the answer in either direction.
func TestGoreleaserGuardCatchesADevCommand(t *testing.T) {
	config := `builds:
  - id: tokenboard
    dir: clients/go
    # cmd/parity is deliberately absent from this list.
    main: ./cmd/tokenboard
  - id: parity
    dir: clients/go
    main: ./cmd/bench-collect
`
	if got := devCommandsInReleaseConfig(config); len(got) != 1 || got[0] != "cmd/bench-collect" {
		t.Fatalf("devCommandsInReleaseConfig = %v, want [cmd/bench-collect]", got)
	}
	if got := releaseMainValues(config); len(got) != 2 || got[1] != "./cmd/bench-collect" {
		t.Fatalf("releaseMainValues = %v, want both build entries", got)
	}
}

// TestGoreleaserGuardIgnoresComments keeps the gate from firing on an
// explanatory note, which is the shape a future comment will take.
func TestGoreleaserGuardIgnoresComments(t *testing.T) {
	config := `builds:
  - id: tokenboard
    dir: clients/go
    main: ./cmd/tokenboard
# Dev-only commands (cmd/parity, cmd/bench-collect) are never built.
`
	if got := devCommandsInReleaseConfig(config); len(got) != 0 {
		t.Fatalf("devCommandsInReleaseConfig = %v, want none", got)
	}
}
