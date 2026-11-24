import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { LeaderboardPanel } from './leaderboard-panel'
import type { LeaderboardEntry } from '../queries'

function entry(overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    rank: 1,
    slug: 'example-user',
    displayName: 'Example User',
    totalTokens: 123456,
    totalTokensWithoutCacheRead: 100000,
    cacheReadRate: 23456 / 123456,
    costUsd: 42.31,
    costAvailable: true,
    primaryModel: null,
    sourceBreakdown: [],
    isCurrentViewer: false,
    ...overrides
  }
}

describe('LeaderboardPanel', () => {
  test('renders leaderboard entries with a mobile list and a desktop table', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        period="daily"
        metric="tokens"
        rangeLabel="2026-04-29"
        timezone="UTC"
        timezoneLabel="UTC+0"
        limit={50}
        entries={[entry()]}
      />
    )

    expect(html).toContain('data-leaderboard-mobile-list="true"')
    expect(html).toContain('data-leaderboard-desktop-table="true"')
    expect(html).toContain('Example User')
    expect(html).toContain('123,456')
    expect(html).toContain('100,000')
    expect(html).toContain('divide-x divide-[var(--app-border-strong)]')
    expect(html).toContain('grid-cols-3')
    expect(html).toContain('tokens-without-cache-read')
    expect(html).toContain('不含缓存读')
    expect(html).toContain('缓存率')
    expect(html).toContain('19%')
  })

  test('renders an empty state that is not constrained by the desktop table', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        entries={[]}
        period="daily"
        metric="tokens"
        rangeLabel="2026-04-29"
        timezone="UTC"
        timezoneLabel="UTC+0"
        limit={50}
      />
    )

    expect(html).toContain('data-leaderboard-empty="true"')
    expect(html).toContain('border-dashed')
    expect(html).not.toContain('colspan="4"')
  })

  // The board asks for a fixed number of rows; when it gets exactly that many there may be more
  // below the cut, and the page must say so rather than let a viewer below the top N infer they
  // have no data.
  test('states when the board was truncated at its row cap', async () => {
    const rows = Array.from({ length: 50 }, (_, index) =>
      entry({ slug: `u${index}`, displayName: `User ${index}`, totalTokens: 1000 - index })
    )
    const html = await renderToString(
      <LeaderboardPanel
        period="daily"
        metric="tokens"
        rangeLabel="2026-04-29"
        timezone="UTC"
        timezoneLabel="UTC+0"
        limit={50}
        entries={rows}
      />
    )

    expect(html).toContain('data-leaderboard-truncated="true"')
    expect(html).toContain('仅显示前 50 名')
  })

  test('stays silent about truncation when the board did not fill its cap', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        period="daily"
        metric="tokens"
        rangeLabel="2026-04-29"
        timezone="UTC"
        timezoneLabel="UTC+0"
        limit={50}
        entries={[entry()]}
      />
    )

    expect(html).not.toContain('data-leaderboard-truncated="true"')
  })

  test('names every cost-unavailable source on leaderboards', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        entries={[
          entry({
            slug: 'agy-user',
            displayName: 'Agy User',
            totalTokens: 100,
            totalTokensWithoutCacheRead: 100,
            cacheReadRate: 0,
            costUsd: 0,
            costAvailable: false
          })
        ]}
        period="daily"
        metric="cost"
        rangeLabel="2026-04-29"
        timezone="UTC"
        timezoneLabel="UTC+0"
        limit={50}
      />
    )

    expect(html).toContain('Antigravity、Grok Build、DeepSeek Harness 费用不可用，费用列和费用排名不包含这些来源成本。')
    expect(html).toContain('费用不可用')
    expect(html).not.toContain('$0.00')
  })
})

