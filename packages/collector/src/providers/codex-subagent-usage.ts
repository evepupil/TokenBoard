import { lstat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
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
import {
  ChildUsageEventMerger,
  codexChildSessionReadLimits,
  formatCodexUsageDate,
  readChildLastUsageEvents,
  readChildLastUsageByDate,
  sumDatedUsage
} from './codex-subagent-usage-child'
import {
  withCodexSubagentUsageCache,
  type CodexSubagentUsageCacheFile,
  type ReadChildUsageByDate,
  type ReadChildUsageEvents
} from './codex-subagent-usage-cache'
import {
  createCodexSubagentUsageWorkerPool,
  defaultCodexSubagentWorkerCount,
  normalizeCodexSubagentWorkerCount
} from './codex-subagent-usage-worker-pool'
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
import { resolveCodexSessionRoot } from './codex-symlink-policy'

type SubagentMeta = {
  startedAt: string
}

type ResolvedSessionFile = {
  sourceFilePath: string
  readFilePath: string
}

type OversizedIrrelevantChildRowSummary = {
  rows: number
  largestBytes: number
}

const oversizedIrrelevantChildRowPattern =
  /^Skipped ([1-9][0-9]*) oversized Codex child session JSONL rows? without usage or subagent metadata \(largest ([1-9][0-9]*) bytes\)$/

export async function applyCodexSubagentUsageCorrections(input: {
  snapshots: UsageSnapshot[]
  sessions: unknown
  codexHomes: string[]
  timezone?: string
  stderr?: (line: string) => void
  stateDir?: string
  cacheFiles?: ReadonlyMap<string, CodexSubagentUsageCacheFile>
  readChildUsageByDate?: ReadChildUsageByDate
  readChildUsageEvents?: ReadChildUsageEvents
  maxConcurrentChildReads?: number
  codexSymlinkRoots?: readonly string[]
}) {
  if (input.snapshots.length === 0) return input.snapshots

  const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const readerRuntime = createChildReaderRuntime(input)
  const diagnostics = createCodexSubagentDiagnostics(input.stderr)
  const earliestSnapshotDate = input.snapshots.reduce(
    (earliest, snapshot) => (snapshot.usageDate < earliest ? snapshot.usageDate : earliest),
    input.snapshots[0].usageDate
  )
  try {
    const adjustments = await withCodexSubagentUsageCache({
      stateDir: input.stateDir,
      timezone,
      cacheFiles: input.cacheFiles,
      readChildUsageByDate: readerRuntime.read,
      readChildUsageEvents: readerRuntime.readEvents,
      callback: (reader) =>
        collectSubagentAdjustments({
          sessions: input.sessions,
          codexHomes: input.codexHomes,
          timezone,
          earliestSnapshotDate,
          stderr: diagnostics.report,
          readChildUsageByDate: reader.read,
          readChildUsageEvents: reader.readEvents,
          maxConcurrentChildReads: readerRuntime.concurrency,
          codexSymlinkRoots: input.codexSymlinkRoots
        })
    })
    if (adjustments.size === 0) return input.snapshots
    return input.snapshots.map((snapshot) =>
      subtractAdjustment(snapshot, adjustments.get(snapshotKey(snapshot)), diagnostics.report)
    )
  } finally {
    try {
      await readerRuntime.close()
    } finally {
      diagnostics.flush()
    }
  }
}

function createCodexSubagentDiagnostics(stderr?: (line: string) => void) {
  let skippedRows = 0
  let largestSkippedRowBytes = 0
  let skippedRowScans = 0

  return {
    report(line: string) {
      const summary = parseOversizedIrrelevantChildRowSummary(line)
      if (!summary) {
        stderr?.(line)
        return
      }
      skippedRows += summary.rows
      largestSkippedRowBytes = Math.max(largestSkippedRowBytes, summary.largestBytes)
      skippedRowScans += 1
    },
    flush() {
      if (skippedRows === 0) return
      const rowLabel = skippedRows === 1 ? 'row' : 'rows'
      const scanLabel = skippedRowScans === 1 ? 'scan' : 'scans'
      stderr?.(
        `Skipped ${skippedRows} oversized Codex child session JSONL ${rowLabel} without usage or subagent metadata across ${skippedRowScans} ${scanLabel} (largest ${largestSkippedRowBytes} bytes)`
      )
    }
  }
}

function parseOversizedIrrelevantChildRowSummary(line: string): OversizedIrrelevantChildRowSummary | null {
  const match = oversizedIrrelevantChildRowPattern.exec(line)
  if (!match) return null
  const rows = Number(match[1])
  const largestBytes = Number(match[2])
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(largestBytes)) return null
  return { rows, largestBytes }
}

