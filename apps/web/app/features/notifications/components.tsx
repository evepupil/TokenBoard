import { AppNav } from '../../components/app-nav'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { CustomSelect } from '../../components/ui/custom-select'
import { Input, Label } from '../../components/ui/input'
import { DailyReportHistoryCard } from './report-history-card'
import type { DailyReportHistoryItem } from './report-history-item'
import {
  ScheduleTimeFields,
  ScheduleWeekdayFields,
  defaultScheduleWeekdayValues,
  scheduleRuleLabel
} from './schedule-fields'
import type { WebhookSubscriptionSummary } from './schema'

export function NotificationsPage(props: {
  email: string
  timezone: string
  subscriptions: WebhookSubscriptionSummary[]
  reportHistory: DailyReportHistoryItem[]
  dailyReportShareEnabled: boolean
  reportHistoryRetentionDays: number
  saved: boolean
  tested: boolean
  testFailed: boolean
  encryptionConfigured: boolean
}) {
  return (
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
      <title>通知 Webhook - TokenBoard</title>
      <AppNav active="notifications" email={props.email} />

      <section class="mx-auto flex max-w-6xl flex-col gap-5">
        <NotificationsHeader />
        <NotificationFlash
          saved={props.saved}
          tested={props.tested}
          testFailed={props.testFailed}
          encryptionConfigured={props.encryptionConfigured}
        />
        <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,0.75fr)]">
          <SubscriptionsCard subscriptions={props.subscriptions} />
          <CreateSubscriptionCard timezone={props.timezone} disabled={!props.encryptionConfigured} />
        </div>
        <DailyReportHistoryCard
          reportHistory={props.reportHistory}
          dailyReportShareEnabled={props.dailyReportShareEnabled}
          retentionDays={props.reportHistoryRetentionDays}
        />
      </section>
    </main>
  )
}

function NotificationsHeader() {
  return (
    <header class="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-xl shadow-black/10">
      <p class="app-accent-text text-sm font-black uppercase tracking-[0.24em]">Notifications</p>
      <h1 class="mt-3 text-3xl font-black tracking-tight sm:text-4xl">通知 Webhook</h1>
      <p class="mt-2 text-sm text-[var(--app-muted)]">
        按本地时间推送当日 token 日报，可用于企微、钉钉、飞书和 Lark 群机器人。
      </p>
    </header>
  )
}

function NotificationFlash(props: {
  saved: boolean
  tested: boolean
  testFailed: boolean
  encryptionConfigured: boolean
}) {
  return (
    <>
      {!props.encryptionConfigured ? (
        <p class="app-flash-error p-3 text-sm">
          当前 Worker 未正确配置 WEBHOOK_ENCRYPTION_KEY，必须使用 32 字节 base64 key 才能保存或发送 webhook。
        </p>
      ) : null}
      {props.saved ? <p class="app-flash-success p-3 text-sm">通知设置已保存。</p> : null}
      {props.tested ? <p class="app-flash-success p-3 text-sm">测试预览通知已发送，内容使用当前配置和今日统计。</p> : null}
      {props.testFailed ? <p class="app-flash-error p-3 text-sm">测试预览通知发送失败，请检查 webhook 配置和最近错误。</p> : null}
    </>
  )
}

