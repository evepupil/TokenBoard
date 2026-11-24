package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/release"
)

// buildTarball assembles a release tarball holding one executable.
func buildTarball(t *testing.T, name string, body []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	archive := tar.NewWriter(writer)
	if err := archive.WriteHeader(&tar.Header{
		Name:     name,
		Mode:     0o755,
		Size:     int64(len(body)),
		Typeflag: tar.TypeReg,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := archive.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// stubVerify stands in for verifyStaged where the fixture cannot be a
// host-native executable. It accepts a staged file that names the release
// version and refuses one that does not, which is the same contract the real
// check enforces; on Unix the tests use the real one end to end.
func stubVerify(path, version string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if !bytes.Contains(data, []byte(version)) {
		return fmt.Errorf("the downloaded TokenBoard binary does not run: it printed %q", string(data))
	}
	return nil
}

// On Windows the shell-script fixtures are not valid executables ("%1 is not
// a valid Win32 application"), so the run tests substitute a content check
// with the same contract. verifyExecutable keeps its own tests for the
// version-matching rules on every platform.
func TestMain(m *testing.M) {
	if runtime.GOOS == "windows" {
		verifyStaged = stubVerify
	}
	os.Exit(m.Run())
}

// stubBinary is a script that answers `version` the way the real binary does.
// It stands in for the executable because a test cannot ship a compiled
// binary for the host it runs on.
func stubBinary(version string) []byte {
	return []byte("#!/bin/sh\nif [ \"$1\" = version ]; then echo \"tokenboard (go) " + version + "\"; exit 0; fi\nexit 0\n")
}

type fakeRelease struct {
	tag      string
	platform string
	tarball  []byte
	// omitChecksums publishes a release with no checksums asset.
	omitChecksums bool
	// badChecksum publishes a manifest that does not match the tarball.
	badChecksum bool
}

// server serves the two web endpoints an update uses: the releases-latest
// redirect and the release asset downloads.
func (f fakeRelease) server(t *testing.T) *httptest.Server {
	t.Helper()
	archiveName := release.ArchiveName(f.platform)
	digest := sha256.Sum256(f.tarball)
	sums := fmt.Sprintf("%s  %s\n", hex.EncodeToString(digest[:]), archiveName)
	if f.badChecksum {
		sums = fmt.Sprintf("%s  %s\n", strings.Repeat("0", 64), archiveName)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/evepupil/TokenBoard/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/evepupil/TokenBoard/releases/tag/"+f.tag, http.StatusFound)
	})
	mux.HandleFunc("/evepupil/TokenBoard/releases/tag/"+f.tag, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("<html>release " + f.tag + "</html>"))
	})
	mux.HandleFunc("/evepupil/TokenBoard/releases/download/"+f.tag+"/"+archiveName,
		func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write(f.tarball)
		})
	mux.HandleFunc("/evepupil/TokenBoard/releases/download/"+f.tag+"/"+release.ChecksumsName(),
		func(w http.ResponseWriter, r *http.Request) {
			if f.omitChecksums {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write([]byte(sums))
		})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

// A successful update replaces the binary and keeps the old one beside it.
func TestRunReplacesTheBinaryAndKeepsABackup(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	if err := os.WriteFile(target, stubBinary("0.0.1"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("0.0.1")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	body := stubBinary("1.2.3")
	fake := fakeRelease{tag: "v1.2.3", platform: "darwin_arm64", tarball: buildTarball(t, "tokenboard", body)}
	server := fake.server(t)

	result, err := runAgainst(t, server, target, "")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !result.Updated || result.Version != "1.2.3" {
		t.Fatalf("result = %+v, want updated 1.2.3", result)
	}
	installed, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(installed, body) {
		t.Errorf("installed binary is not the downloaded one")
	}
	if _, err := os.Stat(result.BackupPath); err != nil {
		t.Errorf("backup missing at %s: %v", result.BackupPath, err)
	}
	previous, err := os.ReadFile(result.BackupPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(previous, []byte("0.0.1")) {
		t.Errorf("backup does not hold the previous binary: %q", previous)
	}
	// The staged copy must not survive a successful swap.
	if _, err := os.Stat(filepath.Join(dir, "tokenboard.new")); !os.IsNotExist(err) {
		t.Errorf("staged file left behind: %v", err)
	}
}

func runAgainst(t *testing.T, server *httptest.Server, target, tag string) (Result, error) {
	t.Helper()
	return runAgainstWithConfigDir(t, server, target, tag, t.TempDir())
}

// runAgainstWithConfigDir pins TOKENBOARD_CONFIG_DIR to a test directory. The
// update probes that directory's bin for a ccusage copy left by an earlier
// release, and without it the test would inspect the machine's real
// ~/.tokenboard/bin.
func runAgainstWithConfigDir(t *testing.T, server *httptest.Server, target, tag, configDir string) (Result, error) {
	t.Helper()
	return Run(Input{
		Repo:       "evepupil/TokenBoard",
		Tag:        tag,
		Target:     target,
		Platform:   "darwin",
		Arch:       "arm64",
		HTTPClient: server.Client(),
		Env: func(key string) string {
			switch key {
			case "TOKENBOARD_RELEASE_BASE_URL":
				return server.URL
			case "TOKENBOARD_CONFIG_DIR":
				return configDir
			}
			return ""
		},
		Stderr: func(string) {},
	})
}

// A feed whose "latest" points below the installed version (a yanked release,
// a tag rolled back) must not silently downgrade the machine. A downgrade
// reintroduces whatever the newer version fixed, and the scheduled path would
// do it on every run without anyone asking.
func TestRunDoesNotDowngradeWhenTheFeedPointsBelowTheInstalledVersion(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	installed := stubBinary("2.0.0")
	if err := os.WriteFile(target, installed, 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("2.0.0")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	var downloads int
	fake := fakeRelease{tag: "v1.9.0", platform: "darwin_arm64", tarball: buildTarball(t, "tokenboard", stubBinary("1.9.0"))}
	server := fake.server(t)
	server.Config.Handler = countingDownloads(server.Config.Handler, &downloads)

	var lines []string
	result, err := Run(Input{
		Repo:       "evepupil/TokenBoard",
		Target:     target,
		Platform:   "darwin",
		Arch:       "arm64",
		HTTPClient: server.Client(),
		Env: func(key string) string {
			if key == "TOKENBOARD_RELEASE_BASE_URL" {
				return server.URL
			}
			return ""
		},
		Stderr: func(line string) { lines = append(lines, line) },
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Updated {
		t.Fatal("a release older than the installed version must not be installed")
	}
	if result.Version != "2.0.0" {
		t.Errorf("result.Version = %q, want the installed 2.0.0", result.Version)
	}
	if downloads != 0 {
		t.Errorf("downloads = %d, want none: the archive must not even be fetched", downloads)
	}
	if !strings.Contains(strings.Join(lines, "\n"), "newer") {
		t.Errorf("stderr = %q, want a line saying the installed version is newer", strings.Join(lines, "\n"))
	}
	if got, err := os.ReadFile(target); err != nil || !bytes.Equal(got, installed) {
		t.Errorf("the installed binary was replaced: %q", got)
	}
}

// countingDownloads wraps a release handler and counts archive downloads.
func countingDownloads(next http.Handler, downloads *int) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".tar.gz") {
			*downloads++
		}
		next.ServeHTTP(w, r)
	})
}

// A release already installed is a no-op, so the scheduled path stays quiet.
func TestRunIsANoopWhenTheVersionMatches(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	if err := os.WriteFile(target, stubBinary("1.2.3"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("1.2.3")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	fake := fakeRelease{tag: "v1.2.3", platform: "darwin_arm64", tarball: buildTarball(t, "tokenboard", stubBinary("1.2.3"))}
	server := fake.server(t)

	result, err := runAgainst(t, server, target, "")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Updated {
		t.Errorf("updated = true, want a no-op")
	}
	if result.BackupPath != "" {
		t.Errorf("backup = %q, want none", result.BackupPath)
	}
}

// A checksum mismatch must refuse the install and leave the original binary
// in place — a wrong binary breaks the collector that would otherwise fix it.
func TestRunRefusesAChecksumMismatchAndKeepsTheOriginal(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	original := stubBinary("0.0.1")
	if err := os.WriteFile(target, original, 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("0.0.1")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	fake := fakeRelease{
		tag: "v1.2.3", platform: "darwin_arm64",
		tarball:     buildTarball(t, "tokenboard", stubBinary("1.2.3")),
		badChecksum: true,
	}
	server := fake.server(t)

	if _, err := runAgainst(t, server, target, ""); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("err = %v, want a checksum mismatch", err)
	}
	installed, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(installed, original) {
		t.Errorf("the original binary was replaced despite the mismatch")
	}
	if _, err := os.Stat(filepath.Join(dir, "tokenboard.new")); !os.IsNotExist(err) {
		t.Errorf("staged file left behind after a refusal: %v", err)
	}
}

// A release without a checksums manifest cannot be verified, so it is not
// installed even though the download itself would succeed.
func TestRunRefusesAReleaseWithoutChecksums(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	if err := os.WriteFile(target, stubBinary("0.0.1"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("0.0.1")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	fake := fakeRelease{
		tag: "v1.2.3", platform: "darwin_arm64",
		tarball:       buildTarball(t, "tokenboard", stubBinary("1.2.3")),
		omitChecksums: true,
	}
	server := fake.server(t)

	if _, err := runAgainst(t, server, target, ""); err == nil || !strings.Contains(err.Error(), "checksums.txt") {
		t.Fatalf("err = %v, want a missing checksums manifest", err)
	}
}

// A downloaded binary that cannot answer `version` is not installed: swapping
// it in would leave a machine whose collector never runs again.
func TestRunRefusesABinaryThatDoesNotRun(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	if err := os.WriteFile(target, stubBinary("0.0.1"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("0.0.1")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	// The tarball carries a binary that answers nothing.
	fake := fakeRelease{
		tag: "v1.2.3", platform: "darwin_arm64",
		tarball: buildTarball(t, "tokenboard", []byte("#!/bin/sh\nexit 1\n")),
	}
	server := fake.server(t)

	if _, err := runAgainst(t, server, target, ""); err == nil || !strings.Contains(err.Error(), "does not run") {
		t.Fatalf("err = %v, want a verification failure", err)
	}
	installed, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(installed, []byte("0.0.1")) {
		t.Errorf("the original binary was replaced by one that cannot run")
	}
}

// An unsupported platform is refused before any network call.
func TestRunRefusesAnUnsupportedPlatform(t *testing.T) {
	if _, err := Run(Input{Platform: "plan9", Arch: "mips"}); err == nil ||
		!strings.Contains(err.Error(), "no release for plan9/mips") {
		t.Fatalf("err = %v, want an unsupported-platform refusal", err)
	}
}

// A malformed repository is refused rather than resolved into a URL that 404s.
func TestRunRefusesAMalformedRepo(t *testing.T) {
	if _, err := Run(Input{Repo: "not-a-repo", Platform: "darwin", Arch: "arm64"}); err == nil ||
		!strings.Contains(err.Error(), "expected owner/repo") {
		t.Fatalf("err = %v, want a malformed repo refusal", err)
	}
}

// A tag pinned explicitly skips the latest-release lookup entirely: the
// download URL is built from the tag, so no redirect request is made.
func TestRunPinsAnExplicitTag(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	if err := os.WriteFile(target, stubBinary("0.0.1"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("0.0.1")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	fake := fakeRelease{tag: "v9.9.9", platform: "darwin_arm64", tarball: buildTarball(t, "tokenboard", stubBinary("9.9.9"))}
	server := fake.server(t)

	result, err := runAgainst(t, server, target, "v9.9.9")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Version != "9.9.9" || !result.Updated {
		t.Fatalf("result = %+v, want an update to 9.9.9", result)
	}
}

// The version comparison must match a whole token: "1.2.30" is not "1.2.3",
// and accepting it would install a binary whose version does not match the
// release the checksums came from.
func TestNamesVersionRequiresAWholeToken(t *testing.T) {
	cases := []struct {
		output  string
		version string
		want    bool
	}{
		{"tokenboard (go) 1.2.3", "1.2.3", true},
		{"tokenboard (go) 1.2.30", "1.2.3", false},
		{"tokenboard (go) 11.2.3", "1.2.3", false},
		{"tokenboard (go) 1.2.3.4", "1.2.3", false},
		{"tokenboard (go) v1.2.3", "1.2.3", true},
		{"1.2.3", "1.2.3", true},
		{"tokenboard (go) 1.2.4", "1.2.3", false},
		{"no version here", "1.2.3", false},
	}
	for _, testCase := range cases {
		if got := namesVersion(testCase.output, testCase.version); got != testCase.want {
			t.Errorf("namesVersion(%q, %q) = %v, want %v", testCase.output, testCase.version, got, testCase.want)
		}
	}
}

// Each backup is a full copy of the binary; a machine that updates on every
// scheduled sync would accumulate one per release forever. Only the newest is
// kept.
func TestRunPrunesOldBackupsKeepingTheNewest(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	if err := os.WriteFile(target, stubBinary("0.0.1"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Two backups from earlier updates, and an unrelated file that must not be
	// touched.
	if err := os.WriteFile(target+".backup-20260101T000000Z", []byte("older"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target+".backup-20260102T000000Z", []byte("previous"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target+".unrelated", []byte("keep me"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("0.0.1")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	fake := fakeRelease{tag: "v1.2.3", platform: "darwin_arm64", tarball: buildTarball(t, "tokenboard", stubBinary("1.2.3"))}
	server := fake.server(t)

	result, err := runAgainst(t, server, target, "")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if _, err := os.Stat(result.BackupPath); err != nil {
		t.Errorf("this update's backup missing: %v", err)
	}
	if _, err := os.Stat(target + ".backup-20260101T000000Z"); !os.IsNotExist(err) {
		t.Errorf("the older backup survived: %v", err)
	}
	if _, err := os.Stat(target + ".backup-20260102T000000Z"); !os.IsNotExist(err) {
		t.Errorf("the previous backup survived: %v", err)
	}
	if data, readErr := os.ReadFile(target + ".unrelated"); readErr != nil || string(data) != "keep me" {
		t.Errorf("unrelated file disturbed: %v", readErr)
	}
}

// A binary living in a directory whose name carries glob metacharacters
// prunes its own backups, not another binary's.
func TestPruneBackupsStaysWithinItsOwnDirectory(t *testing.T) {
	dir := t.TempDir()
	// Two binaries in sibling directories whose names differ only by a glob
	// character in one of them: pruning one must not match the other's files.
	plainDir := filepath.Join(dir, "bin")
	metaDir := filepath.Join(dir, "bin[1]")
	if err := os.MkdirAll(plainDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(metaDir, 0o700); err != nil {
		t.Fatal(err)
	}
	plainBackup := filepath.Join(plainDir, "tokenboard.backup-20260101T000000Z")
	if err := os.WriteFile(plainBackup, []byte("plain"), 0o755); err != nil {
		t.Fatal(err)
	}
	pruneBackups(filepath.Join(metaDir, "tokenboard"), filepath.Join(metaDir, "tokenboard.backup-new"))
	if _, err := os.Stat(plainBackup); err != nil {
		t.Errorf("the sibling directory's backup was removed by an escaped-name pattern: %v", err)
	}
}

// A config directory whose name carries a glob metacharacter
// (`~/.tokenboard[work]`, a Windows user folder, a caller-set
// TOKENBOARD_CONFIG_DIR) must still have its own backups pruned, and must not
// reach a sibling's: with a glob, the character class `[cfg]` in a directory
// named `[cfg]` matched a sibling named `c`.
func TestPruneBackupsHandlesAMetacharacterDirectory(t *testing.T) {
	dir := t.TempDir()
	metaDir := filepath.Join(dir, "[cfg]")
	siblingDir := filepath.Join(dir, "c")
	otherSubdir := filepath.Join(dir, "g")
	for _, target := range []string{metaDir, siblingDir, otherSubdir} {
		if err := os.MkdirAll(target, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	ownOld := filepath.Join(metaDir, "tokenboard.backup-20260101T000000Z")
	if err := os.WriteFile(ownOld, []byte("own old"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A sibling directory's backup: `[cfg]` as a character class matches `c` and
	// `g`, so an unescaped pattern reaches it.
	for _, sibling := range []string{siblingDir, otherSubdir} {
		if err := os.WriteFile(filepath.Join(sibling, "tokenboard.backup-20260101T000000Z"), []byte("sibling"), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	keep := filepath.Join(metaDir, "tokenboard.backup-20260102T000000Z")
	pruneBackups(filepath.Join(metaDir, "tokenboard"), keep)

	// The directory's own old backup must be pruned.
	if _, err := os.Stat(ownOld); !os.IsNotExist(err) {
		t.Errorf("the directory's own old backup survived (glob did not reach it): %v", err)
	}
	// The sibling's must not be touched.
	for _, sibling := range []string{siblingDir, otherSubdir} {
		path := filepath.Join(sibling, "tokenboard.backup-20260101T000000Z")
		if _, err := os.Stat(path); err != nil {
			t.Errorf("a sibling directory's backup was removed: %s: %v", path, err)
		}
	}
}

// Backup names must be unique even within one UTC second. The stamp alone is
// second-precision, and `backupPath` is also the argument to a rename that
// replaces its target: two swaps inside one second (two self-updates racing,
// which nothing serializes) would otherwise overwrite each other's backup and
// destroy the only rollback copy.
func TestBackupPathIsUniqueWithinOneSecond(t *testing.T) {
	fixed := func() time.Time { return time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC) }
	first := backupPath("/home/user/.tokenboard/bin/tokenboard", fixed)
	second := backupPath("/home/user/.tokenboard/bin/tokenboard", fixed)

	if first == second {
		t.Fatalf("two backups in the same second share a name: %s", first)
	}
	// The timestamp must stay in the name: recoverOrphanedBinary picks the
	// newest backup by sorting the names.
	for _, path := range []string{first, second} {
		if !strings.Contains(filepath.Base(path), "20260102T030405Z") {
			t.Errorf("backup %s does not carry the UTC stamp", path)
		}
	}
	// A later second still orders after an earlier one by name.
	later := backupPath("/home/user/.tokenboard/bin/tokenboard",
		func() time.Time { return time.Date(2026, 1, 2, 3, 4, 6, 0, time.UTC) })
	names := []string{first, second, later}
	sort.Strings(names)
	if names[len(names)-1] != later {
		t.Errorf("the newest backup does not sort last: %v", names)
	}
}

// A release without ccusage (an older tag) must still update the client: the
// three-layer acquisition falls back to PATH and the download layer.
func TestRunAcceptsAReleaseWithoutCcusage(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	if err := os.WriteFile(target, stubBinary("0.0.1"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("0.0.1")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	fake := fakeRelease{tag: "v1.2.3", platform: "darwin_arm64", tarball: buildTarball(t, "tokenboard", stubBinary("1.2.3"))}
	server := fake.server(t)

	configDir := t.TempDir()
	result, err := runAgainstWithConfigDir(t, server, target, "", configDir)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !result.Updated {
		t.Error("a release without ccusage must still update the client")
	}
	if _, err := os.Stat(filepath.Join(configDir, "bin", "ccusage")); !os.IsNotExist(err) {
		t.Errorf("ccusage must not appear when the release has none: %v", err)
	}
}

// buildTarballWithFiles assembles a release tarball holding several files.
func buildTarballWithFiles(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	archive := tar.NewWriter(writer)
	for name, body := range files {
		if err := archive.WriteHeader(&tar.Header{
			Name:     name,
			Mode:     0o755,
			Size:     int64(len(body)),
			Typeflag: tar.TypeReg,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := archive.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// A copy of ccusage left by an earlier release stays where it is, and the
// update says so once: the client no longer installs, uses or removes it.
func TestRunReportsTheCcusageItLeavesBehind(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	if err := os.WriteFile(target, stubBinary("0.0.1"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("0.0.1")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	tarball := buildTarball(t, "tokenboard", stubBinary("1.2.3"))
	fake := fakeRelease{tag: "v1.2.3", platform: "darwin_arm64", tarball: tarball}
	server := fake.server(t)

	configDir := t.TempDir()
	ccusagePath := filepath.Join(configDir, "bin", ccusageBinaryName())
	if err := os.MkdirAll(filepath.Dir(ccusagePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ccusagePath, []byte("stale"), 0o755); err != nil {
		t.Fatal(err)
	}
	var lines []string
	if _, err := Run(Input{
		Repo:       "evepupil/TokenBoard",
		Target:     target,
		Platform:   "darwin",
		Arch:       "arm64",
		HTTPClient: server.Client(),
		Stderr:     func(line string) { lines = append(lines, line) },
		Env: func(key string) string {
			switch key {
			case "TOKENBOARD_RELEASE_BASE_URL":
				return server.URL
			case "TOKENBOARD_CONFIG_DIR":
				return configDir
			}
			return ""
		},
	}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	found := false
	for _, line := range lines {
		if strings.Contains(line, "no longer bundles or uses ccusage") && strings.Contains(line, ccusagePath) {
			found = true
		}
	}
	if !found {
		t.Errorf("stderr = %v, want a report of the ccusage left in place", lines)
	}
}

// The staged binary is probed before it is trusted, so it must not see the upload token: a
// tampered feed could answer `version` and read the credentials from its own environment. The
// TS side scrubs this same probe (`client-binary.mjs` `runsVersion` → `scrubbedChildEnv`).
func TestVerifyExecutableDoesNotHandCredentialsToTheStagedBinary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the stub is a shell script")
	}
	dir := t.TempDir()
	envCapture := filepath.Join(dir, "staged-env")
	staged := filepath.Join(dir, "tokenboard")
	script := "#!/bin/sh\n" +
		"printf '%s|%s|%s' \"$TOKENBOARD_UPLOAD_TOKEN\" \"$TOKENBOARD_PAIRING_CODE\" \"$TOKENBOARD_RELEASE_BASE_URL\" > '" + envCapture + "'\n" +
		"echo \"tokenboard (go) 1.2.3\"\n"
	if err := os.WriteFile(staged, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TOKENBOARD_UPLOAD_TOKEN", "tb_upload_secret")
	t.Setenv("TOKENBOARD_PAIRING_CODE", "tb_pair_secret")
	t.Setenv("TOKENBOARD_RELEASE_BASE_URL", "https://user:pw@feed.example")

	if err := verifyExecutable(staged, "1.2.3"); err != nil {
		t.Fatalf("verifyExecutable: %v", err)
	}
	captured, err := os.ReadFile(envCapture)
	if err != nil {
		t.Fatalf("the probe did not run: %v", err)
	}
	if string(captured) != "||" {
		t.Errorf("staged binary saw credentials: %q, want all stripped", string(captured))
	}
}

// A pinned tag that already matches the installed version is a no-op. The
// equality short-circuit used to skip pinned runs so a downgrade stayed
// possible, but the downgrade guard has its own branch: leaving `--tag` (or a
// TOKENBOARD_RELEASE_TAG carried in the scheduler's environment) outside the
// check meant every scheduled run re-downloaded and re-swapped the same 6MB.
func TestRunIsANoopWhenAPinnedTagMatchesTheInstalledVersion(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	installed := stubBinary("1.2.3")
	if err := os.WriteFile(target, installed, 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("1.2.3")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	var downloads int
	fake := fakeRelease{tag: "v1.2.3", platform: "darwin_arm64", tarball: buildTarball(t, "tokenboard", stubBinary("1.2.3"))}
	server := fake.server(t)
	server.Config.Handler = countingDownloads(server.Config.Handler, &downloads)

	result, err := runAgainst(t, server, target, "v1.2.3")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Updated {
		t.Error("a pinned tag matching the installed version must not reinstall it")
	}
	if downloads != 0 {
		t.Errorf("downloads = %d, want none: the archive must not be fetched", downloads)
	}
	if got, err := os.ReadFile(target); err != nil || !bytes.Equal(got, installed) {
		t.Error("the installed binary was replaced")
	}
}

// A pinned downgrade is still allowed: the equality check is not what decides
// it, the version comparison is.
func TestRunStillInstallsAPinnedDowngrade(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	if err := os.WriteFile(target, stubBinary("2.0.0"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("2.0.0")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	fake := fakeRelease{tag: "v1.9.0", platform: "darwin_arm64", tarball: buildTarball(t, "tokenboard", stubBinary("1.9.0"))}
	server := fake.server(t)

	result, err := runAgainst(t, server, target, "v1.9.0")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !result.Updated || result.Version != "1.9.0" {
		t.Errorf("result = %+v, want a pinned downgrade to 1.9.0", result)
	}
}

// A tarball that does not carry the executable, or carries something that is
// not a plain non-empty file under 128MiB, must be refused before anything is
// staged: unpacking it "successfully" would install a directory entry or a
// truncated binary over the client.
func TestExtractBinaryRefusesMalformedTarballs(t *testing.T) {
	cases := []struct {
		name    string
		build   func(t *testing.T) []byte
		wantMsg string
	}{
		{
			name: "missing the executable",
			build: func(t *testing.T) []byte {
				return buildTarball(t, "README.md", []byte("docs"))
			},
			wantMsg: "does not contain tokenboard",
		},
		{
			name: "entry is a directory",
			build: func(t *testing.T) []byte {
				return buildTarballWithType(t, "tokenboard", tar.TypeDir, nil)
			},
			wantMsg: "is not a file",
		},
		{
			name: "entry is empty",
			build: func(t *testing.T) []byte {
				return buildTarball(t, "tokenboard", nil)
			},
			wantMsg: "is empty",
		},
		{
			name: "not a gzip stream",
			build: func(t *testing.T) []byte {
				return []byte("not a tarball at all")
			},
			wantMsg: "invalid TokenBoard release tarball",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := extractBinary(testCase.build(t), "tokenboard")
			if err == nil {
				t.Fatal("a malformed tarball must be refused")
			}
			if !strings.Contains(err.Error(), testCase.wantMsg) {
				t.Errorf("err = %q, want it to mention %q", err, testCase.wantMsg)
			}
		})
	}
}

// buildTarballWithType assembles a tarball whose single entry has the given
// type flag, so a directory entry can be presented where a file is expected.
func buildTarballWithType(t *testing.T, name string, typeflag byte, body []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	archive := tar.NewWriter(writer)
	if err := archive.WriteHeader(&tar.Header{
		Name:     name,
		Mode:     0o755,
		Size:     int64(len(body)),
		Typeflag: typeflag,
	}); err != nil {
		t.Fatal(err)
	}
	if len(body) > 0 {
		if _, err := archive.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// Pruning lists the directory instead of globbing it, so it must not depend on
// escaping at all: on Windows filepath.Glob disables escaping and treats `\`
// as a path separator, which made an escaped `[cfg]` directory an invalid path
// there. A directory whose name carries every glob metacharacter still has its
// own backups pruned, and a sibling whose name resembles the pattern is left
// alone.
func TestPruneBackupsHandlesMetacharacterDirectoriesWithoutGlobbing(t *testing.T) {
	root := t.TempDir()
	oddDir := filepath.Join(root, "bin[1]")
	sibling := filepath.Join(root, "bin1")
	for _, dir := range []string{oddDir, sibling} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	current := filepath.Join(oddDir, "tokenboard")
	keep := current + ".backup-20260103T000000Z-000002"
	stale := []string{
		current + ".backup-20260101T000000Z-000001",
		current + ".backup-20260102T000000Z-000001",
	}
	for _, path := range append(stale, keep) {
		if err := os.WriteFile(path, []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	siblingBackup := filepath.Join(sibling, "tokenboard.backup-20260101T000000Z-000001")
	if err := os.WriteFile(siblingBackup, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A directory named like a backup must never be removed as one.
	fakeDir, _ := os.MkdirTemp(oddDir, "tokenboard.backup-")
	if err := os.MkdirAll(fakeDir, 0o700); err != nil {
		t.Fatal(err)
	}

	pruneBackups(current, keep)

	for _, path := range stale {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("stale backup survived: %s", path)
		}
	}
	if _, err := os.Stat(keep); err != nil {
		t.Errorf("the kept backup was removed: %v", err)
	}
	if _, err := os.Stat(siblingBackup); err != nil {
		t.Errorf("a sibling directory's backup was removed: %v", err)
	}
	if info, err := os.Stat(fakeDir); err != nil || !info.IsDir() {
		t.Errorf("a directory matching the backup prefix was removed: %v", err)
	}
}

// The keep path is compared before removing. Windows compares case
// -insensitively the way its filesystem does, because the same file can be
// named with different case by different callers. On other platforms two names
// that differ only in case are different files and must not be conflated.
func TestSamePathMatchesThePlatformFilesystem(t *testing.T) {
	same := samePath("/opt/bin/tokenboard", "/opt/bin/./tokenboard")
	if !same {
		t.Fatal("a cleaned path was not recognised as the same file")
	}
	folded := samePath(`C:\Bin\tokenboard`, `c:\bin\TokenBoard`)
	if runtime.GOOS == "windows" {
		if !folded {
			t.Fatal("Windows did not compare a case-only difference as the same file")
		}
	} else if folded {
		t.Fatal("a case-only difference was treated as the same file on a case-sensitive filesystem")
	}
}

// The swap's rollback branches decide whether a machine that has a working
// client still has one after a failed install. They only run when a rename
// fails, which a test cannot provoke on a healthy filesystem, so the seam
// supplies the failure.
func TestSwapRestoresTheOriginalWhenTheInstallRenameFails(t *testing.T) {
	dir := t.TempDir()
	staged := filepath.Join(dir, "tokenboard.new")
	current := filepath.Join(dir, "tokenboard")
	backup := filepath.Join(dir, "tokenboard.backup-20260101T000000Z-000001")
	for path, body := range map[string]string{staged: "new", current: "old"} {
		if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	rename := func(from, to string) error {
		if from == staged {
			return errors.New("staged file is locked")
		}
		return os.Rename(from, to)
	}

	err := swapWith(staged, current, backup, rename)
	if err == nil || !strings.Contains(err.Error(), "staged file is locked") {
		t.Fatalf("err = %v, want the install failure", err)
	}
	restored, readErr := os.ReadFile(current)
	if readErr != nil {
		t.Fatalf("the client is gone after a failed install: %v", readErr)
	}
	if string(restored) != "old" {
		t.Fatalf("current = %q, want the original restored", restored)
	}
	if _, statErr := os.Stat(backup); !os.IsNotExist(statErr) {
		t.Errorf("the backup was not moved back: %v", statErr)
	}
}

// When the restore fails too there is nothing left to do, but the error has to
// name both failures and the backup's path: that file is the only working
// client left, and the operator needs its name to put it back by hand.
func TestSwapReportsBothFailuresAndTheBackupPath(t *testing.T) {
	dir := t.TempDir()
	staged := filepath.Join(dir, "tokenboard.new")
	current := filepath.Join(dir, "tokenboard")
	backup := filepath.Join(dir, "tokenboard.backup-20260101T000000Z-000001")
	for path, body := range map[string]string{staged: "new", current: "old"} {
		if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	rename := func(from, to string) error {
		if from == current {
			return os.Rename(from, to)
		}
		return errors.New("locked")
	}

	err := swapWith(staged, current, backup, rename)
	if err == nil {
		t.Fatal("a swap that cannot install or restore must fail")
	}
	for _, want := range []string{"cannot install", "could not be restored", backup} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("err = %v, want it to mention %q", err, want)
		}
	}
}

// A backup that is a symlink is removed as a link, never through it: pruning
// must not delete whatever the link points at. The target here is another
// binary's backup, which a follow-the-link remove would silently destroy.
func TestPruneBackupsRemovesTheLinkNotItsTarget(t *testing.T) {
	dir := t.TempDir()
	current := filepath.Join(dir, "tokenboard")
	keep := current + ".backup-20260103T000000Z-000002"
	target := filepath.Join(dir, "elsewhere")
	if err := os.WriteFile(target, []byte("do not delete"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := current + ".backup-20260101T000000Z-000001"
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks are unavailable here: %v", err)
	}
	if err := os.WriteFile(keep, []byte("keep"), 0o755); err != nil {
		t.Fatal(err)
	}

	pruneBackups(current, keep)

	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Errorf("the stale link survived: %v", err)
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != "do not delete" {
		t.Errorf("pruning reached through the link: %q, %v", data, err)
	}
}
