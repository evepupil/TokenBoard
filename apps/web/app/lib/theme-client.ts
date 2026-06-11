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

export function syncCurrentTheme(targetDocument: Document = document) {
  const activeTheme = readDocumentTheme(targetDocument) ?? getStoredTheme() ?? getPreferredTheme()
  applyTheme(activeTheme, targetDocument)
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

function readDocumentTheme(targetDocument: Document): Theme | null {
  return isTheme(targetDocument.documentElement.dataset.theme)
    ? targetDocument.documentElement.dataset.theme
    : null
}

function applyTheme(theme: Theme, targetDocument: Document = document) {
  targetDocument.documentElement.classList.toggle('theme-light', theme === 'light')
  targetDocument.documentElement.dataset.theme = theme
  targetDocument.documentElement.style.colorScheme = themeColorSchemes[theme]
  syncThemeMeta(theme, targetDocument)
  targetDocument.querySelectorAll<HTMLElement>('[data-theme-toggle]').forEach((button) => {
    const targetThemeLabel = getThemeToggleTargetLabel(theme)
    button.setAttribute('aria-label', `切换到${targetThemeLabel}主题`)
    button.setAttribute('title', `切换到${targetThemeLabel}主题`)
  })
}

export function syncThemeMeta(theme: Theme, targetDocument: Document = document) {
  setMetaContent(targetDocument, 'theme-color', themeChromeColors[theme])
  setMetaContent(targetDocument, 'color-scheme', themeColorSchemes[theme])
}

function setMetaContent(targetDocument: Document, name: string, content: string) {
  targetDocument
    .querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
    ?.setAttribute('content', content)
}
