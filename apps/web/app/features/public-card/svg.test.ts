import { describe, expect, test } from 'vitest'
import { renderUsageCardSvg } from './svg'

const input = {
  displayName: 'Eve',
  publicUrl: 'https://tokenboard.example/api/public/eve.svg',
  totalTokens: 1234567,
  totalCostUsd: 42.5,
  monthTokens: 89012,
  monthCostUsd: 6.78,
  todayTokens: 1200,
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
})
