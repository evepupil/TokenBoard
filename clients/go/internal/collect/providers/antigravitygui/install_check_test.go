package antigravitygui

import (
	"errors"
	"io/fs"
	"os"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/antigravitymeta"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// fakeStat answers as if the named path existed, or with the given error.
func fakeStat(missing map[string]bool, err error) func(string) (os.FileInfo, error) {
	return func(path string) (os.FileInfo, error) {
		if err != nil {
			return nil, err
		}
		if missing[path] {
			return nil, &fs.PathError{Op: "stat", Path: path, Err: fs.ErrNotExist}
		}
		return nil, nil
	}
}

// The app bundle, not the binary, is what decides "not installed": a bundle
// that is present but lacks the binary is a layout change that must keep
// reaching the spawn, and therefore strict mode's failure report.
func TestMissingDefaultLanguageServerOnlyCoversAnAbsentAppBundle(t *testing.T) {
	absentBundle := fakeStat(map[string]bool{defaultLanguageServerAppBundle: true}, nil)
	if !missingDefaultLanguageServer(defaultLanguageServerPath, absentBundle) {
		t.Fatal("a default path with no app bundle should report the app as not installed")
	}

	presentBundle := fakeStat(map[string]bool{}, nil)
	if missingDefaultLanguageServer(defaultLanguageServerPath, presentBundle) {
		t.Fatal("an installed app must reach the spawn attempt")
	}

	if missingDefaultLanguageServer("/opt/custom/language_server", absentBundle) {
		t.Fatal("an operator-supplied path must never be reclassified as not installed")
	}

	permissionDenied := fakeStat(nil, &fs.PathError{Op: "stat", Path: defaultLanguageServerAppBundle, Err: fs.ErrPermission})
	if missingDefaultLanguageServer(defaultLanguageServerPath, permissionDenied) {
		t.Fatal("only ENOENT means the app is absent; another stat error must not hide it")
	}
	if !errors.Is(&fs.PathError{Err: fs.ErrNotExist}, fs.ErrNotExist) {
		t.Fatal("sanity: the fake's error shape must satisfy errors.Is")
	}
}

// The check has to run before the spawn: the message it produces is what keeps
// strict mode from reporting an app that was never installed, and a spawn
// failure would produce the ENOENT shape instead.
func TestSpawnReportsAnAbsentAppWithoutStartingIt(t *testing.T) {
	original := statDefaultAppBundle
	statDefaultAppBundle = fakeStat(map[string]bool{defaultLanguageServerAppBundle: true}, nil)
	t.Cleanup(func() { statDefaultAppBundle = original })
	t.Setenv("TOKENBOARD_ANTIGRAVITY_LANGUAGE_SERVER", "")

	_, err := spawnLanguageServer(Options{Source: string(contract.SourceAntigravity)}, "", "", 1, "csrf")
	if err == nil || !strings.HasPrefix(err.Error(), antigravitymeta.LanguageServerNotInstalledPrefix) {
		t.Fatalf("err = %v, want the not-installed message", err)
	}
}
