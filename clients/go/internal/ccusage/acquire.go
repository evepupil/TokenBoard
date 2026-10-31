package ccusage

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
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
)

// Port of the acquisition half of the spec's §4 three-layer resolution:
// bundled > PATH probe > download, fail-closed. Hook mode never downloads:
// the hook path must not reach the network, so a machine without a usable
// binary reports the source unavailable instead.

// MaxBinaryBytes bounds the downloaded platform tarball.
const MaxBinaryBytes = 64 * 1024 * 1024

// AcquireOptions configures binary resolution.
type AcquireOptions struct {
	Env     func(string) string
	HomeDir string
	// HookMode forbids the download layer.
	HookMode bool
	// Platform and Arch default to the runtime values; tests pin them.
	Platform string
	Arch     string
	// LookPath and FileExists are injectable for tests.
	LookPath   func(string) (string, error)
	FileExists func(string) bool
	// HTTPClient is used by the download layer; nil uses a 30s client.
	HTTPClient *http.Client
	Stderr     func(line string)
	// Version is the expected release; empty uses Version.
	Version string
}

// Binary is a resolved ccusage executable.
type Binary struct {
	Path string
	// Source names the layer that produced it: "env", "bundled", "path" or
	// "download".
	Source string
}

// Resolve returns the ccusage binary to run, acquiring it when necessary.
//
// Resolution order:
//  1. TOKENBOARD_CCUSAGE_BIN (an explicit path; a missing file is an error).
//  2. the bundled install at <configDir>/bin/ccusage.
//  3. a ccusage found on PATH (a version mismatch warns, it does not refuse —
//     a probe hit is still a working binary).
//  4. a download into <configDir>/bin (never in hook mode).
func Resolve(options AcquireOptions) (Binary, error) {
	env := options.Env
	if env == nil {
		env = os.Getenv
	}
	platform := options.Platform
	if platform == "" {
		platform = runtime.GOOS
	}
	arch := options.Arch
	if arch == "" {
		arch = runtime.GOARCH
	}
	expected := options.Version
	if expected == "" {
		expected = Version
	}
	lookPath := options.LookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	fileExists := options.FileExists
	if fileExists == nil {
		fileExists = func(path string) bool {
			info, err := os.Stat(path)
			return err == nil && info.Mode().IsRegular()
		}
	}
	stderr := options.Stderr
	if stderr == nil {
		stderr = func(string) {}
	}

	// TS gates this on truthiness, not on a trimmed value: a whitespace-only
	// setting is "set" and then fails the existence check. Trimming here would
	// turn that error into a silent fall-through to the bundled binary.
	if forced := env("TOKENBOARD_CCUSAGE_BIN"); forced != "" {
		if !fileExists(forced) {
			return Binary{}, fmt.Errorf("TOKENBOARD_CCUSAGE_BIN does not exist: %s", forced)
		}
		return Binary{Path: forced, Source: "env"}, nil
	}

	bundledDir := BundledBinDir(env, options.HomeDir)
	bundled := filepath.Join(bundledDir, binaryName(platform))
	if fileExists(bundled) {
		warnVersionDrift(bundled, expected, stderr)
		return Binary{Path: bundled, Source: "bundled"}, nil
	}
	// A copy installed before the bundled directory followed
	// TOKENBOARD_CONFIG_DIR still sits under the default home. It is a valid
	// bundled copy, so a machine that already has one keeps working without a
	// download.
	if legacy := filepath.Join(defaultBundledBinDir(options.HomeDir), binaryName(platform)); legacy != bundled {
		if fileExists(legacy) {
			warnVersionDrift(legacy, expected, stderr)
			return Binary{Path: legacy, Source: "bundled"}, nil
		}
	}

	if probed, err := lookPath("ccusage"); err == nil && probed != "" {
		warnVersionDrift(probed, expected, stderr)
		return Binary{Path: probed, Source: "path"}, nil
	}

	if options.HookMode {
		return Binary{}, errors.New(
			"ccusage is not installed and hook mode does not download it; install the bundled client or put ccusage on PATH")
	}

	path, err := download(options.HTTPClient, platform, arch, expected, bundledDir, stderr)
	if err != nil {
		return Binary{}, fmt.Errorf("ccusage download failed: %w", err)
	}
	return Binary{Path: path, Source: "download"}, nil
}

