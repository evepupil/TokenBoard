import { afterEach, describe, expect, test, vi } from 'vitest'
import { initAppNavigation } from './client-navigation'

describe('client navigation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('ignores an older document response that resolves after a newer navigation', async () => {
    const dom = installNavigationDom()
    const requests = new Map<string, (response: Response) => void>()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (input: string | URL) =>
          new Promise<Response>((resolve) => {
            requests.set(new URL(String(input)).pathname, resolve)
          })
      )
    )

    initAppNavigation(() => undefined)
    const firstNavigation = dom.click('/first')
    const secondNavigation = dom.click('/second')

    requests.get('/second')?.(navigationResponse('/second', 'second document'))
    await secondNavigation
    requests.get('/first')?.(navigationResponse('/first', 'first document'))
    await firstNavigation

    expect(dom.body.innerHTML).toBe('second document')
    expect(dom.history).toEqual(['/second'])
  })

  test('clears a superseded document busy state when a leaderboard fragment wins', async () => {
    const dom = installNavigationDom({ initialPath: '/leaderboards', hasLeaderboardPanel: true })
    const requests = new Map<string, (response: Response) => void>()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (input: string | URL) =>
          new Promise<Response>((resolve) => {
            requests.set(new URL(String(input)).pathname, resolve)
          })
      )
    )

    initAppNavigation(() => undefined)
    const documentNavigation = dom.click('/dashboard')
    const fragmentNavigation = dom.click('/leaderboards?period=monthly')

    requests.get('/leaderboards/fragment')?.(navigationResponse('/leaderboards/fragment', 'monthly panel'))
    await fragmentNavigation
    requests.get('/dashboard')?.(navigationResponse('/dashboard', 'dashboard document'))
    await documentNavigation

    expect(dom.body.hasAttribute('aria-busy')).toBe(false)
  })
})

function installNavigationDom(
  options: {
    initialPath?: string
    hasLeaderboardPanel?: boolean
  } = {}
) {
  const listeners = new Map<string, (event: Event) => Promise<void> | void>()
  const body = new FakeBody()
  const leaderboardPanel = options.hasLeaderboardPanel ? new FakePanel() : null
  const history: string[] = []
  const location = new URL(options.initialPath ?? '/start', 'https://tokenboard.example.com')
  const document = {
    body,
    title: 'Start',
    documentElement: {
      dataset: { theme: 'dark' },
      classList: { toggle: () => undefined },
      style: {}
    },
    addEventListener(type: string, listener: (event: Event) => Promise<void> | void) {
      listeners.set(type, listener)
    },
    querySelector: (selector: string) => (selector === '[data-leaderboard-panel]' ? leaderboardPanel : null),
    querySelectorAll: () => [],
    getElementById: () => null
  }
  const window = {
    location,
    history: {
      pushState(_state: unknown, _unused: string, url: URL) {
        history.push(url.pathname)
      }
    },
    addEventListener: () => undefined,
    scrollTo: () => undefined
  }

  vi.stubGlobal('Element', FakeElement)
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', window)
  vi.stubGlobal(
    'DOMParser',
    class {
      parseFromString(value: string) {
        return { body: { innerHTML: value }, title: value }
      }
    }
  )

  return {
    body,
    history,
    click(pathname: string) {
      const href = new URL(pathname, location).toString()
      const link = {
        href,
        origin: location.origin,
        target: '',
        dataset: {},
        hasAttribute: () => false
      }
      const event = {
        defaultPrevented: false,
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        target: new FakeElement(link),
        preventDefault: () => undefined
      }
      return Promise.resolve(listeners.get('click')?.(event as unknown as Event))
    }
  }
}

function navigationResponse(pathname: string, body: string) {
  return {
    ok: true,
    url: `https://tokenboard.example.com${pathname}`,
    text: async () => body
  } as Response
}

class FakeElement {
  constructor(private readonly link: unknown) {}

  closest() {
    return this.link
  }
}

class FakeBody {
  innerHTML = ''
  private readonly attributes = new Map<string, string>()

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  removeAttribute(name: string) {
    this.attributes.delete(name)
  }

  hasAttribute(name: string) {
    return this.attributes.has(name)
  }
}

class FakePanel extends FakeBody {
  outerHTML = ''
  readonly classList = {
    add: () => undefined,
    remove: () => undefined
  }
}
