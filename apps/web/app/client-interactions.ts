import { copyTextToClipboard } from './lib/clipboard'

type ToastTone = 'success' | 'error'

export function initCopyButtons() {
  document.addEventListener('click', async (event) => {
    if (!(event.target instanceof Element)) return
    const button = event.target.closest<HTMLButtonElement>('[data-copy-target]')
    if (!button) return
    const targetId = button.dataset.copyTarget
    const text = targetId ? document.getElementById(targetId)?.textContent : null
    if (!text) return
    event.preventDefault()
    const originalLabel = button.getAttribute('aria-label') || '复制'
    const originalTitle = button.getAttribute('title') || originalLabel
    const copied = await copyTextToClipboard(navigator.clipboard, text)
    button.dataset.copied = copied ? 'true' : 'false'
    button.setAttribute('aria-label', copied ? '已复制' : '复制失败')
    button.setAttribute('title', copied ? '已复制' : '复制失败')
    showToast(copied ? '已复制到剪贴板' : '复制失败，请手动选择文本复制', copied ? 'success' : 'error')
    window.setTimeout(() => {
      button.dataset.copied = 'idle'
      button.setAttribute('aria-label', originalLabel)
      button.setAttribute('title', originalTitle)
    }, 1600)
  })
}

export function initConfirmableActions() {
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return
    const button = event.target.closest<HTMLButtonElement>('[data-confirm]')
    if (!button) return
    const message = button.dataset.confirm?.trim()
    if (message && !window.confirm(message)) {
      event.preventDefault()
      event.stopPropagation()
    }
  })
}

export function initSubmitFeedback() {
  document.addEventListener('submit', (event) => {
    const form = event.target
    if (!(form instanceof HTMLFormElement) || form.dataset.submitFeedback !== 'true') return
    if (form.dataset.submitting === 'true') {
      event.preventDefault()
      return
    }
    const submitter = event.submitter instanceof HTMLButtonElement ? event.submitter : null
    preserveSubmitterValue(form, submitter)
    form.dataset.submitting = 'true'
    form.setAttribute('aria-busy', 'true')
    form.querySelectorAll<HTMLButtonElement>('button[type="submit"], button:not([type])').forEach((button) => {
      button.disabled = true
      if (button !== submitter) return
      button.dataset.submitting = 'true'
      button.dataset.originalLabel = button.textContent?.trim() || ''
      button.textContent = button.dataset.submittingLabel || '处理中...'
    })
  })
}

function preserveSubmitterValue(form: HTMLFormElement, submitter: HTMLButtonElement | null) {
  if (!submitter?.name) return
  const exists = Array.from(
    form.querySelectorAll<HTMLInputElement>('input[type="hidden"][data-submit-feedback-value]')
  ).some((input) => input.dataset.submitFeedbackValue === submitter.name)
  if (exists) return
  const input = document.createElement('input')
  input.type = 'hidden'
  input.name = submitter.name
  input.value = submitter.value
  input.dataset.submitFeedbackValue = submitter.name
  form.appendChild(input)
}

function showToast(message: string, tone: ToastTone) {
  const container = getToastContainer()
  const toast = document.createElement('div')
  toast.className = 'app-toast'
  toast.dataset.tone = tone
  toast.setAttribute('role', 'status')
  toast.textContent = message
  container.appendChild(toast)
  window.requestAnimationFrame(() => {
    toast.dataset.visible = 'true'
  })
  window.setTimeout(() => {
    toast.dataset.visible = 'false'
    window.setTimeout(() => {
      toast.remove()
      if (!container.childElementCount) container.remove()
    }, 220)
  }, 2200)
}

function getToastContainer() {
  const existing = document.querySelector<HTMLDivElement>('[data-toast-container]')
  if (existing) return existing
  const container = document.createElement('div')
  container.className = 'app-toast-viewport'
  container.dataset.toastContainer = 'true'
  container.setAttribute('aria-live', 'polite')
  container.setAttribute('aria-atomic', 'true')
  document.body.appendChild(container)
  return container
}