// warnVersionDrift reports a binary whose version is not the expected one. A
// mismatch warns rather than refuses: a working binary from another layer is
// still usable, and refusing would strand a machine that cannot download.
//
// This applies to the bundled layer too. The install path normally puts the
// release's own ccusage there, but an install or downgrade from a tag without
// one leaves the previous copy in place, and a status report that says
// nothing would hide a version the client was never tested against.
func warnVersionDrift(path, expected string, stderr func(string)) {
	detected, ok := probeVersion(path)
	if !ok || detected == expected {
		return
	}
	stderr(fmt.Sprintf(
		"TokenBoard ccusage: %s reports version %s; this client expects %s", path, detected, expected))
}

// BundledBinDir is the directory the bundled ccusage lives in.
//
// The skill installs it beside its own config, so the directory follows the
// config the client was installed with: TOKENBOARD_CONFIG_DIR, else
// ~/.tokenboard. TOKENBOARD_STATE_DIR is deliberately not consulted — it is
// the collector's state directory (cursors, lock), and the skill never
// installs a binary there.
//
// Looking only at ~/.tokenboard/bin would miss an install made under a
// configured directory, and the client would fall through to the download
// layer — which hook mode cannot use.
func BundledBinDir(env func(string) string, homeDir string) string {
	if env == nil {
		env = os.Getenv
	}
	if dir := strings.TrimSpace(env("TOKENBOARD_CONFIG_DIR")); dir != "" {
		return filepath.Join(dir, "bin")
	}
	return defaultBundledBinDir(homeDir)
}

// defaultBundledBinDir is the spec's install location: ~/.tokenboard/bin.
func defaultBundledBinDir(homeDir string) string {
	if homeDir == "" {
		if resolved, err := os.UserHomeDir(); err == nil {
			homeDir = resolved
		}
	}
	return filepath.Join(homeDir, ".tokenboard", "bin")
}

func binaryName(platform string) string {
	if platform == "windows" {
		return "ccusage.exe"
	}
	return "ccusage"
}

// probeVersion reads `ccusage --version`, which prints "ccusage <version>".
// A binary that cannot answer is still usable — the probe only feeds a warning.
func probeVersion(path string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	// The probe runs the same third-party binary the invocation path does, so it must be
	// scrubbed the same way: a tampered ccusage could otherwise read the upload token from its
	// own environment during `--version` and never touch the (correctly scrubbed) run path.
	// `scrubCredentialEnv(nil)` materializes the inherited environment and strips the keys.
	cmd.Env = scrubCredentialEnv(nil)
	output, err := cmd.Output()
	if err != nil {
		return "", false
	}
	fields := strings.Fields(strings.TrimSpace(string(output)))
	if len(fields) < 2 || fields[0] != "ccusage" {
		return "", false
	}
	return fields[1], true
}

// npmPlatformName maps Go's GOOS to the npm platform package segment.
func npmPlatformName(platform string) (string, bool) {
	switch platform {
	case "darwin", "linux", "win32", "windows":
		if platform == "windows" {
			return "win32", true
		}
		return platform, true
	}
	return "", false
}

func npmArchName(arch string) (string, bool) {
	switch arch {
	case "amd64", "x64":
		return "x64", true
	case "arm64":
		return "arm64", true
	}
	return "", false
}

// registryMetadata is the subset of the npm registry response the download
// layer needs.
type registryMetadata struct {
	Dist struct {
		Tarball   string `json:"tarball"`
		Integrity string `json:"integrity"`
	} `json:"dist"`
}

