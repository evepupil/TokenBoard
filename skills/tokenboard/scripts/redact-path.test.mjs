import assert from 'node:assert/strict'
import test from 'node:test'
import { redactLocalPaths, redactPath } from './redact-path.mjs'

// These are the failure shapes that reach status output and the notify worker
// error log. The invariant that matters is that an account name inside a home
// directory or a file:// local address never survives; which placeholder a
// non-path token becomes is secondary.

test('a URL that follows an open path is kept, not swallowed by the path run', () => {
  // `open <path> https://host.example/ingest failed` must keep the URL and the
  // trailing text. The open-tail rule used to eat every token after the path,
  // so the masked URL — and with it the operator's trace — disappeared.
  assert.equal(
    redactLocalPaths('open /Users/Alice/x https://host.example/ingest failed'),
    'open <path> https://host.example/ingest failed'
  )
  assert.equal(redactPath('open /Users/Alice/x https://host.example/ingest failed'), 'open <path> <url> failed')
})

test('a file:// URL is a local path: masked, never kept with the account name', () => {
  // `file://`, unlike `https://`, points at the local filesystem, so keeping it
  // leaks the account name inside the home directory. Both renderings must lose
  // the address.
  assert.equal(redactLocalPaths('failed to read file:///Users/alice/.tokenboard/a.mjs'), 'failed to read <path>')
  assert.equal(redactPath('failed to read file:///Users/alice/.tokenboard/a.mjs'), 'failed to read <path>')
})

test('an unquoted space-separated path masks the part before the space', () => {
  // A space ends the path run, so `/Users/Alice Smith` only masks up to
  // `/Users/Alice`; a trailing word after the space is not provably part of the
  // path and survives when the message ends there. The account name before the
  // space — the thing a reader must not see — is gone. (A full path normally
  // continues with another separator, whose segment is masked too.)
  const out = redactLocalPaths('failed to read /Users/Alice Smith')
  assert.doesNotMatch(out, /alice|Alice/i)
  assert.ok(out.includes('<path>'))
})

test('an editor deep link carrying a local path is masked, not kept as a URL', () => {
  // `vscode://file/Users/alice/x.ts` is a local path behind a URL-shaped scheme.
  // redactLocalPaths keeps remote URLs, but this one names the home directory,
  // so both renderings must lose the address.
  assert.equal(redactLocalPaths('open failed vscode://file/Users/alice/proj/x.ts'), 'open failed <path>')
  assert.equal(redactPath('open failed vscode://file/Users/alice/proj/x.ts'), 'open failed <path>')
})

test('a local path glued to a kept URL is still masked out of the URL', () => {
  // No separating whitespace, so the URL pattern swallows the path into the
  // "URL". The host must survive (notify needs the endpoint); the account name
  // must not. A REST `/users/` path is not an account and must be left alone.
  const json = redactLocalPaths('{"endpoint":"https://host.example/x","config":"/Users/alice/.tokenboard/config.json"}')
  assert.doesNotMatch(json, /alice/i)
  assert.ok(json.includes('https://host.example'))

  const paren = redactLocalPaths('url(https://host.example/x)/home/alice/proj/y')
  assert.doesNotMatch(paren, /alice/i)
  assert.ok(paren.includes('https://host.example'))

  assert.equal(
    redactLocalPaths('GET https://api.example.com/users/123 failed'),
    'GET https://api.example.com/users/123 failed'
  )
})
