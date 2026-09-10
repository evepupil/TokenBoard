import { cacheReadRateFromTotals, formatPercentRate } from '../../lib/usage-metrics'
import {
  formatCostWithAvailability,
  formatModelCostWithAvailability,
  formatSource,
  formatSourceCostNote
} from '../usage/source-format'
import type { WebhookProvider } from './schema'

const wecomMarkdownMaxBytes = 4096
const wecomListLimit = 3
const wecomTruncatedSuffix = '\n\n<font color="comment">内容已截断，请打开 TokenBoard 查看更多统计。</font>'
const dingtalkActionCardMaxBytes = 20_000
const dingtalkListLimit = 3
const dingtalkTruncatedSuffix = '\n\n内容已截断，请打开 TokenBoard 查看更多统计。'
const dingtalkLinkSeparator = '\n\n'
const feishuTitleMaxBytes = 512
const feishuMarkdownMaxBytes = 14 * 1024
const feishuTruncatedSuffix = '\n\n内容已截断，请打开 TokenBoard 查看更多统计。'

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
    sourceSplit?: Array<{ source: string }>
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
  if (input.provider === 'dingtalk') {
    return {
      url: await signedDingTalkUrl(input.webhookUrl, input.signingSecret, input.now),
      body: {
        msgtype: 'actionCard',
        actionCard: {
          title: dingtalkReportTitle(input.report),
          text: formatDingTalkDailyReport(input.report),
          btnOrientation: '0',
          singleTitle: input.report.reportUrl ? '打开日报详情' : '查看排行榜',
          singleURL: input.report.reportUrl ?? input.report.dashboardUrl
        }
      }
    } satisfies WebhookPayload
  }

  if (input.provider === 'feishu') {
    const signature = await feishuSignature(input.signingSecret, input.now)
    const feishuTitle = truncateUtf8(`TokenBoard：${reportTitleWithoutDate(input.report)}`, feishuTitleMaxBytes, '...')
    const feishuText = truncateUtf8(
      formatFeishuDailyReport(input.report),
      feishuMarkdownMaxBytes,
      feishuTruncatedSuffix
    )
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
              content: feishuTitle
            }
          },
          body: {
            elements: [
              {
                tag: 'markdown',
                content: feishuText
              },
              {
                tag: 'button',
                text: {
                  tag: 'plain_text',
                  content: input.report.reportUrl ? '打开日报详情' : '查看排行榜'
                },
                type: 'primary',
                behaviors: [
                  {
                    type: 'open_url',
                    default_url: input.report.reportUrl ?? input.report.dashboardUrl
                  }
                ]
              }
            ]
          }
        }
      }
    } satisfies WebhookPayload
  }

  const text = formatWeComDailyReport(input.report)
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

export function formatWeComDailyReport(report: DailyTokenReport) {
  const lines = [
    `## ${formatWeComTitle(report)}`,
    `<font color="comment">${escapeWeComMarkdownText(report.reportDate)} / ${escapeWeComMarkdownText(report.timezone)}</font>`,
    '',
    `> 总消耗：<font color="info">${formatInteger(report.totalTokens)} token</font>`,
    `> 去缓存读：<font color="info">${formatInteger(report.totalTokensWithoutCacheRead)} token</font>`,
    `> 缓存率：<font color="comment">${formatReportCacheRate(report)}</font>`,
    `> 费用：<font color="warning">${escapeWeComMarkdownText(formatCostWithAvailability(report.costUsd, report.sourceSplit))}</font> / 会话：${formatInteger(report.sessionCount)}`,
    '',
    '**主要来源**',
    ...formatWeComSourceSplit(report),
    '',
    '**主要模型**',
    ...formatWeComTopModels(report),
    '',
    report.reportUrl ? `[打开日报详情](${report.reportUrl})` : `[查看排行榜](${report.dashboardUrl})`
  ]

  return truncateUtf8(lines.join('\n'), wecomMarkdownMaxBytes, wecomTruncatedSuffix)
}

export function formatDingTalkDailyReport(report: DailyTokenReport) {
  const link = dingtalkReportLink(report)
  const bodyLines = [
    `## ${escapeDingTalkMarkdownText(dingtalkReportTitle(report))}`,
    `日期：${escapeDingTalkMarkdownText(report.reportDate)} / ${escapeDingTalkMarkdownText(report.timezone)}`,
    '',
    `**总消耗**：${formatInteger(report.totalTokens)} token  `,
    `**去缓存读**：${formatInteger(report.totalTokensWithoutCacheRead)} token  `,
    `**缓存率**：${formatReportCacheRate(report)}  `,
    `**费用**：${formatCostWithAvailability(report.costUsd, report.sourceSplit)} / 会话：${formatInteger(report.sessionCount)}`,
    '',
    '**主要来源**',
    ...formatDingTalkSourceSplit(report),
    '',
    '**主要模型**',
    ...formatDingTalkTopModels(report)
  ]
  const linkBudget = new TextEncoder().encode(`${dingtalkLinkSeparator}${link}`).byteLength
  const bodyMaxBytes = Math.max(0, dingtalkActionCardMaxBytes - linkBudget)
  const body = truncateUtf8(bodyLines.join('\n'), bodyMaxBytes, dingtalkTruncatedSuffix)

  return `${body}${dingtalkLinkSeparator}${link}`
}

