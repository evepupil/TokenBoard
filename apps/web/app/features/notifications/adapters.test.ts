import { describe, expect, test } from 'vitest'
import {
  buildWebhookPayload,
  formatDailyReport,
  formatDingTalkDailyReport,
  formatWeComDailyReport,
  type DailyTokenReport
} from './adapters'

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
  topModels: [{ model: 'gpt-5', totalTokens: 800, totalTokensWithoutCacheRead: 620, costUsd: 0.8 }]
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

  test('labels Antigravity CLI cost as unavailable in daily reports', () => {
    const text = formatDailyReport({
      ...report,
      costUsd: 0.8,
      sourceSplit: [
        ...report.sourceSplit,
        { source: 'antigravity-cli', totalTokens: 300, totalTokensWithoutCacheRead: 260 }
      ],
      topModels: [
        ...report.topModels,
        {
          model: 'Gemini 3.5 Flash (Medium)',
          totalTokens: 300,
          totalTokensWithoutCacheRead: 260,
          costUsd: 0,
          sourceSplit: [{ source: 'antigravity-cli' }]
        }
      ]
    })

    expect(text).toContain('Antigravity CLI (agy)：260 token')
    expect(text).toContain('Antigravity CLI 费用不可用')
    expect(text).toContain('预估费用 $0.80 (Antigravity CLI 费用不可用)')
    expect(text).toContain('Gemini 3.5 Flash (Medium)：260 token，缓存率 13%，$0.00 (Antigravity CLI 费用不可用)')
  })

  test('keeps Antigravity cost-unavailable labels in webhook top model summaries', async () => {
    const antigravityReport = {
      ...report,
      costUsd: 0.8,
      sourceSplit: [{ source: 'antigravity-cli', totalTokens: 300, totalTokensWithoutCacheRead: 260 }],
      topModels: [
        {
          model: 'Gemini 3.5 Flash (Medium)',
          totalTokens: 300,
          totalTokensWithoutCacheRead: 260,
          costUsd: 0,
          sourceSplit: [{ source: 'antigravity-cli' }]
        }
      ]
    }
    const wecomText = formatWeComDailyReport(antigravityReport)
    const dingtalkText = formatDingTalkDailyReport(antigravityReport)
    const feishuPayload = await buildWebhookPayload({
      provider: 'feishu',
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
      report: antigravityReport,
      now: new Date('2026-04-29T01:00:00.000Z')
    })
    const feishuText = (
      feishuPayload.body as {
        card: { body: { elements: Array<{ tag: string; content?: string }> } }
      }
    ).card.body.elements[0].content

    expect(wecomText).toContain('$0.00 (Antigravity CLI 费用不可用)')
    expect(dingtalkText).toContain('$0.00 (Antigravity CLI 费用不可用)')
    expect(feishuText).toContain('$0.00 (Antigravity CLI 费用不可用)')
  })

  test('keeps valid model costs available in mixed-source reports', async () => {
    const mixedReport: DailyTokenReport = {
      ...report,
      sourceSplit: [
        ...report.sourceSplit,
        { source: 'antigravity-cli', totalTokens: 300, totalTokensWithoutCacheRead: 260 }
      ],
      topModels: [
        { ...report.topModels[0], sourceSplit: [{ source: 'codex' }] },
        {
          model: 'Gemini 3.5 Flash (Medium)',
          totalTokens: 300,
          totalTokensWithoutCacheRead: 260,
          costUsd: 0,
          sourceSplit: [{ source: 'antigravity-cli' }]
        }
      ]
    }

    const text = formatDailyReport(mixedReport)
    const wecomText = formatWeComDailyReport(mixedReport)
    const dingtalkText = formatDingTalkDailyReport(mixedReport)

    expect(text).toContain('gpt-5：620 token，缓存率 23%，$0.80')
    expect(text).not.toContain('gpt-5：620 token，缓存率 23%，$0.80 (Antigravity')
    expect(text).toContain('Gemini 3.5 Flash (Medium)：260 token，缓存率 13%，$0.00 (Antigravity CLI 费用不可用)')
    expect(wecomText).toContain('**gpt-5**：620 token / <font color="warning">$0.80</font>')
    expect(dingtalkText).toContain('**gpt\\-5**：620 token / $0.80')
  })

  test('marks a model shared by billable and Antigravity sources as unavailable', async () => {
    const mixedModelReport: DailyTokenReport = {
      ...report,
      sourceSplit: [
        { source: 'codex', totalTokens: 800, totalTokensWithoutCacheRead: 620 },
        { source: 'antigravity-cli', totalTokens: 300, totalTokensWithoutCacheRead: 260 }
      ],
      topModels: [
        {
          model: 'gpt-5',
          totalTokens: 1100,
          totalTokensWithoutCacheRead: 880,
          costUsd: 0.8,
          sourceSplit: [{ source: 'codex' }, { source: 'antigravity-cli' }]
        }
      ]
    }

    const text = formatDailyReport(mixedModelReport)
    const wecomText = formatWeComDailyReport(mixedModelReport)
    const dingtalkText = formatDingTalkDailyReport(mixedModelReport)
    const feishuPayload = await buildWebhookPayload({
      provider: 'feishu',
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
      report: mixedModelReport,
      now: new Date('2026-04-29T01:00:00.000Z')
    })
    const feishuText =
      (
        feishuPayload.body as {
          card: { body: { elements: Array<{ content?: string }> } }
        }
      ).card.body.elements[0]?.content ?? ''

    expect(text).toContain('$0.80 (Antigravity CLI 费用不可用)')
    expect(wecomText).toContain('$0.80 (Antigravity CLI 费用不可用)')
    expect(dingtalkText).toContain('$0.80 (Antigravity CLI 费用不可用)')
    expect(feishuText).toContain('$0.80 (Antigravity CLI 费用不可用)')
  })

  test('marks legacy model cost availability as unknown instead of using report-wide sources', () => {
    const text = formatDailyReport({
      ...report,
      sourceSplit: [
        ...report.sourceSplit,
        { source: 'antigravity-cli', totalTokens: 300, totalTokensWithoutCacheRead: 260 }
      ],
      topModels: [{ ...report.topModels[0], sourceSplit: undefined }]
    })

    expect(text).toContain('gpt-5：620 token，缓存率 23%，$0.80 (费用可用性未知)')
    expect(text).not.toContain('gpt-5：620 token，缓存率 23%，$0.80 (Antigravity')
  })

  test('treats an empty model source split as unavailable history metadata', () => {
    const text = formatDailyReport({
      ...report,
      sourceSplit: [
        ...report.sourceSplit,
        { source: 'antigravity-cli', totalTokens: 300, totalTokensWithoutCacheRead: 260 }
      ],
      topModels: [{ ...report.topModels[0], sourceSplit: [] }]
    })

    expect(text).toContain('gpt-5：620 token，缓存率 23%，$0.80 (费用可用性未知)')
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
    expect(content).toContain(
      '[打开日报详情](https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)'
    )
    expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(4096)
    expect(content).not.toContain('Example 在 2026-04-29 共消耗')
  })

  test('limits WeCom markdown payloads to the official byte budget', () => {
    const text = formatWeComDailyReport({
      ...report,
      displayName: '<Example>'.repeat(200),
      topModels: [
        {
          model: 'gpt-5'.repeat(1000),
          totalTokens: 1000,
          totalTokensWithoutCacheRead: 900,
          costUsd: 1
        }
      ]
    })

    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(4096)
    expect(text).toContain('内容已截断')
    expect(text).not.toContain('<Example>')
  })

  test('formats DingTalk daily report with supported markdown only', () => {
    const text = formatDingTalkDailyReport({
      ...report,
      displayName: '<Example>',
      topModels: [
        {
          model: 'gpt-5[preview]',
          totalTokens: 800,
          totalTokensWithoutCacheRead: 620,
          costUsd: 0.8
        }
      ]
    })

    expect(text).toContain('## TokenBoard：&lt;Example&gt; token 日报')
    expect(text).toContain('日期：2026\\-04\\-29 / Asia/Shanghai')
    expect(text).toContain('**总消耗**：1,200 token')
    expect(text).toContain('**去缓存读**：900 token')
    expect(text).toContain('**费用**：$1.23 / 会话：4')
    expect(text).toContain('**主要来源**')
    expect(text).toContain('**Codex**：620 token')
    expect(text).toContain('  - 含缓存读 800 token / 缓存率 23%')
    expect(text).toContain('**gpt\\-5\\[preview\\]**：620 token / $0.80')
    expect(text).not.toContain('<font')
    expect(text).toContain(
      '[打开日报详情](https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)'
    )
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(20_000)
  })

  test('keeps DingTalk item hiding counts based on visible list rows', () => {
    const text = formatDingTalkDailyReport({
      ...report,
      sourceSplit: [
        ...report.sourceSplit,
        { source: 'cursor', totalTokens: 300, totalTokensWithoutCacheRead: 200 },
        { source: 'aider', totalTokens: 200, totalTokensWithoutCacheRead: 100 },
        { source: 'custom', totalTokens: 100, totalTokensWithoutCacheRead: 50 }
      ],
      topModels: [
        ...report.topModels,
        { model: 'deepseek-v4-flash', totalTokens: 700, totalTokensWithoutCacheRead: 500, costUsd: 0.3 },
        { model: 'claude-sonnet', totalTokens: 600, totalTokensWithoutCacheRead: 400, costUsd: 0.2 },
        { model: 'qwen', totalTokens: 500, totalTokensWithoutCacheRead: 300, costUsd: 0.1 }
      ]
    })

    expect(text).toContain('- 其余 2 项请打开 TokenBoard 查看。')
    expect(text).toContain('- 其余 1 项请打开 TokenBoard 查看。')
    expect(text).not.toContain('custom')
    expect(text).not.toContain('qwen')
  })

  test('builds DingTalk signed action card payload', async () => {
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
      msgtype: 'actionCard',
      actionCard: {
        title: 'TokenBoard：Example token 日报',
        text: expect.stringContaining('## TokenBoard：Example token 日报'),
        btnOrientation: '0',
        singleTitle: '打开日报详情',
        singleURL: 'https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      }
    })
    const text = (payload.body as { actionCard: { text: string } }).actionCard.text
    expect(text).toContain(
      '[打开日报详情](https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)'
    )
    expect(text).not.toContain('<font')
  })

  test('keeps the DingTalk TokenBoard keyword and fallback link when report sharing is disabled', async () => {
    const text = formatDingTalkDailyReport({ ...report, reportUrl: undefined })
    const payload = await buildWebhookPayload({
      provider: 'dingtalk',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test',
      report: { ...report, reportUrl: undefined },
      now: new Date('2026-04-29T01:00:00.000Z')
    })

    expect(text).toContain('TokenBoard')
    expect(text).toContain('[查看排行榜](https://tokenboard.example.com/leaderboards)')
    expect(payload.body).toMatchObject({
      msgtype: 'actionCard',
      actionCard: {
        title: 'TokenBoard：Example token 日报',
        singleTitle: '查看排行榜',
        singleURL: 'https://tokenboard.example.com/leaderboards'
      }
    })
  })

  test('uses the public leaderboards button for DingTalk when no shared report URL exists', async () => {
    const payload = await buildWebhookPayload({
      provider: 'dingtalk',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=test',
      report: { ...report, reportUrl: undefined },
      now: new Date('2026-04-29T01:00:00.000Z')
    })

    expect(payload.body).toMatchObject({
      msgtype: 'actionCard',
      actionCard: {
        title: 'TokenBoard：Example token 日报',
        text: expect.stringContaining('[查看排行榜](https://tokenboard.example.com/leaderboards)'),
        singleTitle: '查看排行榜',
        singleURL: 'https://tokenboard.example.com/leaderboards'
      }
    })
  })

  test('keeps DingTalk report links outside truncated markdown text', () => {
    const text = formatDingTalkDailyReport({
      ...report,
      displayName: 'Example'.repeat(1000),
      topModels: [
        {
          model: 'gpt-5'.repeat(5000),
          totalTokens: 1000,
          totalTokensWithoutCacheRead: 900,
          costUsd: 1
        }
      ]
    })

    expect(text).toContain('TokenBoard')
    expect(text).toContain('内容已截断')
    expect(text).toContain(
      '[打开日报详情](https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)'
    )
    expect(
      text
        .trimEnd()
        .endsWith('[打开日报详情](https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)')
    ).toBe(true)
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(20_000)
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
            content: 'TokenBoard：Example token 日报'
          }
        },
        body: {
          elements: [
            {
              tag: 'markdown',
              content: expect.stringContaining('> 2026-04-29 / Asia/Shanghai')
            },
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: '打开日报详情'
              },
              type: 'primary',
              behaviors: [
                {
                  type: 'open_url',
                  default_url: 'https://tokenboard.example.com/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
                }
              ]
            }
          ]
        }
      }
    })
    const content = (
      payload.body as {
        card: { body: { elements: Array<{ tag: string; content?: string }> } }
      }
    ).card.body.elements[0].content
    expect(content).not.toContain('[打开日报详情]')
    expect((payload.body as { card: { elements?: unknown } }).card.elements).toBeUndefined()
  })

  test('uses the public leaderboards button for Feishu when no shared report URL exists', async () => {
    const payload = await buildWebhookPayload({
      provider: 'feishu',
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
      report: { ...report, reportUrl: undefined },
      now: new Date('2026-04-29T01:00:00.000Z')
    })

    expect(payload.body).toMatchObject({
      msg_type: 'interactive',
      card: {
        schema: '2.0',
        header: {
          title: {
            content: 'TokenBoard：Example token 日报'
          }
        },
        body: {
          elements: [
            {
              tag: 'markdown',
              content: expect.stringContaining('> 2026-04-29 / Asia/Shanghai')
            },
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: '查看排行榜'
              },
              type: 'primary',
              behaviors: [
                {
                  type: 'open_url',
                  default_url: 'https://tokenboard.example.com/leaderboards'
                }
              ]
            }
          ]
        }
      }
    })
    const content = (
      payload.body as {
        card: { body: { elements: Array<{ tag: string; content?: string }> } }
      }
    ).card.body.elements[0].content
    expect(content).toContain('**主要来源**')
    expect(content).not.toContain('[查看排行榜]')
    expect((payload.body as { card: { elements?: unknown } }).card.elements).toBeUndefined()
  })

  test('limits Feishu interactive card markdown payloads under the webhook body budget', async () => {
    const payload = await buildWebhookPayload({
      provider: 'feishu',
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
      report: {
        ...report,
        displayName: 'Example'.repeat(1000),
        topModels: [
          {
            model: 'gpt-5'.repeat(5000),
            totalTokens: 1000,
            totalTokensWithoutCacheRead: 900,
            costUsd: 1
          }
        ]
      },
      now: new Date('2026-04-29T01:00:00.000Z')
    })
    const content = (
      payload.body as {
        card: { body: { elements: Array<{ content: string }> } }
      }
    ).card.body.elements[0].content
    const title = (
      payload.body as {
        card: { header: { title: { content: string } } }
      }
    ).card.header.title.content

    expect(content).toContain('内容已截断')
    expect(title).toContain('...')
    expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(14 * 1024)
    expect(new TextEncoder().encode(JSON.stringify(payload.body)).byteLength).toBeLessThanOrEqual(20 * 1024)
  })
})
