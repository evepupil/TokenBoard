import { getThemeToggleTargetLabel, themeChromeColors, themeColorSchemes, themeKey } from './theme'

export const themeScript = `
(function () {
  var themeKey = ${JSON.stringify(themeKey)}
  var themeChromeColors = ${JSON.stringify(themeChromeColors)}
  var themeColorSchemes = ${JSON.stringify(themeColorSchemes)}

  function getTheme() {
    try {
      var storedTheme = localStorage.getItem(themeKey)
      if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme
    } catch (_) {}
    return 'light'
  }

  function syncThemeMeta(theme) {
    var colorScheme = themeColorSchemes[theme] || themeColorSchemes.light
    document.documentElement.style.colorScheme = colorScheme
    var themeColorMeta = document.querySelector('meta[name="theme-color"]')
    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', themeChromeColors[theme] || themeChromeColors.light)
    }
    var colorSchemeMeta = document.querySelector('meta[name="color-scheme"]')
    if (colorSchemeMeta) {
      colorSchemeMeta.setAttribute('content', colorScheme)
    }
  }

  function applyTheme(theme) {
    document.documentElement.classList.toggle('theme-light', theme === 'light')
    document.documentElement.dataset.theme = theme
    syncThemeMeta(theme)
    document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
      var targetThemeLabel = theme === 'light' ? ${JSON.stringify(getThemeToggleTargetLabel('light'))} : ${JSON.stringify(getThemeToggleTargetLabel('dark'))}
      button.setAttribute('aria-label', '切换到' + targetThemeLabel + '主题')
      button.setAttribute('title', '切换到' + targetThemeLabel + '主题')
    })
  }

  applyTheme(getTheme())

  document.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('[data-theme-toggle]') : null
    if (!target) return

    var nextTheme = document.documentElement.classList.contains('theme-light') ? 'dark' : 'light'
    try {
      localStorage.setItem(themeKey, nextTheme)
    } catch (_) {}
    applyTheme(nextTheme)
  })
})()
`

// The inline theme script has to run before first paint, so it cannot be an external
// file without reintroducing the flash it exists to prevent. A CSP hash lets the policy
// stay strict instead of falling back to 'unsafe-inline': the digest below is derived
// from the same string the renderer emits, so the two cannot drift apart.
export async function themeScriptHash() {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(themeScript))
  const bytes = new Uint8Array(digest)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `'sha256-${btoa(binary)}'`
}
