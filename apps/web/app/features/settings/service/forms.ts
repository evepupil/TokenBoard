import { parsePublicCardConfigForm } from '../../public-card/config'
import { publicProfileSchema, type PublicProfileInput } from '../schema'
import type { ProfilePageInput } from './types'

export function parseProfileForm(form: Record<string, unknown>): PublicProfileInput {
  return publicProfileSchema.parse({
    slug: String(form.slug || ''),
    displayName: String(form.displayName || ''),
    timezone: String(form.timezone || 'UTC'),
    isPublic: form.isPublic === 'on',
    participatesInLeaderboards: form.participatesInLeaderboards === 'on'
  })
}

export function parseProfilePageForm(form: Record<string, unknown>): ProfilePageInput {
  return {
    profile: parseProfileForm(form),
    publicCardConfig: parsePublicCardConfigForm(form)
  }
}
