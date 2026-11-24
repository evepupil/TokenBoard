import { usageSources } from '@tokenboard/usage-core'
import { Button, LinkButton } from '../../../components/ui/button'
import { CustomSelect } from '../../../components/ui/custom-select'
import type { UserDevice } from '../../device/service'
import type { UsageDetailsFilters } from '../service'
import { formatSource } from '../source-format'
import { csvHref } from './usage-details-format'

export function UsageDetailsFiltersForm(props: { filters: UsageDetailsFilters; devices: UserDevice[] }) {
  return (
    <form
      method="get"
      class="grid gap-3 sm:grid-cols-2 xl:grid-cols-[150px_170px_1fr_1fr_1fr_auto_auto]"
      data-submit-feedback="true"
    >
      <SourceFilter filters={props.filters} />
      <DeviceFilter filters={props.filters} devices={props.devices} />
      <DateFilter label="开始日期" name="startDate" value={props.filters.startDate} />
      <DateFilter label="结束日期" name="endDate" value={props.filters.endDate} />
      <ModelFilter value={props.filters.modelQuery} />
      <Button class="h-11 w-full sm:mt-6" type="submit" data-submitting-label="正在应用...">
        应用筛选
      </Button>
      <LinkButton class="h-11 w-full sm:mt-6" variant="secondary" href={csvHref(props.filters)} download="">
        导出 CSV ↓
      </LinkButton>
    </form>
  )
}

function SourceFilter(props: { filters: UsageDetailsFilters }) {
  return (
    <CustomSelect
      label="来源"
      name="source"
      value={props.filters.source}
      options={sourceOptions}
      wrapperClass="mt-1.5"
    />
  )
}

function DeviceFilter(props: { filters: UsageDetailsFilters; devices: UserDevice[] }) {
  const options = [
    { value: 'all', label: '全部设备' },
    ...props.devices.map((device) => ({ value: device.id, label: device.name }))
  ]

  return (
    <CustomSelect label="设备" name="device" value={props.filters.deviceId} options={options} wrapperClass="mt-1.5" />
  )
}

function DateFilter(props: { label: string; name: string; value: string }) {
  return (
    <label class="font-mono text-xs font-semibold uppercase tracking-wide text-[var(--app-muted)]">
      {props.label}
      <input class={filterControlClass()} name={props.name} type="date" value={props.value} autocomplete="off" />
    </label>
  )
}

function ModelFilter(props: { value: string }) {
  return (
    <label class="font-mono text-xs font-semibold uppercase tracking-wide text-[var(--app-muted)]">
      模型
      <input
        class={filterControlClass('placeholder:text-[var(--app-subtle)]')}
        name="model"
        placeholder="sonnet / gpt-5"
        value={props.value}
        autocomplete="off"
      />
    </label>
  )
}

function filterControlClass(extra = '') {
  return [
    'mt-1.5 h-11 w-full border border-[var(--app-border)] bg-[var(--app-input)] px-3 font-sans text-sm',
    'text-[var(--app-text)] outline-none transition focus:border-[var(--app-accent-bar)] focus:ring-1 focus:ring-[var(--app-accent-bar)]',
    extra
  ]
    .filter(Boolean)
    .join(' ')
}

const sourceOptions = [
  { value: 'all', label: formatSource('all') },
  ...usageSources.map((source) => ({ value: source, label: formatSource(source) }))
]
