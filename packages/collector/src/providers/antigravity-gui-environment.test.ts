import { describe, expect, test } from 'vitest'
import { isUnavailableLanguageServerError } from './antigravity-gui-environment'

describe('isUnavailableLanguageServerError', () => {
  test('does not treat metadata resource or format failures as unavailable', () => {
    expect(
      isUnavailableLanguageServerError(
        new Error('Antigravity metadata response exceeded the 8388608-byte limit for antigravity')
      )
    ).toBe(false)
    expect(
      isUnavailableLanguageServerError(
        new Error('Antigravity metadata request returned invalid JSON for antigravity: Unexpected token')
      )
    ).toBe(false)
  })

  test('recognizes language-server availability failures', () => {
    expect(
      isUnavailableLanguageServerError(new Error('Antigravity metadata request failed for antigravity: HTTP 500'))
    ).toBe(true)
    expect(
      isUnavailableLanguageServerError(new Error('Timed out starting Antigravity language server for antigravity'))
    ).toBe(true)
  })
})
