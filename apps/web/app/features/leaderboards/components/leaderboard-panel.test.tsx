import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { LeaderboardPanel } from './leaderboard-panel'

describe('LeaderboardPanel', () => {
  test('renders leaderboard entries with a mobile list and a desktop table', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        period="daily"
        metric="tokens"
        entries={[
          {
            rank: 1,
            slug: 'example-user',
            displayName: 'Example User',
            totalTokens: 123456,
            totalTokensWithoutCacheRead: 100000,
            cacheReadRate: 23456 / 123456,
            costUsd: 42.31,
            costAvailable: true
          }
        ]}
      />
    )

    expect(html).toContain('data-leaderboard-mobile-list="true"')
    expect(html).toContain('data-leaderboard-desktop-table="true"')
    expect(html).toContain('app-surface-raised rounded-xl')
    expect(html).toContain('Example User')
    expect(html).toContain('123,456')
    expect(html).toContain('100,000')
    expect(html).toContain('grid rounded-full')
    expect(html).toContain('grid-cols-3')
    expect(html).toContain('tokens-without-cache-read')
    expect(html).toContain('不含缓存读')
    expect(html).toContain('缓存率')
    expect(html).toContain('19%')
  })

  test('renders an empty state that is not constrained by the desktop table', async () => {
    const html = await renderToString(<LeaderboardPanel entries={[]} period="daily" metric="tokens" />)

    expect(html).toContain('data-leaderboard-empty="true"')
    expect(html).toContain('app-surface-subtle rounded-xl')
    expect(html).not.toContain('colspan="4"')
  })

  test('names every cost-unavailable source on leaderboards', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        entries={[
          {
            rank: 1,
            slug: 'agy-user',
            displayName: 'Agy User',
            totalTokens: 100,
            totalTokensWithoutCacheRead: 100,
            cacheReadRate: 0,
            costUsd: 0,
            costAvailable: false
          }
        ]}
        period="daily"
        metric="cost"
      />
    )

    expect(html).toContain('Antigravity、Grok Build、DeepSeek Harness 费用不可用，费用列和费用排名不包含这些来源成本。')
    expect(html).toContain('费用不可用')
    expect(html).not.toContain('$0.00')
  })
})
