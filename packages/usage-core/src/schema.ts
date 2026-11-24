import { z } from 'zod'
import { isValidTimezone } from './timezone'

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

export type UsageSource = (typeof usageSources)[number]

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

export type CcusageToolSource = (typeof ccusageToolSources)[number]

export const ccusageToolCommandNames: Record<CcusageToolSource, string> = {
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

export type AntigravityUsageSource = (typeof antigravityUsageSources)[number]

const antigravityUsageSourceSet = new Set<string>(antigravityUsageSources)

export function isAntigravityUsageSource(source: UsageSource): source is AntigravityUsageSource {
  return antigravityUsageSourceSet.has(source)
}

export const costUnavailableSources = [
  'antigravity-cli',
  'antigravity',
  'antigravity-ide',
  'grok-build',
  'deepseek-harness'
] as const

export type CostUnavailableSource = (typeof costUnavailableSources)[number]

const costUnavailableMessages: Record<CostUnavailableSource, string> = {
  'antigravity-cli': 'Antigravity source costs are unavailable; costUsd must be 0',
  antigravity: 'Antigravity source costs are unavailable; costUsd must be 0',
  'antigravity-ide': 'Antigravity source costs are unavailable; costUsd must be 0',
  'grok-build': 'Grok Build source costs are unavailable; costUsd must be 0',
  'deepseek-harness': 'DeepSeek Harness source costs are unavailable; costUsd must be 0'
}

const costUnavailableSourceSet = new Set<string>(costUnavailableSources)

export function isCostUnavailableSource(source: string): source is CostUnavailableSource {
  return costUnavailableSourceSet.has(source)
}

export const maxSnapshotTokens = 1_000_000_000_000
export const maxSnapshotCostUsd = 1_000_000_000
export const maxUsageModelNameLength = 160
export const minUploadIsoDate = '2023-01-01'

const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/

export function isValidIsoDate(value: string): boolean {
  const match = isoDatePattern.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) return false
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function maxUploadIsoDate(now = new Date()): string {
  return new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10)
}

export type UploadIsoDateIssue = 'invalid' | 'too-far-future' | 'before-history-window' | null

export function uploadIsoDateIssue(value: string, now = new Date()): UploadIsoDateIssue {
  if (!isValidIsoDate(value)) return 'invalid'
  if (value > maxUploadIsoDate(now)) return 'too-far-future'
  if (value < minUploadIsoDate) return 'before-history-window'
  return null
}

export function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

export const usageSourceSchema = z.enum(usageSources)

export const usageModelSchema = z.string().min(1).max(maxUsageModelNameLength)

export const usageCorrectionSchema = z.literal('codex-context-pricing')

const snapshotTokenField = z.number().int().min(0).max(maxSnapshotTokens)

export const usageSnapshotSchema = z
  .object({
    source: usageSourceSchema,
    usageDate: z.string().refine(isValidIsoDate, { message: 'Invalid ISO date' }),
    timezone: z.string().refine(isValidTimezone, { message: 'Invalid timezone' }),
    model: usageModelSchema,
    inputTokens: snapshotTokenField,
    outputTokens: snapshotTokenField,
    cacheCreationTokens: snapshotTokenField,
    cacheReadTokens: snapshotTokenField,
    totalTokens: snapshotTokenField,
    costUsd: z.number().finite().min(0).max(maxSnapshotCostUsd),
    sessionCount: snapshotTokenField,
    correction: usageCorrectionSchema.optional(),
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
        message: costUnavailableMessages[snapshot.source]
      })
    }
  })

export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>

export type UsageSnapshotKey = Pick<UsageSnapshot, 'source' | 'usageDate' | 'model'>

export function snapshotKey(key: UsageSnapshotKey): string {
  return `${key.source}\0${key.usageDate}\0${key.model}`
}

export function snapshotHashPayload(snapshot: UsageSnapshot): string {
  const payload: Record<string, unknown> = {
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
  }
  if (snapshot.correction !== undefined) {
    payload.correction = snapshot.correction
  }
  return JSON.stringify(payload)
}
