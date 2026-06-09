import {
  getThemeToggleTargetLabel,
  isTheme,
  themeChromeColors,
  themeColorSchemes,
  themeKey,
  type Theme
} from './theme'

export function initTheme() {
  applyTheme(getStoredTheme() ?? getPreferredTheme())
}

function getStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(themeKey)
    return isTheme(value) ? value : null
  } catch (_) {
    return null
  }
}

function getPreferredTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('theme-light', theme === 'light')
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = themeColorSchemes[theme]
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', themeChromeColors[theme])
  document.querySelectorAll<HTMLElement>('[data-theme-toggle]').forEach((button) => {
    const targetThemeLabel = getThemeToggleTargetLabel(theme)
    button.setAttribute('aria-label', `切换到${targetThemeLabel}主题`)
    button.setAttribute('title', `切换到${targetThemeLabel}主题`)
  })
}
