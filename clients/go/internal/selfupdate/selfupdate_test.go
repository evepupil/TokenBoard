package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

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
	mux.HandleFunc("/MisonL/TokenBoard/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/MisonL/TokenBoard/releases/tag/"+f.tag, http.StatusFound)
	})
	mux.HandleFunc("/MisonL/TokenBoard/releases/tag/"+f.tag, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("<html>release " + f.tag + "</html>"))
	})
	mux.HandleFunc("/MisonL/TokenBoard/releases/download/"+f.tag+"/"+archiveName,
		func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write(f.tarball)
		})
	mux.HandleFunc("/MisonL/TokenBoard/releases/download/"+f.tag+"/"+release.ChecksumsName(),
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
// bundled ccusage install follows that variable, and without it the test would
// write into the machine's real ~/.tokenboard/bin.
func runAgainstWithConfigDir(t *testing.T, server *httptest.Server, target, tag, configDir string) (Result, error) {
	t.Helper()
	return Run(Input{
		Repo:       "MisonL/TokenBoard",
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
		Repo:       "MisonL/TokenBoard",
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

// The glob pattern is escaped, so a binary living in a directory whose name
// carries glob metacharacters prunes its own backups, not another binary's.
func TestPruneBackupsEscapesGlobMeta(t *testing.T) {
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

// Spec §4.1: the release tarball carries the platform's ccusage binary beside
// the client. An update that installed only the client would leave a machine
// whose ccusage version never follows the one the new client expects.
func TestRunInstallsTheBundledCcusage(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	if err := os.WriteFile(target, stubBinary("0.0.1"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("0.0.1")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	tarball := buildTarballWithFiles(t, map[string][]byte{
		"tokenboard": stubBinary("1.2.3"),
		"ccusage":    []byte("#!/bin/sh\necho 'ccusage 20.0.33'\n"),
	})
	fake := fakeRelease{tag: "v1.2.3", platform: "darwin_arm64", tarball: tarball}
	server := fake.server(t)

	configDir := t.TempDir()
	if _, err := runAgainstWithConfigDir(t, server, target, "", configDir); err != nil {
		t.Fatalf("Run: %v", err)
	}
	// The bundled layer looks under the config directory (BundledBinDir), which
	// is where the skill's bootstrap install puts it too.
	bundled, err := os.ReadFile(filepath.Join(configDir, "bin", "ccusage"))
	if err != nil {
		t.Fatalf("the bundled ccusage was not installed: %v", err)
	}
	if !bytes.Contains(bundled, []byte("ccusage 20.0.33")) {
		t.Errorf("installed ccusage is not the bundled one: %q", bundled)
	}
	info, err := os.Stat(filepath.Join(configDir, "bin", "ccusage"))
	if err != nil {
		t.Fatal(err)
	}
	// Windows has no execute bit; a file runs by extension there.
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		t.Errorf("ccusage is not executable: %v", info.Mode())
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

// A tarball whose ccusage entry is malformed must fail the update, not install
// a client whose bundled layer then downloads a different version.
func TestRunRefusesAMalformedCcusageEntry(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "tokenboard")
	if err := os.WriteFile(target, stubBinary("0.0.1"), 0o755); err != nil {
		t.Fatal(err)
	}
	SetCurrentVersion("0.0.1")
	t.Cleanup(func() { SetCurrentVersion("dev") })

	tarball := buildTarballWithFiles(t, map[string][]byte{
		"tokenboard": stubBinary("1.2.3"),
		"ccusage":    nil, // a present-but-empty entry is malformed
	})
	fake := fakeRelease{tag: "v1.2.3", platform: "darwin_arm64", tarball: tarball}
	server := fake.server(t)

	configDir := t.TempDir()
	if _, err := runAgainstWithConfigDir(t, server, target, "", configDir); err == nil {
		t.Fatal("an empty ccusage entry must fail the update")
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("the original binary must stay in place: %v", err)
	}
}

// A release that carries no ccusage leaves the existing copy in place, and the
// update must say so: that copy is now a version the new client was never
// tested against, and a silent update would hide it.
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
	ccusagePath := filepath.Join(configDir, "bin", "ccusage")
	if err := os.MkdirAll(filepath.Dir(ccusagePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ccusagePath, []byte("stale"), 0o755); err != nil {
		t.Fatal(err)
	}
	var lines []string
	if _, err := Run(Input{
		Repo:       "MisonL/TokenBoard",
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
		if strings.Contains(line, "carries no ccusage") && strings.Contains(line, ccusagePath) {
			found = true
		}
	}
	if !found {
		t.Errorf("stderr = %v, want a report of the ccusage left in place", lines)
	}
}