async function collectSubagentAdjustments(input: {
  sessions: unknown
  codexHomes: string[]
  timezone: string
  earliestSnapshotDate: string
  stderr?: (line: string) => void
  readChildUsageByDate: ReadChildUsageByDate
  readChildUsageEvents: ReadChildUsageEvents
  maxConcurrentChildReads: number
  codexSymlinkRoots?: readonly string[]
}) {
  const adjustments = new Map<string, Metric>()
  const rows = extractRows(input.sessions).filter((row) =>
    sessionCouldAffectSnapshotWindow(row, input.earliestSnapshotDate, input.timezone)
  )
  const results = await mapWithConcurrency(rows, input.maxConcurrentChildReads, (row) =>
    collectSessionAdjustments(row, input)
  )
  for (const sessionAdjustments of results) {
    for (const adjustment of sessionAdjustments) {
      addMetric(adjustments, adjustment)
    }
  }
  return adjustments
}

async function collectSessionAdjustments(
  row: UnknownRecord,
  input: {
    codexHomes: string[]
    timezone: string
    stderr?: (line: string) => void
    readChildUsageByDate: ReadChildUsageByDate
    readChildUsageEvents: ReadChildUsageEvents
    codexSymlinkRoots?: readonly string[]
  }
) {
  const sessionFiles = await resolveSessionFiles(row, input.codexHomes, input.codexSymlinkRoots)
  if (sessionFiles.length === 0) return []

  const meta = await readSubagentMetaFromFiles(sessionFiles, input.stderr)
  if (!meta) return []

  const originals = readModelMetrics(row)
  const originalTotal = sumMetrics(originals)
  const correctedByDate = await readCorrectedSubagentMetrics(
    sessionFiles,
    meta,
    originalTotal,
    input.timezone,
    input.stderr,
    input.readChildUsageByDate,
    input.readChildUsageEvents
  )
  const adjustments = correctedByDate.length > 0 ? buildSessionAdjustments(originals, correctedByDate) : []
  if (correctedByDate.length > 0 && adjustments.length === 0) {
    input.stderr?.(
      `Skipping Codex subagent usage correction for ${originalTotal.usageDate}/${originalTotal.model}: corrected usage exceeds session row`
    )
  }
  return adjustments
}