// download fetches the platform package tarball, verifies its sha512
// integrity, and installs the binary into installDir.
func download(
	client *http.Client,
	platform, arch, version, installDir string,
	stderr func(string),
) (string, error) {
	npmPlatform, ok := npmPlatformName(platform)
	if !ok {
		return "", fmt.Errorf("ccusage has no package for platform %s", platform)
	}
	npmArch, ok := npmArchName(arch)
	if !ok {
		return "", fmt.Errorf("ccusage has no package for architecture %s", arch)
	}
	packageName := "@ccusage/ccusage-" + npmPlatform + "-" + npmArch
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	metadataURL := fmt.Sprintf("https://registry.npmjs.org/%s/%s", strings.ReplaceAll(packageName, "/", "%2F"), version)
	response, err := client.Get(metadataURL)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("registry returned HTTP %d for %s", response.StatusCode, packageName)
	}
	var metadata registryMetadata
	if err := json.NewDecoder(io.LimitReader(response.Body, 1024*1024)).Decode(&metadata); err != nil {
		return "", fmt.Errorf("invalid registry metadata for %s: %w", packageName, err)
	}
	if metadata.Dist.Tarball == "" || metadata.Dist.Integrity == "" {
		return "", fmt.Errorf("registry metadata for %s has no tarball integrity", packageName)
	}
	expectedDigest, err := decodeIntegrity(metadata.Dist.Integrity)
	if err != nil {
		return "", err
	}
	tarball, err := fetchTarball(client, metadata.Dist.Tarball)
	if err != nil {
		return "", err
	}
	digest := sha512.Sum512(tarball)
	if !equalBytes(digest[:], expectedDigest) {
		return "", fmt.Errorf("ccusage tarball integrity mismatch for %s", packageName)
	}
	binary, err := extractBinary(tarball, binaryName(platform))
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(installDir, 0o700); err != nil {
		return "", err
	}
	target := filepath.Join(installDir, binaryName(platform))
	tmp := fmt.Sprintf("%s.tmp-%d", target, os.Getpid())
	if err := os.WriteFile(tmp, binary, 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	stderr(fmt.Sprintf("TokenBoard ccusage: installed %s into %s", version, installDir))
	return target, nil
}

// decodeIntegrity parses an SRI "sha512-<base64>" value.
func decodeIntegrity(integrity string) ([]byte, error) {
	const prefix = "sha512-"
	if !strings.HasPrefix(integrity, prefix) {
		return nil, fmt.Errorf("unsupported integrity algorithm in %q", integrity)
	}
	digest, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(integrity, prefix))
	if err != nil {
		return nil, fmt.Errorf("invalid integrity value: %w", err)
	}
	if len(digest) != sha512.Size {
		return nil, errors.New("integrity digest has the wrong length")
	}
	return digest, nil
}

func fetchTarball(client *http.Client, url string) ([]byte, error) {
	response, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("tarball download returned HTTP %d", response.StatusCode)
	}
	limited := io.LimitReader(response.Body, MaxBinaryBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if len(data) > MaxBinaryBytes {
		return nil, fmt.Errorf("ccusage tarball exceeds %d bytes", MaxBinaryBytes)
	}
	return data, nil
}

// extractBinary pulls the native binary out of the npm tarball. The platform
// package stores it at bin/ccusage (bin/ccusage.exe on Windows).
func extractBinary(tarball []byte, name string) ([]byte, error) {
	reader, err := gzip.NewReader(bytes.NewReader(tarball))
	if err != nil {
		return nil, fmt.Errorf("invalid ccusage tarball: %w", err)
	}
	defer reader.Close()
	archive := tar.NewReader(reader)
	want := "package/bin/" + name
	for {
		header, err := archive.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("invalid ccusage tarball: %w", err)
		}
		if header.Name != want {
			continue
		}
		if header.Size > MaxBinaryBytes {
			return nil, fmt.Errorf("ccusage binary exceeds %d bytes", MaxBinaryBytes)
		}
		data, err := io.ReadAll(io.LimitReader(archive, header.Size))
		if err != nil {
			return nil, err
		}
		return data, nil
	}
	return nil, fmt.Errorf("ccusage tarball does not contain %s", want)
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

// ConfigArgs appends the `--config` pair every ccusage invocation carries.
//
// The dynamic config (generated from the server catalogue) wins over an
// explicit one; a configured path that does not exist is an error, not a
// silently dropped flag — ccusage would otherwise fall back to its built-in
// prices and report costs the catalogue never approved.
func ConfigArgs(env func(string) string, fileExists func(string) bool) ([]string, error) {
	if env == nil {
		env = os.Getenv
	}
	if fileExists == nil {
		fileExists = func(path string) bool {
			info, err := os.Stat(path)
			return err == nil && info.Mode().IsRegular()
		}
	}
	dynamic := strings.TrimSpace(env("TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG"))
	explicit := strings.TrimSpace(env("TOKENBOARD_CCUSAGE_CONFIG"))
	configPath := dynamic
	variable := "TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG"
	if configPath == "" {
		configPath = explicit
		variable = "TOKENBOARD_CCUSAGE_CONFIG"
	}
	if configPath == "" {
		return nil, nil
	}
	if !fileExists(configPath) {
		return nil, fmt.Errorf("%s does not exist: %s", variable, configPath)
	}
	return []string{"--config", configPath}, nil
}
