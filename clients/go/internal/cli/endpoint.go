package cli

import (
	"fmt"
	"net/url"
	"strings"
)

// loopbackHosts are the hosts allowed to use plain HTTP. The upload endpoint
// carries the bearer token on every request, so an http:// endpoint sends the
// credential and the usage data in the clear; only the local `wrangler dev`
// server is a case where the scheme is genuinely safe.
var loopbackHosts = map[string]bool{
	"localhost": true,
	"127.0.0.1": true,
	"::1":       true,
	"[::1]":     true,
}

// assertSecureEndpoint rejects an endpoint that would send the upload token over
// an unencrypted, non-loopback connection. It mirrors the TS collector's check so
// the two clients refuse the same configurations.
func assertSecureEndpoint(endpoint string) error {
	if strings.TrimSpace(endpoint) == "" {
		return nil
	}
	parsed, err := url.Parse(endpoint)
	// url.Parse accepts a bare path, so a scheme and host are checked explicitly; the
	// message matches cursorScopeFromEndpoint's, which is the check this one runs ahead of.
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return fmt.Errorf("Invalid endpoint URL: %s", endpoint)
	}
	if parsed.Scheme == "https" {
		return nil
	}
	if parsed.Scheme == "http" && loopbackHosts[parsed.Hostname()] {
		return nil
	}
	return fmt.Errorf(
		"TokenBoard endpoint must use https (the upload token travels on every request); http is allowed only for a loopback host, not %s",
		parsed.Scheme+"://"+parsed.Host)
}
