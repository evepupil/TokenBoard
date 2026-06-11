import { z } from 'zod'

export const usageSourceSchema = z.enum(['claude-code', 'codex'])
export const maxUsageTimezoneLength = 80
export const maxUsageModelNameLength = 160

export const usageTimezoneSchema = z
  .string()
  .min(1)
  .max(maxUsageTimezoneLength)
  .refine(isValidTimezone, 'Invalid timezone')

export const usageModelSchema = z.string().min(1).max(maxUsageModelNameLength)

export const usageSnapshotSchema = z.object({
  source: usageSourceSchema,
  usageDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: usageTimezoneSchema,
  model: usageModelSchema,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  collectedAt: z.string().datetime()
}).superRefine((snapshot, ctx) => {
  if (snapshot.cacheReadTokens > snapshot.totalTokens) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cacheReadTokens'],
      message: 'cacheReadTokens must not exceed totalTokens'
    })
  }
})

export type UsageSource = z.infer<typeof usageSourceSchema>
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>

export type UsageSnapshotKey = Pick<UsageSnapshot, 'source' | 'usageDate' | 'model'>

export function snapshotKey(snapshot: UsageSnapshotKey) {
  return [snapshot.source, snapshot.usageDate, snapshot.model].join('\u0000')
}

export function snapshotHashPayload(snapshot: UsageSnapshot) {
  return JSON.stringify({
    source: snapshot.source,
    usageDate: snapshot.usageDate,
    timezone: snapshot.timezone,
    model: snapshot.model,
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    cacheCreationTokens: snapshot.cacheCreationTokens,
    cacheReadTokens: snapshot.cacheReadTokens,
    totalTokens: snapshot.totalTokens,
    costUsd: snapshot.costUsd,
    sessionCount: snapshot.sessionCount
  })
}

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string') return false

  const timezone = value.trim()
  if (!timezone || timezone !== value || timezone.length > maxUsageTimezoneLength) return false

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0))
    return true
  } catch (_) {
    return false
  }
}
