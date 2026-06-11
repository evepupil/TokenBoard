import { Button, LinkButton } from '../../../components/ui/button'
import { CustomSelect } from '../../../components/ui/custom-select'
import type { UserDevice } from '../../device/service'
import type { UsageDetailsFilters } from '../service'
import { csvHref } from './usage-details-format'

export function UsageDetailsFiltersForm(props: {
  filters: UsageDetailsFilters
  devices: UserDevice[]
}) {
  return (
    <form method="get" class="grid gap-3 sm:grid-cols-2 xl:min-w-[900px] xl:grid-cols-[140px_170px_1fr_1fr_1fr_auto_auto]">
      <SourceFilter filters={props.filters} />
      <DeviceFilter filters={props.filters} devices={props.devices} />
      <DateFilter label="开始日期" name="startDate" value={props.filters.startDate} />
      <DateFilter label="结束日期" name="endDate" value={props.filters.endDate} />
      <ModelFilter value={props.filters.modelQuery} />
      <Button class="h-11 w-full sm:mt-7" type="submit">应用</Button>
      <LinkButton class="h-11 w-full sm:mt-7" variant="secondary" href={csvHref(props.filters)}>CSV</LinkButton>
    </form>
  )
}

function SourceFilter(props: { filters: UsageDetailsFilters }) {
  return <CustomSelect label="来源" name="source" value={props.filters.source} options={sourceOptions} wrapperClass="mt-2" />
}

function DeviceFilter(props: { filters: UsageDetailsFilters; devices: UserDevice[] }) {
  const options = [
    { value: 'all', label: '全部设备' },
    ...props.devices.map((device) => ({ value: device.id, label: device.name }))
  ]

  return (
    <CustomSelect
      label="设备"
      name="device"
      value={props.filters.deviceId}
      options={options}
      wrapperClass="mt-2"
    />
  )
}

function DateFilter(props: { label: string; name: string; value: string }) {
  return (
    <label class="text-sm font-bold text-[var(--app-muted)]">
      {props.label}
      <input class={filterControlClass()} name={props.name} type="date" value={props.value} autocomplete="off" />
    </label>
  )
}

function ModelFilter(props: { value: string }) {
  return (
    <label class="text-sm font-bold text-[var(--app-muted)]">
      模型
      <input
        class={filterControlClass('placeholder:text-[var(--app-subtle)]')}
        name="model"
        placeholder="sonnet"
        value={props.value}
        autocomplete="off"
      />
    </label>
  )
}

function filterControlClass(extra = '') {
  return [
    'mt-2 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-input)] px-3',
    'text-[var(--app-text)] outline-none transition focus:border-lime-300 focus:ring-2 focus:ring-lime-300/20',
    extra
  ].filter(Boolean).join(' ')
}

const sourceOptions = [
  { value: 'all', label: '全部' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' }
]
