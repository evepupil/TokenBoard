import { z } from 'zod'
import { isValidTimezone } from '../../lib/timezone'

export const publicProfileSchema = z.object({
  slug: z.string().min(3).max(32).regex(/^[a-z0-9-]+$/),
  displayName: z.string().min(1).max(80),
  timezone: z.string().min(1).max(80).refine(isValidTimezone, 'Invalid timezone'),
  isPublic: z.boolean(),
  participatesInLeaderboards: z.boolean()
})

export type PublicProfileInput = z.infer<typeof publicProfileSchema>
