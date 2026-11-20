export function initPublicCardPreview() {
  if (document.documentElement.dataset.publicCardPreviewBound === 'true') return
  document.documentElement.dataset.publicCardPreviewBound = 'true'

  document.addEventListener('input', handlePublicCardPreviewEvent)
  document.addEventListener('change', handlePublicCardPreviewEvent)
  refreshPublicCardPreview()
}

// Every refresh takes a generation number. Only the newest request may touch the
// image or the status line: an older request that resolves after a newer one —
// a slow failure landing after a fast success — would otherwise repaint a stale
// error beside the fresh render, or worse, overwrite the new image with old SVG.
// The debounce only prevents *starting* a new timer; it cannot cancel a request
// already in flight.
let publicCardPreviewGeneration = 0

export async function refreshPublicCardPreview() {
  const editor = document.querySelector<HTMLElement>('[data-public-card-config]')
  const image = editor?.querySelector<HTMLImageElement>('[data-public-card-preview]')
  const form = editor?.closest<HTMLFormElement>('form')
  if (!editor || !image || !form) return
  const status = editor.querySelector<HTMLElement>('[data-public-card-preview-status]')

  const payload = readPublicCardPreviewPayload(form, image)
  const generation = ++publicCardPreviewGeneration

  try {
    const response = await fetch('/api/v1/public-card/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (generation !== publicCardPreviewGeneration) return
    if (!response.ok) {
      // A rejected body (an over-long display name, a malformed field) or a server error
      // used to leave the image frozen at its last good render, so the editor looked
      // correct while the preview was stale. Say so instead of swallowing it.
      const message = await previewFailureMessage(response)
      if (generation !== publicCardPreviewGeneration) return
      showPreviewStatus(status, message)
      return
    }

    const svg = await response.text()
    if (generation !== publicCardPreviewGeneration) return
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    showPreviewStatus(status, null)
  } catch (_) {
    // A dropped connection is the same failure to the person typing: the preview is stale.
    if (generation !== publicCardPreviewGeneration) return
    showPreviewStatus(status, '预览暂时不可用，请稍后重试。')
  }
}

async function previewFailureMessage(response: Response) {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } }
    const message = typeof body?.error?.message === 'string' ? body.error.message.trim() : ''
    if (message) return `预览未更新：${message}`
  } catch (_) {
    // A non-JSON error body (a proxy page, an HTML 500) falls through to the status line.
  }
  return `预览未更新（HTTP ${response.status}）。`
}

function showPreviewStatus(element: HTMLElement | null, message: string | null) {
  if (!element) return
  // Reveal before writing: a `role="status"` region that is display:none (the
  // hidden attribute) is outside the accessibility tree, so content written
  // while hidden is never announced. Clearing still happens first, because a
  // success should hide the line as well as empty it.
  if (message === null) {
    element.textContent = ''
    element.hidden = true
    return
  }
  element.hidden = false
  if (element.textContent === message) {
    // Re-writing identical text is not a mutation a live region announces; the
    // element is already visible with this message, so there is nothing to do.
    return
  }
  element.textContent = message
}

function handlePublicCardPreviewEvent(event: Event) {
  if (!(event.target instanceof Element)) return
  const form = event.target.closest<HTMLFormElement>('[data-public-card-form]')
  if (!form?.querySelector('[data-public-card-config]')) return
  schedulePublicCardPreview()
}

let publicCardPreviewTimer: number | undefined

function schedulePublicCardPreview() {
  window.clearTimeout(publicCardPreviewTimer)
  publicCardPreviewTimer = window.setTimeout(refreshPublicCardPreview, 180)
}

function readPublicCardPreviewPayload(form: HTMLFormElement, image: HTMLImageElement) {
  const formData = new FormData(form)

  return {
    config: {
      language: String(formData.get('cardLanguage') || 'zh'),
      theme: String(formData.get('cardTheme') || 'dark'),
      layout: String(formData.get('cardLayout') || 'balanced'),
      title: String(formData.get('cardTitle') || ''),
      subtitle: String(formData.get('cardSubtitle') || ''),
      showPublicUrl: formData.get('cardShowPublicUrl') === 'on',
      glow: {
        enabled: formData.get('cardGlowEnabled') === 'on',
        intensity: Number(formData.get('cardGlowIntensity') || 0.28),
        position: String(formData.get('cardGlowPosition') || 'top-right')
      },
      metrics: readPublicCardMetricSlots(form)
    },
    displayName: String(formData.get('displayName') || 'TokenBoard'),
    publicUrl: image.dataset.publicCardPublicUrl || 'Private preview'
  }
}

function readPublicCardMetricSlots(form: HTMLFormElement) {
  const metrics: string[] = []
  form.querySelectorAll<HTMLInputElement>('[data-card-metric-slot]').forEach((element) => {
    const value = element.value
    if (value && !metrics.includes(value)) metrics.push(value)
  })
  return metrics
}
