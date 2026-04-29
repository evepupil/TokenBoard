import { createClient } from 'honox/client'

createClient()

const themeKey = 'tokenboard-theme'

type Theme = 'dark' | 'light'

function getStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(themeKey)
    return value === 'light' || value === 'dark' ? value : null
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
  document.querySelectorAll<HTMLElement>('[data-theme-toggle]').forEach((button) => {
    const targetThemeLabel = theme === 'light' ? '深色' : '浅色'
    button.setAttribute('aria-label', `切换到${targetThemeLabel}主题`)
    button.setAttribute('title', `切换到${targetThemeLabel}主题`)
  })
}

function initTheme() {
  applyTheme(getStoredTheme() ?? getPreferredTheme())
}

initTheme()

initLeaderboardNavigation()

function initLeaderboardNavigation() {
  document.addEventListener('click', async (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return
    }

    const link = event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>('[data-leaderboard-link]')
      : null
    if (!link || link.origin !== window.location.origin) return

    event.preventDefault()
    await replaceLeaderboardPanel(link.href, true)
  })

  window.addEventListener('popstate', () => {
    if (window.location.pathname === '/leaderboards') {
      void replaceLeaderboardPanel(window.location.href, false)
    }
  })
}

async function replaceLeaderboardPanel(pageHref: string, pushState: boolean) {
  const currentPanel = document.querySelector<HTMLElement>('[data-leaderboard-panel]')
  if (!currentPanel) {
    window.location.href = pageHref
    return
  }

  const pageUrl = new URL(pageHref)
  const fragmentUrl = new URL('/leaderboards/fragment', window.location.origin)
  fragmentUrl.search = pageUrl.search

  currentPanel.setAttribute('aria-busy', 'true')
  currentPanel.classList.add('opacity-70')

  try {
    const response = await fetch(fragmentUrl, {
      headers: { 'x-tokenboard-fragment': 'leaderboard' }
    })
    if (!response.ok) throw new Error(`Failed to load leaderboard: ${response.status}`)

    const html = await response.text()
    currentPanel.outerHTML = html
    if (pushState) window.history.pushState({}, '', pageUrl)
  } catch (_) {
    window.location.href = pageHref
  } finally {
    document
      .querySelector<HTMLElement>('[data-leaderboard-panel]')
      ?.removeAttribute('aria-busy')
  }
}
