import type { Child } from 'hono/jsx'
import { cn } from '../../lib/cn'

export function Input(props: {
  class?: string
  name?: string
  type?: string
  value?: string
  autocomplete?: string
  required?: boolean
  minLength?: number
}) {
  const { class: className, ...rest } = props
  return <input class={cn('mt-2 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-input)] px-4 py-3 text-[var(--app-text)] outline-none transition placeholder:text-[var(--app-subtle)] focus:border-lime-300 focus:ring-2 focus:ring-lime-300/20', className)} {...rest} />
}

export function Label(props: { class?: string; children?: Child }) {
  return <label class={cn('block text-sm text-[var(--app-muted)]', props.class)}>{props.children}</label>
}
