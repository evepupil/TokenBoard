import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageSnapshot, UsageSource } from '@tokenboard/usage-core'
import { collectChangedSessionFiles, updateCursorFile } from './session-cursor'
import { readCursor, withCursorLock, writeCursor, type CursorSnapshot } from './session-cursor-store'
import { parseSessionJsonlLines } from './session-jsonl-parser'
import { isUnresolvedCodexContextPricingSnapshot } from './codex-context-pricing'

type HookInput = {
  source: UsageSource
  sessionsDir: string
  sessionDirs?: readonly string[]
  cursorName: string
  cursorProfileHash?: string
  stateDir?: string
  stderr?: (line: string) => void
  timezone: string
  collectedAt: string
  scanSinceMs?: number
  includePendingSnapshotEntries?: boolean
  includeReconciliationFileEntries?: boolean
  skipSessionScan?: boolean
  allowedRootSymlinks?: readonly string[]
}

export type HookPendingSnapshotEntry = {
  relativePath: string
  sha256: string
  snapshot: UsageSnapshot
  contextPricingPending?: true
}

export type HookReconciliationFileEntry = {
  relativePath: string
  sha256: string
}

export type HookIncrementalResult = {
  rangeArgs: string[]
  changed: boolean
  changedDates: string[]
  changedKeys: Array<{ usageDate: string; model: string }>
  cachedSnapshots: UsageSnapshot[]
  unresolvedContextPricingSnapshots?: UsageSnapshot[]
  pendingSnapshotEntries?: HookPendingSnapshotEntry[]
  reconciliationFileEntries?: HookReconciliationFileEntry[]
}

export async function collectHookIncremental(input: HookInput): Promise<HookIncrementalResult> {
  const cursorPath = join(input.stateDir ?? readStateDir(), input.cursorName)
  return withCursorLock(cursorPath, () =>
    input.skipSessionScan
      ? collectPendingHookCursorLocked(input, cursorPath)
      : collectHookIncrementalLocked(input, cursorPath)
  )
}

async function collectPendingHookCursorLocked(input: HookInput, cursorPath: string): Promise<HookIncrementalResult> {
  const cursor = await readCursor(cursorPath, input.source)
  const pendingSnapshotEntries: HookPendingSnapshotEntry[] = []
  let cleanedSnapshotlessPending = false
  for (const [relativePath, entry] of Object.entries(cursor.files)) {
    if (!entry.pendingUpload) continue
    if (entry.snapshots.length === 0) {
      delete cursor.files[relativePath]
      cleanedSnapshotlessPending = true
      continue
    }
    for (const snapshot of entry.snapshots) {
      const restored = restoreCursorSnapshot(snapshot, input.collectedAt)
      pendingSnapshotEntries.push({
        relativePath,
        sha256: entry.sha256,
        snapshot: restored.snapshot,
        ...(restored.contextPricingPending ? { contextPricingPending: true as const } : {})
      })
    }
  }
  if (cleanedSnapshotlessPending) await writeCursor(cursorPath, cursor)
  return withPendingSnapshotEntries(
    {
      rangeArgs: [],
      changed: pendingSnapshotEntries.length > 0,
      changedDates: [],
      changedKeys: [],
      cachedSnapshots: pendingSnapshotEntries.map((entry) => entry.snapshot),
      ...(pendingSnapshotEntries.some((entry) => entry.contextPricingPending)
        ? {
            unresolvedContextPricingSnapshots: pendingSnapshotEntries
              .filter((entry) => entry.contextPricingPending)
              .map((entry) => entry.snapshot)
          }
        : {})
    },
    {
      pendingSnapshotEntries: input.includePendingSnapshotEntries ? pendingSnapshotEntries : undefined,
      reconciliationFileEntries: input.includeReconciliationFileEntries ? [] : undefined
    }
  )
}

