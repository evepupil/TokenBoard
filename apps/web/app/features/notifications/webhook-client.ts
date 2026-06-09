import { decryptSecret } from './crypto'
import { buildWebhookPayload } from './adapters'
import type { WebhookEnv } from './config'
import { parseProviderWebhookUrl, requireEncryptionKey } from './config'
import { getDailyTokenReport } from './report-queries'
import type { DueWebhookSubscription } from './queries'

type Fetcher = typeof fetch
const webhookRequestTimeoutMs = 10_000
const webhookResponseTextMaxBytes = 4096
const webhookResponseTextTruncatedSuffix = '...[truncated]'

export async function sendWebhookRequest(input: {
  env: WebhookEnv
  subscription: DueWebhookSubscription
  report: Awaited<ReturnType<typeof getDailyTokenReport>>
  now: Date
  fetcher: Fetcher
}) {
  const encryptionKey = requireEncryptionKey(input.env)
  const webhookUrl = parseProviderWebhookUrl(
    input.subscription.provider,
    await decryptSecret(input.subscription.webhookUrlEncrypted, encryptionKey)
  )
  const payload = await buildWebhookPayload({
    provider: input.subscription.provider,
    webhookUrl: webhookUrl.toString(),
    signingSecret: input.subscription.signingSecretEncrypted
      ? await decryptSecret(input.subscription.signingSecretEncrypted, encryptionKey)
      : null,
    report: input.report,
    now: input.now
  })
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), webhookRequestTimeoutMs)
  try {
    const fetcher = input.fetcher
    const response = await fetcher(payload.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload.body),
      signal: controller.signal
    })
    const responseText = await safeResponseText(response)
    if (!response.ok) throw new WebhookHttpError(response.status, responseText)
    assertWebhookBusinessResponse(responseText)
    return response
  } finally {
    clearTimeout(timeoutId)
  }
}

export function deliveryHttpStatus(error: unknown) {
  return error instanceof WebhookHttpError ? error.status : null
}

function assertWebhookBusinessResponse(text: string) {
  if (!text.trim()) return
  try {
    const data = JSON.parse(text) as {
      errcode?: unknown
      errorcode?: unknown
      code?: unknown
      StatusCode?: unknown
      statusCode?: unknown
      errmsg?: unknown
      msg?: unknown
      StatusMessage?: unknown
      statusMessage?: unknown
      message?: unknown
    }
    const code = firstCode(data.errcode, data.errorcode, data.code, data.StatusCode, data.statusCode)
    if (code !== null && code.value !== 0) {
      throw new Error(`Webhook returned application code ${code.raw}: ${firstString(data.errmsg, data.msg, data.StatusMessage, data.statusMessage, data.message) ?? 'unknown error'}`)
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Webhook returned non-JSON response')
    }
    throw error
  }
}

function firstCode(...values: Array<unknown>) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return { value, raw: String(value) }
    }
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
      return { value: Number(value.trim()), raw: value.trim() }
    }
  }
  return null
}

function firstString(...values: Array<unknown>) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

async function safeResponseText(response: Response) {
  try {
    return await readBoundedResponseText(response)
  } catch (_) {
    return ''
  }
}

async function readBoundedResponseText(response: Response) {
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytesRead = 0
  let truncated = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const remaining = webhookResponseTextMaxBytes - bytesRead
      if (value.byteLength > remaining) {
        text += decoder.decode(value.slice(0, remaining), { stream: true })
        bytesRead += remaining
        truncated = true
        await reader.cancel()
        break
      }

      text += decoder.decode(value, { stream: true })
      bytesRead += value.byteLength
      if (bytesRead === webhookResponseTextMaxBytes) {
        truncated = true
        await reader.cancel()
        break
      }
    }
  } finally {
    reader.releaseLock()
  }

  text += decoder.decode()
  return truncated ? `${text}${webhookResponseTextTruncatedSuffix}` : text
}

class WebhookHttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`Webhook returned ${status}${body ? `: ${body}` : ''}`)
  }
}
