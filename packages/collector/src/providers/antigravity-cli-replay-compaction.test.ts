import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { collectAntigravityCliUsage } from './antigravity-cli'
import { cliHistoryAggregateKey, cliHistorySnapshotGroupFromEvent } from './antigravity-cli-cursor'
import { clearPendingUploadCursors } from './session-cursor'

const cascadeHash = 'a'.repeat(64)
const oldEventHash = 'b'.repeat(64)
const newEventHash = 'c'.repeat(64)
const oldCreatedAt = '2025-01-01T10:00:00.000Z'

describe('Antigravity CLI history compaction', () => {
  test('prunes acknowledged old history while retaining a compact baseline for reconciliation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-compaction-'))
    const event = historyEvent(oldEventHash, oldCreatedAt)
    try {
      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents: async () => dbUsage([event], 1)
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })

      const cursor = await readCursor(root)
      const group = cliHistorySnapshotGroupFromEvent(event, 'UTC')

      expect(snapshots).toEqual([expect.objectContaining({ inputTokens: 10, totalTokens: 10, sessionCount: 1 })])
      expect(cursor.files[cliHistoryAggregateKey(group)]?.snapshots).toEqual([
        expect.objectContaining({ usageDate: '2025-01-01', inputTokens: 10 })
      ])
      expect(Object.keys(cursor.files).some((key) => key.startsWith('history-event\0'))).toBe(false)
      expect(Object.keys(cursor.files).some((key) => key.startsWith('session\0antigravity-cli\0'))).toBe(false)
      expect(Object.keys(cursor.files).some((key) => key.startsWith('db-row\0antigravity-cli\0'))).toBe(true)
      expect(cursor.antigravityCliHistoryCompactedThroughDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('requires a full rebuild instead of silently adding an expired unknown event to a compacted group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-reconciliation-'))
    const event = historyEvent(oldEventHash, oldCreatedAt)
    try {
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents: async () => dbUsage([event], 1)
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })

      await expect(
        collectAntigravityCliUsage({
          stateDir: root,
          timezone: 'UTC',
          since: '2025-01-01',
          readDbUsageEvents: async () => dbUsage([historyEvent(newEventHash, '2025-01-01T11:00:00.000Z')], 2)
        })
      ).rejects.toThrow('rerun with --since all')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses the configured timezone for the compaction frontier', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T20:00:00.000Z'))
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-timezone-frontier-'))
    const event = historyEvent(oldEventHash, '2026-04-21T19:00:00.000Z')
    try {
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'Asia/Shanghai',
        since: 'all',
        readDbUsageEvents: async () => dbUsage([event], 1)
      })
      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity-cli',
        timezone: 'Asia/Shanghai'
      })

      const cursor = await readCursor(root)
      expect(cursor.antigravityCliHistoryCompactedThroughDate).toBe('2026-04-23')

      await expect(
        collectAntigravityCliUsage({
          stateDir: root,
          timezone: 'Asia/Shanghai',
          since: '20260422',
          readDbUsageEvents: async () => dbUsage([event], 2)
        })
      ).rejects.toThrow('rerun with --since all')
    } finally {
      vi.useRealTimers()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retains the local cutoff date for negative-offset timezones', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T00:30:00.000Z'))
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-negative-timezone-'))
    const event = historyEvent(oldEventHash, '2026-04-20T23:00:00.000Z')
    try {
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'America/Los_Angeles',
        since: 'all',
        readDbUsageEvents: async () => dbUsage([event], 1)
      })
      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity-cli',
        timezone: 'America/Los_Angeles'
      })

      const cursor = await readCursor(root)
      const group = cliHistorySnapshotGroupFromEvent(event, 'America/Los_Angeles')
      const aggregate = cursor.files[cliHistoryAggregateKey(group)]

      expect(aggregate?.snapshots).toEqual([expect.objectContaining({ usageDate: '2026-04-20', inputTokens: 10 })])
      expect(cursor.antigravityCliHistoryCompactedThroughDate).toBe('2026-04-21')
    } finally {
      vi.useRealTimers()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reuses an all-scope row cursor for the default incremental scan after compaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-full-rebuild-'))
    const event = historyEvent(oldEventHash, oldCreatedAt)
    try {
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents: async () => dbUsage([event], 1)
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })

      const repeated = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        readDbUsageEvents: async ({ lastSeenRowIndexByCascadeHash }) => {
          expect(lastSeenRowIndexByCascadeHash.size).toBe(1)
          return dbUsage([], 1)
        }
      })

      expect(repeated).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rebuilds an old daily model from SQLite without duplicating the compact baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-unreplaced-baseline-'))
    const oldEvent = historyEvent(oldEventHash, oldCreatedAt)
    const newEvent = historyEvent(newEventHash, '2025-01-02T10:00:00.000Z', 'gemini-pro')
    try {
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents: async () => dbUsage([oldEvent], 1)
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })

      const rebuilt = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents: async () => dbUsage([oldEvent, newEvent], 2)
      })
      const cursor = await readCursor(root)
      const oldGroup = cliHistorySnapshotGroupFromEvent(oldEvent, 'UTC')

      expect(rebuilt).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ model: 'gemini-3-flash-a', inputTokens: 10, totalTokens: 10 }),
          expect.objectContaining({ model: 'gemini-pro', inputTokens: 10, totalTokens: 10 })
        ])
      )
      expect(cursor.files[cliHistoryAggregateKey(oldGroup)]).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not mark a history frontier when only a legacy correction is discarded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-correction-compaction-'))
    const cursorPath = join(root, 'antigravity-cli-cursor.json')
    try {
      await writeFile(
        cursorPath,
        `${JSON.stringify(
          {
            version: 1,
            source: 'antigravity-cli',
            antigravityCliMeteringVersion: 3,
            files: {
              ['history-authority-correction\0' + 'd'.repeat(64)]: cursorEntry()
            }
          },
          null,
          2
        )}\n`
      )

      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })

      const cursor = await readCursor(root)
      expect(cursor.antigravityCliHistoryCompactedThroughDate).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('merges multiple retained snapshots into one old-history reconciliation baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-compaction-baseline-'))
    const cursorPath = join(root, 'antigravity-cli-cursor.json')
    const event = historyEvent(oldEventHash, oldCreatedAt)
    const group = cliHistorySnapshotGroupFromEvent(event, 'UTC')
    const aggregateKey = cliHistoryAggregateKey(group)
    try {
      await writeFile(
        cursorPath,
        `${JSON.stringify(
          {
            version: 1,
            source: 'antigravity-cli',
            antigravityCliMeteringVersion: 3,
            files: {
              [aggregateKey]: {
                ...cursorEntry(),
                snapshots: [historySnapshot(10), historySnapshot(20)]
              }
            }
          },
          null,
          2
        )}\n`
      )

      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })

      const cursor = await readCursor(root)
      expect(cursor.files[aggregateKey]?.snapshots).toEqual([
        expect.objectContaining({ inputTokens: 30, totalTokens: 30, sessionCount: 2 })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function historyEvent(eventHash: string, createdAt: string, model = 'gemini-3-flash-a') {
  return {
    cascadeHash,
    eventHash,
    createdAt,
    model,
    inputTokens: 10,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0
  }
}

function dbUsage(events: ReturnType<typeof historyEvent>[], rowIndex: number) {
  return {
    cascadeIds: new Set(events.length > 0 ? ['cascade-a'] : []),
    events,
    lastReadRowIndexByCascade: new Map([['cascade-a', rowIndex]])
  }
}

function historySnapshot(inputTokens: number) {
  return {
    source: 'antigravity-cli',
    usageDate: '2025-01-01',
    timezone: 'UTC',
    model: 'gemini-3-flash-a',
    inputTokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: inputTokens,
    costUsd: 0,
    sessionCount: 1
  }
}

async function readCursor(root: string) {
  return JSON.parse(await readFile(join(root, 'antigravity-cli-cursor.json'), 'utf8')) as {
    antigravityCliHistoryCompactedThroughDate?: string
    files: Record<string, { snapshots: unknown[] }>
  }
}

function cursorEntry() {
  return {
    size: 0,
    mtimeMs: Date.parse('2026-07-20T10:00:00.000Z'),
    sha256: 'e'.repeat(64),
    snapshots: [],
    missingCost: true,
    pendingUpload: false,
    updatedAt: '2026-07-20T10:00:00.000Z'
  }
}