function formatFeishuDailyReport(report: DailyTokenReport) {
  const lines = [
    `> ${report.reportDate} / ${report.timezone}`,
    `> **总消耗**：${formatInteger(report.totalTokens)} token`,
    `> **去缓存读**：${formatInteger(report.totalTokensWithoutCacheRead)} token`,
    `> **缓存率**：${formatReportCacheRate(report)}`,
    `> **费用**：${formatCostWithAvailability(report.costUsd, report.sourceSplit)} / 会话：${formatInteger(report.sessionCount)}`,
    '',
    '**主要来源**',
    ...formatFeishuSourceSplit(report),
    '',
    '**主要模型**',
    ...formatFeishuTopModels(report)
  ]

  return lines.join('\n')
}

export function formatDailyReport(report: DailyTokenReport) {
  const lines = [
    `## ${reportTitle(report)}`,
    `日期：${report.reportDate}`,
    '',
    `${report.displayName} 在 ${report.reportDate} 共消耗 ${formatInteger(report.totalTokens)} token，去掉缓存读后为 ${formatInteger(report.totalTokensWithoutCacheRead)} token，缓存率 ${formatReportCacheRate(report)}。`,
    `预估费用 ${formatCostWithAvailability(report.costUsd, report.sourceSplit)}，共完成 ${formatInteger(report.sessionCount)} 个会话。`,
    '',
    '主要来源',
    ...formatSourceSplit(report),
    '',
    '主要模型',
    ...formatTopModels(report),
    '',
    `统计时区：${report.timezone}`,
    report.reportUrl ? `[查看本次日报](${report.reportUrl})` : `[查看排行榜](${report.dashboardUrl})`
  ]

  return lines.join('\n')
}

function reportTitle(report: DailyTokenReport) {
  const title = `${report.displayName} token 日报 ${report.reportDate}`
  return report.previewLabel ? `${report.previewLabel}：${title}` : title
}

function dingtalkReportTitle(report: DailyTokenReport) {
  return `TokenBoard：${reportTitleWithoutDate(report)}`
}

function formatWeComTitle(report: DailyTokenReport) {
  const label = report.previewLabel ? `${report.previewLabel}：` : ''
  return `${escapeWeComMarkdownText(label)}${escapeWeComMarkdownText(report.displayName)} token 日报`
}

function reportTitleWithoutDate(report: DailyTokenReport) {
  const title = `${report.displayName} token 日报`
  return report.previewLabel ? `${report.previewLabel}：${title}` : title
}

function formatWeComSourceSplit(report: DailyTokenReport) {
  if (report.sourceSplit.length === 0) return ['暂无数据']
  const items = report.sourceSplit
    .slice(0, wecomListLimit)
    .flatMap((item) => [
      `- **${escapeWeComMarkdownText(formatSource(item.source))}**：${formatInteger(item.totalTokensWithoutCacheRead)} token`,
      `  <font color="comment">含缓存读 ${formatInteger(item.totalTokens)} / 缓存率 ${formatReportCacheRate(item)}${formatSourceCostSuffix(item.source)}</font>`
    ])
  return appendHiddenCount(items, report.sourceSplit.length)
}

function formatWeComTopModels(report: DailyTokenReport) {
  if (report.topModels.length === 0) return ['暂无数据']
  const items = report.topModels
    .slice(0, wecomListLimit)
    .flatMap((item) => [
      `- **${escapeWeComMarkdownText(item.model)}**：${formatInteger(item.totalTokensWithoutCacheRead)} token / <font color="warning">${escapeWeComMarkdownText(formatModelCost(item, report))}</font>`,
      `  <font color="comment">缓存率 ${formatReportCacheRate(item)}</font>`
    ])
  return appendHiddenCount(items, report.topModels.length)
}

function appendHiddenCount(items: string[], total: number) {
  const hidden = total - wecomListLimit
  return hidden > 0 ? [...items, `<font color="comment">其余 ${hidden} 项请打开 TokenBoard 查看。</font>`] : items
}

function appendDingTalkHiddenCount(items: string[], total: number) {
  const hidden = total - dingtalkListLimit
  return hidden > 0 ? [...items, `- 其余 ${hidden} 项请打开 TokenBoard 查看。`] : items
}

