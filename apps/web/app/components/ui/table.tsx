import type { Child } from 'hono/jsx'
import { cn } from '../../lib/cn'

export function Table(props: { class?: string; children?: Child }) {
  return <table class={cn('w-full caption-bottom text-sm', props.class)}>{props.children}</table>
}

export function TableHeader(props: { class?: string; children?: Child }) {
  return <thead class={cn('text-xs uppercase tracking-wide text-stone-500', props.class)}>{props.children}</thead>
}

export function TableBody(props: { class?: string; children?: Child }) {
  return <tbody class={cn('[&_tr:last-child]:border-0', props.class)}>{props.children}</tbody>
}

export function TableRow(props: { class?: string; children?: Child }) {
  return <tr class={cn('border-b border-stone-800 transition-colors', props.class)}>{props.children}</tr>
}

export function TableHead(props: { class?: string; children?: Child }) {
  return <th class={cn('px-3 py-2 text-left align-middle font-bold', props.class)}>{props.children}</th>
}

export function TableCell(props: { class?: string; colSpan?: number; children?: Child }) {
  return <td class={cn('px-3 py-3 align-middle', props.class)} colSpan={props.colSpan}>{props.children}</td>
}
