import type { Child } from 'hono/jsx'
import { cn } from '../../lib/cn'

type TableElementProps = {
  class?: string
  children?: Child
  colspan?: number
  scope?: 'col' | 'row' | 'colgroup' | 'rowgroup'
  'data-leaderboard-current-user'?: string
}

export function Table(props: TableElementProps) {
  return <table class={cn('w-full border-collapse text-left text-sm', props.class)}>{props.children}</table>
}

export function TableHeader(props: TableElementProps) {
  return (
    <thead class={cn('border-b border-[var(--app-border-strong)] font-mono text-[11px] uppercase tracking-wider text-[var(--app-muted)]', props.class)}>
      {props.children}
    </thead>
  )
}

export function TableBody(props: TableElementProps) {
  return <tbody class={cn('divide-y divide-[var(--app-border)]', props.class)}>{props.children}</tbody>
}

export function TableRow(props: TableElementProps) {
  const { class: className, children, ...rest } = props
  return (
    <tr class={cn('border-b border-[var(--app-border)] transition hover:bg-[var(--app-hover)]', className)} {...rest}>
      {children}
    </tr>
  )
}

export function TableHead(props: TableElementProps) {
  return (
    <th scope={props.scope ?? 'col'} class={cn('px-3 py-2.5 font-semibold', props.class)}>
      {props.children}
    </th>
  )
}

export function TableCell(props: TableElementProps) {
  return (
    <td class={cn('px-3 py-3', props.class)} colspan={props.colspan}>
      {props.children}
    </td>
  )
}
