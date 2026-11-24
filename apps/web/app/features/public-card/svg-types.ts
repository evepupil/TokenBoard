import type { PublicCardConfig } from './config'
import type { UsageCardModelSlice } from './model-matrix'

export type UsageCardInput = {
  displayName: string
  publicUrl: string
  totalTokens: number
  totalTokensWithoutCacheRead?: number
  totalCacheReadRate?: number
  totalCostUsd: number
  totalCostAvailable?: boolean
  monthTokens: number
  monthTokensWithoutCacheRead?: number
  monthCacheReadRate?: number
  monthCostUsd: number
  monthCostAvailable?: boolean
  todayTokens?: number
  todayTokensWithoutCacheRead?: number
  todayCacheReadRate?: number
  todayCostUsd?: number
  todayCostAvailable?: boolean
  /**
   * Optional per-model token breakdown used to render the heatmap-style Model Unit Matrix.
   * Models below the share threshold are automatically aggregated into "其他 N 个模型" / "Other N models".
   */
  models?: ReadonlyArray<UsageCardModelSlice>
  /**
   * Optional total distinct model count behind `models` when `models` only carries a top-K slice.
   */
  totalModelCount?: number
  /**
   * The offset of the owner's zone right now, e.g. `UTC+8`.
   */
  timezoneLabel?: string
  /**
   * The totals' freshness, already formatted in the owner's zone (e.g. `11-23 13:05`).
   */
  updatedAtLabel?: string | null
}

export type Palette = {
  bg: string
  mastheadBg: string
  primaryCellBg: string
  wafflePanelBg: string
  footerBg: string
  accent: string
  text: string
  muted: string
  subtle: string
  border: string
  ruleStrong: string
  highlightText: string
  glowColor: string
  viz1: string
  viz2: string
  viz3: string
  vizInk: string
  vizOther: string
  neutralData: string
  logoBg: string
  logoBorder: string
  logoInk: string
  logoCapstone: string
}

export const palettes = {
  dark: {
    bg: '#121318',
    mastheadBg: '#121318',
    primaryCellBg: '#181a22',
    wafflePanelBg: '#161820',
    footerBg: '#15171e',
    accent: '#8fa2ff',
    text: '#eceaf2',
    muted: '#b9b6c4',
    subtle: '#8f8b9c',
    border: '#343642',
    ruleStrong: '#eceaf2',
    highlightText: '#a9b6ff',
    glowColor: '#8fa2ff',
    viz1: '#ff7a59',
    viz2: '#8fa2ff',
    viz3: '#e58af0',
    vizInk: '#e8e6f0',
    vizOther: '#4a4d5e',
    neutralData: '#3a3c47',
    logoBg: '#1c1e26',
    logoBorder: '#3a3c47',
    logoInk: '#eceaf2',
    logoCapstone: '#8fa2ff'
  },
  light: {
    bg: '#e8e6ef',
    mastheadBg: '#e8e6ef',
    primaryCellBg: '#f4f3f8',
    wafflePanelBg: '#eeecf4',
    footerBg: '#e2e0eb',
    accent: '#6c50f6',
    text: '#121116',
    muted: '#4a4752',
    subtle: '#625f6b',
    border: '#c2bed0',
    ruleStrong: '#121116',
    highlightText: '#5a3be6',
    glowColor: '#7c63ff',
    viz1: '#e2492c',
    viz2: '#7c63ff',
    viz3: '#c04bd9',
    vizInk: '#18171d',
    vizOther: '#b5b1c3',
    neutralData: '#cfcbd9',
    logoBg: '#121116',
    logoBorder: '#2d2b38',
    logoInk: '#f4f3f8',
    logoCapstone: '#6c50f6'
  }
} as const satisfies Record<PublicCardConfig['theme'], Palette>
