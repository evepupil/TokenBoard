import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  getDashboardTrendTooltipPosition,
  initDashboardTrendTooltip,
  resetDashboardTrendTooltip
} from './dashboard-trend-tooltip'
import { dispatch, FakeElement, installFakeDom } from './dashboard-trend-tooltip.test-support'

describe('dashboard trend tooltip', () => {
  afterEach(() => {
    if ('document' in globalThis) resetDashboardTrendTooltip()
    vi.unstubAllGlobals()
  })

  test('shows clamped tooltip content for pointer interactions and hides on escape', () => {
    const dom = setupTooltipDom()

    dispatch(dom.listeners, 'pointermove', {
      target: dom.bar,
      clientX: 190,
      clientY: 170
    })
    dom.flushAnimationFrame()

    const tooltip = dom.document.querySelector('[data-dashboard-trend-tooltip]')
    expect(tooltip?.dataset.visible).toBe('true')
    expect(tooltip?.getAttribute('aria-hidden')).toBe('false')
    expect(tooltip?.id).toBe('dashboard-trend-tooltip')
    expect(dom.bar.getAttribute('title')).toBeNull()
    expect(tooltip?.style.left).toBe('96px')
    expect(tooltip?.style.top).toBe('130px')
    expect(tooltip?.children.map((line) => line.textContent)).toEqual([
      '日期2026-04-27',
      'Total tokens120',
      '不含缓存读100'
    ])

    dispatch(dom.listeners, 'keydown', { key: 'Escape' })

    expect(tooltip?.dataset.visible).toBe('false')
    expect(tooltip?.getAttribute('aria-hidden')).toBe('true')
  })

  test('shows tooltip on focus and keeps it visible while focus moves between bars', () => {
    const dom = setupTooltipDom()

    dispatch(dom.listeners, 'focusin', { target: dom.bar })

    const tooltip = dom.document.querySelector('[data-dashboard-trend-tooltip]')
    expect(tooltip?.dataset.visible).toBe('true')
    expect(tooltip?.style.left).toBe('79px')
    expect(tooltip?.style.top).toBe('44px')
    expect(dom.bar.getAttribute('aria-describedby')).toBe('dashboard-trend-tooltip')

    dispatch(dom.listeners, 'focusout', {
      target: dom.bar,
      relatedTarget: dom.otherBar
    })
    dispatch(dom.listeners, 'focusin', { target: dom.otherBar })

    expect(tooltip?.dataset.visible).toBe('true')
    expect(dom.bar.getAttribute('aria-describedby')).toBeNull()
    expect(dom.otherBar.getAttribute('aria-describedby')).toBe('dashboard-trend-tooltip')

    dispatch(dom.listeners, 'focusout', {
      target: dom.otherBar,
      relatedTarget: null
    })

    expect(tooltip?.dataset.visible).toBe('false')
  })

  test('preserves the focused tooltip when the pointer moves outside the chart', () => {
    const dom = setupTooltipDom()

    dispatch(dom.listeners, 'focusin', { target: dom.bar })
    dispatch(dom.listeners, 'pointermove', {
      target: dom.document.body,
      clientX: 4,
      clientY: 8
    })
    dom.flushAnimationFrame()

    const tooltip = dom.document.querySelector('[data-dashboard-trend-tooltip]')
    expect(tooltip?.dataset.visible).toBe('true')
    expect(tooltip?.style.left).toBe('79px')
    expect(tooltip?.style.top).toBe('44px')
    expect(dom.bar.getAttribute('aria-describedby')).toBe('dashboard-trend-tooltip')
  })

  test('restores the native title after pointer leave hides the custom tooltip', () => {
    const dom = setupTooltipDom()

    dispatch(dom.listeners, 'pointermove', {
      target: dom.bar,
      clientX: 190,
      clientY: 170
    })
    dom.flushAnimationFrame()

    expect(dom.bar.getAttribute('title')).toBeNull()

    dispatch(dom.listeners, 'pointerout', {
      target: dom.bar,
      relatedTarget: dom.document.body
    })

    const tooltip = dom.document.querySelector('[data-dashboard-trend-tooltip]')
    expect(tooltip?.dataset.visible).toBe('false')
    expect(dom.bar.getAttribute('title')).toBe('2026-04-27: 120 total tokens, 100 不含缓存读')
  })

  test('moves aria-describedby to the hovered bar when pointer overrides focus', () => {
    const dom = setupTooltipDom()

    dispatch(dom.listeners, 'focusin', { target: dom.bar })
    dispatch(dom.listeners, 'pointermove', {
      target: dom.otherBar,
      clientX: 190,
      clientY: 170
    })
    dom.flushAnimationFrame()

    expect(dom.bar.getAttribute('aria-describedby')).toBeNull()
    expect(dom.otherBar.getAttribute('aria-describedby')).toBe('dashboard-trend-tooltip')
  })

  test('does not pin the tooltip after a pointer click focuses a bar', () => {
    const dom = setupTooltipDom()

    dispatch(dom.listeners, 'pointermove', {
      target: dom.bar,
      clientX: 190,
      clientY: 170
    })
    dom.flushAnimationFrame()

    dispatch(dom.listeners, 'pointerdown', { target: dom.bar })
    dispatch(dom.listeners, 'focusin', { target: dom.bar })
    dispatch(dom.listeners, 'pointerup', { target: dom.bar })
    dispatch(dom.listeners, 'pointerout', {
      target: dom.bar,
      relatedTarget: dom.document.body
    })

    const tooltip = dom.document.querySelector('[data-dashboard-trend-tooltip]')
    expect(tooltip?.dataset.visible).toBe('false')
    expect(dom.bar.getAttribute('aria-describedby')).toBeNull()
  })

  test('preserves the focused anchor across scroll so the tooltip can return', () => {
    const dom = setupTooltipDom()

    dispatch(dom.listeners, 'focusin', { target: dom.bar })
    dispatch(dom.listeners, 'scroll', { target: dom.document.body })

    let tooltip = dom.document.querySelector('[data-dashboard-trend-tooltip]')
    expect(tooltip?.dataset.visible).toBe('false')

    dispatch(dom.listeners, 'pointermove', {
      target: dom.document.body,
      clientX: 4,
      clientY: 8
    })
    dom.flushAnimationFrame()

    tooltip = dom.document.querySelector('[data-dashboard-trend-tooltip]')
    expect(tooltip?.dataset.visible).toBe('true')
    expect(dom.bar.getAttribute('aria-describedby')).toBe('dashboard-trend-tooltip')
  })

  test('coalesces pointermove updates into one animation frame', () => {
    const dom = setupTooltipDom()

    dispatch(dom.listeners, 'pointermove', {
      target: dom.bar,
      clientX: 10,
      clientY: 20
    })
    dispatch(dom.listeners, 'pointermove', {
      target: dom.bar,
      clientX: 190,
      clientY: 170
    })

    expect(dom.rafCallbacks).toHaveLength(1)

    dom.flushAnimationFrame()

    const tooltip = dom.document.querySelector('[data-dashboard-trend-tooltip]')
    expect(tooltip?.style.left).toBe('96px')
    expect(tooltip?.style.top).toBe('130px')
  })

  test('does not reuse a detached focused bar after page content is replaced', () => {
    const dom = setupTooltipDom()

    dispatch(dom.listeners, 'focusin', { target: dom.bar })
    dom.detach(dom.bar)

    dispatch(dom.listeners, 'pointermove', {
      target: dom.document.body,
      clientX: 12,
      clientY: 16
    })
    dom.flushAnimationFrame()

    const tooltip = dom.document.querySelector('[data-dashboard-trend-tooltip]')
    expect(tooltip?.dataset.visible).toBe('false')
    expect(dom.bar.getAttribute('aria-describedby')).toBeNull()
  })

  test('reset clears the cached anchor and hides the tooltip before body swaps', () => {
    const dom = setupTooltipDom()

    dispatch(dom.listeners, 'focusin', { target: dom.bar })
    resetDashboardTrendTooltip()

    const tooltip = dom.document.querySelector('[data-dashboard-trend-tooltip]')
    expect(tooltip?.dataset.visible).toBe('false')
    expect(tooltip?.getAttribute('aria-hidden')).toBe('true')
    expect(dom.bar.getAttribute('aria-describedby')).toBeNull()
  })

  test('reset clears pointer-driven focus state before the next keyboard focus', () => {
    const dom = setupTooltipDom()

    dispatch(dom.listeners, 'pointerdown', { target: dom.bar })
    resetDashboardTrendTooltip()
    dispatch(dom.listeners, 'focusin', { target: dom.bar })

    const tooltip = dom.document.querySelector('[data-dashboard-trend-tooltip]')
    expect(tooltip?.dataset.visible).toBe('true')
    expect(dom.bar.getAttribute('aria-describedby')).toBe('dashboard-trend-tooltip')
  })

  test('calculates tooltip positions inside the viewport bounds', () => {
    expect(getDashboardTrendTooltipPosition({
      clientX: 8,
      clientY: 6,
      tooltipWidth: 90,
      tooltipHeight: 36,
      viewportWidth: 200,
      viewportHeight: 180
    })).toEqual({
      left: 22,
      top: 20
    })
  })
})

function setupTooltipDom() {
  const dom = installFakeDom()
  vi.stubGlobal('Element', FakeElement)
  vi.stubGlobal('document', dom.document as unknown as Document)
  vi.stubGlobal('window', dom.window)
  initDashboardTrendTooltip()
  return dom
}
