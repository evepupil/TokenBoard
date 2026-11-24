import { describe, expect, test } from 'vitest'
import { assertSecureEndpoint } from './endpoint'

// The upload endpoint carries the bearer token on every request. An http:// endpoint
// sends it in the clear, so only a loopback host — the local wrangler dev server — may
// use it.
describe('assertSecureEndpoint', () => {
  test.each([
    'https://tokenboard.example.com/api/v1/ingest',
    'http://localhost:8787/api/v1/ingest',
    'http://127.0.0.1:8787/api/v1/ingest',
    'http://[::1]:8787/api/v1/ingest'
  ])('accepts %s', (endpoint) => {
    expect(assertSecureEndpoint(endpoint)).toBe(endpoint)
  })

  test.each(['http://tokenboard.example.com/api/v1/ingest', 'http://10.0.0.5:8787/api/v1/ingest'])(
    'refuses the plain-http non-loopback endpoint %s',
    (endpoint) => {
      expect(() => assertSecureEndpoint(endpoint)).toThrow(/must use https/)
    }
  )

  test('leaves an empty endpoint to the required-config check', () => {
    expect(assertSecureEndpoint('')).toBe('')
  })

  test('rejects a value that is not a URL at all', () => {
    expect(() => assertSecureEndpoint('not a url')).toThrow(/not a valid URL/)
  })
})
