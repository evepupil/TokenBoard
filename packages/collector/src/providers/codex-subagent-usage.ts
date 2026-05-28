import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { usageSnapshotSchema, type UsageSnapshot } from '@tokenboard/usage-core'
import {
  extractRows,
  isRecord,
  normalizeDate,
  readCacheCreationTokens,
  readCacheReadTokens,
  readJsonlRecords,
  readNumber,
  readRecord,
  readString,
  readTotalTokens,
  type UnknownRecord
} from './codex-subagent-usage-json'
import { readChildLastUsageByDate, sumDatedUsage } from './codex-subagent-usage-child'
import {
  addMetric,
  distributeMetric,
  prorateCost,
  snapshotKey,
  subtractMetric,
  subtractNonNegative,
  sumMetrics,
  type Metric
} from './codex-subagent-usage-math'

type SubagentMeta = {
  startedAt: string
}

export async function applyCodexSubagentUsageCorrections(input: {
  snapshots: UsageSnapshot[]
  sessions: unknown
  codexHome: string
  timezone?: string
  stderr?: (line: string) => void
}) {
  const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const adjustments = await collectSubagentAdjustments(input.sessions, input.codexHome, timezone, input.stderr)
  if (adjustments.size === 0) return input.snapshots
  return input.snapshots.map((snapshot) =>
    subtractAdjustment(snapshot, adjustments.get(snapshotKey(snapshot)), input.stderr)
  )
}

async function collectSubagentAdjustments(
  sessions: unknown,
  codexHome: string,
  timezone: string,
  stderr?: (line: string) => void
) {
  const adjustments = new Map<string, Metric>()
  for (const row of extractRows(sessions)) {
    const sessionFile = await resolveSessionFile(row, codexHome)
    if (!sessionFile) continue

    const meta = await readSubagentMeta(sessionFile, stderr)
    if (!meta) continue

    const originals = readModelMetrics(row)
    const originalTotal = sumMetrics(originals)
    const correctedByDate = await readCorrectedSubagentMetrics(sessionFile, meta, originalTotal, timezone, stderr)
    const sessionAdjustments = correctedByDate.length > 0
      ? buildSessionAdjustments(originals, correctedByDate)
      : []
    if (correctedByDate.length > 0 && sessionAdjustments.length === 0) {
      stderr?.(`Skipping Codex subagent usage correction for ${originalTotal.usageDate}/${originalTotal.model}: corrected usage exceeds session row`)
      continue
    }
    for (const adjustment of sessionAdjustments) {
      addMetric(adjustments, adjustment)
    }
  }
  return adjustments
}

function buildSessionAdjustments(originals: Metric[], correctedByDate: Metric[]) {
  const originalPartsByModel = originals.map((original) =>
    distributeMetric(original, correctedByDate.map((usage) => ({
      ...original,
      usageDate: usage.usageDate,
      totalTokens: usage.totalTokens
    })))
  )
  const adjustments: Metric[] = []
  for (const [dateIndex, correctedTotal] of correctedByDate.entries()) {
    const originalParts = originalPartsByModel.map((parts) => parts[dateIndex])
    const correctedParts = distributeMetric(correctedTotal, originalParts)
    if (!canSubtractMetrics(originalParts, correctedParts)) return []
    for (const [partIndex, originalPart] of originalParts.entries()) {
      adjustments.push(subtractMetric(originalPart, correctedParts[partIndex]))
    }
  }
  return adjustments
}

async function readCorrectedSubagentMetrics(
  sessionFile: string,
  meta: SubagentMeta,
  original: Metric,
  timezone: string,
  stderr?: (line: string) => void
) {
  const usageByDate = await readChildLastUsageByDate(sessionFile, meta.startedAt, timezone, stderr)
  // last_token_usage is the provider-recorded per-request usage. If Codex sent
  // copied parent context again, that charged input remains in this child total.
  if (usageByDate.length === 0) return []
  const totalUsage = sumDatedUsage(usageByDate)
  if (totalUsage.totalTokens <= 0 || totalUsage.totalTokens > original.totalTokens) return []
  return usageByDate.map((usage) => ({
    usageDate: usage.usageDate,
    model: original.model,
    inputTokens: subtractNonNegative(usage.inputTokens, usage.cacheReadTokens, 'subagent input'),
    outputTokens: usage.outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: usage.cacheReadTokens,
    totalTokens: usage.totalTokens,
    costUsd: prorateCost(original.costUsd, usage.totalTokens, original.totalTokens)
  }))
}

function subtractAdjustment(
  snapshot: UsageSnapshot,
  adjustment: Metric | undefined,
  stderr?: (line: string) => void
) {
  if (!adjustment) return snapshot
  // ccusage daily can already be based on child request usage while session rows
  // still contain larger cumulative counters. In that case there is nothing to
  // subtract from the daily snapshot without undercounting charged usage.
  if (!canSubtractAdjustment(snapshot, adjustment)) {
    stderr?.(`Skipping Codex subagent usage correction for ${snapshot.usageDate}/${snapshot.model}: corrected usage exceeds daily snapshot`)
    return snapshot
  }
  return usageSnapshotSchema.parse({
    ...snapshot,
    inputTokens: subtractNonNegative(snapshot.inputTokens, adjustment.inputTokens, snapshotKey(snapshot)),
    outputTokens: subtractNonNegative(snapshot.outputTokens, adjustment.outputTokens, snapshotKey(snapshot)),
    cacheCreationTokens: subtractNonNegative(snapshot.cacheCreationTokens, adjustment.cacheCreationTokens, snapshotKey(snapshot)),
    cacheReadTokens: subtractNonNegative(snapshot.cacheReadTokens, adjustment.cacheReadTokens, snapshotKey(snapshot)),
    totalTokens: subtractNonNegative(snapshot.totalTokens, adjustment.totalTokens, snapshotKey(snapshot)),
    costUsd: subtractNonNegative(snapshot.costUsd, adjustment.costUsd, snapshotKey(snapshot))
  })
}

