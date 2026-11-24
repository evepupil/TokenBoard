import type { Child } from 'hono/jsx'
import { cn } from '../../lib/cn'

export function Badge(props: { class?: string; variant?: 'default' | 'outline'; children?: Child }) {
  const variant = props.variant ?? 'default'
  return (
    <span
      class={cn(
        'inline-flex min-h-8 items-center border px-2.5 py-1 font-mono text-xs font-bold uppercase tracking-wider',
        variant === 'default' && 'border-[var(--app-border-strong)] bg-[var(--app-text)] text-[var(--app-bg)]',
        variant === 'outline' && 'border-[var(--app-border)] bg-[var(--app-panel-strong)] text-[var(--app-muted)]',
        props.class
      )}
    >
      {props.children}
    </span>
  )
}
