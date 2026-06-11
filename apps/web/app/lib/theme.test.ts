import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  getThemeToggleTargetLabel,
  initialColorScheme,
  isTheme,
  mobileNightModeOptOutMeta,
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
    expect(initialColorScheme).toBe('dark')
    expect(mobileNightModeOptOutMeta).toEqual({
      name: 'nightmode',
      content: 'disable'
    })
  })

  test('opts light theme out of WebKit forced dark color rewriting', () => {
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8')

    expect(css).toContain('-webkit-force-dark: none;')
    expect(css).toContain('.theme-light *,')
  })

  test('uses app-owned danger colors instead of system dark media classes', () => {
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8')

    expect(css).toContain('.app-danger-text')
    expect(css).toContain('.app-danger-notice')
    expect(css).toContain('.app-danger-action')
    expect(css).toContain('.theme-light .app-danger-action')
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