async function collectHookIncrementalLocked(input: HookInput, cursorPath: string): Promise<HookIncrementalResult> {
  const changed = await collectChangedSessionFiles({
    source: input.source,
    sessionsDir: input.sessionsDir,
    sessionDirs: input.sessionDirs,
    cursorPath,
    cursorProfileHash: input.cursorProfileHash,
    allowedRootSymlinks: input.allowedRootSymlinks,
    scanSinceMs: input.scanSinceMs
  })

  if (changed.hasUnreadableChangedFile) {
    throw new Error(`${input.source} hook has changed session files that are not readable`)
  }

  if (changed.hasUnreadablePendingUpload) {
    throw new Error(`${input.source} hook has pending upload entries that are not readable`)
  }

  const restoredPendingSnapshots = restoreCachedPendingSnapshots(changed.missingPendingSnapshots, input.collectedAt)
  const cachedSnapshots = restoredPendingSnapshots.map((entry) => entry.snapshot)
  const unresolvedContextPricingSnapshots = restoredPendingSnapshots
    .filter((entry) => entry.contextPricingPending)
    .map((entry) => entry.snapshot)
  const pendingSnapshotEntries = input.includePendingSnapshotEntries
    ? restorePendingSnapshotEntries(changed.missingPendingSnapshotEntries, input.collectedAt)
    : undefined
  if (changed.files.length === 0) {
    if (cachedSnapshots.length > 0) {
      if (hasCursorMaintenance(changed)) {
        await changed.commit()
      }
      return withPendingSnapshotEntries(
        {
          rangeArgs: [],
          changed: true,
          changedDates: [],
          changedKeys: [],
          cachedSnapshots,
          ...(unresolvedContextPricingSnapshots.length > 0 ? { unresolvedContextPricingSnapshots } : {})
        },
        {
          pendingSnapshotEntries,
          reconciliationFileEntries: input.includeReconciliationFileEntries ? [] : undefined
        }
      )
    }
    if (changed.hasPendingUpload) {
      throw new Error(`${input.source} hook has pending upload entries but no readable changed session files`)
    }
    if (hasCursorMaintenance(changed)) {
      await changed.commit()
    }
    return withPendingSnapshotEntries(
      {
        rangeArgs: [],
        changed: false,
        changedDates: [],
        changedKeys: [],
        cachedSnapshots: [],
        ...(unresolvedContextPricingSnapshots.length > 0 ? { unresolvedContextPricingSnapshots } : {})
      },
      {
        pendingSnapshotEntries,
        reconciliationFileEntries: input.includeReconciliationFileEntries ? [] : undefined
      }
    )
  }

  const parsed = await parseChangedFiles(input, changed)
  assertNoMalformedRows(input.source, parsed.malformedRows)
  assertNoUnparsedTokenRows(input.source, parsed.unparsedTokenLikeRows)
  assertNoPendingUploadWithoutSnapshots(input.source, parsed.pendingFilesWithoutSnapshots)

  if (parsed.changedDates.size > 0) {
    changed.markPendingUpload(parsed.pendingUploadPaths)
  }
  await changed.commit()
  reportSkippedOversizedRows(input, parsed)

  return withPendingSnapshotEntries(
    {
      rangeArgs: buildDateRangeArgs(parsed.changedDates),
      changed: parsed.changedDates.size > 0 || cachedSnapshots.length > 0,
      changedDates: [...parsed.changedDates].sort(),
      changedKeys: [...parsed.changedKeys.values()].sort(compareSnapshotKeys),
      cachedSnapshots,
      ...(unresolvedContextPricingSnapshots.length > 0 ? { unresolvedContextPricingSnapshots } : {})
    },
    {
      pendingSnapshotEntries,
      reconciliationFileEntries: input.includeReconciliationFileEntries ? parsed.reconciliationFileEntries : undefined
    }
  )
}

