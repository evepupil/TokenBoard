import { Check, ChevronDown } from 'lucide'
import { cn } from '../../lib/cn'
import { LucideIcon } from './icon'

export type CustomSelectOption = {
  value: string
  label: string
}

type CustomSelectProps = {
  label?: string
  name: string
  value: string
  options: CustomSelectOption[]
  disabled?: boolean
  wrapperClass?: string
  inputAttrs?: Record<string, string>
}

export function customSelectOptions<T extends string>(options: readonly T[], labels: Record<T, string>): CustomSelectOption[] {
  return options.map((value) => ({ value, label: labels[value] }))
}

export function CustomSelect(props: CustomSelectProps) {
  const selected = props.options.find((option) => option.value === props.value) ?? props.options[0]

  const buttonId = `${props.name}-menu-button`
  const menuId = `${props.name}-menu`

  const control = (
    <div class={cn('relative', props.wrapperClass)} data-custom-select="true">
      <input
        type="hidden"
        name={props.name}
        value={selected?.value ?? props.value}
        disabled={props.disabled}
        data-custom-select-value="true"
        {...props.inputAttrs}
      />
      <button
        id={buttonId}
        type="button"
        disabled={props.disabled}
        class={selectButtonClass}
        data-custom-select-button="true"
        aria-haspopup="listbox"
        aria-expanded="false"
        aria-controls={menuId}
      >
        <span class="min-w-0 truncate">
          {props.label ? <span class="sr-only">{props.label}: </span> : null}
          <span data-custom-select-label="true">{selected?.label ?? props.value}</span>
        </span>
        <span class="shrink-0 text-[var(--app-muted)]">
          <LucideIcon icon={ChevronDown} size={15} />
        </span>
      </button>
      <div id={menuId} role="listbox" class={selectMenuClass} data-custom-select-menu="true">
        {props.options.map((option) => (
          <CustomSelectOptionItem
            key={option.value}
            option={option}
            selected={option.value === (selected?.value ?? props.value)}
          />
        ))}
      </div>
    </div>
  )

  if (!props.label) return control

  return (
    <div class="block">
      <span class="block font-mono text-xs font-semibold uppercase tracking-wide text-[var(--app-muted)]">
        {props.label}
      </span>
      {control}
    </div>
  )
}

function CustomSelectOptionItem(props: { option: CustomSelectOption; selected: boolean }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={props.selected ? 'true' : 'false'}
      data-custom-select-option="true"
      data-value={props.option.value}
      data-label={props.option.label}
      class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm font-semibold text-[var(--app-text)] transition hover:bg-[var(--app-hover)]"
    >
      <span class="min-w-0 truncate">{props.option.label}</span>
      <span class={cn('shrink-0', props.selected ? 'app-accent-text' : 'text-transparent')}>
        <LucideIcon icon={Check} size={14} />
      </span>
    </button>
  )
}

const selectButtonClass =
  'flex h-11 w-full items-center justify-between gap-3 border border-[var(--app-border)] bg-[var(--app-input)] px-3 text-sm font-semibold text-[var(--app-text)] outline-none transition hover:border-[var(--app-border-strong)] focus:border-[var(--app-accent-bar)] focus:ring-1 focus:ring-[var(--app-accent-bar)] disabled:opacity-60'

const selectMenuClass =
  'app-surface-floating invisible absolute left-0 right-0 top-full z-40 mt-1 max-h-64 overflow-y-auto border border-[var(--app-border-strong)] bg-[var(--app-panel-strong)] p-1 opacity-0 transition'
