// Package release talks to the GitHub Releases channel the Go client is
// distributed through (spec §8): it resolves the latest release tag, and
// hands out the two download URLs an update verifies against.
//
// Nothing here touches the api.github.com REST API. That endpoint is rate
// limited per IP for anonymous callers — sixty requests an hour, shared by
// every machine behind one NAT — so a scheduled self-update on a shared
// network would start failing at random. The web endpoints it uses instead
// (`/releases/latest` redirect, `/releases/download/<tag>/<asset>`) are served
// from the same CDN as ordinary asset downloads and carry no such quota.
package release

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"runtime"
	"strings"
	"time"
)

// DefaultRepo is the GitHub repository the client updates from. It is the
// upstream repository: that is where the releases are cut, and a check that
// cannot reach it must not silently fall back to someone else's repository.
const DefaultRepo = "evepupil/TokenBoard"

// DefaultBaseURL is github.com. Tests point it at a local server.
const DefaultBaseURL = "https://github.com"

// maxRedirects bounds the `/releases/latest` resolution. GitHub answers with
// one hop; a longer chain is a loop, not a release.
const maxRedirects = 5

// maxDownloadBytes bounds one tarball. The binary is a few megabytes; a bound
// this generous is a guard against a redirect to something else entirely.
const maxDownloadBytes = 128 * 1024 * 1024

// Repo returns the repository to update from. Empty means the default; a
// value without an owner/repo shape is an error rather than a URL that will
// 404 later.
func Repo(value string) (string, error) {
	trimmed := strings.Trim(strings.TrimSpace(value), "/")
	if trimmed == "" {
		return DefaultRepo, nil
	}
	parts := strings.Split(trimmed, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", fmt.Errorf("Invalid release repository %q; expected owner/repo", value)
	}
	for _, part := range parts {
		if strings.ContainsAny(part, " \t\r\n") {
			return "", fmt.Errorf("Invalid release repository %q; expected owner/repo", value)
		}
	}
	return trimmed, nil
}

// Asset is one downloadable file of a release.
type Asset struct {
	Name string
	URL  string
}

// Assets are the three things an update needs from a release.
type Assets struct {
	Tag       string
	Archive   Asset
	Checksums Asset
}

// Version strips a leading "v" from a release tag. An empty or "v"-only tag
// stays empty: a caller that cannot name the version must not claim one.
func Version(tagName string) string {
	trimmed := strings.TrimSpace(tagName)
	trimmed = strings.TrimPrefix(trimmed, "v")
	return trimmed
}

// Platform names the release asset suffix for a GOOS/GOARCH pair, matching
// the naming GoReleaser produces for this project's build matrix: the
// `{{ .Os }}_{{ .Arch }}` default, so the suffix is the GOOS and GOARCH
// themselves for the six pairs the config builds.
func Platform(goos, goarch string) (string, bool) {
	os, ok := assetOS(goos)
	if !ok {
		return "", false
	}
	arch, ok := assetArch(goarch)
	if !ok {
		return "", false
	}
	return os + "_" + arch, true
}

func assetOS(goos string) (string, bool) {
	switch goos {
	case "darwin", "linux", "windows":
		return goos, true
	}
	return "", false
}

func assetArch(goarch string) (string, bool) {
	switch goarch {
	case "amd64", "arm64":
		return goarch, true
	}
	return "", false
}

// ArchiveName is the tarball a platform's asset is published under.
func ArchiveName(platform string) string {
	return fmt.Sprintf("tokenboard_%s.tar.gz", platform)
}

// ChecksumsName is the release's digest manifest.
func ChecksumsName() string { return "checksums.txt" }

// Options configures one release lookup.
type Options struct {
	// Repo is "owner/repo"; empty uses DefaultRepo, or TOKENBOARD_RELEASE_REPO.
	Repo string
	// Tag pins a release; empty resolves the latest published one.
	Tag string
	// Platform and Arch default to the runtime values; tests pin them.
	Platform string
	Arch     string
	// BaseURL overrides github.com; tests point it at a local server.
	BaseURL string
	// HTTPClient overrides the client; nil uses a 30s one.
	HTTPClient *http.Client
	// Env resolves TOKENBOARD_RELEASE_REPO; nil means none.
	Env func(string) string
}

