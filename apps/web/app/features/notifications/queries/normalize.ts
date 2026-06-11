import type { WebhookProvider, WebhookSubscriptionSummary } from '../schema'
import {
  defaultWebhookScheduleTime,
  defaultWebhookScheduleWeekdays,
  normalizeScheduleTimes,
  normalizeScheduleWeekdays
} from '../time'
import type {
  WebhookSubscriptionRow,
  WebhookSubscriptionSecretDbRow,
  WebhookSubscriptionSecretRow
} from './types'

export function normalizeSecretRow(row: WebhookSubscriptionSecretDbRow): WebhookSubscriptionSecretRow {
  return {
    ...normalizeSubscriptionSummary(row),
    lockedAt: row.lockedAt ?? null,
    userId: row.userId,
    displayName: row.displayName,
    dailyReportShareEnabled: Boolean(row.dailyReportShareEnabled),
    webhookUrlEncrypted: row.webhookUrlEncrypted,
    signingSecretEncrypted: row.signingSecretEncrypted ?? null
  }
}

export function normalizeSubscriptionSummary(row: WebhookSubscriptionRow): WebhookSubscriptionSummary {
  const scheduleTimesLocal = normalizeScheduleTimes(row.scheduleTimesLocal ?? row.scheduleTimeLocal)
  return {
    ...row,
    provider: row.provider as WebhookProvider,
    scheduleTimeLocal: scheduleTimesLocal[0],
    scheduleTimesLocal,
    scheduleWeekdays: normalizeScheduleWeekdays(row.scheduleWeekdays),
    sendEmptyReport: Boolean(row.sendEmptyReport),
    enabled: Boolean(row.enabled),
    pendingReportDate: row.pendingReportDate ?? null,
    pendingScheduleSlot: row.pendingScheduleSlot ?? null,
    failureCount: Number(row.failureCount ?? 0),
    lastSuccessAt: row.lastSuccessAt ?? null,
    lastFailureAt: row.lastFailureAt ?? null,
    lastError: row.lastError ?? null
  }
}

export function normalizeSettingsSubscriptionSummary(
  row: WebhookSubscriptionRow
): WebhookSubscriptionSummary {
  const scheduleTimes = normalizeSettingsScheduleTimes(row)
  const scheduleWeekdays = normalizeSettingsScheduleWeekdays(row)
  return {
    ...row,
    provider: row.provider as WebhookProvider,
    scheduleTimeLocal: scheduleTimes.values[0],
    scheduleTimesLocal: scheduleTimes.values,
    scheduleWeekdays: scheduleWeekdays.values,
    sendEmptyReport: Boolean(row.sendEmptyReport),
    enabled: Boolean(row.enabled),
    pendingReportDate: row.pendingReportDate ?? null,
    pendingScheduleSlot: row.pendingScheduleSlot ?? null,
    failureCount: Number(row.failureCount ?? 0),
    lastSuccessAt: row.lastSuccessAt ?? null,
    lastFailureAt: row.lastFailureAt ?? null,
    lastError: row.lastError ?? null,
    needsRepair: scheduleTimes.needsRepair || scheduleWeekdays.needsRepair
  }
}

function normalizeSettingsScheduleTimes(row: WebhookSubscriptionRow) {
  const storedValue = isEmptyScheduleValue(row.scheduleTimesLocal)
    ? row.scheduleTimeLocal
    : row.scheduleTimesLocal
  try {
    return {
      values: normalizeScheduleTimes(storedValue),
      needsRepair:
        isEmptyScheduleValue(row.scheduleTimesLocal) ||
        isEmptyScheduleValue(storedValue)
    }
  } catch {
    return normalizeLegacyScheduleTime(row.scheduleTimeLocal)
  }
}

function normalizeLegacyScheduleTime(value: unknown) {
  try {
    return {
      values: normalizeScheduleTimes(value),
      needsRepair: true
    }
  } catch {
    return {
      values: [defaultWebhookScheduleTime],
      needsRepair: true
    }
  }
}

function normalizeSettingsScheduleWeekdays(row: WebhookSubscriptionRow) {
  try {
    return {
      values: normalizeScheduleWeekdays(row.scheduleWeekdays),
      needsRepair: isEmptyScheduleValue(row.scheduleWeekdays)
    }
  } catch {
    return {
      values: defaultWebhookScheduleWeekdays,
      needsRepair: true
    }
  }
}

function isEmptyScheduleValue(value: unknown) {
  return value === null || value === undefined || String(value).trim() === ''
}
