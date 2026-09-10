const loginCardAttentionDurationMs = 900
const loginCardScrollAttentionDelayMs = 320
const loginCardSelector = '[data-login-card="true"]'
const loginCardPrimarySelector = '[data-login-primary="true"]'
const signInPath = '/auth/sign-in'

type LoginFocusWindow = Pick<
  Window,
  'document' | 'innerHeight' | 'innerWidth' | 'location' | 'matchMedia' | 'setTimeout'
>

let loginCardFocusSeq = 0

export function initLoginCardFocus(doc: Document = document, win: LoginFocusWindow = window) {
  doc.addEventListener('click', (event) => {
    const trigger = getLoginFocusTrigger(event)
    if (!trigger) return

    if (
      !shouldHandleLoginFocusNavigation({
        currentHref: win.location.href,
        targetHref: trigger.href
      })
    ) {
      return
    }

    const card = doc.querySelector<HTMLElement>(loginCardSelector)
    if (!card) return

    event.preventDefault()
    focusLoginCard(card, win)
  })
}

export function shouldEnhanceLoginFocusClick(
  event: Pick<MouseEvent, 'altKey' | 'button' | 'ctrlKey' | 'defaultPrevented' | 'metaKey' | 'shiftKey'>
) {
  return !(
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
}

export function shouldHandleLoginFocusNavigation(input: { currentHref: string; targetHref: string }) {
  try {
    const currentUrl = new URL(input.currentHref)
    const targetUrl = new URL(input.targetHref, currentUrl)
    return (
      currentUrl.pathname === signInPath && targetUrl.pathname === signInPath && targetUrl.search === currentUrl.search
    )
  } catch (_) {
    return false
  }
}

export function focusLoginCard(card: HTMLElement, win: LoginFocusWindow = window) {
  const reducedMotion = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const shouldDelayAttention = !reducedMotion && !isElementFullyVisible(card, win)
  const runId = String(++loginCardFocusSeq)

  card.dataset.loginFocusRun = runId
  card.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' })

  win.setTimeout(
    () => {
      if (card.dataset.loginFocusRun !== runId) return
      startLoginCardAttention(card, runId, win)
      focusLoginCardPrimary(card)
    },
    shouldDelayAttention ? loginCardScrollAttentionDelayMs : 0
  )
}

function getLoginFocusTrigger(event: MouseEvent) {
  if (!shouldEnhanceLoginFocusClick(event) || !(event.target instanceof Element)) {
    return null
  }

  return event.target.closest<HTMLAnchorElement>('a[data-login-focus="true"][href]')
}

function isElementFullyVisible(element: HTMLElement, win: LoginFocusWindow) {
  const rect = element.getBoundingClientRect()
  const viewportHeight = win.innerHeight || win.document.documentElement.clientHeight
  const viewportWidth = win.innerWidth || win.document.documentElement.clientWidth

  return rect.top >= 0 && rect.left >= 0 && rect.bottom <= viewportHeight && rect.right <= viewportWidth
}

function startLoginCardAttention(card: HTMLElement, runId: string, win: LoginFocusWindow) {
  if (card.dataset.loginFocusRun !== runId) return

  card.classList.remove('app-login-card-attention')
  void card.offsetWidth
  card.classList.add('app-login-card-attention')

  win.setTimeout(() => {
    if (card.dataset.loginFocusRun !== runId) return
    card.classList.remove('app-login-card-attention')
    delete card.dataset.loginFocusRun
  }, loginCardAttentionDurationMs)
}

function focusLoginCardPrimary(card: HTMLElement) {
  const primary = card.querySelector<HTMLElement>(loginCardPrimarySelector)
  primary?.focus({ preventScroll: true })
}