// repo resolves the repository to update from. Only the explicit field and
// TOKENBOARD_RELEASE_REPO are consulted: which repository a binary install
// updates from is a deployment decision, and the skill that installs it states
// it through that one variable rather than the Go side guessing from
// TOKENBOARD_REPO_URL (a git-clone setting whose value may name a repository
// that publishes no Go releases).
func (o Options) repo() (string, error) {
	if value := strings.TrimSpace(o.Repo); value != "" {
		return Repo(value)
	}
	if o.Env != nil {
		return Repo(o.Env("TOKENBOARD_RELEASE_REPO"))
	}
	return DefaultRepo, nil
}

func (o Options) baseURL() string {
	value := strings.TrimSpace(o.BaseURL)
	if value == "" {
		return DefaultBaseURL
	}
	return strings.TrimSuffix(value, "/")
}

func (o Options) platform() (string, error) {
	goos := o.Platform
	if goos == "" {
		goos = runtime.GOOS
	}
	goarch := o.Arch
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	platform, ok := Platform(goos, goarch)
	if !ok {
		return "", fmt.Errorf("TokenBoard has no release for %s/%s", goos, goarch)
	}
	return platform, nil
}

// Timeouts are split by what the call has to move. `http.Client.Timeout`
// covers the whole request — connect, redirects and body — so one value cannot
// serve both ends of this package: a release lookup is a few hundred bytes of
// headers and should fail fast, while a tarball is several megabytes and needs
// room for a slow link. Sharing one value meant either a lookup that hangs for
// the download budget or a download that fails on a link the lookup survived.
const (
	// downloadTimeout bounds one asset transfer.
	downloadTimeout = 2 * time.Minute
	// retryBudget bounds the retries a caller may make for one asset. The
	// attempt count is small on purpose: the caller is a scheduled job that runs
	// again later, and a machine behind a dead proxy should not spend minutes
	// of its sync on this.
	maxDownloadAttempts = 3
)

// lookupTimeout bounds one `/releases/latest` hop chain. Go's
// http.Client.Timeout restarts for each client.Do, so latestTag carries a
// deadline across its hops by hand; otherwise a chain of slow redirects
// multiplies this budget. A var rather than a const so a test can compress it
// and observe the shared deadline without waiting fifteen real seconds.
var lookupTimeout = 15 * time.Second

func (o Options) client() *http.Client {
	if o.HTTPClient != nil {
		return o.HTTPClient
	}
	return &http.Client{Timeout: lookupTimeout}
}

// Resolve returns the release tag and the download URLs of its platform
// tarball and checksums manifest. With no tag pinned, the latest release is
// found by following `/releases/latest`'s redirect, which is served by the
// same unauthenticated endpoints ordinary downloads use.
func Resolve(options Options) (Assets, error) {
	repo, err := options.repo()
	if err != nil {
		return Assets{}, err
	}
	platform, err := options.platform()
	if err != nil {
		return Assets{}, err
	}
	tag := strings.TrimSpace(options.Tag)
	if tag == "" {
		tag, err = latestTag(options, repo)
		if err != nil {
			return Assets{}, err
		}
	}
	if tag == "" {
		return Assets{}, fmt.Errorf("TokenBoard release tag is empty")
	}
	downloadBase := fmt.Sprintf("%s/%s/releases/download/%s", options.baseURL(), repo, url.PathEscape(tag))
	return Assets{
		Tag: tag,
		Archive: Asset{
			Name: ArchiveName(platform),
			URL:  downloadBase + "/" + ArchiveName(platform),
		},
		Checksums: Asset{
			Name: ChecksumsName(),
			URL:  downloadBase + "/" + ChecksumsName(),
		},
	}, nil
}

