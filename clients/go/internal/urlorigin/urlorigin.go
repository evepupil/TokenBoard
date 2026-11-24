// Package urlorigin renders a parsed URL's origin the way the TS collector's
// `new URL(endpoint).origin` does. The origin is the identity of both the
// pricing cache and the cursor-file scope, and the two clients share one
// state directory, so any spelling difference silently discards or forks the
// other side's state.
package urlorigin

import (
	"errors"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/idna"
)

// The WHATWG URL "domain to ASCII" step: UTS #46 ToASCII, non-transitional,
// CheckBidi and CheckJoiners on, CheckHyphens and UseSTD3ASCIIRules off, no
// DNS length check (VerifyDNSLength is left at its false default).
var whatwgDomainToASCII = idna.New(
	idna.MapForLookup(),
	idna.Transitional(false),
	idna.BidiRule(),
	idna.CheckHyphens(false),
	idna.StrictDomainName(false),
)

// ErrInvalidHost is returned for a host the URL parser would reject.
var ErrInvalidHost = errors.New("invalid host")

// Origin returns scheme://host[:port] with the host lowercased (punycoded when
// it is not ASCII), IPv6 hosts kept in brackets, and the scheme's default port
// dropped.
//
// IDNA runs only on a non-ASCII host. An ASCII host keeps the plain lowercase
// path: Node passes an undecodable label such as "xn--zz" through, where the
// idna profile would reject it.
func Origin(parsed *url.URL) (string, error) {
	host := parsed.Hostname()
	if !isASCII(host) {
		converted, err := whatwgDomainToASCII.ToASCII(host)
		if err != nil {
			return "", ErrInvalidHost
		}
		host = converted
	}
	host = strings.ToLower(host)
	if strings.Contains(host, ":") {
		host = "[" + host + "]" // url.Hostname strips IPv6 brackets
	}
	if port := parsed.Port(); port != "" && !isDefaultPort(parsed.Scheme, port) {
		host = host + ":" + port
	}
	return parsed.Scheme + "://" + host, nil
}

// isDefaultPort normalizes before comparing so a leading-zero port
// ("https://h:0443") is recognized as default and dropped, the way the TS
// URL parser canonicalizes it.
func isDefaultPort(scheme, port string) bool {
	normalized, err := strconv.Atoi(port)
	if err != nil {
		return false
	}
	return (scheme == "https" && normalized == 443) || (scheme == "http" && normalized == 80)
}

func isASCII(value string) bool {
	for index := 0; index < len(value); index++ {
		if value[index] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}
