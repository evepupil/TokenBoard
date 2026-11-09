package copilot

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/adapters/tools"
)

// writeFixtureFile writes one file under root, creating parents.
func writeFixtureFile(t *testing.T, root, relative, content string) string {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// fixtureOptions is an Options whose only environment is one COPILOT_HOME.
func fixtureOptions(home string) tools.Options {
	return tools.Options{
		Env: func(key string) (string, bool) {
			if key == "COPILOT_HOME" {
				return home, true
			}
			return "", false
		},
		Timezone: "UTC",
	}
}

func sourcePaths(paths []SourceFile) []string {
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		out = append(out, path.Path)
	}
	return out
}

// TestCopilotPathsOtelsRecurseAndSessionStateDoesNot mirrors the Rust
// discovers_session_state_and_otel_files_without_nested_session_files
// (paths.rs:101-163): OTel files are found at any depth, session-state files
// only one directory below session-state and only when named events.jsonl.
func TestCopilotPathsOtelsRecurseAndSessionStateDoesNot(t *testing.T) {
	fixture := t.TempDir()
	otel := writeFixtureFile(t, fixture, "home/.copilot/otel/otel.jsonl", "{}\n")
	nestedOtel := writeFixtureFile(t, fixture, "home/.copilot/otel/nested/day/trace.jsonl", "{}\n")
	ignoredOtel := writeFixtureFile(t, fixture, "home/.copilot/otel/notes.txt", "{}\n")
	sessionA := writeFixtureFile(t, fixture, "home/.copilot/session-state/session-a/events.jsonl", "{}\n")
	writeFixtureFile(t, fixture, "home/.copilot/session-state/session-a/other.jsonl", "{}\n")
	sessionB := writeFixtureFile(t, fixture, "home/.copilot/session-state/session-b/events.jsonl", "{}\n")
	writeFixtureFile(t, fixture, "home/.copilot/session-state/nested/session-c/events.jsonl", "{}\n")
	_ = ignoredOtel

	discovered, err := SourcePaths(fixtureOptions(filepath.Join(fixture, "home", ".copilot")))
	if err != nil {
		t.Fatalf("paths(): %v", err)
	}
	want := []SourceFile{
		{Kind: KindOtel, Path: nestedOtel},
		{Kind: KindOtel, Path: otel},
		{Kind: KindSessionState, Path: sessionA},
		{Kind: KindSessionState, Path: sessionB},
	}
	if len(discovered) != len(want) {
		t.Fatalf("paths() = %v, want %v", sourcePaths(discovered), want)
	}
	for index, file := range want {
		if discovered[index] != file {
			t.Fatalf("paths()[%d] = %+v, want %+v (all: %v)", index, discovered[index], file, discovered)
		}
	}
}

// TestCopilotFileExporterPathIsAnExtraOtelFile covers
// COPILOT_OTEL_FILE_EXPORTER_PATH (paths.rs:70-79): a trimmed, existing regular
// file is appended as an OTel source; empty or missing values add nothing, and
// when it is set COPILOT_HOME's own files keep coming too
// (discovers_files_from_copilot_home, paths.rs:166-222).
func TestCopilotFileExporterPathIsAnExtraOtelFile(t *testing.T) {
	fixture := t.TempDir()
	relocatedOtel := writeFixtureFile(t, fixture, "relocated/otel/trace.jsonl", "{}\n")
	relocatedSession := writeFixtureFile(t, fixture, "relocated/session-state/session-1/events.jsonl", "{}\n")
	exporter := writeFixtureFile(t, fixture, "exporter/export.jsonl", "{}\n")

	options := tools.Options{
		Env: func(key string) (string, bool) {
			switch key {
			case "COPILOT_HOME":
				return filepath.Join(fixture, "relocated"), true
			case "COPILOT_OTEL_FILE_EXPORTER_PATH":
				return "  " + exporter + "\n", true
			}
			return "", false
		},
		HomeDir:  func() (string, error) { t.Fatal("HOME must not be consulted when COPILOT_HOME is set"); return "", nil },
		Timezone: "UTC",
	}
	discovered, err := SourcePaths(options)
	if err != nil {
		t.Fatalf("paths(): %v", err)
	}
	want := []SourceFile{
		{Kind: KindOtel, Path: exporter},
		{Kind: KindOtel, Path: relocatedOtel},
		{Kind: KindSessionState, Path: relocatedSession},
	}
	if len(discovered) != len(want) {
		t.Fatalf("paths() = %v, want %v", sourcePaths(discovered), want)
	}
	for index, file := range want {
		if discovered[index] != file {
			t.Fatalf("paths()[%d] = %+v, want %+v (all: %v)", index, discovered[index], file, discovered)
		}
	}

	for name, exporterValue := range map[string]string{
		"empty":   "",
		"missing": filepath.Join(fixture, "nowhere.jsonl"),
		"directory": filepath.Join(
			fixture, "relocated", "otel"),
	} {
		t.Run(name, func(t *testing.T) {
			options.Env = func(key string) (string, bool) {
				switch key {
				case "COPILOT_HOME":
					return filepath.Join(fixture, "relocated"), true
				case "COPILOT_OTEL_FILE_EXPORTER_PATH":
					return exporterValue, true
				}
				return "", false
			}
			discovered, err := SourcePaths(options)
			if err != nil {
				t.Fatalf("paths(): %v", err)
			}
			if len(discovered) != 2 {
				t.Fatalf("paths() = %v, want only the relocated tree's two files", sourcePaths(discovered))
			}
		})
	}
}

// TestCopilotDedupKeepsFirstKind pins add_file (paths.rs:56-67): the first
// registration of a path keeps its kind, and the result is sorted by path
// whatever the discovery order.
func TestCopilotDedupKeepsFirstKind(t *testing.T) {
	fixture := t.TempDir()
	// The exporter names a file that lives under the OTel tree, so the same path
	// is offered twice as OTel, and again as a session-state file spelled with a
	// `..` segment resolving to the same file.
	shared := writeFixtureFile(t, fixture, "shared/otel.jsonl", "{}\n")
	a := writeFixtureFile(t, fixture, "shared/session-state/a/events.jsonl", "{}\n")

	options := tools.Options{
		Env: func(key string) (string, bool) {
			switch key {
			case "COPILOT_OTEL_FILE_EXPORTER_PATH":
				return shared, true
			case "COPILOT_HOME":
				return filepath.Join(fixture, "shared") + "/session-state/../", true
			}
			return "", false
		},
		Timezone: "UTC",
	}
	discovered, err := SourcePaths(options)
	if err != nil {
		t.Fatalf("paths(): %v", err)
	}
	want := []SourceFile{
		{Kind: KindOtel, Path: shared},
		{Kind: KindSessionState, Path: a},
	}
	if len(discovered) != len(want) {
		t.Fatalf("paths() = %v, want %v", sourcePaths(discovered), want)
	}
	for index, file := range want {
		if discovered[index] != file {
			t.Fatalf("paths()[%d] = %+v, want %+v (all: %v)", index, discovered[index], file, discovered)
		}
	}
}
