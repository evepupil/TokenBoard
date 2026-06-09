type ListenerMap = Map<string, Array<(event: Record<string, unknown>) => void>>

export function installFakeDom() {
  const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>()
  const rafCallbacks: FrameRequestCallback[] = []
  const document = new FakeDocument(listeners)
  const bar = createTrendBar('2026-04-27', '120', '100')
  const otherBar = createTrendBar('2026-04-28', '80', '60')

  document.body.appendChild(bar)
  document.body.appendChild(otherBar)

  return {
    listeners,
    document,
    bar,
    otherBar,
    rafCallbacks,
    window: {
      innerWidth: 200,
      innerHeight: 180,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        rafCallbacks.push(callback)
        return rafCallbacks.length
      },
      cancelAnimationFrame: () => {}
    } as unknown as Window,
    flushAnimationFrame() {
      const callbacks = rafCallbacks.splice(0, rafCallbacks.length)
      for (const callback of callbacks) callback(0)
    },
    detach(element: FakeElement) {
      if (!element.parentElement) return
      const parent = element.parentElement
      const index = parent.children.indexOf(element)
      if (index >= 0) parent.children.splice(index, 1)
      element.parentElement = null
    }
  }
}

export function dispatch(listeners: ListenerMap, type: string, event: Record<string, unknown>) {
  for (const listener of listeners.get(type) ?? []) listener(event)
}

export class FakeElement {
  readonly dataset: Record<string, string> = {}
  readonly style: Record<string, string> = {}
  readonly children: FakeElement[] = []
  readonly attributes = new Map<string, string>()
  parentElement: FakeElement | null = null
  className = ''
  id = ''
  rect = { left: 20, top: 30, width: 90, height: 36 }
  private value = ''

  constructor(readonly tagName: string) {}

  appendChild(child: FakeElement) {
    child.parentElement = this
    this.children.push(child)
    return child
  }

  closest<T extends FakeElement>(selector: string): T | null {
    let current: FakeElement | null = this
    while (current) {
      if (matchesSelector(current, selector)) return current as T
      current = current.parentElement
    }
    return null
  }

  getBoundingClientRect() {
    return this.rect as DOMRect
  }

  get isConnected() {
    let current: FakeElement | null = this
    while (current) {
      if (current.tagName === 'body') return true
      current = current.parentElement
    }
    return false
  }

  get textContent() {
    return this.value || this.children.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    this.value = value
    this.children.length = 0
  }

  get innerHTML() {
    return ''
  }

  set innerHTML(value: string) {
    if (value === '') {
      this.value = ''
      this.children.length = 0
    }
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  removeAttribute(name: string) {
    this.attributes.delete(name)
  }
}

class FakeDocument {
  body = new FakeElement('body')
  documentElement = new FakeElement('html')

  constructor(private readonly listeners: ListenerMap) {}

  addEventListener(type: string, handler: (event: Record<string, unknown>) => void) {
    const current = this.listeners.get(type) ?? []
    current.push(handler)
    this.listeners.set(type, current)
  }

  createElement(tagName: string) {
    return new FakeElement(tagName)
  }

  querySelector(selector: string) {
    return findFirstMatch(this.body, selector)
  }
}

function createTrendBar(date: string, total: string, withoutCacheRead: string) {
  const bar = new FakeElement('div')
  bar.dataset.dashboardTrendBar = 'true'
  bar.dataset.trendDate = date
  bar.dataset.trendTotal = total
  bar.dataset.trendWithoutCacheRead = withoutCacheRead
  bar.setAttribute('title', `${date}: ${total} total tokens, ${withoutCacheRead} 不含缓存读`)
  return bar
}

function findFirstMatch(root: FakeElement, selector: string): FakeElement | null {
  for (const child of root.children) {
    if (matchesSelector(child, selector)) return child
    const nested = findFirstMatch(child, selector)
    if (nested) return nested
  }
  return null
}

function matchesSelector(element: FakeElement, selector: string) {
  const dataAttributeMatch = selector.match(/^\[data-([a-z-]+)\]$/)
  if (!dataAttributeMatch) return false

  const datasetKey = dataAttributeMatch[1].replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())
  return datasetKey in element.dataset
}
