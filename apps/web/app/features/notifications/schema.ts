import { z } from 'zod'
import { isValidTimezone } from '../../lib/timezone'
import {
  defaultWebhookScheduleTime,
  defaultWebhookScheduleWeekdays,
  normalizeScheduleTimes,
  normalizeScheduleWeekdays
} from './time'

export const maxWebhookScheduleTimes = 4

export const webhookProviderSchema = z.enum(['wecom', 'dingtalk', 'feishu'])

export const webhookScheduleTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const webhookScheduleWeekdaySchema = z.number().int().min(0).max(6)

export const webhookSubscriptionFormSchema = z.object({
  name: z.string().trim().min(1).max(80),
  provider: webhookProviderSchema,
  webhookUrl: z.string().trim().url().max(2048),
  signingSecret: z.string().trim().max(256).optional(),
  timezone: z.string().trim().min(1).max(80).refine(isValidTimezone, 'Invalid timezone'),
  scheduleTimeLocal: webhookScheduleTimeSchema,
  scheduleTimesLocal: z.array(webhookScheduleTimeSchema).min(1).max(maxWebhookScheduleTimes),
  scheduleWeekdays: z.array(webhookScheduleWeekdaySchema).min(1),
  sendEmptyReport: z.boolean(),
  enabled: z.boolean()
})

export type WebhookProvider = z.infer<typeof webhookProviderSchema>
export type WebhookSubscriptionForm = z.infer<typeof webhookSubscriptionFormSchema>

export type WebhookSubscriptionSummary = {
  id: string
  name: string
  provider: WebhookProvider
  webhookUrlHost: string
  webhookUrlMasked: string
  timezone: string
  scheduleTimeLocal: string
  scheduleTimesLocal: string[]
  scheduleWeekdays: number[]
  sendEmptyReport: boolean
  enabled: boolean
  nextRunAt: string
  pendingReportDate: string | null
  pendingScheduleSlot: string | null
  failureCount: number
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
  needsRepair?: boolean
}

export type ClaimedWebhookSubscription = WebhookSubscriptionSummary & {
  lockedAt: string | null
  dailyReportShareEnabled: boolean
}

export function parseWebhookSubscriptionForm(form: Record<string, unknown>): WebhookSubscriptionForm {
  const scheduleTimesLocal = scheduleTimesFromForm(form)
  const scheduleWeekdays = scheduleWeekdaysFromForm(form)
  return webhookSubscriptionFormSchema.parse({
    name: String(form.name ?? ''),
    provider: String(form.provider ?? ''),
    webhookUrl: String(form.webhookUrl ?? ''),
    signingSecret: String(form.signingSecret ?? '').trim() || undefined,
    timezone: String(form.timezone ?? 'UTC'),
    scheduleTimeLocal: scheduleTimesLocal[0],
    scheduleTimesLocal,
    scheduleWeekdays,
    sendEmptyReport: form.sendEmptyReport === 'on',
    enabled: form.enabled === 'on'
  })
}

export function scheduleTimesFromForm(form: Record<string, unknown>) {
  const scheduleTimes = normalizeScheduleTimes(
    form.scheduleTimesLocal ??
      form['scheduleTimesLocal[]'] ??
      form.scheduleTimeLocal ??
      defaultWebhookScheduleTime
  )
  if (scheduleTimes.length > maxWebhookScheduleTimes) {
    throw new Error('Invalid schedule time')
  }
  return scheduleTimes
}

export function scheduleWeekdaysFromForm(form: Record<string, unknown>) {
  const weekdays = form.scheduleWeekdays ?? form['scheduleWeekdays[]']
  if (String(form.scheduleWeekdaysTouched ?? '') === '1' && weekdays === undefined) {
    throw new Error('Invalid schedule weekday')
  }
  return normalizeScheduleWeekdays(
    weekdays ?? defaultWebhookScheduleWeekdays
  )
}
