import { Check, ChevronDown } from 'lucide'
import { LucideIcon } from './icon'

export type CustomSelectOption = {
  value: string
  label: string
}

export function CustomSelect(props: {
  label?: string
  name: string
  value: string
  options: CustomSelectOption[]
  buttonClass?: string
  wrapperClass?: string
  optionClass?: string
  inputAttrs?: Record<string, string>
}) {
  const selected = props.options.find((option) => option.value === props.value) ?? props.options[0]
  const buttonId = `${props.name}-menu-button`
  const menuId = `${props.name}-menu`
  const select = (
    <div class={`relative ${props.wrapperClass ?? ''}`} data-custom-select="true">
      <input
        type="hidden"
        name={props.name}
        value={selected?.value ?? ''}
        data-custom-select-value="true"
        {...props.inputAttrs}
      />
      <button
        id={buttonId}
        type="button"
        class={props.buttonClass ?? customSelectButtonClass}
        aria-haspopup="listbox"
        aria-expanded="false"
        aria-controls={menuId}
        data-custom-select-button="true"
      >
        <span data-custom-select-label="true">{selected?.label ?? ''}</span>
        <LucideIcon icon={ChevronDown} class="text-[var(--app-muted)]" size={16} />
      </button>
      <div
        id={menuId}
        class="app-surface-floating invisible absolute left-0 right-0 top-[calc(100%+0.35rem)] z-30 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-strong)] p-1 opacity-0 transition"
        role="listbox"
        aria-labelledby={buttonId}
        data-custom-select-menu="true"
      >
        {props.options.map((option) => (
          <CustomSelectOptionButton
            label={option.label}
            selected={option.value === selected?.value}
            value={option.value}
            class={props.optionClass}
          />
        ))}
      </div>
    </div>
  )

  if (!props.label) return select

  return (
    <div class="block text-sm font-bold text-[var(--app-muted)]">
      <span>{props.label}</span>
      {select}
    </div>
  )
}

export function customSelectOptions<T extends string>(options: readonly T[], labels: Record<T, string>) {
  return options.map((value) => ({ value, label: labels[value] }))
}

function CustomSelectOptionButton(props: {
  class?: string
  label: string
  selected: boolean
  value: string
}) {
  return (
    <button
      type="button"
      class={props.class ?? customSelectOptionClass}
      role="option"
      aria-selected={props.selected ? 'true' : 'false'}
      data-custom-select-option="true"
      data-value={props.value}
      data-label={props.label}
    >
      <span>{props.label}</span>
      <LucideIcon icon={Check} class={props.selected ? 'app-accent-text' : 'text-transparent'} size={16} />
    </button>
  )
}

export const customSelectButtonClass = 'flex h-11 w-full items-center justify-between gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-input)] px-3 text-sm font-black text-[var(--app-text)] outline-none transition hover:bg-[var(--app-hover)] focus:border-lime-300 focus:ring-2 focus:ring-lime-300/20'

const customSelectOptionClass = 'flex min-h-10 w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm font-black text-[var(--app-text)] transition hover:bg-[var(--app-hover)] focus:bg-[var(--app-hover)] focus:outline-none'
