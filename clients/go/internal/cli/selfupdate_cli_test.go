package cli

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/state"
)

// The self-update subcommand's CLI boundary: flag parsing, env forwarding,
// exit codes and output shape. The update flow itself is covered by
// internal/selfupdate's tests against a local release server.

// A malformed repository is refused before any network call, and a manual run
// reports it as a failure.
func TestSelfUpdateRefusesAMalformedRepo(t *testing.T) {
	code, stdout, stderr := run(t, map[string]string{
		"TOKENBOARD_RELEASE_REPO": "not-a-repo",
	}, "self-update")
	if code != ExitFailure {
		t.Fatalf("exit = %d, want %d; stderr: %s", code, ExitFailure, stderr)
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty", stdout)
	}
	if !strings.Contains(stderr, "expected owner/repo") {
		t.Errorf("stderr = %q, want a repo refusal", stderr)
	}
}

// The scheduled path must never fail the run: an offline machine is a normal
// state, and the scheduler cannot act on the upgrade failure.
func TestSelfUpdateScheduledPathExitsZeroOnFailure(t *testing.T) {
	code, _, stderr := run(t, map[string]string{
		"TOKENBOARD_RELEASE_REPO": "not-a-repo",
	}, "self-update", "--scheduled")
	if code != ExitOK {
		t.Fatalf("exit = %d, want %d; the scheduled path must not fail the run", code, ExitOK)
	}
	if !strings.Contains(stderr, "expected owner/repo") {
		t.Errorf("stderr = %q, want the failure reason", stderr)
	}
}

// TOKENBOARD_RELEASE_BASE_URL has to reach the update through the CLI's
// injected environment, not os.Getenv: otherwise a test (or an operator
// pointing at a mirror) is silently ignored and the update goes to github.com.
func TestSelfUpdateForwardsTheInjectedEnvironment(t *testing.T) {
	var hits int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		http.NotFound(w, r)
	}))
	defer server.Close()

	code, _, stderr := run(t, map[string]string{
		"TOKENBOARD_RELEASE_BASE_URL": server.URL,
		"TOKENBOARD_RELEASE_REPO":     "owner/repo",
	}, "self-update")
	if code != ExitFailure {
		t.Fatalf("exit = %d, want %d; stderr: %s", code, ExitFailure, stderr)
	}
	if hits == 0 {
		t.Errorf("the stub server was never reached; the injected base URL did not reach the update")
	}
	if !strings.Contains(stderr, "HTTP 404") {
		t.Errorf("stderr = %q, want the stub server's 404", stderr)
	}
}

// The scheduler writes `self-update --scheduled` with no value, so the flag
// is accepted bare; an unknown flag or a value-requiring one without a value
// is still a usage error.
func TestSelfUpdateAcceptsBareScheduledAndRejectsOtherBareFlags(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer server.Close()

	env := map[string]string{
		"TOKENBOARD_RELEASE_BASE_URL": server.URL,
		"TOKENBOARD_RELEASE_REPO":     "owner/repo",
	}
	// Bare --scheduled parses; the run then fails on the 404 but the scheduled
	// path still exits 0.
	if code, _, stderr := run(t, env, "self-update", "--scheduled"); code != ExitOK {
		t.Errorf("bare --scheduled exit = %d, want %d; stderr: %s", code, ExitOK, stderr)
	}
	// A value-requiring flag with no value is still a usage error.
	if code, _, stderr := run(t, env, "self-update", "--tag"); code != ExitUsage {
		t.Errorf("bare --tag exit = %d, want %d; stderr: %s", code, ExitUsage, stderr)
	}
}

// A successful run prints exactly the two fields a caller reads.
func TestSelfUpdatePrintsVersionAndUpdated(t *testing.T) {
	// A no-op is the cheapest success: the running version already matches the
	// release, so nothing is downloaded. Version is stamped by the build; a
	// test stamps it the same way.
	previous := Version
	Version = "1.2.3"
	defer func() { Version = previous }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/owner/repo/releases/latest" {
			http.Redirect(w, r, "/owner/repo/releases/tag/v1.2.3", http.StatusFound)
			return
		}
		if r.URL.Path == "/owner/repo/releases/tag/v1.2.3" {
			_, _ = w.Write([]byte("<html>release</html>"))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	code, stdout, stderr := run(t, map[string]string{
		"TOKENBOARD_RELEASE_BASE_URL": server.URL,
		"TOKENBOARD_RELEASE_REPO":     "owner/repo",
	}, "self-update")
	if code != ExitOK {
		t.Fatalf("exit = %d, want %d; stderr: %s", code, ExitOK, stderr)
	}
	if !strings.Contains(stdout, `"version": "1.2.3"`) || !strings.Contains(stdout, `"updated": false`) {
		t.Errorf("stdout = %q, want version 1.2.3 and updated false", stdout)
	}
}

