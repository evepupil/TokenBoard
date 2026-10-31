package ccusage

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The acquisition contract from spec §4: bundled > PATH > download, and hook
// mode never downloads.

func acquireEnv(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestResolvePrefersTheExplicitBinary(t *testing.T) {
	binary, err := Resolve(AcquireOptions{
		Env:        acquireEnv(map[string]string{"TOKENBOARD_CCUSAGE_BIN": "/opt/bin/ccusage"}),
		FileExists: func(path string) bool { return path == "/opt/bin/ccusage" },
		LookPath:   func(string) (string, error) { return "", os.ErrNotExist },
	})
	if err != nil {
		t.Fatal(err)
	}
	if binary.Path != "/opt/bin/ccusage" || binary.Source != "env" {
		t.Errorf("binary = %+v", binary)
	}
}

func TestResolveRejectsAMissingExplicitBinary(t *testing.T) {
	_, err := Resolve(AcquireOptions{
		Env:        acquireEnv(map[string]string{"TOKENBOARD_CCUSAGE_BIN": "/opt/bin/missing"}),
		FileExists: func(string) bool { return false },
	})
	if err == nil || !strings.Contains(err.Error(), "TOKENBOARD_CCUSAGE_BIN does not exist: /opt/bin/missing") {
		t.Fatalf("err = %v", err)
	}
}

func TestResolvePrefersTheBundledBinaryOverPATH(t *testing.T) {
	home := t.TempDir()
	// The bundled file carries the platform's name: Windows ships ccusage.exe,
	// and the acquisition looks for exactly that (binaryName).
	bundled := filepath.Join(home, ".tokenboard", "bin", binaryName(runtime.GOOS))
	binary, err := Resolve(AcquireOptions{
		Env:        acquireEnv(nil),
		HomeDir:    home,
		FileExists: func(path string) bool { return path == bundled },
		LookPath:   func(string) (string, error) { return "/usr/local/bin/ccusage", nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if binary.Path != bundled || binary.Source != "bundled" {
		t.Errorf("binary = %+v", binary)
	}
}

func TestResolveWarnsWhenTheBundledBinaryIsNotTheExpectedVersion(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the stub is a shell script")
	}
	home := t.TempDir()
	binDir := filepath.Join(home, ".tokenboard", "bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		t.Fatal(err)
	}
	bundled := filepath.Join(binDir, "ccusage")
	// A real script, because the warning comes from running --version.
	if err := os.WriteFile(bundled, []byte("#!/bin/sh\necho 'ccusage 20.0.33'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	var warnings []string
	binary, err := Resolve(AcquireOptions{
		Env:        acquireEnv(nil),
		HomeDir:    home,
		FileExists: func(path string) bool { return path == bundled },
		LookPath:   func(string) (string, error) { return "", os.ErrNotExist },
		Stderr:     func(line string) { warnings = append(warnings, line) },
		Version:    "0.0.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	if binary.Source != "bundled" {
		t.Fatalf("binary = %+v, want the bundled layer", binary)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "expects 0.0.0") {
		t.Fatalf("warnings = %v, want a version drift warning", warnings)
	}
}

func TestResolveFallsBackToPATHWithAVersionWarning(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the stub is a shell script")
	}
	dir := t.TempDir()
	probed := filepath.Join(dir, "ccusage")
	if err := os.WriteFile(probed, []byte("#!/bin/sh\necho 'ccusage 20.0.33'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	var warnings []string
	binary, err := Resolve(AcquireOptions{
		Env:        acquireEnv(nil),
		HomeDir:    t.TempDir(),
		FileExists: func(string) bool { return false },
		LookPath:   func(string) (string, error) { return probed, nil },
		Stderr:     func(line string) { warnings = append(warnings, line) },
		Version:    "0.0.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	if binary.Path != probed || binary.Source != "path" {
		t.Errorf("binary = %+v", binary)
	}
	// A mismatch warns rather than refuses: a working binary from another
	// layer is still usable.
	if len(warnings) != 1 || !strings.Contains(warnings[0], "expects 0.0.0") {
		t.Fatalf("warnings = %v, want a version drift warning", warnings)
	}
}

func TestResolveHookModeFailsClosedWithoutABinary(t *testing.T) {
	_, err := Resolve(AcquireOptions{
		Env:        acquireEnv(nil),
		HomeDir:    t.TempDir(),
		HookMode:   true,
		FileExists: func(string) bool { return false },
		LookPath:   func(string) (string, error) { return "", os.ErrNotExist },
	})
	if err == nil || !strings.Contains(err.Error(), "hook mode does not download") {
		t.Fatalf("err = %v", err)
	}
}

func TestResolveRejectsUnknownPlatforms(t *testing.T) {
	if _, ok := npmPlatformName("plan9"); ok {
		t.Error("plan9 must not map to an npm platform package")
	}
	if _, ok := npmArchName("mips"); ok {
		t.Error("mips must not map to an npm arch package")
	}
	if _, err := Resolve(AcquireOptions{
		Env:        acquireEnv(nil),
		HomeDir:    t.TempDir(),
		Platform:   "plan9",
		FileExists: func(string) bool { return false },
		LookPath:   func(string) (string, error) { return "", os.ErrNotExist },
		HTTPClient: &http.Client{},
	}); err == nil || !strings.Contains(err.Error(), "no package for platform plan9") {
		t.Fatalf("err = %v", err)
	}
}

// registryTransport rewrites registry.npmjs.org requests to the test server,
// so the real download path runs without network.
type registryTransport struct {
	target *url.URL
	base   http.RoundTripper
}

func (t registryTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	clone := request.Clone(request.Context())
	clone.URL.Scheme = t.target.Scheme
	clone.URL.Host = t.target.Host
	return t.base.RoundTrip(clone)
}

func testRegistryClient(t *testing.T, server *httptest.Server) *http.Client {
	t.Helper()
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Transport: registryTransport{target: target, base: http.DefaultTransport}}
}

// buildTarball packs one file into a gzipped tar the way npm does.
func buildTarball(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	gzipWriter := gzip.NewWriter(&buffer)
	archive := tar.NewWriter(gzipWriter)
	if err := archive.WriteHeader(&tar.Header{Name: "package/bin/" + name, Mode: 0o755, Size: int64(len(content))}); err != nil {
		t.Fatal(err)
	}
	if _, err := archive.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestDownloadVerifiesIntegrityAndInstallsTheBinary(t *testing.T) {
	payload := []byte("#!/bin/sh\necho ccusage\n")
	tarball := buildTarball(t, "ccusage", payload)
	digest := sha512.Sum512(tarball)
	integrity := "sha512-" + base64.StdEncoding.EncodeToString(digest[:])

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/@ccusage/") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"dist": map[string]any{"tarball": serverURL(r) + "/tarball.tgz", "integrity": integrity},
			})
			return
		}
		w.Write(tarball)
	}))
	defer server.Close()

	installDir := filepath.Join(t.TempDir(), "bin")
	path, err := download(testRegistryClient(t, server), "darwin", "arm64", Version, installDir, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	installed, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(installed, payload) {
		t.Errorf("installed bytes = %q", installed)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// Windows has no execute bit: a file is executable by extension, and the
	// mode Go reports for a freshly written file carries no permission bits.
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o100 == 0 {
		t.Errorf("installed binary must be executable: %v", info.Mode())
	}
}

func TestDownloadRejectsAnIntegrityMismatch(t *testing.T) {
	tarball := buildTarball(t, "ccusage", []byte("payload"))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/@ccusage/") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"dist": map[string]any{
					"tarball":   serverURL(r) + "/tarball.tgz",
					"integrity": "sha512-" + base64.StdEncoding.EncodeToString(make([]byte, sha512.Size)),
				},
			})
			return
		}
		w.Write(tarball)
	}))
	defer server.Close()

	_, err := download(testRegistryClient(t, server), "darwin", "arm64", Version, t.TempDir(), func(string) {})
	if err == nil || !strings.Contains(err.Error(), "integrity mismatch") {
		t.Fatalf("err = %v", err)
	}
}

