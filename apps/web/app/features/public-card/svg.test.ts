import { describe, expect, test } from 'vitest'
import { renderUsageCardSvg } from './svg'

const input = {
  displayName: 'Eve',
  publicUrl: 'https://tokenboard.example/api/public/eve.svg',
  totalTokens: 1234567,
  totalTokensWithoutCacheRead: 345678,
  totalCacheReadRate: 0.72,
  totalCostUsd: 42.5,
  monthTokens: 89012,
  monthTokensWithoutCacheRead: 45678,
  monthCacheReadRate: 0.49,
  monthCostUsd: 6.78,
  todayTokens: 1200,
  todayTokensWithoutCacheRead: 860,
  todayCacheReadRate: 0.28,
  todayCostUsd: 0.2
}

describe('public card svg renderer', () => {
  test('keeps the default Chinese dark card compatible', () => {
    const svg = renderUsageCardSvg(input)

    expect(svg).toContain('TokenBoard 统计')
    expect(svg).toContain('总 token')
    expect(svg).toContain('总额度')
    expect(svg).toContain('本月 token')
    expect(svg).toContain('本月额度')
    // The intrinsic size is fixed rather than expressed as a style attribute: the response
    // carries `style-src 'self'`, which drops style attributes, and the `max-width` that
    // kept the card from stretching was lost with it. A style attribute must not come back.
    expect(svg).toContain('width="520" height="220"')
    expect(svg).toContain('viewBox="0 0 520 220"')
    expect(svg).toContain('color-scheme="dark"')
    expect(svg).not.toContain('style=')
    expect(svg).toContain('#121318')
    expect(svg).toContain('url(#glow)')
    expect(svg).toContain('data-card-cache-waffle="true"')
  })

  test('renders English light cards with custom title and no glow', () => {
    const svg = renderUsageCardSvg(input, {
      language: 'en',
      theme: 'light',
      title: 'AI Usage',
      subtitle: 'Public stats',
      glow: {
        enabled: false,
        intensity: 0.5,
        position: 'center'
      },
      metrics: ['todayTokens', 'todayCost']
    })

    expect(svg).toContain('AI Usage')
    expect(svg).toContain('Public stats')
    expect(svg).toContain('Today Tokens')
    expect(svg).toContain('Today Cost')
    expect(svg).toContain('1,200')
    expect(svg).toContain('$0.20')
    expect(svg).toContain('color-scheme="only light"')
    expect(svg).toContain('width="520" height="220"')
    expect(svg).toContain('viewBox="0 0 520 220"')
    expect(svg).not.toContain('style=')
    expect(svg).toContain('#e8e6ef')
    expect(svg).toContain('fill="#5a3be6"')
    expect(svg).not.toContain('fill="url(#glow)"')
    expect(svg).not.toContain('Total Tokens')
  })

  test('renders metrics that exclude cache-read tokens', () => {
    const svg = renderUsageCardSvg(input, {
      language: 'en',
      metrics: ['totalTokensWithoutCacheRead', 'monthTokensWithoutCacheRead', 'todayTokensWithoutCacheRead']
    })

    expect(svg).toContain('No Cache Read')
    expect(svg).toContain('Monthly No Cache Read')
    expect(svg).toContain('Today No Cache Read')
    expect(svg).toContain('345,678')
    expect(svg).toContain('45,678')
    expect(svg).toContain('860')
  })

  test('renders cache read rate metrics', () => {
    const svg = renderUsageCardSvg(input, {
      language: 'en',
      metrics: ['totalCacheReadRate', 'monthCacheReadRate', 'todayCacheReadRate']
    })

    expect(svg).toContain('Cache Read Rate')
    expect(svg).toContain('Monthly Cache Read')
    expect(svg).toContain('Today Cache Read')
    expect(svg).toContain('72%')
    expect(svg).toContain('49%')
    expect(svg).toContain('28%')
  })

  test('marks cost metrics when a source reports no cost', () => {
    const svg = renderUsageCardSvg(
      {
        ...input,
        totalCostAvailable: false,
        monthCostAvailable: false,
        todayCostAvailable: true
      },
      {
        metrics: ['totalCost', 'monthCost', 'todayCost']
      }
    )

    expect(svg).toContain('总额度*')
    expect(svg).toContain('本月额度*')
    expect(svg).not.toContain('今日额度*')
    expect(svg).toContain('* 部分来源费用不可用')
  })

  test('does not add unavailable-cost notes when no cost metric is visible', () => {
    const svg = renderUsageCardSvg(
      {
        ...input,
        totalCostAvailable: false
      },
      {
        metrics: ['totalTokens', 'monthTokens']
      }
    )

    expect(svg).not.toContain('部分来源费用不可用')
    expect(svg).not.toContain('总 token*')
  })

  test('does not add unavailable-cost notes for metrics truncated by the layout', () => {
    const svg = renderUsageCardSvg(
      {
        ...input,
        todayCostAvailable: false
      },
      {
        layout: 'wide',
        metrics: ['totalTokens', 'monthTokens', 'todayTokens', 'todayCost']
      }
    )

    expect(svg).not.toContain('今日额度')
    expect(svg).not.toContain('部分来源费用不可用')
  })
})

