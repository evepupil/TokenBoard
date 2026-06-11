import { describe, expect, test } from 'vitest'
import { syncCurrentTheme, syncThemeMeta } from './theme-client'

describe('theme client', () => {
  test('syncs browser chrome and color scheme meta for the active theme', () => {
    const dom = createMetaDocument()

    syncThemeMeta('light', dom.document)

    expect(dom.metas['theme-color'].getAttribute('content')).toBe('#f4f0e8')
    expect(dom.metas['color-scheme'].getAttribute('content')).toBe('only light')

    syncThemeMeta('dark', dom.document)

    expect(dom.metas['theme-color'].getAttribute('content')).toBe('#10130f')
    expect(dom.metas['color-scheme'].getAttribute('content')).toBe('dark')
  })

  test('does not fail when theme meta tags are absent', () => {
    const documentWithoutMetas = {
      documentElement: {
        classList: { toggle: () => undefined },
        dataset: { theme: 'dark' },
        style: {}
      },
      querySelector: () => null
    } as unknown as Document

    expect(() => syncThemeMeta('dark', documentWithoutMetas)).not.toThrow()
  })

  test('syncs current document theme to buttons inserted by client navigation', () => {
    const dom = createMetaDocument()
    const button = new FakeMetaElement()
    const targetDocument = {
      ...dom.document,
      documentElement: {
        classList: { toggle: () => undefined },
        dataset: { theme: 'light' },
        style: {} as Record<string, string>
      },
      querySelectorAll(selector: string) {
        return selector === '[data-theme-toggle]' ? [button] : []
      }
    } as unknown as Document

    syncCurrentTheme(targetDocument)

    expect(button.getAttribute('aria-label')).toBe('切换到深色主题')
    expect(button.getAttribute('title')).toBe('切换到深色主题')
    expect(dom.metas['theme-color'].getAttribute('content')).toBe('#f4f0e8')
    expect(dom.metas['color-scheme'].getAttribute('content')).toBe('only light')
  })
})

function createMetaDocument() {
  const metas = {
    'theme-color': new FakeMetaElement(),
    'color-scheme': new FakeMetaElement()
  }

  return {
    metas,
    document: {
      querySelector(selector: string) {
        if (selector === 'meta[name="theme-color"]') return metas['theme-color']
        if (selector === 'meta[name="color-scheme"]') return metas['color-scheme']
        return null
      }
    } as unknown as Document
  }
}

class FakeMetaElement {
  private readonly attributes = new Map<string, string>()

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null
  }
}
