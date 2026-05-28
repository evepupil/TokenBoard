export function initCustomSelects() {
  if (document.documentElement.dataset.customSelectBound === 'true') return
  document.documentElement.dataset.customSelectBound = 'true'

  document.addEventListener('click', handleCustomSelectClick)
  document.addEventListener('keydown', handleCustomSelectKeydown)
}

function handleCustomSelectClick(event: MouseEvent) {
  if (!(event.target instanceof Element)) return

  const option = event.target.closest<HTMLElement>('[data-custom-select-option]')
  if (option) {
    event.preventDefault()
    selectCustomOption(option)
    return
  }

  const button = event.target.closest<HTMLButtonElement>('[data-custom-select-button]')
  if (button) {
    event.preventDefault()
    toggleCustomSelect(button)
    return
  }

  closeCustomSelects()
}

function handleCustomSelectKeydown(event: KeyboardEvent) {
  if (!(event.target instanceof Element)) return
  const button = event.target.closest<HTMLButtonElement>('[data-custom-select-button]')
  const option = event.target.closest<HTMLElement>('[data-custom-select-option]')

  if (button && (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown')) {
    event.preventDefault()
    openCustomSelect(button)
    focusSelectedOption(button)
    return
  }

  if (!option) {
    if (event.key === 'Escape') closeCustomSelects()
    return
  }

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    selectCustomOption(option)
    return
  }

  if (event.key === 'Escape') {
    event.preventDefault()
    const root = option.closest<HTMLElement>('[data-custom-select]')
    closeCustomSelects()
    root?.querySelector<HTMLButtonElement>('[data-custom-select-button]')?.focus()
    return
  }

  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const options = getSiblingOptions(option)
  const current = options.indexOf(option)
  const next = event.key === 'ArrowDown'
    ? options[(current + 1) % options.length]
    : options[(current - 1 + options.length) % options.length]
  next?.focus()
}

function toggleCustomSelect(button: HTMLButtonElement) {
  const expanded = button.getAttribute('aria-expanded') === 'true'
  closeCustomSelects()
  if (!expanded) openCustomSelect(button)
}

function openCustomSelect(button: HTMLButtonElement) {
  const root = button.closest<HTMLElement>('[data-custom-select]')
  const menu = root?.querySelector<HTMLElement>('[data-custom-select-menu]')
  if (!root || !menu) return

  button.setAttribute('aria-expanded', 'true')
  menu.classList.remove('invisible', 'opacity-0')
}

function closeCustomSelects() {
  document.querySelectorAll<HTMLElement>('[data-custom-select]').forEach((root) => {
    root.querySelector<HTMLButtonElement>('[data-custom-select-button]')?.setAttribute('aria-expanded', 'false')
    root.querySelector<HTMLElement>('[data-custom-select-menu]')?.classList.add('invisible', 'opacity-0')
  })
}

function selectCustomOption(option: HTMLElement) {
  const root = option.closest<HTMLElement>('[data-custom-select]')
  const value = option.dataset.value ?? ''
  const label = option.dataset.label ?? option.textContent?.trim() ?? value
  if (!root) return

  const input = root.querySelector<HTMLInputElement>('[data-custom-select-value]')
  const labelTarget = root.querySelector<HTMLElement>('[data-custom-select-label]')
  const button = root.querySelector<HTMLButtonElement>('[data-custom-select-button]')
  if (!input || !labelTarget || !button) return

  input.value = value
  labelTarget.textContent = label
  root.querySelectorAll<HTMLElement>('[data-custom-select-option]').forEach((item) => {
    const selected = item === option
    item.setAttribute('aria-selected', selected ? 'true' : 'false')
    const mark = item.lastElementChild
    mark?.classList.toggle('text-lime-300', selected)
    mark?.classList.toggle('text-transparent', !selected)
  })

  closeCustomSelects()
  button.focus()
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function focusSelectedOption(button: HTMLButtonElement) {
  const root = button.closest<HTMLElement>('[data-custom-select]')
  const selected = root?.querySelector<HTMLElement>('[data-custom-select-option][aria-selected="true"]')
  selected?.focus()
}

function getSiblingOptions(option: HTMLElement) {
  const menu = option.closest<HTMLElement>('[data-custom-select-menu]')
  return Array.from(menu?.querySelectorAll<HTMLElement>('[data-custom-select-option]') ?? [])
}