func TestDecodeIntegrityRejectsBadValues(t *testing.T) {
	cases := []string{
		"sha1-abcd",
		"sha512-not-base64!!",
		"sha512-" + base64.StdEncoding.EncodeToString([]byte("short")),
	}
	for _, value := range cases {
		if _, err := decodeIntegrity(value); err == nil {
			t.Errorf("decodeIntegrity(%q) must fail", value)
		}
	}
}

func TestExtractBinaryRejectsArchivesWithoutTheBinary(t *testing.T) {
	tarball := buildTarball(t, "something-else", []byte("x"))
	if _, err := extractBinary(tarball, "ccusage"); err == nil {
		t.Fatal("expected a missing-binary failure")
	}
	if _, err := extractBinary([]byte("not gzip"), "ccusage"); err == nil {
		t.Fatal("expected an invalid-archive failure")
	}
}

func TestConfigArgsPreferDynamicThenExplicitAndRejectMissingFiles(t *testing.T) {
	env := acquireEnv(map[string]string{
		"TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG": "/state/dynamic.json",
		"TOKENBOARD_CCUSAGE_CONFIG":         "/checkout/static.json",
	})
	args, err := ConfigArgs(env, func(path string) bool { return path == "/state/dynamic.json" })
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 2 || args[0] != "--config" || args[1] != "/state/dynamic.json" {
		t.Errorf("args = %v", args)
	}

	args, err = ConfigArgs(acquireEnv(map[string]string{
		"TOKENBOARD_CCUSAGE_CONFIG": "/checkout/static.json",
	}), func(path string) bool { return path == "/checkout/static.json" })
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 2 || args[1] != "/checkout/static.json" {
		t.Errorf("args = %v", args)
	}

	if _, err := ConfigArgs(acquireEnv(map[string]string{
		"TOKENBOARD_CCUSAGE_CONFIG": "/absent.json",
	}), func(string) bool { return false }); err == nil ||
		!strings.Contains(err.Error(), "TOKENBOARD_CCUSAGE_CONFIG does not exist: /absent.json") {
		t.Fatalf("err = %v", err)
	}

	args, err = ConfigArgs(acquireEnv(nil), func(string) bool { return false })
	if err != nil || args != nil {
		t.Errorf("no config vars must produce no args: %v, %v", args, err)
	}
}

