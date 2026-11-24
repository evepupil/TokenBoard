import { AppNav } from '../../components/app-nav'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Input, Label } from '../../components/ui/input'
import { CreateSubscriptionForm } from './create-subscription-form'
import { DailyReportHistoryCard } from './report-history-card'
import type { DailyReportHistoryItem } from './report-history-item'
import { ScheduleTimeFields, ScheduleWeekdayFields, scheduleRuleLabel } from './schedule-fields'
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
  formErrorMessage?: string
  encryptionConfigured: boolean
}) {
  return (
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-8 sm:py-6">
      <title>通知 Webhook - TokenBoard</title>
      <AppNav active="notifications" email={props.email} />

      <section class="app-folio-container flex flex-col gap-10 pb-14">
        <NotificationsHeader />
        <NotificationFlash
          saved={props.saved}
          tested={props.tested}
          testFailed={props.testFailed}
          formErrorMessage={props.formErrorMessage}
          encryptionConfigured={props.encryptionConfigured}
        />
        <div class="app-folio-spread items-start">
          <div class="app-folio-spread-left min-w-0">
            <SubscriptionsCard subscriptions={props.subscriptions} />
          </div>
          <div class="app-folio-spread-right min-w-0">
            <CreateSubscriptionCard timezone={props.timezone} disabled={!props.encryptionConfigured} />
          </div>
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
    <header class="border-b border-[var(--app-border-strong)] pb-6">
      <p class="app-folio-kicker">06 — 每日日报推送 · WEBHOOK DISPATCH</p>
      <h1 class="app-folio-h2 mt-2">通知 Webhook</h1>
      <p class="mt-2 max-w-2xl text-sm text-[var(--app-muted)]">
        按本地时间推送当日 token 日报，可用于企微、钉钉、飞书和 Lark 群机器人。
      </p>
    </header>
  )
}

