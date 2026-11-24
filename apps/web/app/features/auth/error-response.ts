// Better Auth answers a failed request with `{ message, code }` at the top level, while
// every TokenBoard route answers with `{ error: { code, message } }`. Two shapes for the
// same concept forces a client to branch on which endpoint it called, so the auth
// handler's error responses are reshaped here — at the single boundary where they enter
// the app — rather than by teaching every caller about the difference.
//
// Only failures are touched. A successful auth response carries the session, and its
// body and headers (notably Set-Cookie) must pass through exactly as Better Auth wrote
// them; rebuilding it would risk dropping the very thing that makes sign-in work.

type AuthErrorBody = { message?: unknown; code?: unknown }

export async function normalizeAuthErrorResponse(response: Response): Promise<Response> {
  // A session response is per-user state, so it must not be stored: without a directive a
  // browser may cache it heuristically and show the previous user's session on a shared
  // machine. The app's own session routes set this in `requireUser`; the Better Auth handler
  // sits outside that middleware, so it is set here. Mutating in place rather than rebuilding
  // keeps the Set-Cookie headers exactly as Better Auth wrote them.
  applyNoStore(response)

  // Redirects are a normal outcome here (sign-in hands off to GitHub), not failures.
  if (response.status < 400) return response

  // The check is on the body, not the `Content-Type` header. Better Auth's rate limiter
  // builds its 429 with `new Response(JSON.stringify(...))` and never sets the header, so
  // the body arrives as JSON behind a `text/plain` type — matching on the header alone
  // skipped precisely the response this adapter exists to reshape, and that 429 escaped
  // to clients in `{ message }` instead of the app's `{ error: { code, message } }`.
  // Attempting the parse is therefore the real test; a body that does not parse is left
  // alone rather than replaced with an invented message.
  let body: unknown
  try {
    body = await response.clone().json()
  } catch {
    return response
  }

  if (!isAuthErrorBody(body)) return response
  // Already in the app's shape: leave it, so a future Better Auth release that adopts it
  // does not get double-wrapped.
  if ('error' in body) return response

  const code = typeof body.code === 'string' && body.code ? body.code : fallbackCode(response.status)
  const message = typeof body.message === 'string' && body.message ? body.message : 'Request failed'

  const headers = new Headers(response.headers)
  headers.set('Content-Type', 'application/json')
  // Better Auth reports the wait in a non-standard `X-Retry-After`. RFC 9110 defines
  // `Retry-After`, and that is what a client or intermediary reads, so the value is
  // mirrored onto the standard header while the original is left in place.
  const retryAfter = headers.get('x-retry-after')
  if (retryAfter && !headers.has('retry-after')) {
    headers.set('Retry-After', retryAfter)
  }
  return new Response(JSON.stringify({ error: { code, message } }), {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

function isAuthErrorBody(value: unknown): value is AuthErrorBody {
  return typeof value === 'object' && value !== null && ('message' in value || 'code' in value)
}

function applyNoStore(response: Response) {
  try {
    response.headers.set('Cache-Control', 'no-store')
  } catch {
    // A redirect or another immutable-header response cannot be edited; those carry no body
    // that could be cached as a session.
  }
}

// Better Auth does not always set a code, so an unmapped failure still has to land on
// something a client can switch on. These mirror the codes the app's own routes use — 429
// included: the rate limiter answers `RATE_LIMITED`, and a client that keys on that code
// should not have to special-case the auth endpoints.
function fallbackCode(status: number) {
  if (status === 400) return 'BAD_REQUEST'
  if (status === 401) return 'UNAUTHORIZED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 429) return 'RATE_LIMITED'
  return 'INTERNAL_SERVER_ERROR'
}
