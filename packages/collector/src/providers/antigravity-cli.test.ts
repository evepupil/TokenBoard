import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AntigravityUsageEvent } from './antigravity-gui-parser'
import { collectAntigravityCliUsage } from './antigravity-cli'
import { clearPendingUploadCursors } from './session-cursor'

const conversationA = 'a'.repeat(64)
const conversationB = 'b'.repeat(64)

describe('collectAntigravityCliUsage', () => {
  test('collects canonical SQLite history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-'))
    try {
      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-06-24T02:00:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['cascade-a']),
          events: [
            historyEvent({
              createdAt: '2026-06-23T16:30:00.000Z',
              model: 'gemini-3-flash-a',
              inputTokens: 100,
              outputTokens: 12,
              cacheReadTokens: 50
            })
          ],
          lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
        })
      })

      expect(snapshots).toEqual([
        {
          source: 'antigravity-cli',
          usageDate: '2026-06-24',
          timezone: 'Asia/Shanghai',
          model: 'gemini-3-flash-a',
          inputTokens: 100,
          outputTokens: 12,
          cacheCreationTokens: 0,
          cacheReadTokens: 50,
          totalTokens: 162,
          costUsd: 0,
          sessionCount: 1,
          collectedAt: '2026-06-24T02:00:00.000Z'
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps distinct history events with identical token counts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-shape-'))
    try {
      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:00:00.000Z',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['cascade-a']),
          events: [
            historyEvent({ eventHash: 'e'.repeat(64), inputTokens: 100, outputTokens: 12, cacheReadTokens: 50 }),
            historyEvent({
              eventHash: 'f'.repeat(64),
              createdAt: '2026-06-23T16:31:00.000Z',
              inputTokens: 100,
              outputTokens: 12,
              cacheReadTokens: 50
            })
          ],
          lastReadRowIndexByCascade: new Map([['cascade-a', 2]])
        })
      })

      expect(snapshots).toEqual([
        expect.objectContaining({
          inputTokens: 200,
          outputTokens: 24,
          cacheReadTokens: 100,
          totalTokens: 324,
          sessionCount: 1
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps same event hashes from separate conversations distinct', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-conversations-'))
    try {
      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['cascade-a', 'cascade-b']),
          events: [
            historyEvent({ cascadeHash: conversationA, eventHash: 'e'.repeat(64), inputTokens: 10 }),
            historyEvent({ cascadeHash: conversationB, eventHash: 'e'.repeat(64), inputTokens: 10 })
          ],
          lastReadRowIndexByCascade: new Map([
            ['cascade-a', 1],
            ['cascade-b', 1]
          ])
        })
      })

      expect(snapshots).toEqual([expect.objectContaining({ inputTokens: 20, totalTokens: 22, sessionCount: 2 })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retries pending history snapshots until they are acknowledged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-pending-history-'))
    const event = historyEvent({ inputTokens: 10, outputTokens: 2 })
    const readDbUsageEvents = async () => ({
      cascadeIds: new Set(['cascade-a']),
      events: [event],
      lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
    })
    try {
      const first = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-23T10:00:00.000Z',
        readDbUsageEvents
      })
      const second = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-23T10:05:00.000Z',
        readDbUsageEvents
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })
      const third = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-23T10:10:00.000Z',
        readDbUsageEvents
      })

      expect(first).toHaveLength(1)
      expect(second).toEqual([{ ...first[0], collectedAt: '2026-06-23T10:05:00.000Z' }])
      expect(third).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses independent hashed cursors for each server origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-server-cursor-'))
    const event = historyEvent({ inputTokens: 10, outputTokens: 2 })
    const readDbUsageEvents = async () => ({
      cascadeIds: new Set(['cascade-a']),
      events: [event],
      lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
    })
    const serverA = 'https://prod.example.com'
    const serverB = 'https://private.example.com'
    try {
      const first = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        cursorScope: serverA,
        collectedAt: '2026-06-23T10:00:00.000Z',
        readDbUsageEvents
      })
      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity-cli',
        cursorScope: serverA,
        timezone: 'UTC'
      })
      const second = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        cursorScope: serverB,
        collectedAt: '2026-06-23T10:05:00.000Z',
        readDbUsageEvents
      })

      expect(first).toHaveLength(1)
      expect(second).toEqual([{ ...first[0], collectedAt: '2026-06-23T10:05:00.000Z' }])
      const cursorFiles = (await readdir(root)).filter((name) => name.includes('cursor'))
      expect(cursorFiles).toHaveLength(2)
      expect(cursorFiles.join('\n')).not.toContain('prod.example.com')
      expect(cursorFiles.join('\n')).not.toContain('private.example.com')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses the configured timezone for history dates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-timezone-'))
    try {
      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'Asia/Shanghai',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['cascade-a']),
          events: [historyEvent({ createdAt: '2026-06-23T16:30:00.000Z' })],
          lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
        })
      })

      expect(snapshots[0]?.usageDate).toBe('2026-06-24')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('propagates unavailable and malformed SQLite history errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-errors-'))
    try {
      await expect(
        collectAntigravityCliUsage({
          stateDir: root,
          timezone: 'UTC',
          readDbUsageEvents: async () => {
            throw new Error('Antigravity SQLite reader unavailable: sqlite3 not found')
          }
        })
      ).rejects.toThrow('Antigravity SQLite reader unavailable: sqlite3 not found')

      await expect(
        collectAntigravityCliUsage({
          stateDir: root,
          timezone: 'UTC',
          readDbUsageEvents: async () => {
            throw new Error('Failed to read Antigravity SQLite metadata: invalid row')
          }
        })
      ).rejects.toThrow('Failed to read Antigravity SQLite metadata: invalid row')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('passes DB row cursors and uploads complete daily snapshots after acknowledgement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-cursor-'))
    const firstEvent = historyEvent({ inputTokens: 100, outputTokens: 12, cacheReadTokens: 50 })
    const secondEvent = historyEvent({
      eventHash: 'f'.repeat(64),
      createdAt: '2026-06-23T16:31:00.000Z',
      inputTokens: 25,
      outputTokens: 3,
      cacheReadTokens: 10
    })
    const dbCursorReads: Array<Map<string, number>> = []
    try {
      const first = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:00:00.000Z',
        readDbUsageEvents: async ({ lastSeenRowIndexByCascadeHash }) => {
          dbCursorReads.push(lastSeenRowIndexByCascadeHash)
          return {
            cascadeIds: new Set(['cascade-a']),
            events: [firstEvent],
            lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
          }
        }
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })
      const second = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-06-24T02:05:00.000Z',
        readDbUsageEvents: async ({ lastSeenRowIndexByCascadeHash }) => {
          dbCursorReads.push(lastSeenRowIndexByCascadeHash)
          return {
            cascadeIds: new Set(['cascade-a']),
            events: [secondEvent],
            lastReadRowIndexByCascade: new Map([['cascade-a', 2]])
          }
        }
      })

      expect(first[0]?.inputTokens).toBe(100)
      expect(dbCursorReads[0]?.size).toBe(0)
      expect(dbCursorReads[1]?.get(hash('cascade-a'))).toBe(1)
      expect(second).toEqual([
        expect.objectContaining({
          inputTokens: 125,
          outputTokens: 15,
          cacheReadTokens: 60,
          totalTokens: 200,
          sessionCount: 1
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps DB reads bounded unless full history is explicitly requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-db-limit-'))
    const reads: Array<{ maxDbFiles?: number | null; requireCompleteDirectoryScan?: boolean }> = []
    const readDbUsageEvents = async (input: { maxDbFiles?: number | null; requireCompleteDirectoryScan?: boolean }) => {
      reads.push(input)
      return { cascadeIds: new Set<string>(), events: [] }
    }
    try {
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: '20260624',
        readDbUsageEvents
      })
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: '20260624',
        maxDbFiles: null,
        readDbUsageEvents
      })
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents
      })

      expect(reads).toEqual([
        {
          maxDbFiles: undefined,
          sinceDate: '2026-06-24',
          timezone: 'UTC',
          detectRowCursorReset: false,
          lastSeenRowIndexByCascadeHash: new Map(),
          requireCompleteDirectoryScan: false
        },
        {
          maxDbFiles: null,
          sinceDate: '2026-06-24',
          timezone: 'UTC',
          detectRowCursorReset: false,
          lastSeenRowIndexByCascadeHash: new Map(),
          requireCompleteDirectoryScan: true
        },
        {
          maxDbFiles: null,
          sinceDate: undefined,
          timezone: 'UTC',
          detectRowCursorReset: false,
          lastSeenRowIndexByCascadeHash: new Map(),
          requireCompleteDirectoryScan: true
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps legacy unanchored cursor recovery within the bounded file budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-unanchored-bounded-'))
    const reads: Array<{
      maxDbFiles?: number | null
      forceFullScanCascadeHashes?: ReadonlySet<string>
    }> = []
    const readDbUsageEvents = async (input: {
      maxDbFiles?: number | null
      forceFullScanCascadeHashes?: ReadonlySet<string>
    }) => {
      reads.push(input)
      return {
        cascadeIds: new Set<string>(),
        events: [],
        lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
      }
    }
    try {
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: '20260624',
        readDbUsageEvents
      })
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: '20260624',
        readDbUsageEvents
      })

      expect(reads[1]?.maxDbFiles).toBeUndefined()
      expect(reads[1]?.forceFullScanCascadeHashes?.size).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function historyEvent(overrides: Partial<AntigravityUsageEvent> = {}): AntigravityUsageEvent {
  return {
    cascadeHash: conversationA,
    eventHash: 'e'.repeat(64),
    createdAt: '2026-06-23T16:30:00.000Z',
    model: 'gemini-3-flash-a',
    inputTokens: 10,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    ...overrides
  }
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
