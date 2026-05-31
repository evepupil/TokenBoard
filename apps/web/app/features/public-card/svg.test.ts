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
    expect(svg).toContain('#161a13')
    expect(svg).toContain('url(#glow)')
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
    expect(svg).toContain('#fffef8')
    expect(svg).toContain('fill="#365314"')
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
})
