import type { Child } from 'hono/jsx'
import { cn } from '../../lib/cn'

type InputProps = {
  class?: string
  name: string
  type?: string
  value?: string
  placeholder?: string
  autocomplete?: string
  required?: boolean
  disabled?: boolean
  minLength?: number
  maxLength?: number
  'aria-label'?: string
  'data-timezone-input'?: string
  'data-timezone-default'?: string
  'data-timezone-autofill'?: string
}

export function Input(props: InputProps) {
  const { class: className, ...rest } = props
  return (
    <input
      class={cn(
        'mt-2 w-full border border-[var(--app-border)] bg-[var(--app-input)] px-3.5 py-2.5 text-sm text-[var(--app-text)] outline-none transition placeholder:text-[var(--app-subtle)] focus:border-[var(--app-accent-bar)] focus:ring-1 focus:ring-[var(--app-accent-bar)] disabled:opacity-60',
        className
      )}
      {...rest}
    />
  )
}

export function Label(props: { class?: string; children?: Child }) {
  return (
    <label class={cn('block text-xs font-semibold uppercase tracking-wide text-[var(--app-muted)]', props.class)}>
      {props.children}
    </label>
  )
}
