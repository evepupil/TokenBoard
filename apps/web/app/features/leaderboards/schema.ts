import { z } from 'zod'

export const leaderboardPeriodSchema = z.enum(['daily', 'monthly'])
export const leaderboardMetricSchema = z.enum(['tokens', 'cost'])

