import { ApiError } from '../../lib/errors'
import type { Bindings } from '../../lib/db'
import { webhookProviderSchema, type WebhookProvider } from './schema'

export type WebhookEnv = Pick<
  Bindings,
  | 'DB'
  | 'WEBHOOK_ENCRYPTION_KEY'
  | 'BETTER_AUTH_URL'
  | 'TOKENBOARD_DAILY_REPORT_HISTORY_DAYS'
  | 'TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS'
>

export const defaultWebhookLogRetentionDays = 90
export const maxWebhookLogRetentionDays = 365

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

export function requireEncryptionKey(env: Pick<WebhookEnv, 'WEBHOOK_ENCRYPTION_KEY'>) {
  const secret = env.WEBHOOK_ENCRYPTION_KEY?.trim()
  if (!secret) {
    throw new ApiError('INTERNAL_SERVER_ERROR', 'WEBHOOK_ENCRYPTION_KEY is not configured', 500)
  }
  if (decodeEncryptionKey(secret).length !== 32) {
    throw new ApiError('INTERNAL_SERVER_ERROR', 'WEBHOOK_ENCRYPTION_KEY must be a 32-byte base64 secret', 500)
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
    throw new ApiError('INTERNAL_SERVER_ERROR', 'WEBHOOK_ENCRYPTION_KEY must be a 32-byte base64 secret', 500)
  }
  try {
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch (_) {
    throw new ApiError('INTERNAL_SERVER_ERROR', 'WEBHOOK_ENCRYPTION_KEY must be a 32-byte base64 secret', 500)
  }
}

export function parseProviderWebhookUrl(provider: WebhookProvider, value: string) {
  const parsedProvider = webhookProviderSchema.parse(provider)
  const url = new URL(value)
  if (url.protocol !== 'https:') {
    throw new ApiError('BAD_REQUEST', 'Webhook URL must use HTTPS', 400)
  }

  const allowed = providerHostRules[parsedProvider]
  if (!allowed(url)) {
    throw new ApiError('BAD_REQUEST', 'Webhook URL host or path is not supported for this provider', 400)
  }
  return url
}

export function maskWebhookUrl(url: URL) {
  return `${url.host}/...`
}

export function dashboardUrl(env: Pick<WebhookEnv, 'BETTER_AUTH_URL'>) {
  const origin = env.BETTER_AUTH_URL?.replace(/\/$/, '')
  return origin ? `${origin}/dashboard` : '/dashboard'
}

const providerHostRules: Record<WebhookProvider, (url: URL) => boolean> = {
  wecom: (url) => (
    url.host === 'qyapi.weixin.qq.com' &&
    url.pathname === '/cgi-bin/webhook/send' &&
    hasQueryToken(url, 'key')
  ),
  dingtalk: (url) => (
    url.host === 'oapi.dingtalk.com' &&
    url.pathname === '/robot/send' &&
    hasQueryToken(url, 'access_token')
  ),
  feishu: (url) => (
    ['open.feishu.cn', 'open.larksuite.com'].includes(url.host) &&
    hasPathToken(url, '/open-apis/bot/v2/hook/')
  )
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
