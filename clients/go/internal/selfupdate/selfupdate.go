// Package selfupdate implements the spec §8 upgrade path: download a release
// tarball, verify it against the release's checksums.txt, and swap it into
// place with the previous binary kept until the new one has proved it runs.
//
// The order is load-bearing and mirrors the TS archive fallback's
// replace-with-rollback: stage beside the target, verify, then swap. A swap
// that replaced first and verified second would leave a machine whose
// collector cannot run at all — and the scheduled sync would never repair it,
// because the thing that upgrades is the thing that broke.
package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/ccusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/release"
)

// maxBinaryBytes bounds the executable inside the tarball. The tarball itself
// is bounded by release.Download's maxDownloadBytes.
const maxBinaryBytes = 128 * 1024 * 1024

// binaryName is the executable the tarball ships.
func binaryName(goos string) string {
	if goos == "windows" {
		return "tokenboard.exe"
	}
	return "tokenboard"
}

// ccusageBinaryName is the bundled ccusage entry in the tarball, matching the
// name internal/ccusage's bundled layer looks up.
func ccusageBinaryName(goos string) string {
	if goos == "windows" {
		return "ccusage.exe"
	}
	return "ccusage"
}

// Input configures one update.
type Input struct {
	// Repo is the GitHub repository; empty uses release.DefaultRepo.
	Repo string
	// Tag pins a release; empty takes the latest.
	Tag string
	// Target is the executable to replace. Empty uses the running binary.
	Target string
	// Platform and Arch default to the runtime values; tests pin them.
	Platform string
	Arch     string
	// HTTPClient overrides the client; nil uses a 30s one.
	HTTPClient *http.Client
	// Env resolves TOKENBOARD_RELEASE_REPO; nil means none.
	Env func(string) string
	// Stderr receives progress and diagnostics. Nil discards them.
	Stderr func(line string)
	// Now stamps the backup name; nil uses time.Now.
	Now func() time.Time
}

// Result reports what one update did.
type Result struct {
	Version string
	// Updated is false when the installed version already matched.
	Updated bool
	// BackupPath names the previous binary, kept as the rollback until the
	// next successful update replaces it.
	BackupPath string
}

