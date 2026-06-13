import { describe, expect, test } from 'vitest'
import { buildWebhookPayload, formatDailyReport, formatWeComDailyReport, type DailyTokenReport } from './adapters'

const report: DailyTokenReport = {
  displayName: 'Example',
  reportDate: '2026-04-29',
  timezone: 'Asia/Shanghai',
  dashboardUrl: 'https://tokenboard.example.com/leaderboards',
  totalTokens: 1200,
  totalTokensWithoutCacheRead: 900,
  costUsd: 1.23,
  sessionCount: 4,
  reportUrl: 'https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sourceSplit: [
    { source: 'codex', totalTokens: 800, totalTokensWithoutCacheRead: 620 },
    { source: 'claude-code', totalTokens: 400, totalTokensWithoutCacheRead: 280 }
  ],
  topModels: [
    { model: 'gpt-5', totalTokens: 800, totalTokensWithoutCacheRead: 620, costUsd: 0.8 }
  ]
}

describe('notification adapters', () => {
  test('formats the daily token report without raw usage content', () => {
    const text = formatDailyReport(report)

    expect(text).toContain('Example token 日报 2026-04-29')
    expect(text).toContain('Example 在 2026-04-29 共消耗 1,200 token')
    expect(text).toContain('去掉缓存读后为 900 token')
    expect(text).toContain('缓存率 25%')
    expect(text).toContain('Codex：620 token，含缓存读 800 token，缓存率 23%')
    expect(text).toContain('gpt-5：620 token，缓存率 23%')
    expect(text).toContain(
      '[查看本次日报](https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)'
    )
    expect(text).not.toContain('[查看排行榜](https://tokenboard.example.com/leaderboards)')
  })

  test('falls back to the public leaderboards when no shared report URL exists', () => {
    const text = formatDailyReport({ ...report, reportUrl: undefined })
    const wecomText = formatWeComDailyReport({ ...report, reportUrl: undefined })

    expect(text).toContain('[查看排行榜](https://tokenboard.example.com/leaderboards)')
    expect(wecomText).toContain('[查看排行榜](https://tokenboard.example.com/leaderboards)')
    expect(text).not.toContain('/dashboard')
    expect(wecomText).not.toContain('/dashboard')
  })

  test('builds WeCom markdown payload', async () => {
    const payload = await buildWebhookPayload({
      provider: 'wecom',
      webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',
      report,
      now: new Date('2026-04-29T01:00:00.000Z')
    })

    expect(payload.url).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test')
    expect(payload.body).toMatchObject({
      msgtype: 'markdown',
      markdown: {
        content: expect.stringContaining('## Example token 日报')
      }
    })
    const content = (payload.body as { markdown: { content: string } }).markdown.content
    expect(content).toContain('<font color="info">1,200 token</font>')
    expect(content).toContain('<font color="warning">$1.23</font>')
    expect(content).toContain('**主要来源**')
    expect(content).toContain('**Codex**：620 token')
    expect(content).toContain('[打开日报详情](https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)')
    expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(4096)
    expect(content).not.toContain('Example 在 2026-04-29 共消耗')
  })

  test('limits WeCom markdown payloads to the official byte budget', () => {
    const text = formatWeComDailyReport({
      ...report,
      displayName: '<Example>'.repeat(200),
      topModels: [{
        model: 'gpt-5'.repeat(1000),
        totalTokens: 1000,
        totalTokensWithoutCacheRead: 900,
        costUsd: 1
      }]
    })

    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(4096)
    expect(text).toContain('内容已截断')
    expect(text).not.toContain('<Example>')
  })

  test('builds DingTalk signed markdown payload', async () => {
    const payload = await buildWebhookPayload({
      provider: 'dingtalk',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test',
      signingSecret: 'secret',
      report,
      now: new Date('2026-04-29T01:00:00.000Z')
    })
    const url = new URL(payload.url)

    expect(url.searchParams.get('timestamp')).toBe('1777424400000')
    expect(url.searchParams.get('sign')).toBe('271FYrVJTyHSiWISNOt9wkeJS60pGSCXu8bJqFB+Gqw=')
    expect(payload.body).toMatchObject({
      msgtype: 'markdown',
      markdown: {
        title: 'Example token 日报 2026-04-29'
      }
    })
  })

  test('builds Feishu signed card payload', async () => {
    const payload = await buildWebhookPayload({
      provider: 'feishu',
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
      signingSecret: 'secret',
      report,
      now: new Date('2026-04-29T01:00:00.000Z')
    })

    expect(payload.url).toBe('https://open.feishu.cn/open-apis/bot/v2/hook/test')
    expect(payload.body).toMatchObject({
      timestamp: '1777424400',
      sign: 'gHYRDlE5oblzGdxSCvKCNHdIetIgJ8BKxQv+yMn4kvU=',
      msg_type: 'interactive',
      card: {
        schema: '2.0',
        header: {
          title: {
            tag: 'plain_text',
            content: 'Example token 日报 2026-04-29'
          }
        },
        body: {
          elements: [
            {
              tag: 'markdown',
              content: expect.stringContaining('Example token 日报 2026-04-29')
            }
          ]
        }
      }
    })
    expect((payload.body as { card: { elements?: unknown } }).card.elements).toBeUndefined()
  })
})