function NotificationFlash(props: {
  saved: boolean
  tested: boolean
  testFailed: boolean
  formErrorMessage?: string
  encryptionConfigured: boolean
}) {
  return (
    <>
      {!props.encryptionConfigured ? (
        <p class="app-flash-error p-3 text-sm">
          当前 Worker 未正确配置 Webhook 加密密钥，必须使用 32 字节 base64 key 才能保存或发送 webhook。
        </p>
      ) : null}
      {props.saved ? <p class="app-flash-success p-3 text-sm">通知设置已保存。</p> : null}
      {props.tested ? (
        <p class="app-flash-success p-3 text-sm">测试预览通知已发送，内容使用当前配置和今日统计。</p>
      ) : null}
      {props.testFailed ? (
        <p class="app-flash-error p-3 text-sm">测试预览通知发送失败，请检查 webhook 配置和最近错误。</p>
      ) : null}
      {props.formErrorMessage ? <p class="app-flash-error p-3 text-sm">{props.formErrorMessage}</p> : null}
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
          <p class="border border-dashed border-[var(--app-border)] bg-[var(--app-bg-soft)] p-5 text-sm text-[var(--app-muted)]">
            还没有通知 webhook。
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function SubscriptionItem(props: { subscription: WebhookSubscriptionSummary }) {
  return (
    <article class="border border-[var(--app-border)] bg-[var(--app-panel-strong)] p-4">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0">
          <p class="font-mono text-xs font-bold uppercase tracking-wide text-[var(--app-muted)]">
            {providerLabel(props.subscription.provider)}
          </p>
          <h2 class="mt-1 break-words text-lg font-extrabold">{props.subscription.name}</h2>
          <p class="mt-1 break-all font-mono text-xs text-[var(--app-muted)]">{props.subscription.webhookUrlMasked}</p>
        </div>
        <span
          class={
            props.subscription.enabled
              ? 'app-status-pill app-status-pill-ok'
              : 'app-status-pill app-status-pill-warning'
          }
        >
          {props.subscription.enabled ? '已启用' : '已停用'}
        </span>
      </div>
      {props.subscription.needsRepair ? (
        <p class="app-danger-notice mt-3 border p-3 text-xs font-bold">这个 Webhook 有旧格式字段，请检查后保存一次。</p>
      ) : null}
      <SubscriptionForm subscription={props.subscription} />
    </article>
  )
}

function SubscriptionForm(props: { subscription: WebhookSubscriptionSummary }) {
  return (
    <form method="post" class="mt-4 grid gap-3 md:grid-cols-2" data-submit-feedback="true">
      <input type="hidden" name="subscriptionId" value={props.subscription.id} />
      <Label>
        名称
        <Input name="name" value={props.subscription.name} autocomplete="off" required />
      </Label>
      <Label>
        时区
        <Input name="timezone" value={props.subscription.timezone} autocomplete="off" required />
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
      <label class="flex min-h-11 items-center gap-3 border border-[var(--app-border)] bg-[var(--app-input)] px-3 text-sm font-semibold text-[var(--app-text)]">
        <input
          class="accent-[var(--app-accent-bar)]"
          type="checkbox"
          name="sendEmptyReport"
          checked={props.subscription.sendEmptyReport}
        />
        空日报也发送
      </label>
      <label class="flex min-h-11 items-center gap-3 border border-[var(--app-border)] bg-[var(--app-input)] px-3 text-sm font-semibold text-[var(--app-text)] md:col-span-2">
        <input
          class="accent-[var(--app-accent-bar)]"
          type="checkbox"
          name="enabled"
          checked={props.subscription.enabled}
        />
        启用定时推送
      </label>
    </>
  )
}

function SubscriptionMeta(props: { subscription: WebhookSubscriptionSummary }) {
  return (
    <dl class="grid gap-2 border-t border-[var(--app-border)] pt-3 text-xs text-[var(--app-muted)] md:col-span-2 sm:grid-cols-2">
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
      <dt class="font-mono font-bold uppercase tracking-wide">{props.label}</dt>
      <dd class="mt-1 break-all font-mono text-[var(--app-text)]">{props.value}</dd>
    </div>
  )
}

function SubscriptionActions(props: { subscription: WebhookSubscriptionSummary }) {
  return (
    <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap md:col-span-2">
      <Button class="w-full sm:w-auto" type="submit" name="action" value="update" data-submitting-label="正在保存...">
        保存
      </Button>
      <SubscriptionAction action="test" submittingLabel="正在发送...">
        测试发送
      </SubscriptionAction>
      <SubscriptionAction
        action={props.subscription.enabled ? 'disable' : 'enable'}
        submittingLabel={props.subscription.enabled ? '正在停用...' : '正在启用...'}
      >
        {props.subscription.enabled ? '停用' : '启用'}
      </SubscriptionAction>
      <SubscriptionAction
        action="delete"
        confirm="确认删除这个 Webhook 通知配置？"
        submittingLabel="正在删除..."
        variant="danger"
      >
        删除
      </SubscriptionAction>
    </div>
  )
}

function SubscriptionAction(props: {
  action: string
  children: string
  confirm?: string
  submittingLabel?: string
  variant?: 'danger'
}) {
  return (
    <button
      class={`min-h-11 border px-4 py-2.5 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent-bar)] ${
        props.variant === 'danger'
          ? 'app-danger-action'
          : 'border-[var(--app-border-strong)] bg-[var(--app-panel-strong)] text-[var(--app-text)] hover:bg-[var(--app-text)] hover:text-[var(--app-bg)]'
      }`}
      type="submit"
      name="action"
      value={props.action}
      data-confirm={props.confirm}
      data-submitting-label={props.submittingLabel || '处理中...'}
      data-submitting-tone={props.variant}
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

function providerLabel(provider: string) {
  if (provider === 'wecom') return '企微'
  if (provider === 'dingtalk') return '钉钉'
  if (provider === 'feishu') return '飞书 / Lark'
  return provider
}
