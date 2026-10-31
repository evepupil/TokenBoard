package release

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The latest release is found by following one redirect, not by calling the
// rate-limited REST API: a scheduled self-update behind a shared egress IP
// must not depend on an anonymous quota.
func TestResolveFollowsTheReleasesLatestRedirect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/MisonL/TokenBoard/releases/latest" {
			http.Redirect(w, r, "/MisonL/TokenBoard/releases/tag/v1.2.3", http.StatusFound)
			return
		}
		if r.URL.Path == "/MisonL/TokenBoard/releases/tag/v1.2.3" {
			_, _ = w.Write([]byte("tag page"))
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	assets, err := Resolve(Options{Platform: "darwin", Arch: "arm64", BaseURL: server.URL})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if assets.Tag != "v1.2.3" {
		t.Errorf("tag = %q, want v1.2.3", assets.Tag)
	}
	if assets.Archive.Name != ArchiveName("darwin_arm64") {
		t.Errorf("archive = %q", assets.Archive.Name)
	}
	if !strings.Contains(assets.Archive.URL, "/releases/download/v1.2.3/") {
		t.Errorf("archive URL = %q", assets.Archive.URL)
	}
	if assets.Checksums.Name != ChecksumsName() {
		t.Errorf("checksums asset = %+v", assets.Checksums)
	}
}

// A chain longer than one hop is a loop, not a release: it is refused instead
// of followed.
func TestResolveRefusesARedirectLoop(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/MisonL/TokenBoard/releases/latest", http.StatusFound)
	}))
	defer server.Close()

	if _, err := Resolve(Options{Platform: "darwin", Arch: "arm64", BaseURL: server.URL}); err == nil ||
		!strings.Contains(err.Error(), "redirected more than") {
		t.Fatalf("err = %v, want a redirect-loop refusal", err)
	}
}

// A repository with no release is a 404, reported as one rather than as an
// empty tag.
func TestResolveReportsAMissingRelease(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer server.Close()

	if _, err := Resolve(Options{Platform: "darwin", Arch: "arm64", BaseURL: server.URL}); err == nil ||
		!strings.Contains(err.Error(), "HTTP 404") {
		t.Fatalf("err = %v, want a 404 report", err)
	}
}