function createChildReaderRuntime(input: {
  readChildUsageByDate?: ReadChildUsageByDate
  readChildUsageEvents?: ReadChildUsageEvents
  maxConcurrentChildReads?: number
}) {
  const hasInjectedReader = Boolean(input.readChildUsageByDate || input.readChildUsageEvents)
  const concurrency =
    input.maxConcurrentChildReads === undefined
      ? hasInjectedReader
        ? 1
        : defaultCodexSubagentWorkerCount()
      : normalizeCodexSubagentWorkerCount(input.maxConcurrentChildReads)
  if (hasInjectedReader || concurrency === 1) {
    return {
      concurrency,
      read: input.readChildUsageByDate ?? readChildLastUsageByDate,
      readEvents: input.readChildUsageEvents ?? readChildLastUsageEvents,
      close: async () => undefined
    }
  }
  let pool: ReturnType<typeof createCodexSubagentUsageWorkerPool> | undefined
  const getPool = () => {
    pool ??= createCodexSubagentUsageWorkerPool(concurrency)
    return pool
  }
  return {
    concurrency,
    read: (...args: Parameters<ReadChildUsageByDate>) => getPool().read(...args),
    readEvents: (...args: Parameters<ReadChildUsageEvents>) => getPool().readEvents(...args),
    close: async () => pool?.close()
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
) {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(values[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function sessionCouldAffectSnapshotWindow(row: UnknownRecord, earliestSnapshotDate: string, timezone: string) {
  const lastActivity = readString(row, ['lastActivity', 'date', 'usageDate'])
  if (!lastActivity) return true
  try {
    return formatCodexUsageDate(lastActivity, timezone) >= earliestSnapshotDate
  } catch {
    // Keep malformed values on the existing validation path after identifying a child session.
    return true
  }
}

function buildSessionAdjustments(originals: Metric[], correctedByDate: Metric[]) {
  const originalPartsByModel = originals.map((original) =>
    distributeMetric(
      original,
      correctedByDate.map((usage) => ({
        ...original,
        usageDate: usage.usageDate,
        totalTokens: usage.totalTokens
      }))
    )
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
  sessionFiles: ResolvedSessionFile[],
  meta: SubagentMeta,
  original: Metric,
  timezone: string,
  stderr: ((line: string) => void) | undefined,
  readChildUsageByDate: ReadChildUsageByDate,
  readChildUsageEvents: ReadChildUsageEvents
) {
  const usageByDate =
    sessionFiles.length === 1
      ? await readChildUsageByDate(
          sessionFiles[0].readFilePath,
          meta.startedAt,
          timezone,
          stderr,
          sessionFiles[0].sourceFilePath
        )
      : await readCrossProfileChildUsageByDate(sessionFiles, meta.startedAt, timezone, stderr, readChildUsageEvents)
  // last_token_usage is the provider-recorded per-request usage. If Codex sent
  // copied parent context again, that charged input remains in this child total.
  if (usageByDate.length === 0) return []
  const totalUsage = sumDatedUsage(usageByDate)
  if (totalUsage.totalTokens <= 0 || totalUsage.totalTokens > original.totalTokens) return []
  return usageByDate.map((usage) => ({
    usageDate: usage.usageDate,
    model: original.model,
    inputTokens: correctedChildInputTokens(usage),
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    totalTokens: usage.totalTokens,
    costUsd: prorateCost(original.costUsd, usage.totalTokens, original.totalTokens)
  }))
}

function correctedChildInputTokens(usage: {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
}) {
  // Legacy Codex records report cached input inside input_tokens, while newer
  // records can report it as a separate additive field. The total proves which
  // representation produced this event; without that proof preserve input.
  const cacheReadIsIncludedInInput =
    usage.cacheReadTokens <= usage.inputTokens &&
    usage.totalTokens === usage.inputTokens + usage.cacheCreationTokens + usage.outputTokens
  return cacheReadIsIncludedInInput
    ? subtractNonNegative(usage.inputTokens, usage.cacheReadTokens, 'subagent input')
    : usage.inputTokens
}

async function readCrossProfileChildUsageByDate(
  sessionFiles: ResolvedSessionFile[],
  timestamp: string,
  timezone: string,
  stderr: ((line: string) => void) | undefined,
  readChildUsageEvents: ReadChildUsageEvents
) {
  const merger = new ChildUsageEventMerger()
  for (const sessionFile of sessionFiles) {
    merger.add(
      await readChildUsageEvents(sessionFile.readFilePath, timestamp, timezone, stderr, sessionFile.sourceFilePath)
    )
  }
  return merger.toUsageByDate()
}

function subtractAdjustment(snapshot: UsageSnapshot, adjustment: Metric | undefined, stderr?: (line: string) => void) {
  if (!adjustment) return snapshot
  // ccusage daily can already be based on child request usage while session rows
  // still contain larger cumulative counters. In that case there is nothing to
  // subtract from the daily snapshot without undercounting charged usage.
  if (!canSubtractAdjustment(snapshot, adjustment)) {
    stderr?.(
      `Skipping Codex subagent usage correction for ${snapshot.usageDate}/${snapshot.model}: corrected usage exceeds daily snapshot`
    )
    return snapshot
  }
  return usageSnapshotSchema.parse({
    ...snapshot,
    inputTokens: subtractNonNegative(snapshot.inputTokens, adjustment.inputTokens, snapshotKey(snapshot)),
    outputTokens: subtractNonNegative(snapshot.outputTokens, adjustment.outputTokens, snapshotKey(snapshot)),
    cacheCreationTokens: subtractNonNegative(
      snapshot.cacheCreationTokens,
      adjustment.cacheCreationTokens,
      snapshotKey(snapshot)
    ),
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
  for await (const record of readJsonlRecords(filePath, stderr, codexChildSessionReadLimits)) {
    if (record.type !== 'session_meta') continue
    const payload = readRecord(record.payload)
    const startedAt = readString(payload, ['timestamp']) || readString(record, ['timestamp'])
    if (startedAt && hasSubagentMetadata(payload)) return { startedAt }
  }
  return null
}

async function readSubagentMetaFromFiles(sessionFiles: ResolvedSessionFile[], stderr?: (line: string) => void) {
  for (const sessionFile of sessionFiles) {
    const meta = await readSubagentMeta(sessionFile.readFilePath, stderr)
    if (meta) return meta
  }
  return null
}

async function resolveSessionFiles(row: UnknownRecord, codexHomes: string[], codexSymlinkRoots?: readonly string[]) {
  const sessionFiles = new Map<string, ResolvedSessionFile>()
  for (const codexHome of codexHomes) {
    const sessionFile = await resolveSessionFileInHome(row, codexHome, codexSymlinkRoots)
    if (sessionFile) sessionFiles.set(sessionFile.sourceFilePath, sessionFile)
  }
  return [...sessionFiles.values()]
}

async function resolveSessionFileInHome(row: UnknownRecord, codexHome: string, codexSymlinkRoots?: readonly string[]) {
  for (const rootName of ['sessions', 'archived_sessions']) {
    const sessionsDir = resolve(codexHome, rootName)
    const resolvedSessionsDir = await resolveCodexSessionRoot(sessionsDir, {
      rejectRootSymlink: true,
      allowedRootSymlinks: codexSymlinkRoots,
      rootBoundary: codexHome
    })
    if (!resolvedSessionsDir) continue
    const sourceRoot = sessionsDir
    const sessionId = readString(row, ['sessionId'])
    if (sessionId) {
      const file = await existingSessionFile(sourceRoot, resolvedSessionsDir, `${sessionId}.jsonl`)
      if (file) return file
    }

    const directory = readString(row, ['directory'])
    const sessionFile = readString(row, ['sessionFile'])
    if (directory && sessionFile) {
      const file = await existingSessionFile(sourceRoot, resolvedSessionsDir, directory, `${sessionFile}.jsonl`)
      if (file) return file
    }
  }
  return null
}

async function existingSessionFile(
  sourceRoot: string,
  readRoot: string,
  ...segments: string[]
): Promise<ResolvedSessionFile | null> {
  const sourceFilePath = resolve(sourceRoot, ...segments)
  const readFilePath = resolve(readRoot, ...segments)
  if (!isPathInside(sourceRoot, sourceFilePath) || !isPathInside(readRoot, readFilePath)) return null
  const inspected = await inspectSessionFilePath(readRoot, readFilePath)
  return inspected ? { sourceFilePath, readFilePath } : null
}

function isPathInside(parent: string, child: string) {
  const relativePath = relative(parent, child)
  if (isAbsolute(relativePath)) return false
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`)
}

async function inspectSessionFilePath(sessionsDir: string, filePath: string) {
  const relativePath = relative(sessionsDir, filePath)
  const pathSegments = relativePath.split(sep)
  let currentPath = sessionsDir
  for (const [index, segment] of pathSegments.entries()) {
    const details = await inspectPathEntry(currentPath)
    if (!details) return null
    if (details.isSymbolicLink()) {
      throw new Error('Unable to read Codex subagent session file: symbolic links are not supported')
    }
    if (!details.isDirectory()) {
      throw new Error('Unable to read Codex subagent session file: session path is not a directory')
    }
    currentPath = join(currentPath, segment)

    if (index !== pathSegments.length - 1) continue
    const fileDetails = await inspectPathEntry(currentPath)
    if (!fileDetails) return null
    if (fileDetails.isSymbolicLink()) {
      throw new Error('Unable to read Codex subagent session file: symbolic links are not supported')
    }
    return fileDetails.isFile() ? filePath : null
  }
  return null
}

async function inspectPathEntry(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    const cause = error as NodeJS.ErrnoException
    if (cause.code === 'ENOENT') return null
    throw new Error('Unable to inspect Codex subagent session path', { cause: error })
  }
}

function hasSubagentMetadata(payload: UnknownRecord | null) {
  const source = readRecord(payload?.source)
  return readRecord(source?.subagent) !== null
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
  const directCost = readCostNumber(row, ['costUsd', 'costUSD', 'cost'])
  if (directCost > 0 || row === parent) return directCost

  const parentCost = readCostNumber(parent, ['costUsd', 'costUSD', 'cost'])
  const parentTokens = readTotalTokens(parent)
  const rowTokens = readTotalTokens(row)
  if (parentCost <= 0 || parentTokens <= 0 || rowTokens <= 0) return 0
  return parentCost * (rowTokens / parentTokens)
}

function readCostNumber(record: UnknownRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return 0
}