// serverURL reconstructs the test server origin for responses that must name
// it (the handler cannot see its own URL).
func serverURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// TS gates the explicit binary on `if (forcedCcusage)`, a truthiness test: a
// value of only whitespace is set, and the missing path is then an error. Trim
// first made it look unset here, so one client refused the file and the other
// silently moved on to the bundled binary.
func TestResolveTreatsAWhitespaceExplicitBinaryAsSet(t *testing.T) {
	_, err := Resolve(AcquireOptions{
		Env:        acquireEnv(map[string]string{"TOKENBOARD_CCUSAGE_BIN": " "}),
		FileExists: func(string) bool { return false },
		LookPath:   func(string) (string, error) { return "", os.ErrNotExist },
	})
	if err == nil || !strings.Contains(err.Error(), "TOKENBOARD_CCUSAGE_BIN does not exist") {
		t.Fatalf("err = %v, want a missing-binary error", err)
	}
}

// The skill installs the bundled ccusage beside its own config, which is
// TOKENBOARD_CONFIG_DIR/bin when that is set. Looking only at
// ~/.tokenboard/bin would miss that install and silently fall through to a
// download the hook path cannot perform.
func TestResolveFindsTheBundledBinaryInTheConfiguredConfigDirectory(t *testing.T) {
	home := t.TempDir()
	configDir := filepath.Join(t.TempDir(), "custom-config")
	bundled := filepath.Join(configDir, "bin", binaryName(runtime.GOOS))
	binary, err := Resolve(AcquireOptions{
		Env:        acquireEnv(map[string]string{"TOKENBOARD_CONFIG_DIR": configDir}),
		HomeDir:    home,
		FileExists: func(path string) bool { return path == bundled },
		LookPath:   func(string) (string, error) { return "", os.ErrNotExist },
		// Hook mode refuses to download: a miss fails fast instead of reaching
		// the network, which is also the mode that cannot recover by downloading.
		HookMode: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if binary.Path != bundled || binary.Source != "bundled" {
		t.Errorf("binary = %+v, want %s from the config directory", binary, bundled)
	}
}

// A copy installed before the config directory was honored still works: the
// skill that put it there keeps finding it.
func TestResolveFallsBackToTheDefaultHomeCopy(t *testing.T) {
	home := t.TempDir()
	configDir := filepath.Join(t.TempDir(), "custom-config")
	legacy := filepath.Join(home, ".tokenboard", "bin", binaryName(runtime.GOOS))
	binary, err := Resolve(AcquireOptions{
		Env:        acquireEnv(map[string]string{"TOKENBOARD_CONFIG_DIR": configDir}),
		HomeDir:    home,
		FileExists: func(path string) bool { return path == legacy },
		LookPath:   func(string) (string, error) { return "", os.ErrNotExist },
		HookMode:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if binary.Path != legacy || binary.Source != "bundled" {
		t.Errorf("binary = %+v, want %s", binary, legacy)
	}
}

// The version probe runs the same third-party binary the invocation path does, so it must carry
// the same scrubbed environment. A tampered ccusage that only answered `--version` — the path
// that runs on every resolve — would otherwise still read the upload token from its environment.
func TestResolveProbesVersionWithoutCredentials(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the stub is a shell script")
	}
	dir := t.TempDir()
	probed := filepath.Join(dir, "ccusage")
	envCapture := filepath.Join(dir, "child-env")
	script := "#!/bin/sh\n" +
		"printf '%s' \"$TOKENBOARD_UPLOAD_TOKEN|$TOKENBOARD_PAIRING_CODE\" > '" + envCapture + "'\n" +
		"echo 'ccusage 20.0.33'\n"
	if err := os.WriteFile(probed, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TOKENBOARD_UPLOAD_TOKEN", "tb_upload_secret")
	t.Setenv("TOKENBOARD_PAIRING_CODE", "tb_pair_secret")

	binary, err := Resolve(AcquireOptions{
		Env:        acquireEnv(nil),
		HomeDir:    t.TempDir(),
		FileExists: func(string) bool { return false },
		LookPath:   func(string) (string, error) { return probed, nil },
		Stderr:     func(string) {},
		Version:    "0.0.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	if binary.Path != probed {
		t.Fatalf("binary = %+v, want the PATH layer", binary)
	}
	captured, err := os.ReadFile(envCapture)
	if err != nil {
		t.Fatalf("the probe did not run: %v", err)
	}
	if string(captured) != "|" {
		t.Errorf("child saw credentials: %q, want both stripped", string(captured))
	}
}
