// Package collect hosts the orchestration layer: source classification,
// failure semantics, and the transient-error rules that decide whether a
// failed sync run is retryable (exit 75) or a plain failure.
package collect

import (
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// TransientSyncExitCode is what the scheduled runner treats as "retry this
// later". The skill scripts mirror this literal; keep them in sync.
const TransientSyncExitCode = 75

// transientErrorPatterns mirrors transient-error.ts. Every entry must name a
// transport failure on its own: bare words like "network" or "tls" also match
// local filesystem paths ("/mnt/ssl-backup/...") and would turn a disk fault
// into pointless retries.
var transientErrorPatterns = []string{
	"fetch failed",
	"unknown_certificate_verification_error",
	"certificate verification",
	"verify the first certificate",
	"certificate has expired",
	"certificate is not yet valid",
	"self-signed certificate",
	"cert_has_expired",
	"cert_not_yet_valid",
	"econnreset",
	"econnrefused",
	"etimedout",
	"eai_again",
	"enotfound",
	"network socket",
	"socket hang up",
	"tls connection",
	"tls handshake",
	"ssl routines",
	"ssl_error",
	// The request deadline, in full, so a local lock timeout never matches.
	"request timed out",

	// Go-native transport signatures. The kernel-level E* tokens above only
	// appear in errors that carry them literally; Go's net package words them
	// out, so the phrasing itself is matched too.
	"connect: connection refused",
	"connection reset by peer",
	"no such host",
	"i/o timeout",
	"network is unreachable",
	"no route to host",
	"connection refused",
}

var transientHttpStatuses = map[int]bool{
	408: true, 429: true, 500: true, 502: true, 503: true, 504: true,
}

var httpStatusPattern = regexp.MustCompile(`status (\d{3})\b`)

// IsTransientNetworkError classifies an error the same way
// transient-error.ts does, on the lowercased message: a known transport
// signature, or a "status <code>" mention of a retryable gateway status.
//
// A *url.Error is transient on its type alone. net/http wraps every failure
// that happened on the wire in one, with wordings the shared list cannot all
// carry ("unexpected EOF", "http2: ..."), while TS's fetch reports the whole
// class as TypeError("fetch failed") — the single signature the list already
// has. Matching the type rather than the text is also what keeps a truncated
// local file's io.ErrUnexpectedEOF, which reads the same, out of the retry
// path.
func IsTransientNetworkError(err error) bool {
	if err == nil {
		return false
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return true
	}
	message := strings.ToLower(err.Error())
	for _, pattern := range transientErrorPatterns {
		if strings.Contains(message, pattern) {
			return true
		}
	}
	if match := httpStatusPattern.FindStringSubmatch(message); match != nil {
		status, convErr := strconv.Atoi(match[1])
		if convErr == nil && transientHttpStatuses[status] {
			return true
		}
	}
	return false
}
