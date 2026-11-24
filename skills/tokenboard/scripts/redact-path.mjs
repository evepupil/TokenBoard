// Path redaction for operator-facing diagnostics. status output and the notify
// worker error log are both pasted into issues and chats, where the account
// name inside a home directory is not the reader's to see. The rules live here,
// in one module, because two call sites (status.mjs and notify.mjs) need the
// same behaviour — keeping a copy in each let one drift.
import { redactUrlCredentials } from './redact-credentials.mjs'

// A path is a run of path characters (anything but whitespace and quotes) that
// contains a separator. Parentheses stay inside the run — `/home/alice(work)/x`
// is one path — but a space ends it. So `/Users/Alice Bob/x` masks both segments
// (each contains a separator), yet a message that stops at a space-containing
// account name (`/Users/Alice Smith`) leaves the trailing word: the run is only
// the part before the space. The account name before that space is still masked.
// Credentials are redacted first so the path run can never re-expose one the URL
// rules would have caught.
//
// status.mjs is pasted verbatim into chats, so the URL itself goes too: the
// host and path are not needed to act on the message.
export function redactPath(message) {
  return redactPaths(message, () => '<url>')
}

// The notify worker error log keeps the URL (already stripped of userinfo and
// secret query parameters) because the failing endpoint is what the operator
// needs, while a local filesystem path in the same message still names the
// home directory.
//
// Keeping the URL has a trap: when a local path is glued to the URL with no
// separating whitespace — a JSON fragment `{"config":"/Users/…"}` or a
// `(https://…)/home/…` shape — the URL pattern's `\S*` swallows the path into
// the "URL", so the path rule never sees it and the account name rides into the
// kept endpoint. Home-rooted paths are masked back out of the kept URL; the
// host survives, the home directory does not. The roots are case-sensitive on
// purpose: `/Users/` (macOS), `/home/` (Linux) and `\Users\` (Windows) name an
// account, whereas a REST `/users/` path does not and is left alone.
const homePathInUrl = /(?:\/Users\/|\/home\/|\\Users\\)[^\s"'`<>]*/g

export function redactLocalPaths(message) {
  return redactPaths(message, (url) => url.replace(homePathInUrl, '<path>'))
}

// The URL spans are masked out before the path rule runs, so a URL's slashes
// are never mistaken for a filesystem path; renderUrl decides what each masked
// span becomes.
function redactPaths(message, renderUrl) {
  const urls = []
  const masked = redactUrlCredentials(String(message)).replace(urlPattern, (url) => {
    urls.push(renderUrl(url))
    // A NUL-delimited index contains no separator, so the path rule below
    // cannot match it; the open-tail rule must also treat NUL as a boundary so
    // it never swallows a URL that sits after the path.
    return `\u0000${urls.length - 1}\u0000`
  })
  const redacted = masked
    .replace(/[^\s'"`]*[\\/][^\s'"`]*/g, '<path>')
    // Each swallowed token must carry at least one character, so a space
    // followed by a URL mask (NUL) is not "a token" and the loop stops there.
    // With `*` the loop ate the separating space and glued the mask to
    // `<path>`, losing the space when the URL was restored.
    .replace(/(open |'|")<path>(?: [^\u0000'"`:\n]+)+/g, (_, lead) => `${lead}<path>`)
  return redacted.replace(/\u0000(\d+)\u0000/g, (_, index) => urls[Number(index)])
}

// The leading `\b` pins the scheme to a word boundary so the engine cannot
// retry from the second character of `file:` (which it did as `ile://`, a
// valid-looking scheme, defeating the lookahead). `file:` is excluded because
// a file URL points at the local filesystem, so its path is a local path and
// must be masked rather than kept (keeping it would leak the account name
// inside the home directory). Editor deep links carry a local path the same way
// — `vscode://file/Users/.../x.ts`, `jetbrains://file/...` — so any scheme
// whose path starts with `file/` is excluded too; without that it was treated
// as an endpoint and `redactLocalPaths` kept the home directory verbatim. The
// remaining schemes are real remote endpoints, which the notify log needs.
const urlPattern = /\b(?:(?!file:)[a-z][a-z0-9+.-]*:\/\/(?!file\/)\S*)/gi