// latestTag follows the releases-latest redirect to the tag page. The client
// is copied with redirects disabled so the Location can be inspected
// deliberately: a chain longer than one hop is reported instead of walked
// into a loop, and a relative Location is resolved against the current URL.
func latestTag(options Options, repo string) (string, error) {
	client := *options.client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	current := fmt.Sprintf("%s/%s/releases/latest", options.baseURL(), repo)
	origin, err := url.Parse(current)
	if err != nil {
		return "", fmt.Errorf("TokenBoard release lookup URL is invalid: %w", err)
	}
	// One budget for the whole chain: http.Client.Timeout restarts on every
	// client.Do, so a chain of slow redirects would otherwise multiply it.
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(lookupTimeout))
	defer cancel()
	for hop := 0; hop <= maxRedirects; hop++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, current, nil)
		if err != nil {
			return "", err
		}
		response, err := client.Do(request)
		if err != nil {
			return "", err
		}
		response.Body.Close()
		switch {
		case response.StatusCode == http.StatusNotFound:
			return "", fmt.Errorf("TokenBoard release lookup returned HTTP 404 for %s", repo)
		case isFollowedRedirect(response.StatusCode):
			location := response.Header.Get("Location")
			if location == "" {
				return "", fmt.Errorf("TokenBoard release lookup returned HTTP %d without a Location", response.StatusCode)
			}
			resolved, err := url.Parse(location)
			if err != nil {
				return "", fmt.Errorf("TokenBoard release lookup returned an invalid redirect: %w", err)
			}
			currentURL, err := url.Parse(current)
			if err != nil {
				return "", err
			}
			next := currentURL.ResolveReference(resolved)
			// The lookup is the earlier request, but it carries no credential
			// and the answer it wants is a tag page on the release host. A hop
			// to anywhere else would put the download URLs' provenance in the
			// hands of a server the release page never named — the asset hop
			// already refuses this (Download's CheckRedirect).
			if !sameRedirectHost(origin, next) {
				return "", fmt.Errorf("TokenBoard release lookup redirected to %s, which is not the release host", next.Host)
			}
			current = next.String()
			continue
		case response.StatusCode == http.StatusOK:
			return tagFromURL(current)
		default:
			return "", fmt.Errorf("TokenBoard release lookup returned HTTP %d", response.StatusCode)
		}
	}
	return "", fmt.Errorf("TokenBoard release lookup redirected more than %d times", maxRedirects)
}

// isFollowedRedirect lists exactly the statuses net/http follows. Treating any
// 3xx with a Location as a redirect would walk a 304 (a cache answer) to a
// place the server never meant, and the TS client refuses the same ones.
func isFollowedRedirect(code int) bool {
	switch code {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther,
		http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return true
	}
	return false
}

// tagFromURL pulls the tag out of a `/releases/tag/<tag>` page URL.
func tagFromURL(pageURL string) (string, error) {
	parsed, err := url.Parse(pageURL)
	if err != nil {
		return "", err
	}
	prefix := "/releases/tag/"
	index := strings.Index(parsed.Path, prefix)
	if index < 0 {
		return "", fmt.Errorf("TokenBoard release lookup did not land on a tag page: %s", path.Clean(parsed.Path))
	}
	tag := parsed.Path[index+len(prefix):]
	decoded, err := url.PathUnescape(tag)
	if err != nil {
		return "", fmt.Errorf("TokenBoard release tag %q is not a valid path segment", tag)
	}
	if decoded == "" {
		return "", fmt.Errorf("TokenBoard release tag is empty")
	}
	return decoded, nil
}

// releaseRedirectHosts are the hosts a GitHub release download may land on: the
// origin itself and the asset CDN GitHub redirects to.
//
// The comparison keeps the port: hostname alone would treat two servers on the
// same address (a proxy, a test server, a local mirror) as the same host.
func sameRedirectHost(origin, target *url.URL) bool {
	if strings.EqualFold(origin.Host, target.Host) {
		return true
	}
	// The CDN is matched by hostname so an explicit :443 (or none) both work.
	for _, allowed := range []string{"objects.githubusercontent.com", "release-assets.githubusercontent.com"} {
		if strings.EqualFold(target.Hostname(), allowed) {
			return true
		}
	}
	return false
}

// Download fetches an asset's bytes.
//
// Redirects are followed only to the same host. `latestTag` already refuses to
// cross hosts when resolving the tag; letting the asset download follow an
// arbitrary chain would reopen the hole it closes — and this is the hop that
// carries the tarball and the checksums, which cannot vouch for each other if
// both arrive from a host the release page never named. GitHub's asset redirect
// is same-host (`github.com` → `objects.githubusercontent.com` is reached via
// the tag-derived `releases/download` URL, which answers 302 to the CDN), so the
// rule is: same host for the first hop, and the CDN host GitHub names, nothing
// else.
func Download(client *http.Client, asset Asset) ([]byte, error) {
	if client == nil {
		client = &http.Client{Timeout: downloadTimeout}
	}
	var lastErr error
	for attempt := 1; attempt <= maxDownloadAttempts; attempt++ {
		data, err := downloadOnce(client, asset)
		if err == nil {
			return data, nil
		}
		lastErr = err
		if !isTransient(err) {
			return nil, err
		}
		if attempt < maxDownloadAttempts {
			time.Sleep(retryDelay(attempt))
		}
	}
	return nil, fmt.Errorf("%w (after %d attempts)", lastErr, maxDownloadAttempts)
}

// retryDelay backs off between attempts. It stays short: the caller is a
// scheduled job that will run again, so waiting longer spends the sync window
// without improving the odds.
func retryDelay(attempt int) time.Duration {
	return time.Duration(attempt) * 2 * time.Second
}

