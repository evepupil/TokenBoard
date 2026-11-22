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
  'deepseek-harness',
  'amp',
  'droid',
  'codebuff',
  'hermes',
  'goose',
  'kilo',
  'copilot',
  'gemini-cli',
  'kimi',
  'qwen',
  'openclaw',
  'zcode'
] as const
/**
 * Tool sources collected through the pinned ccusage runtime. Each maps to a ccusage
 * subcommand of the same name (`ccusage <tool> daily --json`), except gemini-cli which
 * maps to the `gemini` subcommand to avoid clashing with the Antigravity Gemini core.
 */
export const ccusageToolSources = [
  'amp',
  'droid',
  'codebuff',
  'hermes',
  'goose',
  'kilo',
  'copilot',
  'gemini-cli',
  'kimi',
  'qwen',
  'openclaw',
  'zcode'
] as const
export const ccusageToolCommandNames: Record<(typeof ccusageToolSources)[number], string> = {
  amp: 'amp',
  droid: 'droid',
  codebuff: 'codebuff',
  hermes: 'hermes',
  goose: 'goose',
  kilo: 'kilo',
  copilot: 'copilot',
  'gemini-cli': 'gemini',
  kimi: 'kimi',
  qwen: 'qwen',
  openclaw: 'openclaw',
  zcode: 'zcode'
}
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

/**
 * Ceiling for a single snapshot's `costUsd`. Cost is the one field the aggregation layer
 * sums across rows, so an extreme value would overflow that sum to `Infinity`, which then
 * serialises to `null` in the public JSON. Six orders of magnitude above the largest
 * per-snapshot cost seen in production, so it bounds the arithmetic without constraining
 * real usage.
 */
export const maxSnapshotCostUsd = 1_000_000_000

/**
 * Ceiling for a single snapshot's token counts. These fields are summed by the aggregation
 * layer, and SQLite evaluates `SUM` over int64: a sum that leaves that range raises `integer
 * overflow` and aborts the entire statement. In a cross-tenant query one such row therefore
 * fails the endpoint for every reader, not only the account whose rows overflowed. Cost already
 * carried a ceiling for the same reason; these fields did not. The value is far above any real
 * single-day usage — a trillion tokens per row. It bounds one row, not a window: the 5-tuple
 * ingest key includes `device_id`, so an account can still create arbitrarily many capped rows,
 * and ~9.2M of them reach the int64 sum. The public read paths (leaderboard, README card)
 * therefore aggregate with `total()`, which accumulates in floating point and cannot overflow;
 * this ceiling keeps any single value in that float faithful to whole tokens below 2^53.
 */
export const maxSnapshotTokens = 1_000_000_000_000

export const usageSnapshotSchema = z
  .object({
    source: usageSourceSchema,
    usageDate: z.string().refine(isValidIsoDate, 'Invalid ISO date'),
    timezone: usageTimezoneSchema,
    model: usageModelSchema,
    inputTokens: z.number().int().nonnegative().max(maxSnapshotTokens),
    outputTokens: z.number().int().nonnegative().max(maxSnapshotTokens),
    cacheCreationTokens: z.number().int().nonnegative().max(maxSnapshotTokens),
    cacheReadTokens: z.number().int().nonnegative().max(maxSnapshotTokens),
    totalTokens: z.number().int().nonnegative().max(maxSnapshotTokens),
    costUsd: z.number().nonnegative().max(maxSnapshotCostUsd),
    sessionCount: z.number().int().nonnegative().max(maxSnapshotTokens),
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
