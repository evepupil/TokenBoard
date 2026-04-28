import { z } from 'zod'

export const usageSourceSchema = z.enum(['claude-code', 'codex'])

export const usageSnapshotSchema = z.object({
  source: usageSourceSchema,
  usageDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  collectedAt: z.string().datetime()
})

export type UsageSource = z.infer<typeof usageSourceSchema>
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>