function hasCursorMaintenance(changed: Awaited<ReturnType<typeof collectChangedSessionFiles>>) {
  return changed.hasCursorCleanup || changed.hasCursorMetadataUpdate || changed.hasCursorProfileUpdate
}

function restoreCachedPendingSnapshots(
  missingPendingSnapshots: Array<{ snapshots: CursorSnapshot[] }>,
  collectedAt: string
) {
  return missingPendingSnapshots.flatMap((entry) =>
    entry.snapshots.map((snapshot) => restoreCursorSnapshot(snapshot, collectedAt))
  )
}

function restorePendingSnapshotEntries(
  missingPendingSnapshots: Array<{ relativePath: string; sha256: string; snapshots: CursorSnapshot[] }>,
  collectedAt: string
): HookPendingSnapshotEntry[] {
  return missingPendingSnapshots.flatMap((entry) =>
    entry.snapshots.map((snapshot) => {
      const restored = restoreCursorSnapshot(snapshot, collectedAt)
      return {
        relativePath: entry.relativePath,
        sha256: entry.sha256,
        snapshot: restored.snapshot,
        ...(restored.contextPricingPending ? { contextPricingPending: true as const } : {})
      }
    })
  )
}

function restoreCursorSnapshot(snapshot: CursorSnapshot, collectedAt: string) {
  const { codexContextPricingPending, ...publicSnapshot } = snapshot
  return {
    snapshot: { ...publicSnapshot, collectedAt } as UsageSnapshot,
    contextPricingPending: isUnresolvedCodexContextPricingSnapshot(snapshot)
  }
}

function withPendingSnapshotEntries(
  result: Omit<HookIncrementalResult, 'pendingSnapshotEntries' | 'reconciliationFileEntries'>,
  entries: {
    pendingSnapshotEntries: HookPendingSnapshotEntry[] | undefined
    reconciliationFileEntries: HookReconciliationFileEntry[] | undefined
  }
): HookIncrementalResult {
  return {
    ...result,
    ...(entries.pendingSnapshotEntries === undefined ? {} : { pendingSnapshotEntries: entries.pendingSnapshotEntries }),
    ...(entries.reconciliationFileEntries === undefined
      ? {}
      : { reconciliationFileEntries: entries.reconciliationFileEntries })
  }
}

async function parseChangedFiles(input: HookInput, changed: Awaited<ReturnType<typeof collectChangedSessionFiles>>) {
  const changedDates = new Set<string>()
  const changedKeys = new Map<string, { usageDate: string; model: string }>()
  let malformedRows = 0
  let pendingFilesWithoutSnapshots = 0
  const pendingUploadPaths = new Set<string>()
  const reconciliationFileEntries: HookReconciliationFileEntry[] = []
  let unparsedTokenLikeRows = 0
  let skippedOversizedRows = 0
  let largestSkippedOversizedRowBytes = 0

  for (const file of changed.files) {
    const parsed = await parseSessionJsonlLines({
      source: input.source,
      timezone: input.timezone,
      collectedAt: input.collectedAt,
      sessionId: file.relativePath,
      lines: file.readLines()
    })
    for (const snapshot of parsed.snapshots) {
      changedDates.add(snapshot.usageDate)
      changedKeys.set(snapshotKey(snapshot), { usageDate: snapshot.usageDate, model: snapshot.model })
    }
    if (parsed.snapshots.length > 0) {
      pendingUploadPaths.add(file.relativePath)
      reconciliationFileEntries.push({ relativePath: file.relativePath, sha256: file.sha256 })
    }
    if (file.pendingUpload && parsed.snapshots.length === 0 && parsed.ignoredUploadSafeRows === 0) {
      pendingFilesWithoutSnapshots += 1
    }
    malformedRows += parsed.malformedRows
    unparsedTokenLikeRows += parsed.unparsedTokenLikeRows
    skippedOversizedRows += parsed.skippedOversizedRows ?? 0
    largestSkippedOversizedRowBytes = Math.max(
      largestSkippedOversizedRowBytes,
      parsed.largestSkippedOversizedRowBytes ?? 0
    )
    updateCursorFile(changed.cursor, file, parsed)
  }

  return {
    changedDates,
    changedKeys,
    malformedRows,
    pendingFilesWithoutSnapshots,
    pendingUploadPaths,
    reconciliationFileEntries,
    unparsedTokenLikeRows,
    skippedOversizedRows,
    largestSkippedOversizedRowBytes
  }
}