function dingtalkReportLink(report: DailyTokenReport) {
  return report.reportUrl ? `[打开日报详情](${report.reportUrl})` : `[查看排行榜](${report.dashboardUrl})`
}

function formatDingTalkSourceSplit(report: DailyTokenReport) {
  if (report.sourceSplit.length === 0) return ['暂无数据']
  const items = report.sourceSplit
    .slice(0, dingtalkListLimit)
    .flatMap((item) => [
      `- **${escapeDingTalkMarkdownText(formatSource(item.source))}**：${formatInteger(item.totalTokensWithoutCacheRead)} token`,
      `  - 含缓存读 ${formatInteger(item.totalTokens)} token / 缓存率 ${formatReportCacheRate(item)}${formatSourceCostSuffix(item.source)}`
    ])
  return appendDingTalkHiddenCount(items, report.sourceSplit.length)
}

function formatDingTalkTopModels(report: DailyTokenReport) {
  if (report.topModels.length === 0) return ['暂无数据']
  const items = report.topModels
    .slice(0, dingtalkListLimit)
    .flatMap((item) => [
      `- **${escapeDingTalkMarkdownText(item.model)}**：${formatInteger(item.totalTokensWithoutCacheRead)} token / ${formatModelCost(item, report)}`,
      `  - 缓存率 ${formatReportCacheRate(item)}`
    ])
  return appendDingTalkHiddenCount(items, report.topModels.length)
}

function formatFeishuSourceSplit(report: DailyTokenReport) {
  if (report.sourceSplit.length === 0) return ['暂无数据']
  const items = report.sourceSplit
    .slice(0, wecomListLimit)
    .flatMap((item) => [
      `- **${formatSource(item.source)}**：${formatInteger(item.totalTokensWithoutCacheRead)} token`,
      `  - 含缓存读 ${formatInteger(item.totalTokens)} token / 缓存率 ${formatReportCacheRate(item)}${formatSourceCostSuffix(item.source)}`
    ])
  return appendFeishuHiddenCount(items, report.sourceSplit.length)
}

function formatFeishuTopModels(report: DailyTokenReport) {
  if (report.topModels.length === 0) return ['暂无数据']
  const items = report.topModels
    .slice(0, wecomListLimit)
    .flatMap((item) => [
      `- **${item.model}**：${formatInteger(item.totalTokensWithoutCacheRead)} token / ${formatModelCost(item, report)}`,
      `  - 缓存率 ${formatReportCacheRate(item)}`
    ])
  return appendFeishuHiddenCount(items, report.topModels.length)
}

function appendFeishuHiddenCount(items: string[], total: number) {
  const hidden = total - wecomListLimit
  return hidden > 0 ? [...items, `其余 ${hidden} 项请打开 TokenBoard 查看。`] : items
}

function formatSourceSplit(report: DailyTokenReport) {
  if (report.sourceSplit.length === 0) return ['暂无数据']
  return report.sourceSplit.map(
    (item) =>
      `- ${formatSource(item.source)}：${formatInteger(item.totalTokensWithoutCacheRead)} token，含缓存读 ${formatInteger(item.totalTokens)} token，缓存率 ${formatReportCacheRate(item)}${formatSourceCostSuffix(item.source)}`
  )
}

function formatTopModels(report: DailyTokenReport) {
  if (report.topModels.length === 0) return ['暂无数据']
  return report.topModels.map(
    (item) =>
      `- ${item.model}：${formatInteger(item.totalTokensWithoutCacheRead)} token，缓存率 ${formatReportCacheRate(item)}，${formatModelCost(item, report)}`
  )
}

function formatModelCost(item: DailyTokenReport['topModels'][number], report: DailyTokenReport) {
  return formatModelCostWithAvailability(item.costUsd, item.sourceSplit, report.sourceSplit)
}

function formatSourceCostSuffix(source: string) {
  const note = formatSourceCostNote(source)
  return note ? ` / ${note}` : ''
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

function escapeWeComMarkdownText(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, ' ')
}

function escapeDingTalkMarkdownText(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ')
    .replace(/([\\`*_{}\[\]()#+\-.!|])/g, '\\$1')
}

function truncateUtf8(value: string, maxBytes: number, suffix: string) {
  const encoder = new TextEncoder()
  if (encoder.encode(value).byteLength <= maxBytes) return value

  const suffixBytes = encoder.encode(suffix).byteLength
  const targetBytes = Math.max(0, maxBytes - suffixBytes)
  let bytes = 0
  let output = ''

  for (const char of value) {
    const charBytes = encoder.encode(char).byteLength
    if (bytes + charBytes > targetBytes) break
    output += char
    bytes += charBytes
  }

  return `${output.trimEnd()}${suffix}`
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