// A pinned tag skips the lookup entirely, so a release page that is not even
// served still resolves to its download URLs.
func TestResolveUsesAPinnedTagWithoutALookup(t *testing.T) {
	assets, err := Resolve(Options{Platform: "linux", Arch: "amd64", Tag: "v0.9.0", BaseURL: "https://example.invalid"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if assets.Tag != "v0.9.0" {
		t.Errorf("tag = %q", assets.Tag)
	}
	if assets.Archive.Name != "tokenboard_linux_amd64.tar.gz" {
		t.Errorf("archive name = %q", assets.Archive.Name)
	}
}

// The six platform pairs the build matrix publishes are the six Platform
// accepts; anything else is refused before a network call.
func TestPlatformCoversTheReleaseMatrix(t *testing.T) {
	want := map[string]string{
		"darwin_amd64":  "tokenboard_darwin_amd64.tar.gz",
		"darwin_arm64":  "tokenboard_darwin_arm64.tar.gz",
		"linux_amd64":   "tokenboard_linux_amd64.tar.gz",
		"linux_arm64":   "tokenboard_linux_arm64.tar.gz",
		"windows_amd64": "tokenboard_windows_amd64.tar.gz",
		"windows_arm64": "tokenboard_windows_arm64.tar.gz",
	}
	for platform, name := range want {
		os, arch, _ := strings.Cut(platform, "_")
		if got, ok := Platform(os, arch); !ok || got != platform {
			t.Errorf("Platform(%s, %s) = %q, %v; want %q", os, arch, got, ok, platform)
		}
		if ArchiveName(platform) != name {
			t.Errorf("ArchiveName(%s) = %q, want %q", platform, ArchiveName(platform), name)
		}
	}
	if _, ok := Platform("plan9", "mips"); ok {
		t.Errorf("Platform accepted an unbuildable platform")
	}
}

// A manifest that cannot be read in full cannot vouch for the asset it
// covers: a malformed line is an error, not a skipped entry.
func TestChecksumsRejectAMalformedManifest(t *testing.T) {
	cases := map[string]string{
		"no digest separator": "abc123 tokenboard.tar.gz",
		"short digest":        "abc123  tokenboard.tar.gz",
		"empty name":          strings.Repeat("a", 64) + "  ",
		"no entries":          "\n  \n",
	}
	for name, content := range cases {
		if _, err := Checksums([]byte(content)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestChecksumsAndVerifyRoundTrip(t *testing.T) {
	data := []byte("tarball bytes")
	digest := sha256.Sum256(data)
	manifest := fmt.Sprintf("%s  tokenboard_darwin_arm64.tar.gz\n", hex.EncodeToString(digest[:]))
	checksums, err := Checksums([]byte(manifest))
	if err != nil {
		t.Fatalf("Checksums: %v", err)
	}
	if err := Verify(data, "tokenboard_darwin_arm64.tar.gz", checksums); err != nil {
		t.Errorf("Verify: %v", err)
	}
	if err := Verify([]byte("tampered"), "tokenboard_darwin_arm64.tar.gz", checksums); err == nil ||
		!strings.Contains(err.Error(), "checksum mismatch") {
		t.Errorf("Verify tampered: %v", err)
	}
	if err := Verify(data, "absent.tar.gz", checksums); err == nil ||
		!strings.Contains(err.Error(), "no entry") {
		t.Errorf("Verify absent: %v", err)
	}
}

// The stamped build version and the release tag are compared as strings
// (selfupdate.go:282), so this one mapping has to hold for every tag this
// channel will accept. A tag GoReleaser did not publish under would resolve
// to a version no build reports, and every scheduled run would reinstall.
func TestVersionStripsTheTagPrefix(t *testing.T) {
	cases := map[string]string{"v0.1.0": "0.1.0", "v1.2.3": "1.2.3", "v2.0.0-rc.1": "2.0.0-rc.1"}
	for tag, want := range cases {
		if got := Version(tag); got != want {
			t.Errorf("Version(%q) = %q; want %q", tag, got, want)
		}
	}
	if got := Version(""); got != "" {
		t.Errorf("Version(\"\") = %q; want empty so the caller refuses it", got)
	}
}

// A repository that is not owner/repo cannot become a URL; refusing it here
// keeps a typo from turning into a request to the wrong host.
func TestRepoValidation(t *testing.T) {
	if repo, err := Repo(""); err != nil || repo != DefaultRepo {
		t.Errorf("Repo(\"\") = %q, %v; want the default", repo, err)
	}
	if repo, err := Repo(" owner/name "); err != nil || repo != "owner/name" {
		t.Errorf("Repo trimmed = %q, %v", repo, err)
	}
	for _, value := range []string{"not-a-repo", "a/b/c", "a/b c", "/b", "a/"} {
		if _, err := Repo(value); err == nil {
			t.Errorf("Repo(%q) accepted", value)
		}
	}
}

// The tag lookup refuses to cross hosts, and the asset download carries the
// tarball and the checksums — the two things that vouch for each other. A
// cross-host redirect there would let a host the release page never named
// supply both, so it is refused the same way.
func TestDownloadRefusesACrossHostRedirect(t *testing.T) {
	var foreignHits int
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		foreignHits++
		_, _ = w.Write([]byte("evil"))
	}))
	defer foreign.Close()

	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, foreign.URL+"/payload", http.StatusFound)
	}))
	defer origin.Close()

	_, err := Download(nil, Asset{Name: "checksums.txt", URL: origin.URL + "/checksums.txt"})
	if err == nil || !strings.Contains(err.Error(), "not the release host") {
		t.Fatalf("err = %v, want a cross-host refusal", err)
	}
	if foreignHits != 0 {
		t.Fatalf("the foreign host was contacted %d times", foreignHits)
	}
}

// A chain of exactly maxRedirects hops is still followed: the bound counts
// redirects, so refusing one hop early would make the documented budget a lie.
func TestDownloadFollowsExactlyTheRedirectBudget(t *testing.T) {
	hops := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hops < maxRedirects {
			hops++
			http.Redirect(w, r, fmt.Sprintf("/hop/%d", hops), http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("abc123  tokenboard_darwin_arm64.tar.gz\n"))
	}))
	defer server.Close()

	data, err := Download(nil, Asset{Name: "checksums.txt", URL: server.URL + "/checksums.txt"})
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	if !strings.Contains(string(data), "abc123") {
		t.Fatalf("data = %q", data)
	}
	if hops != maxRedirects {
		t.Errorf("hops = %d, want %d", hops, maxRedirects)
	}
}

// A same-host redirect (the release page naming its own asset path) still works.
func TestDownloadFollowsASameHostRedirect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/checksums.txt" {
			http.Redirect(w, r, "/actual-checksums.txt", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("abc123  tokenboard_darwin_arm64.tar.gz\n"))
	}))
	defer server.Close()

	data, err := Download(nil, Asset{Name: "checksums.txt", URL: server.URL + "/checksums.txt"})
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	if !strings.Contains(string(data), "abc123") {
		t.Fatalf("data = %q", data)
	}
}