// The board shows who is ahead, but not what they run — a viewer could see a total and nothing
// about where it came from. The model column and the source split come straight off the entry,
// and the split names its sources rather than showing bare ids.
describe('LeaderboardPanel model and source columns', () => {
  test('names the primary model and the leading sources with their share', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        entries={[
          entry({
            primaryModel: 'claude-opus-4-1',
            sourceBreakdown: [
              { source: 'claude-code', share: 0.62 },
              { source: 'codex', share: 0.3 },
              { source: 'opencode', share: 0.08 }
            ]
          })
        ]}
        period="daily"
        metric="tokens"
        rangeLabel="2026-04-29"
        timezone="UTC"
        timezoneLabel="UTC+0"
        limit={50}
      />
    )

    expect(html).toContain('主要模型')
    expect(html).toContain('claude-opus-4-1')
    expect(html).toContain('data-leaderboard-source-share="true"')
    expect(html).toContain('Claude Code')
    expect(html).toContain('62%')
    expect(html).toContain('Codex')
    expect(html).toContain('30%')
    // Only the two leading sources are named; the tail collapses into one remainder so a user
    // running many sources cannot push the rest of the row out of the cell.
    expect(html).toContain('其他 1 个来源')
    expect(html).toContain('8%')
    expect(html).toContain('title="Claude Code 62% / Codex 30% / OpenCode 8%"')
    expect(html).not.toContain('>OpenCode<')
  })

  test('falls back to placeholders when a user has no model or source data', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        entries={[entry({ primaryModel: null, sourceBreakdown: [] })]}
        period="daily"
        metric="tokens"
        rangeLabel="2026-04-29"
        timezone="UTC"
        timezoneLabel="UTC+0"
        limit={50}
      />
    )

    expect(html).not.toContain('data-leaderboard-source-share="true"')
    expect(html.match(/—/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

// The board is a page of strangers, and the viewer's own row is the one they came to find. The
// marker is the query's boolean, so it must not appear for anyone else, and must not appear at
// all for an anonymous viewer.
describe('LeaderboardPanel current viewer highlight', () => {
  test('marks only the viewer row', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        entries={[
          entry({ rank: 1, slug: 'other-user', displayName: 'Other User' }),
          entry({ rank: 2, slug: 'viewer', displayName: 'Viewer', isCurrentViewer: true })
        ]}
        period="daily"
        metric="tokens"
        rangeLabel="2026-04-29"
        timezone="UTC"
        timezoneLabel="UTC+0"
        limit={50}
      />
    )

    // One marker in the mobile list and one in the desktop table, and no more.
    expect(html.match(/data-leaderboard-current-user="true"/g)).toHaveLength(2)
    expect(html.match(/data-leaderboard-current-user-badge="true"/g)).toHaveLength(2)
    expect(html).toContain('app-current-viewer-row')
    expect(html).toContain('app-current-viewer-marker')
    expect(html).toContain('app-current-viewer-tag')
  })

  test('marks nobody for an anonymous viewer', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        entries={[entry({ slug: 'other-user', displayName: 'Other User' })]}
        period="daily"
        metric="tokens"
        rangeLabel="2026-04-29"
        timezone="UTC"
        timezoneLabel="UTC+0"
        limit={50}
      />
    )

    expect(html).not.toContain('data-leaderboard-current-user="true"')
    expect(html).not.toContain('data-leaderboard-current-user-badge="true"')
    expect(html).not.toContain('app-current-viewer-marker')
  })
})

// The panel used to render a title and a table with no indication of which day it covered, so
// a viewer had no way to tell whether the numbers were today's. The caption now carries the
// window the query ranked and the offset it was measured in.
describe('LeaderboardPanel range caption', () => {
  test('states the day a daily board covers and the viewer offset', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        entries={[]}
        period="daily"
        metric="tokens"
        rangeLabel="2026-05-01"
        timezone="Asia/Shanghai"
        timezoneLabel="UTC+8"
        limit={50}
      />
    )

    expect(html).toContain('data-leaderboard-range="true"')
    expect(html).toContain('2026-05-01')
    expect(html).toContain('UTC+8')
    expect(html).toContain('Asia/Shanghai')
  })

  test('states the month a monthly board covers', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        entries={[]}
        period="monthly"
        metric="cost"
        rangeLabel="2026-05"
        timezone="America/Los_Angeles"
        timezoneLabel="UTC-7"
        limit={50}
      />
    )

    expect(html).toContain('2026-05')
    expect(html).toContain('UTC-7')
  })

  // Two users' rows labelled with the same date were collected in different zones, so a viewer
  // comparing themselves against someone abroad is comparing different windows. Saying only the
  // viewer's own offset would imply the two are the same day, which is the misreading this
  // surface invited.
  test('explains that each collector stamps its own local day', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        entries={[]}
        period="daily"
        metric="tokens"
        rangeLabel="2026-05-01"
        timezone="Asia/Shanghai"
        timezoneLabel="UTC+8"
        limit={50}
      />
    )

    expect(html).toContain('各自本地时区')
  })

  // The period and metric strips both carry a link per metric, so a selector that matches on the
  // query alone lands on the wrong strip. The swap restore reads the strip from the group name
  // and the selection from the active item, and the active item has to be focusable for the
  // restore to land on it at all.
  test('names each tab strip and makes its active item focusable', async () => {
    const html = await renderToString(
      <LeaderboardPanel
        entries={[]}
        period="daily"
        metric="cost"
        rangeLabel="2026-05-01"
        timezone="UTC"
        timezoneLabel="UTC+0"
        limit={50}
      />
    )

    expect(html).toContain('data-leaderboard-group="period"')
    expect(html).toContain('data-leaderboard-group="metric"')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('data-leaderboard-value="cost"')
    // The strip that changed is the one whose active item carries the new selection; the period
    // strip's active item keeps its own value, so a restore aimed at `metric` finds `cost`.
    expect(html).toContain('data-leaderboard-value="daily"')
  })
})
