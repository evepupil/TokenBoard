import type { Child } from 'hono/jsx'
import { cn } from '../../lib/cn'

export function Badge(props: { class?: string; variant?: 'default' | 'secondary' | 'outline'; children?: Child }) {
  const variant = props.variant ?? 'default'
  return (
    <span class={cn(
      'inline-flex items-center rounded-full px-3 py-1 text-xs font-black uppercase tracking-wide',
      variant === 'default' && 'bg-lime-300 text-stone-950',
      variant === 'secondary' && 'bg-stone-800 text-stone-200',
      variant === 'outline' && 'border border-stone-700 text-stone-300',
      props.class
    )}>{props.children}</span>
  )
}
