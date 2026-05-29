import { z } from 'zod'

export const leaderboardPeriodSchema = z.enum(['daily', 'monthly'])
export const leaderboardMetricSchema = z.enum(['tokens', 'tokens-without-cache-read', 'cost'])
