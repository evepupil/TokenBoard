import { Input } from '../../components/ui/input'
import { maxWebhookScheduleTimes, type WebhookSubscriptionSummary } from './schema'

export const scheduleTimeSlotCount = maxWebhookScheduleTimes
const defaultScheduleWeekdays = [0, 1, 2, 3, 4, 5, 6]
const weekdayOptions = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' }
]

export function ScheduleTimeFields(props: {
  scheduleTimesLocal: string[]
  disabled?: boolean
}) {
  return (
    <fieldset class="md:col-span-2">
      <legend class="text-sm text-[var(--app-muted)]">推送时间（可填多个）</legend>
      <div class="mt-2 grid gap-2 sm:grid-cols-2">
        {scheduleTimeSlots(props.scheduleTimesLocal).map((time, index) => (
          <Input
            key={index}
            name="scheduleTimesLocal[]"
            type="time"
            value={time}
            required={index === 0}
            disabled={props.disabled}
          />
        ))}
      </div>
    </fieldset>
  )
}

export function ScheduleWeekdayFields(props: {
  scheduleWeekdays?: number[]
  disabled?: boolean
}) {
  const scheduleWeekdays = props.scheduleWeekdays ?? defaultScheduleWeekdays
  return (
    <fieldset class="md:col-span-2">
      <legend class="text-sm text-[var(--app-muted)]">推送日期</legend>
      <input type="hidden" name="scheduleWeekdaysTouched" value="1" disabled={props.disabled} />
      <div class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {weekdayOptions.map((weekday) => (
          <label key={weekday.value} class="flex min-h-11 items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-input)] px-3 text-sm font-bold text-[var(--app-text)]">
            <input
              type="checkbox"
              name="scheduleWeekdays[]"
              value={String(weekday.value)}
              checked={scheduleWeekdays.includes(weekday.value)}
              disabled={props.disabled}
            />
            {weekday.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function defaultScheduleWeekdayValues() {
  return defaultScheduleWeekdays
}

export function scheduleRuleLabel(subscription: WebhookSubscriptionSummary) {
  const times = subscription.scheduleTimesLocal?.length > 0
    ? subscription.scheduleTimesLocal
    : [subscription.scheduleTimeLocal]
  return `${times.join('、')}；${weekdaysLabel(subscription.scheduleWeekdays ?? defaultScheduleWeekdays)}`
}

function scheduleTimeSlots(times: string[]) {
  const normalized = times?.length > 0 ? times : ['18:00']
  return normalized.concat(Array(Math.max(0, scheduleTimeSlotCount - normalized.length)).fill(''))
}

function weekdaysLabel(weekdays: number[]) {
  if (defaultScheduleWeekdays.every((weekday) => weekdays.includes(weekday))) return '每天'
  return weekdayOptions
    .filter((weekday) => weekdays.includes(weekday.value))
    .map((weekday) => weekday.label)
    .join('、')
}
