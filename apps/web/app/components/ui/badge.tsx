import type { Child } from 'hono/jsx'
import { cn } from '../../lib/cn'

export function Badge(props: { class?: string; variant?: 'default' | 'secondary' | 'outline'; children?: Child }) {
  const variant = props.variant ?? 'default'
  return (
    <span class={cn(
      'inline-flex items-center rounded-full px-3 py-1 text-xs font-black uppercase tracking-wide',
      variant === 'default' && 'bg-lime-300 text-stone-950',
      variant === 'secondary' && 'bg-[var(--app-bg-soft)] text-[var(--app-text)]',
      variant === 'outline' && 'border border-[var(--app-border)] text-[var(--app-muted)]',
      props.class
    )}>{props.children}</span>
  )
}
