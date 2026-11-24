import type { Child } from 'hono/jsx'
import { cn } from '../../../lib/cn'
import type { UsageMetricValue } from './usage-metric-format'

type UsageMetricGridColumns = 3 | 4

export function UsageMetricGrid(props: { columns?: UsageMetricGridColumns; class?: string; children?: Child }) {
  return (
    <div
      class={cn(
        'grid min-w-0 grid-cols-1 gap-px border-y border-[var(--app-border-strong)] bg-[var(--app-border)] sm:grid-cols-2',
        props.columns === 3 ? 'xl:grid-cols-3' : 'xl:grid-cols-4',
        props.class
      )}
      data-usage-metric-grid="true"
    >
      {props.children}
    </div>
  )
}

export function UsageMetricCard(props: { label: string; value: string | UsageMetricValue; tone?: 'lime' }) {
  const metric = readMetricValue(props.value)
  const exactLabel =
    metric.exactValue === metric.value
      ? `${props.label}: ${metric.exactValue}${metric.detail ? ` (${metric.detail})` : ''}`
      : `${props.label}: ${metric.exactValue} (${metric.value}${metric.detail ? `, ${metric.detail}` : ''})`

  return (
    <div
      class={cn(
        'app-metric-card min-w-0 p-5 sm:p-6',
        props.tone === 'lime'
          ? 'app-metric-card-primary bg-[var(--app-panel-strong)] text-[var(--app-text)]'
          : 'bg-[var(--app-panel)] text-[var(--app-text)]'
      )}
      data-usage-metric-card="true"
    >
      <p
        class={cn(
          'font-mono text-xs font-semibold uppercase tracking-wide',
          props.tone === 'lime' ? 'app-metric-card-primary-label' : 'text-[var(--app-muted)]'
        )}
      >
        {props.label}
      </p>
      <div
        class="mt-3 min-w-0 text-3xl font-semibold leading-none tracking-tight tabular-nums sm:text-4xl [overflow-wrap:anywhere]"
        data-usage-metric-value="true"
        title={metric.exactValue}
      >
        <span class="sr-only">{exactLabel}</span>
        <span aria-hidden="true">{metric.value}</span>
        {metric.detail ? (
          <span
            class="app-accent-text mt-2 block font-mono text-xs font-medium leading-snug tracking-normal"
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
  return typeof value === 'string' ? { value, exactValue: value } : value
}
