import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { collectAntigravityCliUsage } from './antigravity-cli'
import { cliHistoryAggregateKey, cliHistorySnapshotGroupFromEvent } from './antigravity-cli-cursor'
import { clearPendingUploadCursors } from './session-cursor'

const cascadeHash = 'a'.repeat(64)
const eventHash = 'b'.repeat(64)
const createdAt = '2026-07-20T10:00:00.000Z'

describe('Antigravity CLI full history rebuild', () => {
  test('rebuilds acknowledged bounded history without adding the retained daily total', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-full-rebuild-'))
    const event = historyEvent()
    try {
      const bounded = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: '20260720',
        collectedAt: createdAt,
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['cascade-a']),
          events: [event],
          lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
        })
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })

      const rebuilt = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        collectedAt: '2026-07-20T11:00:00.000Z',
        readDbUsageEvents: async ({ lastSeenRowIndexByCascadeHash, requireCompleteDirectoryScan }) => {
          expect(lastSeenRowIndexByCascadeHash).toEqual(new Map())
          expect(requireCompleteDirectoryScan).toBe(true)
          return {
            cascadeIds: new Set(['cascade-a']),
            events: [event],
            lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
          }
        }
      })

      expect(bounded).toEqual([
        expect.objectContaining({
          inputTokens: 10,
          totalTokens: 10,
          sessionCount: 1
        })
      ])
      expect(rebuilt).toEqual([
        expect.objectContaining({
          inputTokens: 10,
          totalTokens: 10,
          sessionCount: 1
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('emits a zero correction when an acknowledged history group disappears from SQLite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-missing-history-correction-'))
    const event = historyEvent()
    try {
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: '20260720',
        collectedAt: createdAt,
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['cascade-a']),
          events: [event],
          lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
        })
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })

      const correction = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        collectedAt: '2026-07-20T11:00:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set<string>(),
          events: [],
          lastReadRowIndexByCascade: new Map<string, number>()
        })
      })

      expect(correction).toEqual([
        expect.objectContaining({
          source: 'antigravity-cli',
          usageDate: '2026-07-20',
          timezone: 'UTC',
          model: 'gemini-3-flash-a',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          sessionCount: 0
        })
      ])
      const cursor = JSON.parse(await readFile(join(root, 'antigravity-cli-cursor.json'), 'utf8')) as {
        files: Record<string, { pendingUpload?: boolean; snapshots: Array<{ inputTokens: number }> }>
      }
      expect(Object.values(cursor.files)).toEqual([
        expect.objectContaining({
          pendingUpload: true,
          snapshots: [expect.objectContaining({ inputTokens: 0 })]
        })
      ])

      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })
      const afterAcknowledgement = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set<string>(),
          events: [],
          lastReadRowIndexByCascade: new Map<string, number>()
        })
      })
      expect(afterAcknowledgement).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('emits a zero correction when an acknowledged compacted group disappears from SQLite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-missing-compacted-correction-'))
    const oldCreatedAt = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString()
    const event = historyEvent(oldCreatedAt)
    try {
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['cascade-a']),
          events: [event],
          lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
        })
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })

      const compacted = JSON.parse(await readFile(join(root, 'antigravity-cli-cursor.json'), 'utf8')) as {
        files: Record<string, { snapshots?: Array<{ inputTokens?: number }> }>
      }
      const aggregateKey = cliHistoryAggregateKey(cliHistorySnapshotGroupFromEvent(event, 'UTC'))
      expect(compacted.files[aggregateKey]?.snapshots).toEqual([
        expect.objectContaining({ inputTokens: 10, usageDate: oldCreatedAt.slice(0, 10) })
      ])

      const correction = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        collectedAt: '2026-07-20T11:00:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set<string>(),
          events: [],
          lastReadRowIndexByCascade: new Map<string, number>()
        })
      })

      expect(correction).toEqual([
        expect.objectContaining({
          source: 'antigravity-cli',
          usageDate: oldCreatedAt.slice(0, 10),
          timezone: 'UTC',
          model: 'gemini-3-flash-a',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          sessionCount: 0
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retains pending usage when an acknowledged group also has an unacknowledged entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-pending-missing-history-'))
    const acknowledgedEvent = historyEvent('2026-07-20T10:00:00.000Z', eventHash, 10)
    const pendingEvent = historyEvent('2026-07-20T10:01:00.000Z', 'c'.repeat(64), 20)
    try {
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: '20260720',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['cascade-a']),
          events: [acknowledgedEvent],
          lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
        })
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })

      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: '20260720',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['cascade-a']),
          events: [acknowledgedEvent, pendingEvent],
          lastReadRowIndexByCascade: new Map([['cascade-a', 2]])
        })
      })

      const rebuilt = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set<string>(),
          events: [],
          lastReadRowIndexByCascade: new Map<string, number>()
        })
      })

      expect(rebuilt).toEqual([
        expect.objectContaining({
          source: 'antigravity-cli',
          usageDate: '2026-07-20',
          timezone: 'UTC',
          model: 'gemini-3-flash-a',
          inputTokens: 30,
          totalTokens: 30,
          sessionCount: 1
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rebuilds a compacted old daily model from SQLite without accumulating prior totals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-compacted-full-rebuild-'))
    const oldCreatedAt = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString()
    const event = historyEvent(oldCreatedAt)
    const readDbUsageEvents = async () => ({
      cascadeIds: new Set(['cascade-a']),
      events: [event],
      lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
    })
    try {
      const first = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })

      const rebuilt = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })

      const rebuiltAgain = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents
      })

      for (const snapshots of [first, rebuilt, rebuiltAgain]) {
        expect(snapshots).toEqual([
          expect.objectContaining({
            inputTokens: 10,
            totalTokens: 10,
            sessionCount: 1
          })
        ])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps acknowledged retained history bounded and rebuilds it without duplicating the daily model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-bounded-full-rebuild-'))
    const oldCreatedAt = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString()
    const events = Array.from({ length: 3_000 }, (_, index) =>
      historyEvent(oldCreatedAt, index.toString(16).padStart(64, '0'))
    )
    const readDbUsageEvents = async () => ({
      cascadeIds: new Set(['cascade-a']),
      events,
      lastReadRowIndexByCascade: new Map([['cascade-a', events.length]])
    })
    try {
      const first = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })

      const compacted = JSON.parse(await readFile(join(root, 'antigravity-cli-cursor.json'), 'utf8')) as {
        files: Record<string, unknown>
      }
      const persistedKeys = Object.keys(compacted.files)
      expect(persistedKeys).toHaveLength(2)
      expect(persistedKeys).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^db-row\0antigravity-cli\0[a-f0-9]{64}$/),
          expect.stringMatching(/^aggregate\0[a-f0-9]{64}$/)
        ])
      )

      const rebuilt = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents
      })

      for (const snapshots of [first, rebuilt]) {
        expect(snapshots).toEqual([
          expect.objectContaining({
            inputTokens: events.length * 10,
            totalTokens: events.length * 10,
            sessionCount: 1
          })
        ])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects a finite database limit before a canonical full rebuild', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-partial-full-rebuild-'))
    let reads = 0
    try {
      await expect(
        collectAntigravityCliUsage({
          stateDir: root,
          timezone: 'UTC',
          since: 'all',
          maxDbFiles: 1,
          readDbUsageEvents: async () => {
            reads += 1
            return {
              cascadeIds: new Set(['cascade-a']),
              events: [historyEvent()],
              lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
            }
          }
        })
      ).rejects.toThrow('requires an unbounded SQLite database scan')

      expect(reads).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function historyEvent(createdAt = '2026-07-20T10:00:00.000Z', hash = eventHash, inputTokens = 10) {
  return {
    cascadeHash,
    eventHash: hash,
    createdAt,
    model: 'gemini-3-flash-a',
    inputTokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0
  }
}
