import { Button } from '../../components/ui/button'
import { CustomSelect } from '../../components/ui/custom-select'
import { Input, Label } from '../../components/ui/input'
import { ScheduleTimeFields, ScheduleWeekdayFields, defaultScheduleWeekdayValues } from './schedule-fields'

export function CreateSubscriptionForm(props: { timezone: string; disabled: boolean }) {
  return (
    <form method="post" class="space-y-4" data-submit-feedback="true">
      <input type="hidden" name="action" value="create" />
      <Label>
        名称
        <Input name="name" placeholder="每日日报" autocomplete="off" required disabled={props.disabled} />
      </Label>
      <ProviderSelect disabled={props.disabled} />
      <Label>
        Webhook URL
        <Input
          name="webhookUrl"
          type="url"
          placeholder="https://..."
          autocomplete="off"
          required
          disabled={props.disabled}
        />
      </Label>
      <Label>
        加签 secret (钉钉、飞书 / Lark 启用加签时填写)
        <Input name="signingSecret" type="password" autocomplete="new-password" disabled={props.disabled} />
      </Label>
      <Label>
        时区
        <Input name="timezone" value={props.timezone} autocomplete="off" required disabled={props.disabled} />
      </Label>
      <ScheduleTimeFields scheduleTimesLocal={['18:00']} disabled={props.disabled} />
      <ScheduleWeekdayFields scheduleWeekdays={defaultScheduleWeekdayValues()} disabled={props.disabled} />
      <CreateChecks disabled={props.disabled} />
      <Button class="w-full" type="submit" disabled={props.disabled} data-submitting-label="正在保存 Webhook...">
        保存 Webhook
      </Button>
    </form>
  )
}

function ProviderSelect(props: { disabled: boolean }) {
  return (
    <CustomSelect
      label="平台"
      name="provider"
      value="wecom"
      disabled={props.disabled}
      options={[
        { value: 'wecom', label: '企微' },
        { value: 'dingtalk', label: '钉钉' },
        { value: 'feishu', label: '飞书 / Lark' }
      ]}
    />
  )
}

function CreateChecks(props: { disabled: boolean }) {
  return (
    <>
      <label class="app-surface-subtle flex min-h-11 items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-input)] px-3 text-sm font-bold text-[var(--app-text)]">
        <input type="checkbox" name="sendEmptyReport" disabled={props.disabled} />
        空日报也发送
      </label>
      <label class="app-surface-subtle flex min-h-11 items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-input)] px-3 text-sm font-bold text-[var(--app-text)]">
        <input type="checkbox" name="enabled" checked disabled={props.disabled} />
        启用定时推送
      </label>
    </>
  )
}
