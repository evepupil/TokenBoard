import { describe, expect, test } from 'vitest'
import {
  defaultPublicCardConfig,
  parsePublicCardConfig,
  parsePublicCardConfigForm,
  stringifyPublicCardConfig
} from './config'

describe('public card config', () => {
  test('uses default config for empty stored values', () => {
    expect(parsePublicCardConfig(null)).toEqual(defaultPublicCardConfig)
    expect(parsePublicCardConfig('')).toEqual(defaultPublicCardConfig)
  })

  test('parses stored config with defaults and unique metric order', () => {
    expect(parsePublicCardConfig(JSON.stringify({
      language: 'en',
      theme: 'light',
      metrics: ['todayTokens', 'todayTokens', 'totalCost']
    }))).toMatchObject({
      language: 'en',
      theme: 'light',
      layout: 'balanced',
      metrics: ['todayTokens', 'totalCost']
    })
  })

  test('truncates stored metric lists to rendered slots', () => {
    expect(parsePublicCardConfig(JSON.stringify({
      metrics: [
        'totalTokens',
        'totalCost',
        'monthTokens',
        'monthCost',
        'todayTokens',
        'todayCost',
        'totalTokensWithoutCacheRead'
      ]
    })).metrics).toEqual([
      'totalTokens',
      'totalCost',
      'monthTokens',
      'monthCost',
      'todayTokens',
      'todayCost'
    ])
  })

  test('uses default config for invalid stored values', () => {
    expect(parsePublicCardConfig(JSON.stringify({
      language: 'de',
      metrics: ['totalTokens', 'legacyMetric']
    }))).toEqual(defaultPublicCardConfig)
  })

  test('parses form slots as metric enablement and order', () => {
    expect(parsePublicCardConfigForm({
      cardLanguage: 'en',
      cardTheme: 'light',
      cardLayout: 'compact',
      cardTitle: 'Usage',
      cardSubtitle: 'Latest stats',
      cardShowPublicUrl: 'on',
      cardGlowEnabled: 'on',
      cardGlowIntensity: '0.5',
      cardGlowPosition: 'center',
      cardMetric1: 'todayTokens',
      cardMetric2: '',
      cardMetric3: 'totalCost',
      cardMetric4: 'todayTokens'
    })).toEqual({
      language: 'en',
      theme: 'light',
      layout: 'compact',
      title: 'Usage',
      subtitle: 'Latest stats',
      showPublicUrl: true,
      glow: {
        enabled: true,
        intensity: 0.5,
        position: 'center'
      },
      metrics: ['todayTokens', 'totalCost']
    })
  })

  test('returns null when resetting to defaults', () => {
    expect(parsePublicCardConfigForm({ cardAction: 'reset' })).toBeNull()
  })

  test('allows all metric slots to be hidden', () => {
    expect(parsePublicCardConfigForm({
      cardMetric1: '',
      cardMetric2: '',
      cardMetric3: '',
      cardMetric4: '',
      cardMetric5: '',
      cardMetric6: ''
    })?.metrics).toEqual([])
  })

  test('stringifies only normalized config', () => {
    expect(JSON.parse(stringifyPublicCardConfig({
      ...defaultPublicCardConfig,
      metrics: ['totalTokens', 'totalTokens', 'todayCost']
    }))).toMatchObject({
      metrics: ['totalTokens', 'todayCost']
    })
  })

  test('keeps card metric slots separate from available metric choices', () => {
    expect(parsePublicCardConfigForm({
      cardMetric1: 'totalTokensWithoutCacheRead',
      cardMetric6: 'todayTokensWithoutCacheRead',
      cardMetric7: 'monthTokensWithoutCacheRead'
    })?.metrics).toEqual(['totalTokensWithoutCacheRead', 'todayTokensWithoutCacheRead'])
  })

  test('accepts cache read rate card metrics', () => {
    expect(parsePublicCardConfigForm({
      cardMetric1: 'totalCacheReadRate',
      cardMetric2: 'monthCacheReadRate',
      cardMetric3: 'todayCacheReadRate'
    })?.metrics).toEqual(['totalCacheReadRate', 'monthCacheReadRate', 'todayCacheReadRate'])
  })
})
