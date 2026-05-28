export function initPublicCardPreview() {
  if (document.documentElement.dataset.publicCardPreviewBound === 'true') return
  document.documentElement.dataset.publicCardPreviewBound = 'true'

  document.addEventListener('input', handlePublicCardPreviewEvent)
  document.addEventListener('change', handlePublicCardPreviewEvent)
  refreshPublicCardPreview()
}

export async function refreshPublicCardPreview() {
  const editor = document.querySelector<HTMLElement>('[data-public-card-config]')
  const image = editor?.querySelector<HTMLImageElement>('[data-public-card-preview]')
  const form = editor?.closest<HTMLFormElement>('form')
  if (!editor || !image || !form) return

  const payload = readPublicCardPreviewPayload(form, image)

  try {
    const response = await fetch('/api/v1/public-card/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (!response.ok) return

    const svg = await response.text()
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  } catch (_) {
  }
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
