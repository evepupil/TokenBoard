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
      dark: '#121318',
      light: '#e8e6ef'
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

  // `--app-subtle` styles 12px body text (device notes, timestamps), so it must clear the WCAG
  // AA 4.5:1 floor against the page background of its own theme. The value it replaced measured
  // 3.9:1 on dark and 4.2:1 on light — both below AA. This pins the floor so a later palette
  // tweak cannot quietly drop it back.
  test('keeps the subtle text color above the AA contrast floor in both themes', () => {
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8')

    const dark = readThemeColor(css, ':root', '--app-subtle')
    const light = readThemeColor(css, '.theme-light', '--app-subtle')

    expect(contrastRatio(dark, readThemeColor(css, ':root', '--app-bg'))).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(light, readThemeColor(css, '.theme-light', '--app-bg'))).toBeGreaterThanOrEqual(4.5)
  })
})

// Read one custom property from a theme block. The blocks are `:root { … }` and
// `.theme-light { … }`, so slicing from the block opener to the next `}` is enough.
function readThemeColor(css: string, block: string, property: string) {
  const start = css.indexOf(`${block} {`)
  if (start < 0) throw new Error(`Missing ${block} block in style.css`)
  const body = css.slice(start, css.indexOf('}', start))
  const match = new RegExp(`${property}:\\s*(#[0-9a-f]{6})`, 'i').exec(body)
  if (!match) throw new Error(`Missing ${property} in ${block}`)
  return match[1]
}

function contrastRatio(foreground: string, background: string) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

function relativeLuminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const [r, g, b] = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  )
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