function canSubtractAdjustment(snapshot: UsageSnapshot, adjustment: Metric) {
  return (
    canSubtract(snapshot.inputTokens, adjustment.inputTokens) &&
    canSubtract(snapshot.outputTokens, adjustment.outputTokens) &&
    canSubtract(snapshot.cacheCreationTokens, adjustment.cacheCreationTokens) &&
    canSubtract(snapshot.cacheReadTokens, adjustment.cacheReadTokens) &&
    canSubtract(snapshot.totalTokens, adjustment.totalTokens) &&
    canSubtract(snapshot.costUsd, adjustment.costUsd)
  )
}

function canSubtractMetrics(left: Metric[], right: Metric[]) {
  return left.every((metric, index) => {
    const candidate = right[index]
    return (
      canSubtract(metric.inputTokens, candidate.inputTokens) &&
      canSubtract(metric.outputTokens, candidate.outputTokens) &&
      canSubtract(metric.cacheCreationTokens, candidate.cacheCreationTokens) &&
      canSubtract(metric.cacheReadTokens, candidate.cacheReadTokens) &&
      canSubtract(metric.totalTokens, candidate.totalTokens) &&
      canSubtract(metric.costUsd, candidate.costUsd)
    )
  })
}

function canSubtract(left: number, right: number) {
  return left - right >= -0.000001
}

function readModelMetrics(row: UnknownRecord): Metric[] {
  return extractModelRows(row).map(({ model, metrics }) => ({
    usageDate: readSessionDate(row),
    model,
    inputTokens: readNumber(metrics, ['inputTokens']),
    outputTokens: readNumber(metrics, ['outputTokens']),
    cacheCreationTokens: readCacheCreationTokens(metrics),
    cacheReadTokens: readCacheReadTokens(metrics),
    totalTokens: readTotalTokens(metrics),
    costUsd: readCostUsd(metrics, row)
  }))
}

function extractModelRows(row: UnknownRecord) {
  const models = row.models
  if (isRecord(models)) {
    return Object.entries(models)
      .filter(([, metrics]) => isRecord(metrics))
      .map(([model, metrics]) => ({ model, metrics: metrics as UnknownRecord }))
  }
  return [{ model: readModel(row), metrics: row }]
}

async function readSubagentMeta(filePath: string, stderr?: (line: string) => void): Promise<SubagentMeta | null> {
  for await (const record of readJsonlRecords(filePath, stderr)) {
    if (record.type !== 'session_meta') continue
    const payload = readRecord(record.payload)
    const parentThreadId = readParentThreadId(payload)
    const startedAt = readString(payload, ['timestamp']) || readString(record, ['timestamp'])
    if (parentThreadId && startedAt) return { startedAt }
  }
  return null
}

async function resolveSessionFile(row: UnknownRecord, codexHome: string) {
  const sessionsDir = resolve(codexHome, 'sessions')
  const sessionId = readString(row, ['sessionId'])
  if (sessionId) return existingSessionFile(sessionsDir, `${sessionId}.jsonl`)

  const directory = readString(row, ['directory'])
  const sessionFile = readString(row, ['sessionFile'])
  if (directory && sessionFile) return existingSessionFile(sessionsDir, directory, `${sessionFile}.jsonl`)
  return null
}

async function existingSessionFile(sessionsDir: string, ...segments: string[]) {
  const filePath = resolve(sessionsDir, ...segments)
  if (!isPathInside(sessionsDir, filePath)) return null
  return existingFile(filePath)
}

function isPathInside(parent: string, child: string) {
  const relativePath = relative(parent, child)
  if (isAbsolute(relativePath)) return false
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`)
}

async function existingFile(filePath: string) {
  return stat(filePath)
    .then((fileStat) => fileStat.isFile() ? filePath : null)
    .catch(() => null)
}

function readParentThreadId(payload: UnknownRecord | null) {
  const source = readRecord(payload?.source)
  const subagent = readRecord(source?.subagent)
  const threadSpawn = readRecord(subagent?.thread_spawn)
  return readString(threadSpawn, ['parent_thread_id'])
}

function readSessionDate(row: UnknownRecord) {
  const value = readString(row, ['lastActivity', 'date', 'usageDate'])
  if (!value) throw new Error('Codex session row is missing last activity')
  return normalizeDate(value)
}

function readModel(row: UnknownRecord) {
  return readString(row, ['model', 'modelName', 'name']) || 'all'
}

function readCostUsd(row: UnknownRecord, parent: UnknownRecord) {
  const directCost = readNumber(row, ['costUsd', 'costUSD', 'cost'])
  if (directCost > 0 || row === parent) return directCost

  const parentCost = readNumber(parent, ['costUsd', 'costUSD', 'cost'])
  const parentTokens = readTotalTokens(parent)
  const rowTokens = readTotalTokens(row)
  if (parentCost <= 0 || parentTokens <= 0 || rowTokens <= 0) return 0
  return parentCost * (rowTokens / parentTokens)
}
