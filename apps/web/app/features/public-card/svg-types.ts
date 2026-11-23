import type { PublicCardConfig } from './config'

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
   * The offset of the owner's zone right now, e.g. `UTC+8`.
   *
   * The card is read from anywhere — it is embedded in a README — while "今日" on it is the
   * *owner's* local day, and a viewer several zones away cannot tell that from the number. The
   * offset is what answers "which day": two zones at the same offset turn the day over at the
   * same instant. The zone's name is deliberately not rendered — it is longer than the line
   * allows, and a public card naming the owner's exact zone discloses where they are, which the
   * offset does not. `/api/public/<slug>.json` still reports the name for anything that needs it.
   *
   * Left optional because cards rendered from older stored configs and the JSON fixtures carry
   * none, and a guess would be worse than no note.
   */
  timezoneLabel?: string
  /**
   * The totals' freshness, already formatted in the owner's zone (e.g. `11-23 13:05`).
   *
   * The service supplies a label rather than an ISO instant because the card is read from
   * anywhere while the stamp has to mean the *owner's* clock — the same reason
   * `timezoneLabel` exists. Optional because the preview paths (SSR fixtures, the live
   * editor POST) have no real totals behind them and inventing a fresh time would be a
   * lie; they leave it unset. Rendered only when the config's `showUpdatedAt` is on.
   */
  updatedAtLabel?: string | null
}

export type Palette = {
  bgStart: string
  bgEnd: string
  panel: string
  panelStrong: string
  text: string
  muted: string
  border: string
  logoPanelStart: string
  logoPanelEnd: string
  shadow: string
  highlightText: string
}

export const palettes = {
  dark: {
    bgStart: '#161a13',
    bgEnd: '#0c0d0a',
    panel: '#151812',
    panelStrong: '#10130f',
    text: '#fafaf9',
    muted: '#a8a29e',
    border: '#78716c',
    logoPanelStart: '#272a22',
    logoPanelEnd: '#11130f',
    shadow: '#090a08',
    highlightText: '#bef264'
  },
  light: {
    bgStart: '#fffef8',
    bgEnd: '#ede6d8',
    panel: '#f8f4ec',
    panelStrong: '#ffffff',
    text: '#1c1917',
    muted: '#57534e',
    border: '#a8a29e',
    logoPanelStart: '#f8f4ec',
    logoPanelEnd: '#e7dccb',
    shadow: '#f4f0e8',
    highlightText: '#365314'
  }
} as const satisfies Record<PublicCardConfig['theme'], Palette>