// `--tag` is the operator's way to install a specific release; the parser used
// to accept it and then drop it, so the update silently took the newest one.
// A pinned tag resolves without a release lookup, so a recording server sees
// the archive download and never `/releases/latest`.
func TestSelfUpdatePinsTheTagFlagWithoutALookup(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		http.NotFound(w, r)
	}))
	defer server.Close()

	code, _, stderr := run(t, map[string]string{
		"TOKENBOARD_RELEASE_BASE_URL": server.URL,
	}, "self-update", "--tag", "v0.0.1")

	if code != ExitFailure {
		t.Errorf("exit = %d, want %d (the download 404s); stderr: %s", code, ExitFailure, stderr)
	}
	if len(paths) == 0 {
		t.Fatalf("no request reached the release server; stderr: %s", stderr)
	}
	for _, path := range paths {
		if strings.Contains(path, "releases/latest") {
			t.Errorf("a pinned tag must skip the latest-release lookup; requests: %v", paths)
		}
		if !strings.Contains(path, "/releases/download/v0.0.1/") {
			t.Errorf("request %q is not the pinned tag's download", path)
		}
	}
}

// `--repo` names the repository for this run. An operator overriding a value
// the scheduler exported expects the flag to win; the skill's upgrade path
// spells the same precedence (`flags['release-repo'] || env.…`).
func TestSelfUpdateRepoFlagOverridesTheEnvironment(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		http.NotFound(w, r)
	}))
	defer server.Close()

	code, _, stderr := run(t, map[string]string{
		"TOKENBOARD_RELEASE_BASE_URL": server.URL,
		"TOKENBOARD_RELEASE_REPO":     "env/repo",
	}, "self-update", "--repo", "flag/repo")

	if code != ExitFailure {
		t.Errorf("exit = %d, want %d (the lookup 404s); stderr: %s", code, ExitFailure, stderr)
	}
	if len(paths) == 0 {
		t.Fatalf("no request reached the release server; stderr: %s", stderr)
	}
	for _, path := range paths {
		if !strings.HasPrefix(path, "/flag/repo/") {
			t.Errorf("request %q did not use the --repo value; requests: %v", path, paths)
		}
	}
}

// self-update rewrites the executable, so two of them running at once can
// delete each other's staged file mid-verification. Nothing else serializes
// them: the skill's sync.lock only covers runs started through sync.mjs, and
// `dispatch`'s collector-run.lock is entered after this subcommand returns.
// A second instance therefore yields instead of racing: it reports the update
// as already in progress, exits 0, and makes no release request at all.
func TestSelfUpdateYieldsToAnotherUpdateHoldingItsLock(t *testing.T) {
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		http.NotFound(w, r)
	}))
	defer server.Close()

	stateDir := t.TempDir()
	if err := os.Chmod(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	lock, err := state.Acquire(filepath.Join(stateDir, "self-update.lock"), time.Second)
	if err != nil || lock == nil {
		t.Fatalf("could not take the lock for the test: %v", err)
	}
	defer func() { _ = lock.Release() }()

	env := map[string]string{
		"TOKENBOARD_STATE_DIR":        stateDir,
		"TOKENBOARD_RELEASE_BASE_URL": server.URL,
		"TOKENBOARD_RELEASE_REPO":     "owner/repo",
	}
	code, stdout, stderr := run(t, env, "self-update")
	if code != ExitOK {
		t.Errorf("exit = %d, want %d; stderr: %s", code, ExitOK, stderr)
	}
	if requests != 0 {
		t.Errorf("the yielding run made %d release requests, want none", requests)
	}
	if !strings.Contains(stdout, `"updated": false`) {
		t.Errorf("stdout = %q, want an updated:false report", stdout)
	}
	if !strings.Contains(stderr, "already in progress") {
		t.Errorf("stderr = %q, want a note that another update holds the lock", stderr)
	}
}

// The lock is released when the run ends, so the next scheduled update is not
// blocked by a previous attempt that could not reach the network.
func TestSelfUpdateReleasesItsLockWhenTheUpdateFails(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()

	stateDir := t.TempDir()
	if err := os.Chmod(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{
		"TOKENBOARD_STATE_DIR":        stateDir,
		"TOKENBOARD_RELEASE_BASE_URL": server.URL,
		"TOKENBOARD_RELEASE_REPO":     "owner/repo",
	}
	if code, _, stderr := run(t, env, "self-update"); code != ExitFailure {
		t.Fatalf("exit = %d, want %d; stderr: %s", code, ExitFailure, stderr)
	}
	lock, err := state.Acquire(filepath.Join(stateDir, "self-update.lock"), time.Second)
	if err != nil || lock == nil {
		t.Fatalf("the failed update left its lock behind: %v", err)
	}
	_ = lock.Release()
}