// The card is the surface a reader encounters without any other context: it is embedded in a
// README and read from anywhere. "今日" on it is the *owner's* local day, and a viewer several
// zones away has no way to know that from the numbers — the same instant is two different dates
// either side of the boundary. Naming the zone and its offset is what makes the figure legible
// to a reader who is not in it.
describe('public card timezone caption', () => {
  test('states the owner zone beside the today metrics', () => {
    const svg = renderUsageCardSvg({ ...input, timezoneLabel: 'UTC+8' }, { metrics: ['todayTokens', 'totalTokens'] })

    expect(svg).toContain('data-card-timezone="true"')
    expect(svg).toContain('UTC+8')
  })

  test('labels the caption in English for an English card', () => {
    const svg = renderUsageCardSvg(
      { ...input, timezoneLabel: 'UTC-7' },
      { language: 'en', metrics: ['todayTokens', 'totalTokens'] }
    )

    expect(svg).toContain('Today:')
    expect(svg).toContain('UTC-7')
  })

  // The note shares the bottom line with the cost-unavailable note, and the longest IANA zone
  // name made an English card's two notes overlap. The offset answers "which day" on its own —
  // two zones at the same offset turn the day over at the same instant — so the name is left off
  // rather than allowed to collide. This pins the note to a length that always fits.
  test('keeps the note short enough not to collide with the cost note', () => {
    const svg = renderUsageCardSvg(
      {
        ...input,
        totalCostAvailable: false,
        timezoneLabel: 'UTC-3'
      },
      { language: 'en', metrics: ['todayTokens', 'totalCost'] }
    )

    expect(svg).toContain('Today: UTC-3')
    expect(svg).not.toContain('ComodRivadavia')
  })

  // The caption only has meaning for a metric whose value depends on the boundary. A card
  // showing totals alone would carry a note about a day it does not display.
  test('omits the caption when no today metric is shown', () => {
    const svg = renderUsageCardSvg({ ...input, timezoneLabel: 'UTC+8' }, { metrics: ['totalTokens', 'monthTokens'] })

    expect(svg).not.toContain('data-card-timezone="true"')
  })

  // Cards configured before this existed, and the JSON/SVG fixtures, carry no zone. The note
  // would be a guess, so it is left off rather than filled in with UTC.
  test('omits the caption when the input carries no zone', () => {
    const svg = renderUsageCardSvg(input, { metrics: ['todayTokens', 'totalTokens'] })

    expect(svg).not.toContain('data-card-timezone="true"')
  })

  // It shares the bottom line with the cost-unavailable note, so it has to sit on the other
  // side rather than on top of it.
  test('does not collide with the cost-unavailable note', () => {
    const svg = renderUsageCardSvg(
      { ...input, totalCostAvailable: false, timezoneLabel: 'UTC+8' },
      { metrics: ['todayTokens', 'totalCost'] }
    )

    expect(svg).toContain('部分来源费用不可用')
    expect(svg).toContain('data-card-timezone="true"')
    expect(svg).toContain('text-anchor="end"')
  })

  // Every user-controlled string reaches the card as XML text, so it must be entity-encoded or
  // a display name can close a tag and inject markup into the document. The implementation has
  // always escaped; this pins it so a refactor cannot drop it silently.
  test('escapes user-controlled fields out of the XML document', () => {
    const svg = renderUsageCardSvg(
      {
        ...input,
        displayName: '<script>alert(1)</script>',
        timezoneLabel: 'A & B'
      },
      {
        // `title` and `subtitle` are the operator's own config strings, but they still ride into
        // XML text nodes, so they are covered here too. `displayName` reaches the subtitle when
        // the config does not override it, which is the user-controlled path that matters.
        title: 'Eve &amp; Co',
        showPublicUrl: false,
        metrics: ['todayTokens', 'totalTokens']
      }
    )

    // The raw payload must never appear verbatim …
    expect(svg).not.toContain('<script>')
    // … and the entity-encoded form must, in both the visible text and the aria-label/title.
    expect(svg).toContain('&lt;script&gt;')
    expect(svg).toContain('Eve &amp;amp; Co')
    // A bare `&` becomes `&amp;`; the double-encoding above is the correct result of encoding an
    // already-encoded title, and confirms `&` itself is encoded rather than passed through.
    expect(svg).toContain('A &amp; B')
  })

  // The README card looked frozen for weeks (a user could not tell "quiet day" from
  // "stale cache"), so the totals' read instant can be stamped on it. Off by default;
  // only the service knows the real instant and the user's zone, so it hands the
  // renderer a display label — the same supply split as `timezoneLabel`.
  test('stamps the read instant when the option is on', () => {
    const withStamp = renderUsageCardSvg(
      { ...input, updatedAtLabel: '11-23 05:00' },
      { showUpdatedAt: true, metrics: ['totalTokens'] }
    )
    expect(withStamp).toContain('data-card-updated="true"')
    expect(withStamp).toContain('数据更新：11-23 05:00')

    // The default stays quiet even with the instant known: the option being off is
    // the stored-config default, so an existing user's card changes only when they
    // opt in.
    const without = renderUsageCardSvg({ ...input, updatedAtLabel: '11-23 05:00' }, { metrics: ['totalTokens'] })
    expect(without).not.toContain('数据更新：')
    expect(without).not.toContain('data-card-updated')

    // English cards get English copy.
    const english = renderUsageCardSvg(
      { ...input, updatedAtLabel: '11-23 05:00' },
      { language: 'en', showUpdatedAt: true, metrics: ['totalTokens'] }
    )
    expect(english).toContain('Updated: 11-23 05:00')

    // The option is on but nothing supplied the instant: render nothing rather than
    // a clock pretending to be data (older inputs and preview fixtures carry none).
    const missing = renderUsageCardSvg(input, { showUpdatedAt: true, metrics: ['totalTokens'] })
    expect(missing).not.toContain('数据更新：')
    expect(missing).not.toContain('data-card-updated')
  })

  // The stamp joins with the timezone note in the top-right masthead so the card
  // does not need an extra bottom row unless a cost-unavailable footnote is present.
  test('places the stamp and timezone in the top-right masthead without colliding with the cost note', () => {
    const svg = renderUsageCardSvg(
      { ...input, updatedAtLabel: '11-23 05:00', timezoneLabel: 'UTC+8', todayCostAvailable: false },
      { language: 'en', showUpdatedAt: true, metrics: ['todayCost'] }
    )
    expect(svg).toContain('width="520" height="220"')
    expect(svg).toContain('Today: UTC+8 · Updated: 11-23 05:00')
    expect(svg).toContain('data-card-timezone="true"')
    expect(svg).toContain('data-card-updated="true"')
    expect(svg).toContain('* Some sources report no cost')
    expect(svg).not.toContain('FIG. 01')
    expect(svg).not.toContain('TELEMETRY FOLIO')
    expect(svg).toContain('y="24.5" text-anchor="end"')
    expect(svg).toContain('y="213"')
  })

  // Without the stamp the timezone keeps its lone top-right line — the join is
  // only paid for when both notes are on, and no bottom footer row is opened.
  test('the timezone note keeps its lone top-right line when no stamp or cost note is shown', () => {
    const svg = renderUsageCardSvg({ ...input, timezoneLabel: 'UTC+8' }, { language: 'en', metrics: ['todayTokens'] })
    expect(svg).toContain('data-card-timezone="true"')
    expect(svg).toContain('Today: UTC+8')
    expect(svg).not.toContain('· Updated')
    expect(svg).not.toContain('y="213"')
  })

  test('renders the heatmap-style model unit matrix and folds low-share models into 其他 N 个模型', () => {
    const models = [
      { model: 'claude-sonnet-4-6', totalTokens: 578_200_000 },
      { model: 'gemini-4-hydrogen', totalTokens: 398_500_000 },
      { model: 'gpt-5.4-codex', totalTokens: 322_400_000 },
      { model: 'gemini-2.5-pro', totalTokens: 82_200_000 },
      { model: 'claude-opus-4-6', totalTokens: 66_700_000 },
      { model: 'deepseek-r1', totalTokens: 57_300_000 },
      { model: 'o3-mini', totalTokens: 45_120_000 }
    ]

    const zhSvg = renderUsageCardSvg(
      { ...input, totalTokens: 1_550_420_000, monthTokens: 482_910_000, models, totalModelCount: 7 },
      { theme: 'light', layout: 'balanced', language: 'zh' }
    )
    expect(zhSvg).toContain('data-card-model-matrix="true"')
    expect(zhSvg).toContain('1.55B')
    expect(zhSvg).toContain('482.9M')
    expect(zhSvg).toContain('claude-sonnet-4-6')
    expect(zhSvg).toContain('gemini-4-hydrogen')
    expect(zhSvg).toContain('gpt-5.4-codex')
    expect(zhSvg).toContain('gemini-2.5-pro')
    expect(zhSvg).toContain('其他 3 个模型')
    expect(zhSvg).not.toContain('deepseek-r1')
    expect(zhSvg).not.toContain('o3-mini')
    expect(zhSvg).not.toContain('style=')

    const enSvg = renderUsageCardSvg(
      { ...input, totalTokens: 1_550_420_000, models, totalModelCount: 7 },
      { theme: 'dark', layout: 'wide', language: 'en' }
    )
    expect(enSvg).toContain('data-card-model-matrix="true"')
    expect(enSvg).toContain('MODEL UNIT MATRIX')
    expect(enSvg).toContain('Other 3 models')
  })
})
