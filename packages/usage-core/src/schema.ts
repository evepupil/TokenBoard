import { z } from 'zod'
import { isValidIsoDate } from './dates'

export const usageSources = [
  'claude-code',
  'codex',
  'antigravity-cli',
  'antigravity',
  'antigravity-ide',
  'opencode',
  'pi',
  'grok-build',
  'deepseek-harness'
] as const
export const antigravityUsageSources = ['antigravity-cli', 'antigravity', 'antigravity-ide'] as const

/**
 * Sources whose local usage records carry no cost figure. Deriving one from a
 * pricing table would be a guess, so the collector uploads `costUsd: 0` and
 * every reporting surface labels the cost as unavailable instead of `$0.00`.
 */
export const costUnavailableSources = [
  'antigravity-cli',
  'antigravity',
  'antigravity-ide',
  'grok-build',
  'deepseek-harness'
] as const

const costUnavailableMessages: Record<(typeof costUnavailableSources)[number], string> = {
  'antigravity-cli': 'Antigravity source costs are unavailable; costUsd must be 0',
  antigravity: 'Antigravity source costs are unavailable; costUsd must be 0',
  'antigravity-ide': 'Antigravity source costs are unavailable; costUsd must be 0',
  'grok-build': 'Grok Build source costs are unavailable; costUsd must be 0',
  'deepseek-harness': 'DeepSeek Harness source costs are unavailable; costUsd must be 0'
}

export const usageSourceSchema = z.enum(usageSources)
export const maxUsageTimezoneLength = 80
export const maxUsageModelNameLength = 160
const validTimezoneCache = new Set<string>()

export const usageTimezoneSchema = z
  .string()
  .min(1)
  .max(maxUsageTimezoneLength)
  .refine(isValidTimezone, 'Invalid timezone')

export const usageModelSchema = z.string().min(1).max(maxUsageModelNameLength)

export const usageSnapshotSchema = z
  .object({
    source: usageSourceSchema,
    usageDate: z.string().refine(isValidIsoDate, 'Invalid ISO date'),
    timezone: usageTimezoneSchema,
    model: usageModelSchema,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheCreationTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    sessionCount: z.number().int().nonnegative(),
    correction: z.literal('codex-context-pricing').optional(),
    collectedAt: z.string().datetime()
  })
  .superRefine((snapshot, ctx) => {
    if (snapshot.cacheReadTokens > snapshot.totalTokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cacheReadTokens'],
        message: 'cacheReadTokens must not exceed totalTokens'
      })
    }

    if (isCostUnavailableSource(snapshot.source) && snapshot.costUsd > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['costUsd'],
        message: costUnavailableMessages[snapshot.source as (typeof costUnavailableSources)[number]]
      })
    }
  })

export type UsageSource = z.infer<typeof usageSourceSchema>
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>

export type UsageSnapshotKey = Pick<UsageSnapshot, 'source' | 'usageDate' | 'model'>

export function isAntigravityUsageSource(source: UsageSource) {
  return (antigravityUsageSources as readonly UsageSource[]).includes(source)
}

/** True when the source cannot report a cost, so `costUsd` carries no meaning. */
export function isCostUnavailableSource(source: UsageSource) {
  return (costUnavailableSources as readonly UsageSource[]).includes(source)
}

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
    sessionCount: snapshot.sessionCount,
    correction: snapshot.correction
  })
}

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string') return false

  const timezone = value.trim()
  if (!timezone || timezone !== value || timezone.length > maxUsageTimezoneLength) return false
  const cacheKey = timezone.toLowerCase()
  if (validTimezoneCache.has(cacheKey)) return true

  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    formatter.format(new Date(0))
    validTimezoneCache.add(cacheKey)
    validTimezoneCache.add(formatter.resolvedOptions().timeZone.toLowerCase())
    return true
  } catch (_) {
    return false
  }
}

export function timezoneValidationCacheSize() {
  return validTimezoneCache.size
}
