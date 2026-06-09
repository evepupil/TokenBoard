import { describe, expect, test } from 'vitest'
import {
  getThemeToggleTargetLabel,
  isTheme,
  themeChromeColors,
  themeColorSchemes,
  themeKey
} from './theme'

describe('theme helpers', () => {
  test('uses the shared storage key and browser chrome colors', () => {
    expect(themeKey).toBe('tokenboard-theme')
    expect(themeChromeColors).toEqual({
      dark: '#10130f',
      light: '#f4f0e8'
    })
  })

  test('marks the light theme as only light to avoid mobile auto-darkening', () => {
    expect(themeColorSchemes.dark).toBe('dark')
    expect(themeColorSchemes.light).toBe('only light')
  })

  test('validates theme names and toggle labels', () => {
    expect(isTheme('dark')).toBe(true)
    expect(isTheme('light')).toBe(true)
    expect(isTheme('sepia')).toBe(false)
    expect(isTheme(null)).toBe(false)
    expect(getThemeToggleTargetLabel('dark')).toBe('浅色')
    expect(getThemeToggleTargetLabel('light')).toBe('深色')
  })
})
