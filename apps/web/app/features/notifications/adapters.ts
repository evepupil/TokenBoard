import { formatUsd } from '../../lib/money'
import { cacheReadRateFromTotals, formatPercentRate } from '../../lib/usage-metrics'
import type { WebhookProvider } from './schema'

export type DailyTokenReport = {
  displayName: string
  reportDate: string
  timezone: string
  dashboardUrl: string
  reportUrl?: string
  previewLabel?: string
  totalTokens: number
  totalTokensWithoutCacheRead: number
  cacheReadRate?: number
  costUsd: number
  sessionCount: number
  sourceSplit: Array<{
    source: string
    totalTokens: number
    totalTokensWithoutCacheRead: number
    cacheReadRate?: number
  }>
  topModels: Array<{
    model: string
    totalTokens: number
    totalTokensWithoutCacheRead: number
    cacheReadRate?: number
    costUsd: number
  }>
}

export type WebhookPayload = {
  url: string
  body: unknown
}

export async function buildWebhookPayload(input: {
  provider: WebhookProvider
  webhookUrl: string
  signingSecret?: string | null
  report: DailyTokenReport
  now: Date
}) {
  const text = formatDailyReport(input.report)
  const title = reportTitle(input.report)

  if (input.provider === 'dingtalk') {
    return {
      url: await signedDingTalkUrl(input.webhookUrl, input.signingSecret, input.now),
      body: {
        msgtype: 'markdown',
        markdown: {
          title,
          text
        }
      }
    } satisfies WebhookPayload
  }

  if (input.provider === 'feishu') {
    const signature = await feishuSignature(input.signingSecret, input.now)
    return {
      url: input.webhookUrl,
      body: {
        ...signature,
        msg_type: 'interactive',
        card: {
          schema: '2.0',
          header: {
            title: {
              tag: 'plain_text',
              content: title
            }
          },
          body: {
            elements: [
              {
                tag: 'markdown',
                content: text
              }
            ]
          }
        }
      }
    } satisfies WebhookPayload
  }

  return {
    url: input.webhookUrl,
    body: {
      msgtype: 'markdown',
      markdown: {
        content: text
      }
    }
  } satisfies WebhookPayload
}

export function formatDailyReport(report: DailyTokenReport) {
  const lines = [
    `## ${reportTitle(report)}`,
    `日期：${report.reportDate}`,
    '',
    `${report.displayName} 在 ${report.reportDate} 共消耗 ${formatInteger(report.totalTokens)} token，去掉缓存读后为 ${formatInteger(report.totalTokensWithoutCacheRead)} token，缓存率 ${formatReportCacheRate(report)}。`,
    `预估费用 ${formatUsd(report.costUsd)}，共完成 ${formatInteger(report.sessionCount)} 个会话。`,
    '',
    '主要来源',
    ...formatSourceSplit(report),
    '',
    '主要模型',
    ...formatTopModels(report),
    '',
    `统计时区：${report.timezone}`,
    report.reportUrl
      ? `[查看本次日报](${report.reportUrl})`
      : `[打开 TokenBoard](${report.dashboardUrl})`
  ]

  return lines.join('\n')
}

function reportTitle(report: DailyTokenReport) {
  const title = `${report.displayName} token 日报 ${report.reportDate}`
  return report.previewLabel
    ? `${report.previewLabel}：${title}`
    : title
}

function formatSourceSplit(report: DailyTokenReport) {
  if (report.sourceSplit.length === 0) return ['暂无数据']
  return report.sourceSplit.map((item) => (
    `- ${formatSource(item.source)}：${formatInteger(item.totalTokensWithoutCacheRead)} token，含缓存读 ${formatInteger(item.totalTokens)} token，缓存率 ${formatReportCacheRate(item)}`
  ))
}

function formatTopModels(report: DailyTokenReport) {
  if (report.topModels.length === 0) return ['暂无数据']
  return report.topModels.map((item) => (
    `- ${item.model}：${formatInteger(item.totalTokensWithoutCacheRead)} token，缓存率 ${formatReportCacheRate(item)}，${formatUsd(item.costUsd)}`
  ))
}

function formatReportCacheRate(input: {
  totalTokens: number
  totalTokensWithoutCacheRead: number
  cacheReadRate?: number
}) {
  return formatPercentRate(input.cacheReadRate ?? cacheReadRateFromTotals(input))
}

function formatInteger(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

function formatSource(source: string) {
  if (source === 'claude-code') return 'Claude Code'
  if (source === 'codex') return 'Codex'
  return source
}

async function signedDingTalkUrl(url: string, secret: string | null | undefined, now: Date) {
  if (!secret) return url
  const timestamp = String(now.getTime())
  const sign = await hmacSha256Base64(`${timestamp}\n${secret}`, secret)
  const value = new URL(url)
  value.searchParams.set('timestamp', timestamp)
  value.searchParams.set('sign', sign)
  return value.toString()
}

async function feishuSignature(secret: string | null | undefined, now: Date) {
  if (!secret) return {}
  const timestamp = String(Math.floor(now.getTime() / 1000))
  const sign = await hmacSha256Base64('', `${timestamp}\n${secret}`)
  return { timestamp, sign }
}

async function hmacSha256Base64(message: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return base64Encode(new Uint8Array(signature))
}

function base64Encode(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}
