import { createHash } from 'node:crypto'
import { readAntigravityDbUsageEvents, type AntigravityDbUsageResult } from './antigravity-history-db'
import { defaultConversationDir } from './antigravity-gui-environment'
import { lastSeenDbRowIndexByCascadeHash, unanchoredDbRowCursorHashes } from './antigravity-gui-cursor'
import type { CollectAntigravityGuiUsageOptions } from './antigravity-gui'
import type { AntigravityCollectionRange } from './antigravity-since'
import type { readCursor } from './session-cursor-store'

export async function readAntigravityGuiLocalDbUsage(
  options: CollectAntigravityGuiUsageOptions,
  cursor: Awaited<ReturnType<typeof readCursor>>,
  range: AntigravityCollectionRange,
  timezone: string
): Promise<{
  usage: AntigravityDbUsageResult
  error?: unknown
}> {
  try {
    return {
      usage: filterDbUsageByRange(await readAntigravityGuiLocalDbUsageOrThrow(options, cursor, range, timezone), range)
    }
  } catch (error) {
    return {
      usage: { cascadeIds: new Set<string>(), events: [] },
      error
    }
  }
}

function filterDbUsageByRange(
  usage: AntigravityDbUsageResult,
  range: AntigravityCollectionRange
): AntigravityDbUsageResult {
  if (!range.sinceDate) return usage
  const events = usage.events.filter((event) => range.includesTimestamp(event.createdAt))
  const coveredHashes = new Set(events.flatMap((event) => [event.cascadeHash, ...(event.cascadeHashAliases ?? [])]))
  const cascadeIds = new Set(
    [...usage.cascadeIds].filter((cascadeId) => coveredHashes.has(createHash('sha256').update(cascadeId).digest('hex')))
  )
  return { ...usage, cascadeIds, events }
}

async function readAntigravityGuiLocalDbUsageOrThrow(
  options: CollectAntigravityGuiUsageOptions,
  cursor: Awaited<ReturnType<typeof readCursor>>,
  range: AntigravityCollectionRange,
  timezone: string
) {
  const lastSeenRowIndexByCascadeHash = lastSeenDbRowIndexByCascadeHash({
    cursor,
    source: options.source,
    historyScope: range.historyScope
  })
  if (options.readDbUsageEvents) {
    const maxDbFiles = resolveMaxDbFiles(options.maxDbFiles, range)
    const unanchoredCascadeHashes = unanchoredDbRowCursorHashes({
      cursor,
      source: options.source,
      historyScope: range.historyScope
    })
    const readOptions = {
      lastSeenRowIndexByCascadeHash,
      maxDbFiles,
      sinceDate: range.sinceDate,
      timezone,
      detectRowCursorReset: lastSeenRowIndexByCascadeHash.size > 0,
      requireCompleteDirectoryScan: range.fullHistory || maxDbFiles === null,
      ...(unanchoredCascadeHashes.size > 0 ? { forceFullScanCascadeHashes: unanchoredCascadeHashes } : {})
    }
    return options.readDbUsageEvents(readOptions)
  }
  if (options.requestGeneratorMetadata) {
    return { cascadeIds: new Set<string>(), events: [] }
  }
  const maxDbFiles = resolveMaxDbFiles(options.maxDbFiles, range)
  const unanchoredCascadeHashes = unanchoredDbRowCursorHashes({
    cursor,
    source: options.source,
    historyScope: range.historyScope
  })
  return readAntigravityDbUsageEvents({
    conversationDir: options.conversationDir ?? defaultConversationDir(options.source),
    lastSeenRowIndexByCascadeHash,
    maxDbFiles,
    scanState: cursor.antigravityDbFileScan,
    sinceDate: range.sinceDate,
    timezone,
    detectRowCursorReset: lastSeenRowIndexByCascadeHash.size > 0,
    requireCompleteDirectoryScan: range.fullHistory || maxDbFiles === null,
    sourceLabel: 'Antigravity GUI',
    forceFullScanCascadeHashes: unanchoredCascadeHashes.size > 0 ? unanchoredCascadeHashes : undefined
  })
}

function resolveMaxDbFiles(value: number | null | undefined, range: AntigravityCollectionRange) {
  return value === undefined ? (range.fullHistory ? null : undefined) : value
}