function SubscriptionsCard(props: { subscriptions: WebhookSubscriptionSummary[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>已配置 Webhook</CardTitle>
        <CardDescription>URL 和 secret 只加密保存，不会在页面回显。</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        {props.subscriptions.length > 0 ? (
          props.subscriptions.map((subscription) => <SubscriptionItem subscription={subscription} />)
        ) : (
          <p class="rounded-lg border border-dashed border-[var(--app-border)] p-4 text-sm text-[var(--app-muted)]">
            还没有通知 webhook。
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function SubscriptionItem(props: { subscription: WebhookSubscriptionSummary }) {
  return (
    <article class="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-4">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0">
          <p class="text-xs font-bold uppercase tracking-wide text-[var(--app-muted)]">{providerLabel(props.subscription.provider)}</p>
          <h2 class="mt-1 break-words text-lg font-black">{props.subscription.name}</h2>
          <p class="mt-1 break-all text-sm text-[var(--app-muted)]">{props.subscription.webhookUrlMasked}</p>
        </div>
        <span class={props.subscription.enabled ? 'app-status-pill app-status-pill-ok' : 'app-status-pill app-status-pill-warning'}>
          {props.subscription.enabled ? '已启用' : '已停用'}
        </span>
      </div>
      <SubscriptionForm subscription={props.subscription} />
    </article>
  )
}

function SubscriptionForm(props: { subscription: WebhookSubscriptionSummary }) {
  return (
    <form method="post" class="mt-4 grid gap-3 md:grid-cols-2">
      <input type="hidden" name="subscriptionId" value={props.subscription.id} />
      <Label>
        名称
        <Input name="name" value={props.subscription.name} required />
      </Label>
      <Label>
        时区
        <Input name="timezone" value={props.subscription.timezone} required />
      </Label>
      <ScheduleTimeFields scheduleTimesLocal={props.subscription.scheduleTimesLocal} />
      <ScheduleWeekdayFields scheduleWeekdays={props.subscription.scheduleWeekdays} />
      <SubscriptionChecks subscription={props.subscription} />
      <SubscriptionMeta subscription={props.subscription} />
      <SubscriptionActions subscription={props.subscription} />
    </form>
  )
}

function SubscriptionChecks(props: { subscription: WebhookSubscriptionSummary }) {
  return (
    <>
      <label class="flex min-h-11 items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-input)] px-3 text-sm font-bold text-[var(--app-text)]">
        <input type="checkbox" name="sendEmptyReport" checked={props.subscription.sendEmptyReport} />
        空日报也发送
      </label>
      <label class="flex min-h-11 items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-input)] px-3 text-sm font-bold text-[var(--app-text)] md:col-span-2">
        <input type="checkbox" name="enabled" checked={props.subscription.enabled} />
        启用定时推送
      </label>
    </>
  )
}

function SubscriptionMeta(props: { subscription: WebhookSubscriptionSummary }) {
  return (
    <dl class="grid gap-2 text-xs text-[var(--app-muted)] md:col-span-2 sm:grid-cols-2">
      <Meta label="推送规则" value={scheduleRuleLabel(props.subscription)} />
      <Meta label="下次推送" value={props.subscription.nextRunAt} />
      <Meta label="最近成功" value={props.subscription.lastSuccessAt ?? '无'} />
      <Meta label="最近失败" value={props.subscription.lastFailureAt ?? '无'} />
      <Meta label="错误" value={props.subscription.lastError ?? '无'} />
    </dl>
  )
}

function Meta(props: { label: string; value: string }) {
  return (
    <div>
      <dt class="font-bold uppercase tracking-wide">{props.label}</dt>
      <dd class="mt-1 break-all text-[var(--app-text)]">{props.value}</dd>
    </div>
  )
}

function SubscriptionActions(props: { subscription: WebhookSubscriptionSummary }) {
  return (
    <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap md:col-span-2">
      <Button class="w-full sm:w-auto" type="submit" name="action" value="update">保存</Button>
      <SubscriptionAction action="test">测试发送</SubscriptionAction>
      <SubscriptionAction action={props.subscription.enabled ? 'disable' : 'enable'}>
        {props.subscription.enabled ? '停用' : '启用'}
      </SubscriptionAction>
      <SubscriptionAction action="delete" confirm="确认删除这个 Webhook 通知配置？" variant="danger">删除</SubscriptionAction>
    </div>
  )
}

function SubscriptionAction(props: { action: string; children: string; confirm?: string; variant?: 'danger' }) {
  return (
    <button
      class={`min-h-11 rounded-xl border px-4 py-3 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 ${props.variant === 'danger'
        ? 'border-red-400/40 text-red-700 hover:bg-red-500/10 dark:text-red-300'
        : 'border-[var(--app-border)] text-[var(--app-text)] hover:border-lime-300'}`}
      type="submit"
      name="action"
      value={props.action}
      data-confirm={props.confirm}
    >
      {props.children}
    </button>
  )
}

function CreateSubscriptionCard(props: { timezone: string; disabled: boolean }) {
  return (
    <Card class="self-start">
      <CardHeader>
        <CardTitle>新增 Webhook</CardTitle>
        <CardDescription>仅支持官方机器人地址，避免把服务端变成任意转发器。</CardDescription>
      </CardHeader>
      <CardContent>
        <CreateSubscriptionForm {...props} />
      </CardContent>
    </Card>
  )
}

function CreateSubscriptionForm(props: { timezone: string; disabled: boolean }) {
  return (
    <form method="post" class="space-y-4">
      <input type="hidden" name="action" value="create" />
      <Label>
        名称
        <Input name="name" placeholder="每日日报" required disabled={props.disabled} />
      </Label>
      <ProviderSelect />
      <Label>
        Webhook URL
        <Input name="webhookUrl" type="url" placeholder="https://..." required disabled={props.disabled} />
      </Label>
      <Label>
        加签 secret (钉钉、飞书 / Lark 启用加签时填写)
        <Input name="signingSecret" type="password" autocomplete="new-password" disabled={props.disabled} />
      </Label>
      <Label>
        时区
        <Input name="timezone" value={props.timezone} required disabled={props.disabled} />
      </Label>
      <ScheduleTimeFields scheduleTimesLocal={['18:00']} disabled={props.disabled} />
      <ScheduleWeekdayFields scheduleWeekdays={defaultScheduleWeekdayValues()} disabled={props.disabled} />
      <CreateChecks disabled={props.disabled} />
      <Button class="w-full" type="submit" disabled={props.disabled}>保存 Webhook</Button>
    </form>
  )
}

function ProviderSelect() {
  return (
    <CustomSelect
      label="平台"
      name="provider"
      value="wecom"
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
      <label class="flex min-h-11 items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-input)] px-3 text-sm font-bold text-[var(--app-text)]">
        <input type="checkbox" name="sendEmptyReport" disabled={props.disabled} />
        空日报也发送
      </label>
      <label class="flex min-h-11 items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-input)] px-3 text-sm font-bold text-[var(--app-text)]">
        <input type="checkbox" name="enabled" checked disabled={props.disabled} />
        启用定时推送
      </label>
    </>
  )
}

function providerLabel(provider: string) {
  if (provider === 'wecom') return '企微'
  if (provider === 'dingtalk') return '钉钉'
  if (provider === 'feishu') return '飞书 / Lark'
  return provider
}
