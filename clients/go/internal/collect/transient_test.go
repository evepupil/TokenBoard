package collect

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"testing"
)

func TestIsTransientNetworkErrorMatchesTSSignatures(t *testing.T) {
	transient := []error{
		errors.New("Post \"https://x/ingest\": fetch failed"),
		errors.New("x509: certificate has expired or is not yet valid"),
		errors.New("tls: handshake failure: tls handshake timeout"),
		errors.New("read tcp: connection reset by peer (econnreset)"),
		errors.New("dial tcp: connect: connection refused (econnrefused)"),
		errors.New("i/o timeout (etimedout)"),
		errors.New("lookup tokenboard.example: no such host (eai_again)"),
		errors.New("network socket write failed"),
		errors.New("TokenBoard request timed out after 30000ms"),
		fmt.Errorf("Upload failed with status %d", 503),
		errors.New("snapshot check failed with status 429 somewhere"),
	}
	for _, err := range transient {
		if !IsTransientNetworkError(err) {
			t.Errorf("%q should be transient", err)
		}
	}
}

// The bare-word trap: a local path containing tls/ssl/network words must not
// classify as transient. These mirror the TS test's rationale.
func TestIsTransientNetworkErrorRejectsPathLookalikes(t *testing.T) {
	notTransient := []error{
		errors.New("Unable to read Codex session file /Volumes/network-share/sessions/a.jsonl: EIO"),
		errors.New("open /mnt/ssl-backup/cursor.json: permission denied"),
		errors.New("Snapshot check failed with status 400"),
		errors.New("Upload failed with status 401"),
		errors.New("invalid cursor JSON"),
	}
	for _, err := range notTransient {
		if IsTransientNetworkError(err) {
			t.Errorf("%q must NOT be transient", err)
		}
	}
}

// net/http wraps every failure that happened on the wire in *url.Error, and
// its text for a connection that died mid-response is "unexpected EOF" — a
// wording none of the TS signatures cover. The type is the Go counterpart of
// TS's `fetch failed`, which covers every transport failure there. The same
// wording also comes from a truncated local file, so the type check is what
// keeps that read fault non-transient.
func TestIsTransientNetworkErrorClassifiesTransportFailures(t *testing.T) {
	transport := &url.Error{Op: "Post", URL: "https://tokenboard.example/api/v1/ingest", Err: io.ErrUnexpectedEOF}
	if !IsTransientNetworkError(transport) {
		t.Fatalf("a *url.Error transport failure should be transient: %v", transport)
	}
	local := fmt.Errorf("read /tmp/session.jsonl: %w", io.ErrUnexpectedEOF)
	if IsTransientNetworkError(local) {
		t.Fatalf("a local read fault must NOT be transient: %v", local)
	}
}

// Go-native error shapes: *net.OpError and *net.DNSError must classify as
// transient since they are the idiomatic transport failures here.
func TestIsTransientNetworkErrorClassifiesGoNativeErrors(t *testing.T) {
	opErr := &net.OpError{Op: "dial", Err: errors.New("connection refused")}
	wrapped := fmt.Errorf("Post \"https://tokenboard.example/api/v1/ingest\": %w", opErr)
	if !IsTransientNetworkError(wrapped) {
		t.Errorf("wrapped OpError should be transient: %v", wrapped)
	}
	dnsErr := &net.DNSError{Err: "no such host", Name: "tokenboard.example", IsNotFound: true}
	if !IsTransientNetworkError(fmt.Errorf("dial: %w", dnsErr)) {
		t.Errorf("DNSError should be transient via enotfound text: %v", dnsErr)
	}
}
