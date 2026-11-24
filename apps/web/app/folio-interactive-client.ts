import {
  computeFolioMatrixLayout,
  isFolioMatrixMode,
  type FolioMatrixLayout,
  type FolioMatrixMode,
  type FolioMatrixTone
} from './lib/folio-matrix-layout'

const SVG_NS = 'http://www.w3.org/2000/svg'

const TONE_FILL_VAR: Record<FolioMatrixTone, string> = {
  muted: 'var(--app-muted)',
  violet: 'var(--app-viz-2)',
  vermilion: 'var(--app-viz-1)',
  magenta: 'var(--app-viz-3)',
  ink: 'var(--app-viz-4)',
  neutral: 'var(--app-viz-neutral)'
}

let activeMatrixHighlightRoot: Element | null = null

export function initFolioTabs() {
  if (document.documentElement.dataset.folioTabsBound === 'true') return
  document.documentElement.dataset.folioTabsBound = 'true'

  hydrateInitialMatrices()
  initFolioHoverTooltip()

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return

    const matrixButton = event.target.closest<HTMLButtonElement>('[data-folio-matrix-button]')
    if (matrixButton) {
      const mode = matrixButton.dataset.folioMatrixButton
      const groupName = matrixButton.dataset.folioMatrixGroup
      if (mode && groupName && isFolioMatrixMode(mode)) {
        switchFolioMatrixMode(groupName, mode)
      }
      return
    }

    const button = event.target.closest<HTMLButtonElement>('[data-folio-tab-button]')
    if (!button) return

    const groupName = button.dataset.folioTabGroup
    const targetValue = button.dataset.folioTabValue
    if (!groupName || !targetValue) return

    document
      .querySelectorAll<HTMLButtonElement>(`[data-folio-tab-button][data-folio-tab-group="${groupName}"]`)
      .forEach((candidate) => {
        const active = candidate.dataset.folioTabValue === targetValue
        candidate.setAttribute('aria-pressed', active ? 'true' : 'false')
      })

    document
      .querySelectorAll<HTMLElement>(`[data-folio-tab-panel][data-folio-tab-group="${groupName}"]`)
      .forEach((panel) => {
        const active = panel.dataset.folioTabPanel === targetValue
        panel.hidden = !active
      })
  })
}

function hydrateInitialMatrices() {
  document.querySelectorAll<HTMLElement>('[data-folio-matrix-root]').forEach((root) => {
    const modeAttr = root.dataset.matrixMode ?? 'all'
    const mode: FolioMatrixMode = isFolioMatrixMode(modeAttr) ? modeAttr : 'all'
    const layout = computeFolioMatrixLayout(mode)
    applyMatrixLayout(root, layout, false)
  })
}

function switchFolioMatrixMode(groupName: string, mode: FolioMatrixMode) {
  document
    .querySelectorAll<HTMLButtonElement>(`[data-folio-matrix-button][data-folio-matrix-group="${groupName}"]`)
    .forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.dataset.folioMatrixButton === mode ? 'true' : 'false')
    })

  const root = document.querySelector<HTMLElement>(`[data-folio-matrix-root]`)
  if (!root) return

  clearMatrixGroupHighlight(root)
  hideFolioTooltip()
  root.dataset.matrixMode = mode
  const layout = computeFolioMatrixLayout(mode)
  applyMatrixLayout(root, layout, true)
}