// Run performs one update: resolve, download, verify, swap.
func Run(input Input) (Result, error) {
	stderr := input.Stderr
	if stderr == nil {
		stderr = func(string) {}
	}
	goos := input.Platform
	if goos == "" {
		goos = runtime.GOOS
	}
	goarch := input.Arch
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	// Refuse an unbuildable platform before any network call; the archive name
	// is derived from the same pair inside release.Resolve.
	if _, ok := release.Platform(goos, goarch); !ok {
		return Result{}, fmt.Errorf("TokenBoard has no release for %s/%s", goos, goarch)
	}
	repo, err := release.Repo(input.Repo)
	if err != nil {
		return Result{}, err
	}
	current, err := targetPath(input.Target)
	if err != nil {
		return Result{}, err
	}

	client := input.HTTPClient
	assets, err := release.Resolve(release.Options{
		Repo:       repo,
		Tag:        input.Tag,
		Platform:   goos,
		Arch:       goarch,
		HTTPClient: client,
		BaseURL:    envValue(input.Env, "TOKENBOARD_RELEASE_BASE_URL"),
	})
	if err != nil {
		return Result{}, err
	}
	version := release.Version(assets.Tag)
	if version == "" {
		return Result{}, fmt.Errorf("TokenBoard release %s has no usable version", assets.Tag)
	}
	if !pinned(input.Tag) && release.Version(CurrentVersion()) == version {
		// A scheduled run must stay quiet when there is nothing to do: the
		// log is long-lived and an "already current" line every hour is noise.
		return Result{Version: version}, nil
	}

	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	archiveData, err := release.Download(client, assets.Archive)
	if err != nil {
		return Result{}, err
	}
	checksumData, err := release.Download(client, assets.Checksums)
	if err != nil {
		return Result{}, err
	}
	checksums, err := release.Checksums(checksumData)
	if err != nil {
		return Result{}, err
	}
	if err := release.Verify(archiveData, assets.Archive.Name, checksums); err != nil {
		return Result{}, err
	}
	binary, err := extractBinary(archiveData, binaryName(goos))
	if err != nil {
		return Result{}, err
	}
	// Spec §4.1: the tarball also carries the platform's ccusage. It is
	// optional — an older release without it still updates the client, which
	// then falls back to PATH and the download layer. A malformed entry is not
	// the same as an absent one, so a corrupt archive fails the update instead
	// of silently leaving no ccusage behind.
	ccusageData, hasCcusage, err := extractOptionalEntry(archiveData, ccusageBinaryName(goos))
	if err != nil {
		return Result{}, err
	}

	dir := filepath.Dir(current)
	staged := filepath.Join(dir, binaryName(goos)+".new")
	if err := writeExecutable(staged, binary); err != nil {
		return Result{}, err
	}
	defer func() { _ = os.Remove(staged) }()
	if err := verifyStaged(staged, version); err != nil {
		_ = os.Remove(staged)
		return Result{}, fmt.Errorf("the downloaded TokenBoard binary does not run: %w", err)
	}

	backup := backupPath(current, input.Now)
	if err := swap(staged, current, backup); err != nil {
		return Result{}, err
	}
	// One backup is the rollback; the ones before it are only disk. Each is a
	// full copy of the binary, so a machine that updates on every scheduled
	// sync would otherwise accumulate one per release, forever.
	pruneBackups(current, backup)
	// The bundled ccusage lands beside the client, where the three-layer
	// acquisition looks first. A failure here is reported but does not undo a
	// client update that already succeeded: the probe and download layers
	// still cover the machine.
	//
	// The target follows the config directory, matching where the skill's
	// bootstrap install puts it: the client may be pinned at an explicit path
	// (tests, or a hand-placed binary) while the ccusage it should pair with
	// lives under TOKENBOARD_CONFIG_DIR/bin.
	if hasCcusage {
		ccusageDir := ccusage.BundledBinDir(input.Env, "")
		if err := os.MkdirAll(ccusageDir, 0o700); err != nil {
			stderr(fmt.Sprintf("TokenBoard updated to %s, but the bundled ccusage could not be installed: %v", version, err))
		} else if err := writeExecutable(filepath.Join(ccusageDir, ccusageBinaryName(goos)), ccusageData); err != nil {
			stderr(fmt.Sprintf("TokenBoard updated to %s, but the bundled ccusage could not be installed: %v", version, err))
		}
	} else if stalePath := filepath.Join(ccusage.BundledBinDir(input.Env, ""), ccusageBinaryName(goos)); fileExists(stalePath) {
		// The release carries no ccusage, so whatever is there stays — a
		// version this client was never tested against. Say so rather than
		// report a clean update; the skill's bootstrap install reports the
		// same thing.
		stderr(fmt.Sprintf(
			"TokenBoard updated to %s; release %s carries no ccusage, so the existing %s is left in place",
			version, assets.Tag, stalePath))
	}
	stderr(fmt.Sprintf("TokenBoard updated to %s (previous binary kept at %s)", version, backup))
	return Result{Version: version, Updated: true, BackupPath: backup}, nil
}

// pruneBackups removes the backups beside the installed binary, keeping the
// one this update just made. Cleanup never fails the update: the new binary is
// already in place and verified, and a leftover file is not worth reporting an
// upgrade as failed for.
func pruneBackups(current, keep string) {
	matches, err := filepath.Glob(backupPathPattern(current))
	if err != nil {
		return
	}
	for _, match := range matches {
		if match == keep {
			continue
		}
		_ = os.Remove(match)
	}
}

// backupPathPattern is the glob for one binary's backups. The literal prefix is
// escaped so a directory containing glob metacharacters cannot widen the match.
func backupPathPattern(current string) string {
	return filepath.Join(filepath.Dir(current), escapeGlobMeta(filepath.Base(current))+".backup-*")
}

