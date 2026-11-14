package cli

import (
	"strings"
	"testing"
)

// The upload endpoint carries the bearer token on every request. An http:// endpoint
// sends it in the clear, so only a loopback host — the local wrangler dev server — may
// use it. The TS collector enforces the same rule, so a config one side accepts must not
// be silently accepted by the other.
func TestAssertSecureEndpoint(t *testing.T) {
	accepted := []string{
		"https://tokenboard.example.com/api/v1/ingest",
		"http://localhost:8787/api/v1/ingest",
		"http://127.0.0.1:8787/api/v1/ingest",
		"http://[::1]:8787/api/v1/ingest",
		"",
	}
	for _, endpoint := range accepted {
		if err := assertSecureEndpoint(endpoint); err != nil {
			t.Errorf("assertSecureEndpoint(%q) = %v, want nil", endpoint, err)
		}
	}

	refused := []string{
		"http://tokenboard.example.com/api/v1/ingest",
		"http://10.0.0.5:8787/api/v1/ingest",
	}
	for _, endpoint := range refused {
		err := assertSecureEndpoint(endpoint)
		if err == nil {
			t.Fatalf("assertSecureEndpoint(%q) accepted a plain-http non-loopback endpoint", endpoint)
		}
		if !strings.Contains(err.Error(), "must use https") {
			t.Errorf("error = %q, want it to name the requirement", err.Error())
		}
	}

	if err := assertSecureEndpoint("not a url"); err == nil || !strings.Contains(err.Error(), "Invalid endpoint URL") {
		t.Errorf("unparseable endpoint = %v, want the shared invalid-URL message", err)
	}
}
