import { createClient } from 'honox/client'

createClient()

const themeKey = 'tokenboard-theme'

type Theme = 'dark' | 'light'

function getStoredTheme(): Theme | null {
  const value = window.localStorage.getItem(themeKey)
  return value === 'light' || value === 'dark' ? value : null
}

function getPreferredTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('theme-light', theme === 'light')
  document.documentElement.dataset.theme = theme
  document.querySelectorAll<HTMLElement>('[data-theme-label]').forEach((label) => {
    label.textContent = theme === 'light' ? '浅色' : '深色'
  })
}

function initTheme() {
  applyTheme(getStoredTheme() ?? getPreferredTheme())

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-theme-toggle]') : null
    if (!target) return

    const nextTheme: Theme = document.documentElement.classList.contains('theme-light') ? 'dark' : 'light'
    window.localStorage.setItem(themeKey, nextTheme)
    applyTheme(nextTheme)
  })
}

initTheme()
