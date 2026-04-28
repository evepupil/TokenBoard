import type { Child } from 'hono/jsx'
import { cn } from '../../lib/cn'

export function Card(props: { class?: string; children?: Child }) {
  return <section class={cn('rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text)] shadow-xl shadow-black/10 backdrop-blur', props.class)}>{props.children}</section>
}

export function CardHeader(props: { class?: string; children?: Child }) {
  return <div class={cn('flex flex-col gap-1.5 p-5', props.class)}>{props.children}</div>
}

export function CardTitle(props: { class?: string; children?: Child }) {
  return <h2 class={cn('text-base font-black tracking-tight', props.class)}>{props.children}</h2>
}

export function CardDescription(props: { class?: string; children?: Child }) {
  return <p class={cn('text-sm text-[var(--app-muted)]', props.class)}>{props.children}</p>
}

export function CardContent(props: { class?: string; children?: Child }) {
  return <div class={cn('p-5 pt-0', props.class)}>{props.children}</div>
}
