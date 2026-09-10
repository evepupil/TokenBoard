import { describe, expect, test } from 'vitest'
import { maxAntigravityLanguageServerUsageEvents, reserveAntigravityLanguageServerUsageEvents } from './antigravity-gui'

describe('Antigravity language-server usage event budget', () => {
  test('rejects a collection that exceeds the total usage-event limit', () => {
    expect(reserveAntigravityLanguageServerUsageEvents(maxAntigravityLanguageServerUsageEvents - 1, 1)).toBe(
      maxAntigravityLanguageServerUsageEvents
    )

    expect(() => reserveAntigravityLanguageServerUsageEvents(maxAntigravityLanguageServerUsageEvents, 1)).toThrow(
      `Antigravity language server metadata exceeded the ${maxAntigravityLanguageServerUsageEvents} usage-event limit`
    )
  })
})