function reportSkippedOversizedRows(
  input: HookInput,
  parsed: {
    skippedOversizedRows: number
    largestSkippedOversizedRowBytes: number
  }
) {
  if (parsed.skippedOversizedRows === 0) return
  const suffix = parsed.skippedOversizedRows === 1 ? '' : 's'
  input.stderr?.(
    `Skipped ${parsed.skippedOversizedRows} oversized ${input.source} session JSONL row${suffix} without token or usage metadata (largest ${parsed.largestSkippedOversizedRowBytes} bytes)`
  )
}

function assertNoMalformedRows(source: UsageSource, count: number) {
  if (count > 0) {
    throw new Error(`${source} hook found ${count} malformed JSONL rows`)
  }
}

function assertNoUnparsedTokenRows(source: UsageSource, count: number) {
  if (count > 0) {
    throw new Error(`${source} hook found ${count} unparsed token-like rows`)
  }
}

function assertNoPendingUploadWithoutSnapshots(source: UsageSource, count: number) {
  if (count > 0) {
    throw new Error(`${source} hook has ${count} pending upload files with no parsed usage snapshots`)
  }
}

export function assertHookReconciliationSnapshots(input: {
  sourceLabel: string
  expectedDates: string[]
  expectedKeys?: Array<{ usageDate: string; model: string }>
  snapshots: UsageSnapshot[]
}) {
  const expectedKeys =
    input.expectedKeys && input.expectedKeys.length > 0
      ? input.expectedKeys
      : input.expectedDates.map((usageDate) => ({
          usageDate,
          model: ''
        }))
  if (expectedKeys.length === 0) return

  const actualKeys = new Set(input.snapshots.map(snapshotKey))
  const actualDates = new Set(input.snapshots.map((snapshot) => snapshot.usageDate))
  const missingKeys = expectedKeys.filter((key) =>
    isSpecificModel(key.model) ? !actualKeys.has(snapshotKey(key)) : !actualDates.has(key.usageDate)
  )
  if (missingKeys.length === 0) return

  throw new Error(
    `${input.sourceLabel} hook reconciliation returned no snapshots for parsed usage keys: ${missingKeys.map(formatSnapshotKey).join(', ')}`
  )
}

export function isHookMode() {
  return process.env.TOKENBOARD_HOOK_MODE === '1'
}

export function readStateDir() {
  return process.env.TOKENBOARD_STATE_DIR || process.env.TOKENBOARD_CONFIG_DIR || join(homedir(), '.tokenboard')
}

function buildDateRangeArgs(dates: Set<string>) {
  const values = [...dates].sort()
  if (values.length === 0) {
    return []
  }
  return ['--since', toCompactDate(values[0]), '--until', toCompactDate(values[values.length - 1])]
}

function snapshotKey(input: { usageDate: string; model: string }) {
  return `${input.usageDate}\0${input.model}`
}

function formatSnapshotKey(input: { usageDate: string; model: string }) {
  return input.model ? `${input.usageDate}/${input.model}` : input.usageDate
}

function compareSnapshotKeys(left: { usageDate: string; model: string }, right: { usageDate: string; model: string }) {
  return left.usageDate.localeCompare(right.usageDate) || left.model.localeCompare(right.model)
}

function isSpecificModel(model: string) {
  return model.length > 0 && model !== 'all'
}

function toCompactDate(value: string) {
  return value.replaceAll('-', '')
}
