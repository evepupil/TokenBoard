import type { Child } from 'hono/jsx'
import { cn } from '../../../lib/cn'
import type { UsageMetricValue } from './usage-metric-format'

type UsageMetricGridColumns = 3 | 4

export function UsageMetricGrid(props: {
  columns?: UsageMetricGridColumns
  class?: string
  children?: Child
}) {
  return (
    <div
      class={cn(
        'grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2',
        props.columns === 3 ? 'xl:grid-cols-3' : 'xl:grid-cols-4',
        props.class
      )}
      data-usage-metric-grid="true"
    >
      {props.children}
    </div>
  )
}

export function UsageMetricCard(props: {
  label: string
  value: string | UsageMetricValue
  tone?: 'lime'
}) {
  const metric = readMetricValue(props.value)
  const exactLabel = metric.exactValue === metric.value
    ? `${props.label}: ${metric.exactValue}`
    : `${props.label}: ${metric.exactValue} (${metric.value}${metric.detail ? `, ${metric.detail}` : ''})`

  return (
    <div class={cn(
      'min-w-0 rounded-lg border p-4 lg:p-3',
      props.tone === 'lime'
        ? 'border-lime-300/40 bg-lime-300 text-stone-950'
        : 'border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text)]'
    )}>
      <p class={cn('text-sm', props.tone === 'lime' ? 'text-stone-700' : 'text-[var(--app-muted)]')}>
        {props.label}
      </p>
      <div
        class="mt-2 min-w-0 text-2xl font-black leading-tight tabular-nums sm:text-3xl lg:text-2xl xl:text-3xl [overflow-wrap:anywhere]"
        data-usage-metric-value="true"
        title={metric.exactValue}
      >
        <span class="sr-only">{exactLabel}</span>
        <span aria-hidden="true">{metric.value}</span>
        {metric.detail ? (
          <span
            class="mt-1 block text-sm font-bold leading-snug tracking-normal opacity-80 sm:text-base lg:text-sm xl:text-base"
            aria-hidden="true"
            data-usage-metric-detail="true"
          >
            ({metric.detail})
          </span>
        ) : null}
      </div>
    </div>
  )
}

function readMetricValue(value: string | UsageMetricValue): UsageMetricValue {
  return typeof value === 'string'
    ? { value, exactValue: value }
    : value
}
