import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageSnapshot, UsageSource } from '@tokenboard/usage-core'
import {
  collectChangedSessionFiles,
  updateCursorFile
} from './session-cursor'
import { parseSessionJsonlLines } from './session-jsonl-parser'

type HookInput = {
  source: UsageSource
  sessionsDir: string
  cursorName: string
  timezone: string
  collectedAt: string
}

export type HookIncrementalResult = {
  rangeArgs: string[]
  changed: boolean
  changedDates: string[]
  changedKeys: Array<{ usageDate: string; model: string }>
  cachedSnapshots: UsageSnapshot[]
}

export async function collectHookIncremental(input: HookInput): Promise<HookIncrementalResult> {
  const changed = await collectChangedSessionFiles({
    source: input.source,
    sessionsDir: input.sessionsDir,
    cursorPath: join(readStateDir(), input.cursorName)
  })

  if (changed.hasUnreadableChangedFile) {
    throw new Error(`${input.source} hook has changed session files that are not readable`)
  }

  if (changed.hasUnreadablePendingUpload) {
    throw new Error(`${input.source} hook has pending upload entries that are not readable`)
  }

  const cachedSnapshots = restoreCachedPendingSnapshots(changed.missingPendingSnapshots, input.collectedAt)
  if (changed.files.length === 0) {
    if (cachedSnapshots.length > 0) {
      if (changed.hasCursorCleanup) {
        await changed.commit()
      }
      return {
        rangeArgs: [],
        changed: true,
        changedDates: [],
        changedKeys: [],
        cachedSnapshots
      }
    }
    if (changed.hasPendingUpload) {
      throw new Error(`${input.source} hook has pending upload entries but no readable changed session files`)
    }
    if (changed.hasCursorCleanup) {
      await changed.commit()
    }
    return { rangeArgs: [], changed: false, changedDates: [], changedKeys: [], cachedSnapshots: [] }
  }

  const parsed = await parseChangedFiles(input, changed)
  assertNoMalformedRows(input.source, parsed.malformedRows)
  assertNoUnparsedTokenRows(input.source, parsed.unparsedTokenLikeRows)
  assertNoPendingUploadWithoutSnapshots(input.source, parsed.pendingFilesWithoutSnapshots)

  if (parsed.changedDates.size > 0) {
    changed.markPendingUpload(parsed.pendingUploadPaths)
  }
  await changed.commit()

  return {
    rangeArgs: buildDateRangeArgs(parsed.changedDates),
    changed: parsed.changedDates.size > 0 || cachedSnapshots.length > 0,
    changedDates: [...parsed.changedDates].sort(),
    changedKeys: [...parsed.changedKeys.values()].sort(compareSnapshotKeys),
    cachedSnapshots
  }
}

function restoreCachedPendingSnapshots(
  missingPendingSnapshots: Array<{ snapshots: Array<Omit<UsageSnapshot, 'collectedAt'>> }>,
  collectedAt: string
) {
  return missingPendingSnapshots.flatMap((entry) =>
    entry.snapshots.map((snapshot) => ({ ...snapshot, collectedAt }))
  )
}

async function parseChangedFiles(input: HookInput, changed: Awaited<ReturnType<typeof collectChangedSessionFiles>>) {
  const changedDates = new Set<string>()
  const changedKeys = new Map<string, { usageDate: string; model: string }>()
  let malformedRows = 0
  let pendingFilesWithoutSnapshots = 0
  const pendingUploadPaths = new Set<string>()
  let unparsedTokenLikeRows = 0

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
    }
    if (file.pendingUpload && parsed.snapshots.length === 0 && parsed.ignoredUploadSafeRows === 0) {
      pendingFilesWithoutSnapshots += 1
    }
    malformedRows += parsed.malformedRows
    unparsedTokenLikeRows += parsed.unparsedTokenLikeRows
    updateCursorFile(changed.cursor, file, parsed)
  }

  return { changedDates, changedKeys, malformedRows, pendingFilesWithoutSnapshots, pendingUploadPaths, unparsedTokenLikeRows }
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
  const expectedKeys = input.expectedKeys && input.expectedKeys.length > 0
    ? input.expectedKeys
    : input.expectedDates.map((usageDate) => ({
        usageDate,
        model: ''
      }))
  if (expectedKeys.length === 0) return

  const actualKeys = new Set(input.snapshots.map(snapshotKey))
  const actualDates = new Set(input.snapshots.map((snapshot) => snapshot.usageDate))
  const missingKeys = expectedKeys.filter((key) =>
    isSpecificModel(key.model)
      ? !actualKeys.has(snapshotKey(key))
      : !actualDates.has(key.usageDate)
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
  return [
    '--since',
    toCompactDate(values[0]),
    '--until',
    toCompactDate(values[values.length - 1])
  ]
}

function snapshotKey(input: { usageDate: string; model: string }) {
  return `${input.usageDate}\0${input.model}`
}

function formatSnapshotKey(input: { usageDate: string; model: string }) {
  return input.model ? `${input.usageDate}/${input.model}` : input.usageDate
}

function compareSnapshotKeys(
  left: { usageDate: string; model: string },
  right: { usageDate: string; model: string }
) {
  return left.usageDate.localeCompare(right.usageDate) || left.model.localeCompare(right.model)
}

function isSpecificModel(model: string) {
  return model.length > 0 && model !== 'all'
}

function toCompactDate(value: string) {
  return value.replaceAll('-', '')
}