// isRetryableStatus reports whether a non-200 status is worth another attempt.
// 501 (not implemented) and 505 (HTTP version not supported) are permanent:
// the server will answer the same way however many times it is asked.
func isRetryableStatus(code int) bool {
	if code == http.StatusTooManyRequests {
		return true
	}
	return code >= 500 && code != http.StatusNotImplemented && code != http.StatusHTTPVersionNotSupported
}

// isTransient reports whether retrying the same request could plausibly
// succeed. A dropped connection or a truncated body is a link problem; a 4xx
// is the release not existing, and 501/505 mean the server will not answer
// this request however many times it is asked.
func isTransient(err error) bool {
	var permanentErr *permanentDownloadError
	if errors.As(err, &permanentErr) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		// The download budget ran out: another attempt has the same budget.
		return false
	}
	return true
}

// permanentDownloadError marks a failure a retry cannot fix.
type permanentDownloadError struct{ err error }

func (e *permanentDownloadError) Error() string { return e.err.Error() }
func (e *permanentDownloadError) Unwrap() error { return e.err }

func downloadOnce(client *http.Client, asset Asset) ([]byte, error) {
	origin, err := url.Parse(asset.URL)
	if err != nil {
		return nil, err
	}
	bounded := *client
	previous := client.CheckRedirect
	bounded.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		// via holds the requests already made, so its length is the redirect
		// number this call is deciding: refusing at `> maxRedirects` follows
		// exactly maxRedirects hops, matching latestTag's loop.
		if len(via) > maxRedirects {
			return &permanentDownloadError{err: fmt.Errorf("download %s redirected more than %d times", asset.Name, maxRedirects)}
		}
		if !sameRedirectHost(origin, request.URL) {
			return &permanentDownloadError{err: fmt.Errorf("download %s redirected to %s, which is not the release host", asset.Name, request.URL.Host)}
		}
		if previous != nil {
			return previous(request, via)
		}
		return nil
	}
	response, err := bounded.Get(asset.URL)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		err := fmt.Errorf("download %s returned HTTP %d", asset.Name, response.StatusCode)
		// A retry only helps when the server is saying "not now": 429 (rate
		// limited) and 5xx except 501 and 505, which mean it will never answer
		// this request. Everything else is the request itself being wrong.
		if isRetryableStatus(response.StatusCode) {
			return nil, err
		}
		return nil, &permanentDownloadError{err: err}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxDownloadBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxDownloadBytes {
		// The bound is the same on every attempt; a server sending more is not
		// a link problem.
		return nil, &permanentDownloadError{err: fmt.Errorf("download %s exceeds %d bytes", asset.Name, maxDownloadBytes)}
	}
	return data, nil
}

// Checksums parses a GoReleaser checksums.txt: one "<hex>  <name>" line per
// file. A malformed line is an error, not a skipped entry — a manifest that
// cannot be read in full cannot vouch for the asset it covers.
func Checksums(content []byte) (map[string]string, error) {
	out := map[string]string{}
	for _, raw := range strings.Split(string(content), "\n") {
		line := strings.TrimRight(raw, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		digest, name, found := strings.Cut(line, " ")
		if !found {
			return nil, fmt.Errorf("invalid checksums.txt line: %q", line)
		}
		name = strings.TrimSpace(name)
		digest = strings.TrimSpace(digest)
		if name == "" || digest == "" {
			return nil, fmt.Errorf("invalid checksums.txt line: %q", line)
		}
		if !isHexDigest(digest) {
			return nil, fmt.Errorf("invalid checksums.txt digest: %q", digest)
		}
		out[name] = digest
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("checksums.txt has no entries")
	}
	return out, nil
}

func isHexDigest(value string) bool {
	if len(value) != hex.EncodedLen(sha256.Size) {
		return false
	}
	for _, char := range value {
		switch {
		case char >= '0' && char <= '9':
		case char >= 'a' && char <= 'f':
		case char >= 'A' && char <= 'F':
		default:
			return false
		}
	}
	return true
}

// Verify compares a downloaded asset against the manifest. The name must be
// present: an asset the manifest does not cover is not verified, and
// installing it would defeat the point of the manifest.
func Verify(data []byte, name string, checksums map[string]string) error {
	expected, ok := checksums[name]
	if !ok {
		return fmt.Errorf("checksums.txt has no entry for %s", name)
	}
	digest := sha256.Sum256(data)
	if !strings.EqualFold(hex.EncodeToString(digest[:]), expected) {
		return fmt.Errorf("checksum mismatch for %s", name)
	}
	return nil
}
