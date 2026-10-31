// The upload endpoint carries the bearer token on every request, and the pricing
// fetch derives its origin from the same value. Over plain HTTP both the credential
// and the usage data cross the network in the clear, so an `http://` endpoint is
// accepted only for a loopback host — the local `wrangler dev` server, which is the
// one place the scheme is genuinely safe.
//
// This is a configuration check rather than a transport one: a wrong endpoint is a
// setup mistake the operator can fix in seconds, and failing loudly here beats
// discovering it from a packet capture.

const loopbackHostnames = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Throws when `endpoint` would send credentials over an unencrypted, non-loopback
 * connection. Returns the endpoint unchanged so callers can inline the check.
 */
export function assertSecureEndpoint(endpoint: string): string {
  if (!endpoint.trim()) return endpoint
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error(`TokenBoard endpoint is not a valid URL: ${endpoint}`)
  }
  if (url.protocol === 'https:') return endpoint
  if (url.protocol === 'http:' && loopbackHostnames.has(url.hostname)) return endpoint
  throw new Error(
    `TokenBoard endpoint must use https (the upload token travels on every request); http is allowed only for a loopback host, not ${url.origin}`
  )
}