func escapeGlobMeta(value string) string {
	var builder strings.Builder
	for _, char := range value {
		if strings.ContainsRune(`*?[]\`, char) {
			builder.WriteRune('\\')
		}
		builder.WriteRune(char)
	}
	return builder.String()
}

// fileExists reports whether path is an existing regular file.
func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func pinned(tag string) bool { return strings.TrimSpace(tag) != "" }

// envValue reads a key through the input's environment, empty when unset.
func envValue(env func(string) string, key string) string {
	if env == nil {
		return ""
	}
	return env(key)
}

// currentVersionValue is the running binary's build-stamped version. The CLI
// records it with SetCurrentVersion; "dev" means unstamped, which never
// compares equal to a release and so always updates.
var currentVersionValue = "dev"

// SetCurrentVersion records the running binary's version.
func SetCurrentVersion(version string) {
	version = strings.TrimSpace(version)
	if version == "" {
		version = "dev"
	}
	currentVersionValue = version
}

// CurrentVersion returns the version SetCurrentVersion recorded, defaulting
// to "dev" for a binary built without a stamp.
func CurrentVersion() string { return currentVersionValue }

func targetPath(explicit string) (string, error) {
	if strings.TrimSpace(explicit) != "" {
		return filepath.Clean(explicit), nil
	}
	path, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("cannot resolve the running TokenBoard binary: %w", err)
	}
	// os.Executable resolves symlinks on most platforms; a binary reached
	// through one must still update the file behind it.
	if resolved, err := filepath.EvalSymlinks(path); err == nil && resolved != "" {
		path = resolved
	}
	return path, nil
}

func backupPath(current string, now func() time.Time) string {
	stamp := time.Now().UTC()
	if now != nil {
		stamp = now().UTC()
	}
	return fmt.Sprintf("%s.backup-%s", current, stamp.Format("20060102T150405Z"))
}

// swap replaces current with staged, keeping the old file as backup.
//
// The two renames are not atomic as a pair: between them the target path does
// not exist. The original is never lost — it is at `backup` — but a process
// killed in that window leaves the machine with no client at `current`, and
// the next scheduled sync reports "client is not installed". The skill's
// binary path therefore restores from the backup before spawning (see
// `recoverOrphanedBinary` in client-binary.mjs); a manual run can always
// rename the backup back by hand.
func swap(staged, current, backup string) error {
	if err := os.Rename(current, backup); err != nil {
		return fmt.Errorf("cannot back up the current TokenBoard binary: %w", err)
	}
	if err := os.Rename(staged, current); err != nil {
		// Put the original back before reporting: a failed swap must not
		// leave the machine without a collector.
		if restoreErr := os.Rename(backup, current); restoreErr != nil {
			return fmt.Errorf("cannot install the new TokenBoard binary: %v; "+
				"and the original could not be restored from %s: %w", err, backup, restoreErr)
		}
		return fmt.Errorf("cannot install the new TokenBoard binary: %w", err)
	}
	return nil
}

func writeExecutable(path string, data []byte) error {
	if err := os.RemoveAll(path); err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0o755); err != nil {
		return err
	}
	// The umask may have stripped the execute bit; without it the new binary
	// cannot run at all, and the verification below would fail for a reason
	// that has nothing to do with the download.
	if err := os.Chmod(path, 0o755); err != nil {
		return err
	}
	return nil
}

// verifyStaged is the executable verification Run performs. It is a variable
// so a test on a host that cannot run the fixture (Windows rejects a shell
// script as "%1 is not a valid Win32 application") can substitute a check with
// the same contract; production code never assigns it.
var verifyStaged = verifyExecutable

// versionProbeTimeout bounds the staged binary's version check.
const versionProbeTimeout = 10 * time.Second

// verifyExecutable runs the staged binary's version check. A binary that
// cannot answer is not installed: swapping it in would break the next
// scheduled sync with no way to notice.
//
// The printed line must name the expected version as a whole token. A
// substring test would accept "1.2.30" for "1.2.3", and the staged binary is
// the only thing standing between a truncated download and a broken install.
func verifyExecutable(path, want string) error {
	// A freshly staged binary can block on first run — Gatekeeper quarantine,
	// antivirus scanning, a broken loader — and an unbounded wait here hangs
	// self-update entirely (the `--scheduled` exit-zero fallback never runs
	// because the error branch is never reached). The probe gets a bound, the
	// same way ccusage's version probe does.
	ctx, cancel := context.WithTimeout(context.Background(), versionProbeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "version")
	cmd.WaitDelay = versionProbeTimeout
	output, err := cmd.Output()
	if err != nil {
		return err
	}
	printed := strings.TrimSpace(string(output))
	if printed == "" {
		return errors.New("the binary printed no version")
	}
	if !namesVersion(printed, want) {
		return fmt.Errorf("version check printed %q, want %q", printed, want)
	}
	return nil
}

// namesVersion reports whether the output names version as a standalone
// token, delimited by anything that is not part of a version number.
func namesVersion(output, version string) bool {
	start := 0
	for {
		index := strings.Index(output[start:], version)
		if index < 0 {
			return false
		}
		index += start
		end := index + len(version)
		before := byte(' ')
		if index > 0 {
			before = output[index-1]
		}
		after := byte(' ')
		if end < len(output) {
			after = output[end]
		}
		if !isVersionContinuation(before) && !isVersionContinuation(after) {
			return true
		}
		start = index + 1
	}
}

// isVersionContinuation reports whether a byte continues a version number, so
// "1.2.3" is not found inside "1.2.30" or "v1.2.3.1".
func isVersionContinuation(char byte) bool {
	return (char >= '0' && char <= '9') || char == '.'
}

// extractBinary pulls the executable out of the release tarball. A tarball
// that ships anything else is refused rather than installed blindly.
func extractBinary(tarball []byte, name string) ([]byte, error) {
	reader, err := gzip.NewReader(bytes.NewReader(tarball))
	if err != nil {
		return nil, fmt.Errorf("invalid TokenBoard release tarball: %w", err)
	}
	defer reader.Close()
	data, found, err := readTarballEntry(tar.NewReader(reader), name)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("TokenBoard release tarball does not contain %s", name)
	}
	return data, nil
}

// extractOptionalEntry reads an entry that may be absent. An entry that is
// present but malformed is an error, not a release without the file: skipping
// it would install a client whose bundled layer then downloads a different
// version than the release was built with.
func extractOptionalEntry(tarball []byte, name string) ([]byte, bool, error) {
	reader, err := gzip.NewReader(bytes.NewReader(tarball))
	if err != nil {
		return nil, false, fmt.Errorf("invalid TokenBoard release tarball: %w", err)
	}
	defer reader.Close()
	return readTarballEntry(tar.NewReader(reader), name)
}

// readTarballEntry reads the first regular file whose base name matches. The
// entry is bounded and must be non-empty; anything else is a malformed archive.
func readTarballEntry(archive *tar.Reader, name string) ([]byte, bool, error) {
	for {
		header, err := archive.Next()
		if err == io.EOF {
			return nil, false, nil
		}
		if err != nil {
			return nil, false, fmt.Errorf("invalid TokenBoard release tarball: %w", err)
		}
		if filepath.Base(header.Name) != name {
			continue
		}
		if header.Typeflag != tar.TypeReg {
			return nil, false, fmt.Errorf("TokenBoard release tarball entry %s is not a file", header.Name)
		}
		if header.Size > maxBinaryBytes {
			return nil, false, fmt.Errorf("TokenBoard binary exceeds %d bytes", maxBinaryBytes)
		}
		data, err := io.ReadAll(io.LimitReader(archive, header.Size))
		if err != nil {
			return nil, false, err
		}
		if len(data) == 0 {
			return nil, false, fmt.Errorf("TokenBoard release tarball entry %s is empty", header.Name)
		}
		return data, true, nil
	}
}
