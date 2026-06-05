import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { NotificationsPage } from './notifications'

describe('NotificationsPage', () => {
  test('renders configured webhook rows without full webhook URLs', async () => {
    const html = await renderToString(
      <NotificationsPage
        email="user@example.com"
        timezone="Asia/Shanghai"
        reportHistory={[]}
        dailyReportShareEnabled={true}
        reportHistoryRetentionDays={30}
        saved={false}
        tested={false}
        testFailed={false}
        encryptionConfigured={true}
        subscriptions={[
          {
            id: 'sub_1',
            name: '日报',
            provider: 'wecom',
            webhookUrlHost: 'qyapi.weixin.qq.com',
            webhookUrlMasked: 'qyapi.weixin.qq.com/...abcdef',
            timezone: 'Asia/Shanghai',
            scheduleTimeLocal: '09:30',
            scheduleTimesLocal: ['09:30', '18:00'],
            scheduleWeekdays: [1, 3, 5],
            sendEmptyReport: false,
            enabled: true,
            nextRunAt: '2026-04-30T01:30:00.000Z',
            pendingReportDate: null,
            pendingScheduleSlot: null,
            failureCount: 0,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastError: null,
            createdAt: '2026-04-29T01:30:00.000Z',
            updatedAt: '2026-04-29T01:30:00.000Z'
          }
        ]}
      />
    )

    expect(html).toContain('通知 Webhook')
    expect(html).toContain('qyapi.weixin.qq.com/...abcdef')
    expect(html).not.toContain('key=')
    expect(html).toContain('data-custom-select="true"')
    expect(html).toContain('测试发送')
    expect(html).toContain('09:30、18:00')
    expect(html).toContain('周一、周三、周五')
    expect(html).toContain('name="scheduleTimesLocal[]"')
    expect(html).toContain('name="scheduleWeekdays[]"')
  })

  test('shows encryption configuration warning', async () => {
    const html = await renderToString(
      <NotificationsPage
        email="user@example.com"
        timezone="UTC"
        reportHistory={[]}
        dailyReportShareEnabled={true}
        reportHistoryRetentionDays={30}
        saved={false}
        tested={false}
        testFailed={false}
        encryptionConfigured={false}
        subscriptions={[]}
      />
    )

    expect(html).toContain('WEBHOOK_ENCRYPTION_KEY')
    expect(html).toContain('disabled')
  })

  test('shows failed test send feedback separately from success feedback', async () => {
    const html = await renderToString(
      <NotificationsPage
        email="user@example.com"
        timezone="UTC"
        reportHistory={[]}
        dailyReportShareEnabled={true}
        reportHistoryRetentionDays={30}
        saved={false}
        tested={false}
        testFailed={true}
        encryptionConfigured={true}
        subscriptions={[]}
      />
    )

    expect(html).toContain('测试预览通知发送失败')
    expect(html).not.toContain('测试预览通知已发送')
  })

  test('renders daily report history snapshots', async () => {
    const html = await renderToString(
      <NotificationsPage
        email="user@example.com"
        timezone="UTC"
        reportHistoryRetentionDays={7}
        dailyReportShareEnabled={true}
        saved={false}
        tested={false}
        testFailed={false}
        encryptionConfigured={true}
        subscriptions={[]}
        reportHistory={[
          {
            id: 'drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            displayName: 'Example',
            reportDate: '2026-04-29',
            scheduleSlot: '2026-04-29T18:00',
            timezone: 'Asia/Shanghai',
            dashboardUrl: 'https://tokenboard.example.com/dashboard',
            totalTokens: 1200,
            totalTokensWithoutCacheRead: 900,
            cacheReadRate: 0.25,
            costUsd: 1.23,
            sessionCount: 4,
            reportUrl: '/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            shareRevokedAt: null,
            sourceSplit: [
              {
                source: 'codex',
                totalTokens: 1200,
                totalTokensWithoutCacheRead: 900,
                cacheReadRate: 0.25
              }
            ],
            topModels: [
              {
                model: 'gpt-5',
                totalTokens: 1200,
                totalTokensWithoutCacheRead: 900,
                cacheReadRate: 0.25,
                costUsd: 1.23
              }
            ],
            generatedAt: '2026-04-29T10:00:00.000Z',
            updatedAt: '2026-04-29T10:00:00.000Z'
          }
        ]}
      />
    )

    expect(html).toContain('历史日报')
    expect(html).toContain('保留最近 7 天')
    expect(html).toContain('2026-04-29')
    expect(html).toContain('18:00')
    expect(html).toContain('1,200')
    expect(html).toContain('900')
    expect(html).toContain('25%')
    expect(html).toContain('$1.23')
    expect(html).toContain('gpt-5')
    expect(html).toContain('href="/reports/daily/drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')
    expect(html).toContain('name="reportId" value="drr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')
    expect(html).toContain('value="revoke-report-share"')
    expect(html).toContain('查看')
  })

  test('renders daily report share settings', async () => {
    const html = await renderToString(
      <NotificationsPage
        email="user@example.com"
        timezone="UTC"
        reportHistory={[]}
        dailyReportShareEnabled={false}
        reportHistoryRetentionDays={30}
        saved={false}
        tested={false}
        testFailed={false}
        encryptionConfigured={true}
        subscriptions={[]}
      />
    )

    expect(html).toContain('日报分享')
    expect(html).toContain('name="dailyReportShareEnabled"')
    expect(html).toContain('value="update-share-settings"')
    expect(html).not.toContain('name="dailyReportShareEnabled" checked')
  })
})
