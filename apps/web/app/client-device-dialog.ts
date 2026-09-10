import { shouldEnhanceDeviceDetailsClick } from './features/device/device-details-client'

export function initDeviceDetailsDialogs() {
  if (typeof HTMLDialogElement === 'undefined') return
  let active: { controller: AbortController; nonce: number } | null = null
  let sequence = 0
  document.addEventListener('click', async (event) => {
    if (!(event.target instanceof Element)) return
    const openButton = event.target.closest<HTMLAnchorElement>('[data-device-details-open]')
    if (openButton) {
      if (!shouldEnhanceDeviceDetailsClick(event)) return
      event.preventDefault()
      const dialogId = openButton.dataset.deviceDetailsOpen
      const dialog = dialogId ? document.getElementById(dialogId) : null
      if (!(dialog instanceof HTMLDialogElement)) {
        window.location.href = openButton.href
        return
      }
      active?.controller.abort()
      const controller = new AbortController()
      const nonce = ++sequence
      active = { controller, nonce }
      dialog.setAttribute('aria-labelledby', 'device-details-dialog-title')
      dialog.innerHTML = renderLoading()
      if (!dialog.open) dialog.showModal()
      try {
        const response = await fetch(openButton.href, {
          headers: { 'x-tokenboard-fragment': 'device-details' },
          signal: controller.signal
        })
        if (response.status >= 500) throw new Error(`Failed to load device details: ${response.status}`)
        if (!active || active.nonce !== nonce || controller.signal.aborted) return
        const html = await response.text()
        if (!active || active.nonce !== nonce || controller.signal.aborted) return
        dialog.innerHTML = html
        active = null
      } catch (_) {
        if (controller.signal.aborted) return
        if (active?.nonce === nonce) active = null
        dialog.close()
        window.location.href = openButton.href
      }
      return
    }
    const closeButton = event.target.closest<HTMLButtonElement>('[data-device-details-close]')
    if (closeButton) {
      event.preventDefault()
      active?.controller.abort()
      active = null
      closeButton.closest<HTMLDialogElement>('[data-device-details-dialog]')?.close()
      return
    }
    if (event.target instanceof HTMLDialogElement && event.target.dataset.deviceDetailsDialog === 'true') {
      active?.controller.abort()
      active = null
      event.target.close()
    }
  })
  const abort = (event: Event) => {
    if (!(event.target instanceof HTMLDialogElement)) return
    if (event.target.dataset.deviceDetailsDialog !== 'true') return
    active?.controller.abort()
    active = null
  }
  document.addEventListener('cancel', abort, true)
  document.addEventListener('close', abort, true)
}

function renderLoading() {
  return `
    <header class="flex items-start justify-between gap-3 border-b border-[var(--app-border)] bg-[var(--app-panel)] p-4">
      <div class="min-w-0">
        <p id="device-details-dialog-title" class="text-base font-black text-[var(--app-text)]">设备详情</p>
        <p class="mt-1 text-sm font-bold text-[var(--app-muted)]">正在加载...</p>
      </div>
      <button type="button" class="inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--app-border)] bg-[var(--app-bg-soft)] text-[var(--app-muted)] transition hover:bg-[var(--app-hover)] hover:text-[var(--app-text)]" data-device-details-close="true" aria-label="关闭详情">x</button>
    </header>
    <div class="app-device-dialog-body bg-[var(--app-bg-soft)] p-4 text-sm font-bold text-[var(--app-muted)]">
      正在加载设备安装、凭证和最近操作。
    </div>`
}
