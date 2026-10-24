import { ApiError } from '../../lib/errors'
import type { Bindings } from '../../lib/db'
import { NotificationFormError } from './errors'
import { webhookProviderSchema, type WebhookProvider } from './schema'

export type WebhookEnv = Pick<
  Bindings,
  | 'DB'
  | 'WEBHOOK_ENCRYPTION_KEY'
  | 'BETTER_AUTH_URL'
  | 'TOKENBOARD_DAILY_REPORT_HISTORY_DAYS'
  | 'TOKENBOARD_USAGE_SUMMARY_STRICT'
  | 'TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE'
  | 'TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS'
>

export const defaultWebhookLogRetentionDays = 90
export const maxWebhookLogRetentionDays = 365
export const defaultWebhookCronBatchSize = 5
// The ceiling exists to bound one cron invocation (each delivery is a network fetch plus D1
// statements), but pinning it equal to the default left operators no room to drain a backlog
// after downtime without editing code. 50 keeps a single invocation bounded while allowing
// the env var to trade throughput for catch-up speed.
export const maxWebhookCronBatchSize = 50

// Every subscription a user creates is a standing cron delivery target with its own history
// rows, so an uncapped account can crowd the shared cron batch and grow D1 without limit. The
// settings UI manages one subscription at a time; a legitimate account stays far below this.
export const maxWebhookSubscriptionsPerUser = 20

// The variable name and the reason a key is rejected are operator diagnostics, not user-facing
// copy. This Worker hosts many accounts, and any signed-in user can POST to the notifications
// settings route, so whatever message the error carries is readable by them: naming
// `WEBHOOK_ENCRYPTION_KEY` tells a stranger how the deployment is wired, and an unconfigured
// deployment answers that way for every account on it. Splitting the actionable reason onto
// `diagnostic` lets each boundary choose — the HTTP error body stays generic (jsonError echoes
// `message`), while the delivery logs keep the detail an operator needs to fix it.
export class WebhookConfigurationError extends ApiError {
  constructor(readonly diagnostic: string) {
    super('INTERNAL_SERVER_ERROR', 'Internal server error', 500)
  }
}

// For log paths that only have an `unknown` error and must not lose the diagnostic.
export function webhookDiagnostic(error: unknown) {
  return error instanceof WebhookConfigurationError ? error.diagnostic : null
}

export function webhookLogRetentionDays(env: Pick<WebhookEnv, 'TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS'>) {
  if (env.TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS === undefined) {
    return defaultWebhookLogRetentionDays
  }
  const raw = env.TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS.trim()
  if (!raw || !/^\d+$/.test(raw)) throw invalidWebhookLogRetentionError()
  const days = Number(raw)
  if (!Number.isSafeInteger(days) || days < 1 || days > maxWebhookLogRetentionDays) {
    throw invalidWebhookLogRetentionError()
  }
  return days
}

export function webhookCronBatchSize(env: Pick<WebhookEnv, 'TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE'>) {
  if (env.TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE === undefined) {
    return defaultWebhookCronBatchSize
  }
  const raw = env.TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE.trim()
  if (!raw || !/^\d+$/.test(raw)) throw invalidWebhookCronBatchSizeError()
  const size = Number(raw)
  if (!Number.isSafeInteger(size) || size < 1 || size > maxWebhookCronBatchSize) {
    throw invalidWebhookCronBatchSizeError()
  }
  return size
}

// Only the first tick of the UTC day (00:00–00:15 with the 15-minute cron), matching the
// daily maintenance window that gates the rate-limit and device-retention prunes in
// server.ts. A tighter cron would re-enter this window within hour 0.
export function shouldPruneWebhookDeliveryLogs(now: Date) {
  return now.getUTCHours() === 0 && now.getUTCMinutes() < 15
}

export function requireEncryptionKey(env: Pick<WebhookEnv, 'WEBHOOK_ENCRYPTION_KEY'>) {
  const secret = env.WEBHOOK_ENCRYPTION_KEY?.trim()
  if (!secret) {
    throw new WebhookConfigurationError('WEBHOOK_ENCRYPTION_KEY is not configured')
  }
  if (decodeEncryptionKey(secret).length !== 32) {
    throw new WebhookConfigurationError('WEBHOOK_ENCRYPTION_KEY must be a 32-byte base64 secret')
  }
  return secret
}

export function hasValidEncryptionKey(env: Pick<WebhookEnv, 'WEBHOOK_ENCRYPTION_KEY'>) {
  try {
    requireEncryptionKey(env)
    return true
  } catch (_) {
    return false
  }
}

export function decodeEncryptionKey(secret: string) {
  const normalized = secret.trim().replaceAll('-', '+').replaceAll('_', '/')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new WebhookConfigurationError('WEBHOOK_ENCRYPTION_KEY must be a 32-byte base64 secret')
  }
  try {
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch (_) {
    throw new WebhookConfigurationError('WEBHOOK_ENCRYPTION_KEY must be a 32-byte base64 secret')
  }
}

export function parseProviderWebhookUrl(provider: WebhookProvider, value: string) {
  const parsedProvider = webhookProviderSchema.parse(provider)
  const url = new URL(value)
  if (url.protocol !== 'https:') {
    throw new NotificationFormError('webhook-url-must-use-https')
  }

  const allowed = providerHostRules[parsedProvider]
  if (!allowed(url)) {
    throw new NotificationFormError('webhook-url-not-supported')
  }
  return url
}

export function maskWebhookUrl(url: URL) {
  return `${url.host}/...`
}

export function publicLeaderboardUrl(env: Pick<WebhookEnv, 'BETTER_AUTH_URL'>) {
  const origin = env.BETTER_AUTH_URL?.replace(/\/$/, '')
  return origin ? `${origin}/leaderboards` : '/leaderboards'
}

const providerHostRules: Record<WebhookProvider, (url: URL) => boolean> = {
  wecom: (url) =>
    url.host === 'qyapi.weixin.qq.com' && url.pathname === '/cgi-bin/webhook/send' && hasQueryToken(url, 'key'),
  dingtalk: (url) =>
    url.host === 'oapi.dingtalk.com' && url.pathname === '/robot/send' && hasQueryToken(url, 'access_token'),
  feishu: (url) =>
    ['open.feishu.cn', 'open.larksuite.com'].includes(url.host) && hasPathToken(url, '/open-apis/bot/v2/hook/')
}

function hasQueryToken(url: URL, name: string) {
  return Boolean(url.searchParams.get(name)?.trim())
}

function hasPathToken(url: URL, prefix: string) {
  if (!url.pathname.startsWith(prefix)) return false
  const token = url.pathname.slice(prefix.length).trim()
  return Boolean(token) && !token.includes('/')
}

function invalidWebhookLogRetentionError() {
  return new Error(`TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS must be an integer from 1 to ${maxWebhookLogRetentionDays}`)
}

function invalidWebhookCronBatchSizeError() {
  return new Error(`TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE must be an integer from 1 to ${maxWebhookCronBatchSize}`)
}
