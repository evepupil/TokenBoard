import { createClient } from 'honox/client'
import { copyTextToClipboard } from './lib/clipboard'
import { isValidTimezone, timezoneCookieName } from './lib/timezone'

createClient()

const themeKey = 'tokenboard-theme'

type Theme = 'dark' | 'light'
type ToastTone = 'success' | 'error'

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
initBrowserTimezone()
initTimezoneInputs()

initCopyButtons()
initAppNavigation()

function initBrowserTimezone() {
  const timezone = detectBrowserTimezone()
  if (!timezone) return

  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${timezoneCookieName}=${encodeURIComponent(timezone)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
}

function initTimezoneInputs() {
  const timezone = detectBrowserTimezone()
  if (!timezone) return

  document.querySelectorAll<HTMLInputElement>('[data-timezone-input]').forEach((input) => {
    const mode = input.dataset.timezoneAutofill
    if (mode !== 'true' && mode !== 'always') return
    if (mode === 'always') {
      input.value = timezone
      return
    }

    const initialValue = input.dataset.timezoneDefault?.trim() || input.defaultValue.trim()
    const currentValue = input.value.trim()
    if (currentValue && currentValue !== 'UTC' && initialValue !== 'UTC') return

    input.value = timezone
  })
}

function detectBrowserTimezone() {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return isValidTimezone(timezone) ? timezone : null
  } catch (_) {
    return null
  }
}

function initCopyButtons() {
  document.addEventListener('click', async (event) => {
    if (!(event.target instanceof Element)) return

    const button = event.target.closest<HTMLButtonElement>('[data-copy-target]')
    if (!button) return

    const targetId = button.dataset.copyTarget
    const text = targetId ? document.getElementById(targetId)?.textContent : null
    if (!text) return

    event.preventDefault()

    const originalLabel = button.getAttribute('aria-label') || '复制'
    const originalTitle = button.getAttribute('title') || originalLabel
    const copied = await copyTextToClipboard(navigator.clipboard, text)

    button.dataset.copied = copied ? 'true' : 'false'
    button.setAttribute('aria-label', copied ? '已复制' : '复制失败')
    button.setAttribute('title', copied ? '已复制' : '复制失败')
    showToast(copied ? '已复制到剪贴板' : '复制失败，请手动选择文本复制', copied ? 'success' : 'error')

    window.setTimeout(() => {
      button.dataset.copied = 'idle'
      button.setAttribute('aria-label', originalLabel)
      button.setAttribute('title', originalTitle)
    }, 1600)
  })
}

function showToast(message: string, tone: ToastTone) {
  const container = getToastContainer()
  const toast = document.createElement('div')
  toast.className = 'app-toast'
  toast.dataset.tone = tone
  toast.setAttribute('role', 'status')
  toast.textContent = message

  container.appendChild(toast)
  window.requestAnimationFrame(() => {
    toast.dataset.visible = 'true'
  })

  window.setTimeout(() => {
    toast.dataset.visible = 'false'
    window.setTimeout(() => {
      toast.remove()
      if (!container.childElementCount) container.remove()
    }, 220)
  }, 2200)
}

function getToastContainer() {
  const existing = document.querySelector<HTMLDivElement>('[data-toast-container]')
  if (existing) return existing

  const container = document.createElement('div')
  container.className = 'app-toast-viewport'
  container.dataset.toastContainer = 'true'
  container.setAttribute('aria-live', 'polite')
  container.setAttribute('aria-atomic', 'true')
  document.body.appendChild(container)
  return container
}

function initAppNavigation() {
  document.addEventListener('click', async (event) => {
    const link = getNavigableLink(event)
    if (!link) return

    event.preventDefault()
    await navigateTo(link.href, true)
  })

  window.addEventListener('popstate', () => {
    void navigateTo(window.location.href, false)
  })
}

function getNavigableLink(event: MouseEvent) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    !(event.target instanceof Element)
  ) {
    return null
  }

  const link = event.target.closest<HTMLAnchorElement>('a[href]')
  if (!link) return null
  if (link.target && link.target !== '_self') return null
  if (link.hasAttribute('download') || link.dataset.noAjax === 'true') return null
  if (link.origin !== window.location.origin) return null

  const url = new URL(link.href)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.pathname.startsWith('/api/')) return null
  if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return null

  return link
}

async function navigateTo(pageHref: string, pushState: boolean) {
  const pageUrl = new URL(pageHref)
  const currentUrl = new URL(window.location.href)
  const shouldReplaceLeaderboardPanel =
    pageUrl.pathname === '/leaderboards' &&
    currentUrl.pathname === '/leaderboards'

  if (shouldReplaceLeaderboardPanel) {
    await replaceLeaderboardPanel(pageUrl, pushState)
    return
  }

  await replaceDocument(pageUrl, pushState)
}

async function replaceLeaderboardPanel(pageUrl: URL, pushState: boolean) {
  const currentPanel = document.querySelector<HTMLElement>('[data-leaderboard-panel]')
  if (!currentPanel) {
    window.location.href = pageUrl.toString()
    return
  }

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
    syncDocumentTitle(pageUrl)
    syncScroll(pageUrl)
  } catch (_) {
    window.location.href = pageUrl.toString()
  } finally {
    document
      .querySelector<HTMLElement>('[data-leaderboard-panel]')
      ?.removeAttribute('aria-busy')
  }
}

async function replaceDocument(pageUrl: URL, pushState: boolean) {
  document.body.setAttribute('aria-busy', 'true')

  try {
    const response = await fetch(pageUrl, {
      headers: { 'x-tokenboard-fragment': 'document' }
    })
    if (!response.ok) throw new Error(`Failed to load page: ${response.status}`)

    const html = await response.text()
    const nextDocument = new DOMParser().parseFromString(html, 'text/html')
    const nextBody = nextDocument.body
    const resolvedUrl = new URL(response.url || pageUrl.toString())
    if (!nextBody) throw new Error('Missing body in response document')

    document.body.innerHTML = nextBody.innerHTML
    if (pushState) window.history.pushState({}, '', resolvedUrl)
    document.title = nextDocument.title || document.title
    initTimezoneInputs()
    syncScroll(resolvedUrl)
  } catch (_) {
    window.location.href = pageUrl.toString()
  } finally {
    document.body.removeAttribute('aria-busy')
  }
}

function syncDocumentTitle(pageUrl: URL) {
  if (pageUrl.pathname !== '/leaderboards') return

  const period = pageUrl.searchParams.get('period') === 'monthly' ? '每月' : '每日'
  const metric = pageUrl.searchParams.get('metric') === 'cost' ? '费用' : 'token'
  document.title = `${period}${metric}排行榜 - TokenBoard`
}

function syncScroll(pageUrl: URL) {
  if (pageUrl.hash) {
    const target = document.getElementById(pageUrl.hash.slice(1))
    if (target) {
      target.scrollIntoView()
      return
    }
  }

  window.scrollTo(0, 0)
}
