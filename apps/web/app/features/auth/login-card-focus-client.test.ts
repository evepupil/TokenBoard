import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  focusLoginCard,
  initLoginCardFocus,
  shouldEnhanceLoginFocusClick,
  shouldHandleLoginFocusNavigation
} from './login-card-focus-client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('login card focus client', () => {
  test('handles only same sign-in page navigation', () => {
    expect(
      shouldHandleLoginFocusNavigation({
        currentHref: 'https://tokenboard.example/auth/sign-in',
        targetHref: 'https://tokenboard.example/auth/sign-in'
      })
    ).toBe(true)
    expect(
      shouldHandleLoginFocusNavigation({
        currentHref: 'https://tokenboard.example/auth/sign-in?error=github',
        targetHref: 'https://tokenboard.example/auth/sign-in'
      })
    ).toBe(false)
    expect(
      shouldHandleLoginFocusNavigation({
        currentHref: 'https://tokenboard.example/',
        targetHref: 'https://tokenboard.example/auth/sign-in'
      })
    ).toBe(false)
  })

  test.each([
    ['ordinary primary click', {}, true],
    ['middle click', { button: 1 }, false],
    ['meta click', { metaKey: true }, false],
    ['ctrl click', { ctrlKey: true }, false],
    ['shift click', { shiftKey: true }, false],
    ['alt click', { altKey: true }, false],
    ['already handled click', { defaultPrevented: true }, false]
  ])('%s enhancement decision', (_label, init, expected) => {
    expect(shouldEnhanceLoginFocusClick(mouseEvent(init))).toBe(expected)
  })

  test('scrolls, highlights, and moves focus to the primary login action', () => {
    const timers: Array<{ callback: () => void; delay: number }> = []
    const primary = { focus: vi.fn() }
    const card = fakeLoginCard(primary)

    focusLoginCard(card as unknown as HTMLElement, fakeWindow(timers) as unknown as Window)

    expect(card.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    expect(timers[0]?.delay).toBe(0)

    timers.shift()?.callback()

    expect(card.classList.contains('app-login-card-attention')).toBe(true)
    expect(primary.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(timers[0]?.delay).toBe(900)

    timers.shift()?.callback()

    expect(card.classList.contains('app-login-card-attention')).toBe(false)
    expect(card.dataset.loginFocusRun).toBeUndefined()
  })

  test('registers a same-page click handler that prevents navigation and focuses the primary action', () => {
    vi.stubGlobal('Element', FakeElementBase)
    const timers: Array<{ callback: () => void; delay: number }> = []
    const primary = { focus: vi.fn() }
    const card = fakeLoginCard(primary)
    const doc = fakeDocument(card)
    const win = fakeWindow(timers, { document: doc })
    const event = clickEvent(new FakeLoginTrigger('https://tokenboard.example/auth/sign-in'))

    initLoginCardFocus(doc as unknown as Document, win as unknown as Window)
    doc.dispatchClick(event)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(card.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })

    timers.shift()?.callback()

    expect(primary.focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  test('uses delayed attention for offscreen cards', () => {
    const timers: Array<{ callback: () => void; delay: number }> = []
    const primary = { focus: vi.fn() }
    const card = fakeLoginCard(primary, { bottom: 1200 })

    focusLoginCard(card as unknown as HTMLElement, fakeWindow(timers) as unknown as Window)

    expect(timers[0]?.delay).toBe(320)
    expect(primary.focus).not.toHaveBeenCalled()
  })

  test('uses immediate non-smooth scrolling for reduced motion users', () => {
    const timers: Array<{ callback: () => void; delay: number }> = []
    const primary = { focus: vi.fn() }
    const card = fakeLoginCard(primary, { bottom: 1200 })

    focusLoginCard(card as unknown as HTMLElement, fakeWindow(timers, { reducedMotion: true }) as unknown as Window)

    expect(card.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' })
    expect(timers[0]?.delay).toBe(0)
  })
})

function mouseEvent(init: Partial<MouseEvent> = {}) {
  return {
    button: 0,
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init
  } as MouseEvent
}

function clickEvent(target: FakeLoginTrigger) {
  return {
    ...mouseEvent(),
    target,
    preventDefault: vi.fn()
  } as unknown as MouseEvent & { preventDefault: ReturnType<typeof vi.fn> }
}

function fakeDocument(card: ReturnType<typeof fakeLoginCard>) {
  let clickListener: ((event: MouseEvent) => void) | null = null
  return {
    documentElement: { clientHeight: 800, clientWidth: 1200 },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'click' && typeof listener === 'function') {
        clickListener = listener as (event: MouseEvent) => void
      }
    },
    querySelector: vi.fn((selector: string) => (selector === '[data-login-card="true"]' ? card : null)),
    dispatchClick(event: MouseEvent) {
      clickListener?.(event)
    }
  }
}

function fakeWindow(
  timers: Array<{ callback: () => void; delay: number }>,
  options: {
    document?: ReturnType<typeof fakeDocument>
    reducedMotion?: boolean
  } = {}
) {
  return {
    innerHeight: 800,
    innerWidth: 1200,
    location: { href: 'https://tokenboard.example/auth/sign-in' },
    document: options.document ?? { documentElement: { clientHeight: 800, clientWidth: 1200 } },
    matchMedia: () => ({ matches: options.reducedMotion ?? false }),
    setTimeout(callback: TimerHandler, delay?: number) {
      if (typeof callback === 'function') {
        timers.push({ callback: callback as () => void, delay: delay ?? 0 })
      }
      return timers.length
    }
  }
}

function fakeLoginCard(primary: { focus: ReturnType<typeof vi.fn> }, rect: Partial<DOMRect> = {}) {
  const classList = new FakeClassList()
  return {
    dataset: {} as Record<string, string | undefined>,
    classList,
    offsetWidth: 1,
    scrollIntoView: vi.fn(),
    querySelector: vi.fn((selector: string) => (selector === '[data-login-primary="true"]' ? primary : null)),
    getBoundingClientRect: () => ({
      top: 10,
      left: 10,
      bottom: rect.bottom ?? 240,
      right: 480,
      width: 470,
      height: 230,
      x: 10,
      y: 10,
      toJSON: () => ({})
    })
  }
}

class FakeElementBase {}

class FakeLoginTrigger extends FakeElementBase {
  constructor(private readonly hrefValue: string) {
    super()
  }

  closest(selector: string) {
    return selector === 'a[data-login-focus="true"][href]' ? { href: this.hrefValue } : null
  }
}

class FakeClassList {
  private readonly values = new Set<string>()

  add(value: string) {
    this.values.add(value)
  }

  remove(value: string) {
    this.values.delete(value)
  }

  contains(value: string) {
    return this.values.has(value)
  }
}
