import type { PublicCardConfig } from '../../public-card/config'
import type { PublicProfileInput } from '../schema'

export const profileTimezoneSource = {
  default: 'default',
  browser: 'browser',
  user: 'user'
} as const

export type ProfileSettings = PublicProfileInput & {
  publicJsonUrl: string
  publicSvgUrl: string
  publicMarkdown: string
  publicCardConfig: PublicCardConfig
  shouldUseBrowserTimezoneDefault?: boolean
  profileNeedsRepair?: boolean
}

export type ProfileTimezoneSettings = {
  timezone: string
  shouldUseBrowserTimezoneDefault?: boolean
  profileNeedsRepair?: boolean
}

export type ProfilePageInput = {
  profile: PublicProfileInput
  publicCardConfig: PublicCardConfig | null
}

export type ProfileRow = {
  userId: string
  slug: string
  displayName: string
  timezone: string
  isPublic: number | boolean
  participatesInLeaderboards: number | boolean
  publicCardConfig?: string | null
  timezoneSource?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export type ProfileTimezoneRow = {
  userId: string
  timezone: string | null
  timezoneSource?: string | null
}

export type ProfileDisplayNameRow = {
  displayName: string | null
}
