const dashboardTrendBarSelector = '[data-dashboard-trend-bar]'
const dashboardTrendTooltipSelector = '[data-dashboard-trend-tooltip]'
const dashboardTrendTooltipId = 'dashboard-trend-tooltip'
let dashboardTrendTooltipFrame = 0
let dashboardTrendTooltipAnchor: HTMLElement | null = null
let dashboardTrendTooltipActiveBar: HTMLElement | null = null
let dashboardTrendPointerFocusTarget: HTMLElement | null = null
let pendingDashboardTrendPointerState:
  | {
      bar: HTMLElement | null
      clientX: number
      clientY: number
    }
  | null = null

export function initDashboardTrendTooltip() {
  document.addEventListener('pointerdown', handleDashboardTrendPointerDown)
  document.addEventListener('pointerup', clearDashboardTrendPointerFocusTarget)
  document.addEventListener('pointercancel', clearDashboardTrendPointerFocusTarget)
  document.addEventListener('pointermove', handleDashboardTrendPointerMove)
  document.addEventListener('pointerout', handleDashboardTrendPointerOut)
  document.addEventListener('focusin', handleDashboardTrendFocusIn)
  document.addEventListener('focusout', handleDashboardTrendFocusOut)
  document.addEventListener('scroll', hideDashboardTrendTooltip, true)
  document.addEventListener('keydown', handleDashboardTrendKeydown)
}

export function showDashboardTrendTooltip(bar: HTMLElement, clientX: number, clientY: number) {
  const tooltip = getDashboardTrendTooltip()
  const date = bar.dataset.trendDate ?? '-'
  const total = bar.dataset.trendTotal ?? '0'
  const withoutCacheRead = bar.dataset.trendWithoutCacheRead ?? '0'

  syncDashboardTrendTooltipBar(bar)
  tooltip.innerHTML = ''
  tooltip.appendChild(tooltipLine('日期', date))
  tooltip.appendChild(tooltipLine('Total tokens', total))
  tooltip.appendChild(tooltipLine('不含缓存读', withoutCacheRead))
  tooltip.dataset.visible = 'true'
  tooltip.setAttribute('aria-hidden', 'false')

  const tooltipRect = tooltip.getBoundingClientRect()
  const position = getDashboardTrendTooltipPosition({
    clientX,
    clientY,
    tooltipWidth: tooltipRect.width,
    tooltipHeight: tooltipRect.height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight
  })

  tooltip.style.left = `${position.left}px`
  tooltip.style.top = `${position.top}px`
}

export function hideDashboardTrendTooltip() {
  pendingDashboardTrendPointerState = null
  if (dashboardTrendTooltipActiveBar) {
    restoreDashboardTrendBarTitle(dashboardTrendTooltipActiveBar)
    dashboardTrendTooltipActiveBar.removeAttribute('aria-describedby')
    dashboardTrendTooltipActiveBar = null
  }
  const tooltip = document.querySelector<HTMLElement>(dashboardTrendTooltipSelector)
  if (!tooltip) return

  tooltip.dataset.visible = 'false'
  tooltip.setAttribute('aria-hidden', 'true')
}

export function resetDashboardTrendTooltip() {
  dashboardTrendPointerFocusTarget = null
  dashboardTrendTooltipAnchor = null
  hideDashboardTrendTooltip()
}

export function getDashboardTrendTooltipPosition(props: {
  clientX: number
  clientY: number
  tooltipWidth: number
  tooltipHeight: number
  viewportWidth: number
  viewportHeight: number
}) {
  const offset = 14
  const left = Math.min(
    props.clientX + offset,
    props.viewportWidth - props.tooltipWidth - offset
  )
  const top = Math.min(
    props.clientY + offset,
    props.viewportHeight - props.tooltipHeight - offset
  )

  return {
    left: Math.max(offset, left),
    top: Math.max(offset, top)
  }
}

function handleDashboardTrendPointerMove(event: PointerEvent) {
  const bar = getDashboardTrendBar(event.target)
  pendingDashboardTrendPointerState = {
    bar,
    clientX: event.clientX,
    clientY: event.clientY
  }
  if (dashboardTrendTooltipFrame) return

  dashboardTrendTooltipFrame = window.requestAnimationFrame(() => {
    dashboardTrendTooltipFrame = 0
    if (!pendingDashboardTrendPointerState) return

    if (!pendingDashboardTrendPointerState.bar) {
      if (showFocusedDashboardTrendTooltip()) return
      hideDashboardTrendTooltip()
      return
    }

    showDashboardTrendTooltip(
      pendingDashboardTrendPointerState.bar,
      pendingDashboardTrendPointerState.clientX,
      pendingDashboardTrendPointerState.clientY
    )
  })
}

