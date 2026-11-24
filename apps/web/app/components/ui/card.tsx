import type { Child } from 'hono/jsx'
import { cn } from '../../lib/cn'

type CardProps = {
  class?: string
  children?: Child
}

type CardHeadingProps = {
  class?: string
  children?: Child
  as?: 'h1' | 'h2' | 'h3'
}

export function Card(props: CardProps) {
  return (
    <section
      class={cn(
        'app-surface-raised border border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text)]',
        props.class
      )}
    >
      {props.children}
    </section>
  )
}

export function CardHeader(props: CardProps) {
  return (
    <div class={cn('flex flex-col gap-1.5 border-b border-[var(--app-border)] px-5 py-4 sm:px-6 sm:py-5', props.class)}>
      {props.children}
    </div>
  )
}

export function CardTitle(props: CardHeadingProps) {
  const Tag = props.as ?? 'h2'
  return <Tag class={cn('text-lg font-bold tracking-tight sm:text-xl', props.class)}>{props.children}</Tag>
}

export function CardDescription(props: CardProps) {
  return <p class={cn('text-sm leading-6 text-[var(--app-muted)]', props.class)}>{props.children}</p>
}

export function CardContent(props: CardProps) {
  return <div class={cn('p-5 sm:p-6', props.class)}>{props.children}</div>
}
