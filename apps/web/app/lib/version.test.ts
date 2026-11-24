import { describe, expect, test } from 'vitest'
import { clientVersion, serverVersion } from './version'

// Both numbers are shown to users and served over HTTP, so a typo ("0.1", "v0.1.0",
// "0.1.0-rc1") silently ships a broken identity. Pin the shape here rather than relying on
// the footer test, which only checks that whatever is in the constant appears on screen.
describe('version constants', () => {
  test.each([
    ['serverVersion', serverVersion],
    ['clientVersion', clientVersion]
  ])('%s is a bare semantic version', (_, value) => {
    expect(value).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