function applyMatrixLayout(root: HTMLElement, layout: FolioMatrixLayout, animate: boolean) {
  const svg = root.querySelector<SVGSVGElement>('[data-folio-matrix-svg]')
  const labelsLayer = root.querySelector<SVGGElement>('[data-matrix-labels]')
  const squaresLayer = root.querySelector<SVGGElement>('[data-matrix-squares]')
  const hitsLayer = root.querySelector<SVGGElement>('[data-matrix-hits]')
  if (!svg || !labelsLayer || !squaresLayer || !hitsLayer) return

  svg.setAttribute('viewBox', `0 0 ${layout.viewBoxWidth} ${layout.viewBoxHeight}`)
  const rects = Array.from(squaresLayer.querySelectorAll<SVGRectElement>('[data-matrix-sq]'))
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  rects.forEach((rect, idx) => {
    const sq = layout.squares[idx]
    if (!sq) return
    // Clear SSR SVG transform attribute so CSS transform smoothly interpolates in GPU compositor
    if (rect.hasAttribute('transform')) {
      rect.removeAttribute('transform')
    }
    rect.setAttribute('width', String(layout.cellSize))
    rect.setAttribute('height', String(layout.cellSize))
    rect.dataset.matrixGroupId = sq.groupId
    rect.style.fill = TONE_FILL_VAR[sq.tone]
    rect.style.transitionDelay = animate && !reducedMotion ? `${sq.staggerMs}ms` : '0ms'
    rect.style.transform = `translate3d(${sq.x}px, ${sq.y}px, 0)`
  })

  // Rebuild group headings cleanly with gentle CSS fade-in (no persistent inline opacity so dimming works)
  labelsLayer.innerHTML = ''
  layout.groups.forEach((group) => {
    if (!group.headingText) return
    const text = document.createElementNS(SVG_NS, 'text')
    text.setAttribute('x', String(group.headingX))
    text.setAttribute('y', String(group.headingY))
    text.setAttribute(
      'class',
      animate && !reducedMotion ? 'app-matrix-group-label is-entering' : 'app-matrix-group-label'
    )
    text.dataset.matrixGroupId = group.id
    text.textContent = group.headingText
    labelsLayer.appendChild(text)
  })

  // Rebuild interactive hit regions for hover + keyboard focus tooltips
  hitsLayer.innerHTML = ''
  layout.groups.forEach((group) => {
    const hit = document.createElementNS(SVG_NS, 'rect')
    hit.setAttribute('x', String(group.hitX))
    hit.setAttribute('y', String(group.hitY))
    hit.setAttribute('width', String(group.hitWidth))
    hit.setAttribute('height', String(group.hitHeight))
    hit.setAttribute('fill', 'transparent')
    hit.setAttribute('class', 'app-matrix-hit')
    hit.setAttribute('tabindex', '0')
    hit.setAttribute('role', 'img')
    hit.setAttribute('aria-label', `${group.label}: ${group.tokensLabel}，占比 ${group.percentLabel}`)
    hit.dataset.matrixHit = 'true'
    hit.dataset.matrixGroupId = group.id
    hit.dataset.folioTooltipTarget = 'true'
    hit.dataset.folioTooltipCat = group.categoryLabel
    hit.dataset.folioTooltipVal = group.label
    hit.dataset.folioTooltipSub = `${
      group.tokensLabel.includes('Tokens') ? group.tokensLabel : `${group.tokensLabel} Tokens`
    } · 占比 ${group.percentLabel}`
    hitsLayer.appendChild(hit)
  })
}

function setMatrixGroupHighlight(root: Element, groupId: string) {
  activeMatrixHighlightRoot = root
  root.setAttribute('data-matrix-hovering', 'true')
  root.querySelectorAll<SVGElement>('[data-matrix-sq], .app-matrix-group-label').forEach((el) => {
    const matches = el.dataset.matrixGroupId === groupId
    el.setAttribute('data-matrix-dimmed', matches ? 'false' : 'true')
  })
}

function clearMatrixGroupHighlight(root: Element | null) {
  const target = root ?? activeMatrixHighlightRoot
  if (!target) return
  target.removeAttribute('data-matrix-hovering')
  target.querySelectorAll<SVGElement>('[data-matrix-dimmed]').forEach((el) => {
    el.removeAttribute('data-matrix-dimmed')
  })
  if (target === activeMatrixHighlightRoot) activeMatrixHighlightRoot = null
}