function handleDashboardTrendPointerDown(event: PointerEvent) {
  dashboardTrendPointerFocusTarget = getDashboardTrendBar(event.target)
}

function handleDashboardTrendPointerOut(event: PointerEvent) {
  if (!isElement(event.target)) return
  if (event.relatedTarget instanceof Element && event.relatedTarget.closest(dashboardTrendBarSelector)) return

  pendingDashboardTrendPointerState = null
  if (showFocusedDashboardTrendTooltip()) return
  hideDashboardTrendTooltip()
}

function handleDashboardTrendFocusIn(event: FocusEvent) {
  const bar = getDashboardTrendBar(event.target)
  if (!bar) return
  if (dashboardTrendPointerFocusTarget === bar) return

  dashboardTrendTooltipAnchor = bar

  const rect = bar.getBoundingClientRect()
  showDashboardTrendTooltip(bar, rect.left + rect.width / 2, rect.top)
}

function handleDashboardTrendFocusOut(event: FocusEvent) {
  const currentBar = getDashboardTrendBar(event.target)
  if (dashboardTrendTooltipAnchor && dashboardTrendTooltipAnchor === currentBar) {
    dashboardTrendTooltipAnchor = null
  }
  if (event.relatedTarget instanceof Element && event.relatedTarget.closest(dashboardTrendBarSelector)) return
  if (pendingDashboardTrendPointerState?.bar) return

  hideDashboardTrendTooltip()
}

function handleDashboardTrendKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') resetDashboardTrendTooltip()
}

function clearDashboardTrendPointerFocusTarget() {
  dashboardTrendPointerFocusTarget = null
}

function getDashboardTrendBar(target: EventTarget | null) {
  if (!isElement(target)) return null
  return target.closest<HTMLElement>(dashboardTrendBarSelector)
}

function showFocusedDashboardTrendTooltip() {
  if (!dashboardTrendTooltipAnchor) return false
  if (!dashboardTrendTooltipAnchor.isConnected) {
    dashboardTrendTooltipAnchor = null
    return false
  }

  const rect = dashboardTrendTooltipAnchor.getBoundingClientRect()
  showDashboardTrendTooltip(
    dashboardTrendTooltipAnchor,
    rect.left + rect.width / 2,
    rect.top
  )
  return true
}

function syncDashboardTrendTooltipBar(bar: HTMLElement) {
  if (dashboardTrendTooltipActiveBar && dashboardTrendTooltipActiveBar !== bar) {
    restoreDashboardTrendBarTitle(dashboardTrendTooltipActiveBar)
    dashboardTrendTooltipActiveBar.removeAttribute('aria-describedby')
  }

  dashboardTrendTooltipActiveBar = bar
  suppressDashboardTrendBarTitle(bar)
  bar.setAttribute('aria-describedby', dashboardTrendTooltipId)
}

function suppressDashboardTrendBarTitle(bar: HTMLElement) {
  const title = bar.getAttribute('title')
  if (!title) return

  bar.dataset.trendTitle = title
  bar.removeAttribute('title')
}

function restoreDashboardTrendBarTitle(bar: HTMLElement) {
  const title = bar.dataset.trendTitle
  if (!title) return

  bar.setAttribute('title', title)
  delete bar.dataset.trendTitle
}

function getDashboardTrendTooltip() {
  const existing = document.querySelector<HTMLDivElement>(dashboardTrendTooltipSelector)
  if (existing) return existing

  const tooltip = document.createElement('div')
  tooltip.className = 'app-chart-tooltip'
  tooltip.id = dashboardTrendTooltipId
  tooltip.dataset.dashboardTrendTooltip = 'true'
  tooltip.dataset.visible = 'false'
  tooltip.setAttribute('role', 'tooltip')
  tooltip.setAttribute('aria-hidden', 'true')
  document.body.appendChild(tooltip)
  return tooltip
}

function tooltipLine(label: string, value: string) {
  const line = document.createElement('div')
  line.className = 'app-chart-tooltip-line'

  const labelElement = document.createElement('span')
  labelElement.className = 'app-chart-tooltip-label'
  labelElement.textContent = label

  const valueElement = document.createElement('span')
  valueElement.className = 'app-chart-tooltip-value'
  valueElement.textContent = value

  line.appendChild(labelElement)
  line.appendChild(valueElement)
  return line
}

function isElement(value: EventTarget | null): value is Element {
  return value instanceof Element
}