function initFolioHoverTooltip() {
  let activeTarget: Element | null = null

  document.addEventListener('pointermove', (event) => {
    if (!(event.target instanceof Element)) return
    const target = event.target.closest('[data-folio-tooltip-target]')
    if (!target) {
      if (activeTarget) {
        activeTarget = null
        clearMatrixGroupHighlight(null)
        hideFolioTooltip()
      }
      return
    }

    if (activeTarget !== target) {
      activeTarget = target
      const matrixRoot = target.closest('[data-folio-matrix-root]')
      const groupId = target.getAttribute('data-matrix-group-id')
      if (matrixRoot && groupId && matrixRoot.getAttribute('data-matrix-mode') !== 'all') {
        setMatrixGroupHighlight(matrixRoot, groupId)
      } else {
        clearMatrixGroupHighlight(null)
      }
    }

    showFolioTooltip(target, event.clientX, event.clientY)
  })

  document.addEventListener('pointerout', (event) => {
    if (!(event.target instanceof Element)) return
    const leftTarget = event.target.closest('[data-folio-tooltip-target]')
    if (!leftTarget) return
    if (event.relatedTarget instanceof Element && event.relatedTarget.closest('[data-folio-tooltip-target]')) return
    activeTarget = null
    clearMatrixGroupHighlight(null)
    hideFolioTooltip()
  })

  document.addEventListener('focusin', (event) => {
    if (!(event.target instanceof Element)) return
    const target = event.target.closest('[data-folio-tooltip-target]')
    if (!target) return
    activeTarget = target
    const matrixRoot = target.closest('[data-folio-matrix-root]')
    const groupId = target.getAttribute('data-matrix-group-id')
    if (matrixRoot && groupId && matrixRoot.getAttribute('data-matrix-mode') !== 'all') {
      setMatrixGroupHighlight(matrixRoot, groupId)
    }
    const rect = target.getBoundingClientRect()
    showFolioTooltip(target, rect.left + rect.width * 0.5, rect.top + rect.height * 0.35)
  })

  document.addEventListener('focusout', (event) => {
    if (!(event.target instanceof Element)) return
    if (!event.target.closest('[data-folio-tooltip-target]')) return
    activeTarget = null
    clearMatrixGroupHighlight(null)
    hideFolioTooltip()
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      activeTarget = null
      clearMatrixGroupHighlight(null)
      hideFolioTooltip()
    }
  })

  document.addEventListener(
    'scroll',
    () => {
      if (activeTarget) {
        activeTarget = null
        clearMatrixGroupHighlight(null)
        hideFolioTooltip()
      }
    },
    true
  )
}

function getFolioTooltip(): HTMLDivElement {
  let el = document.querySelector<HTMLDivElement>('[data-folio-floating-tooltip]')
  if (el) return el

  el = document.createElement('div')
  el.className = 'app-folio-tooltip'
  el.setAttribute('role', 'tooltip')
  el.setAttribute('aria-hidden', 'true')
  el.dataset.folioFloatingTooltip = 'true'
  el.dataset.visible = 'false'

  const cat = document.createElement('div')
  cat.className = 'app-folio-tooltip-cat'
  const val = document.createElement('div')
  val.className = 'app-folio-tooltip-val'
  const sub = document.createElement('div')
  sub.className = 'app-folio-tooltip-sub'
  el.appendChild(cat)
  el.appendChild(val)
  el.appendChild(sub)
  document.body.appendChild(el)
  return el
}

function showFolioTooltip(target: Element, clientX: number, clientY: number) {
  const catText = target.getAttribute('data-folio-tooltip-cat') ?? ''
  const valText = target.getAttribute('data-folio-tooltip-val') ?? ''
  const subText = target.getAttribute('data-folio-tooltip-sub') ?? ''
  if (!valText) return

  const tooltip = getFolioTooltip()
  const children = tooltip.children
  if (children[0]) children[0].textContent = catText
  if (children[1]) children[1].textContent = valText
  if (children[2]) children[2].textContent = subText

  tooltip.dataset.visible = 'true'
  tooltip.setAttribute('aria-hidden', 'false')

  const rect = tooltip.getBoundingClientRect()
  const offset = 16
  const vw = window.innerWidth
  const vh = window.innerHeight
  let x = clientX + offset
  let y = clientY - rect.height * 0.5
  if (x + rect.width + offset > vw) {
    x = Math.max(offset, clientX - rect.width - offset)
  }
  if (y < offset) y = offset
  if (y + rect.height + offset > vh) {
    y = Math.max(offset, vh - rect.height - offset)
  }

  tooltip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`
}

function hideFolioTooltip() {
  const tooltip = document.querySelector<HTMLDivElement>('[data-folio-floating-tooltip]')
  if (!tooltip) return
  tooltip.dataset.visible = 'false'
  tooltip.setAttribute('aria-hidden', 'true')
}
