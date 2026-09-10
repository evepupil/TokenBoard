import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { collectAntigravityCliUsage } from './antigravity-cli'
import { clearPendingUploadCursors } from './session-cursor'

const cascadeHash = 'a'.repeat(64)

describe('collectAntigravityCliUsage since ranges', () => {
  test('excludes SQLite history before the configured local date', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-since-'))
    try {
      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'Asia/Shanghai',
        since: '20260624',
        readDbUsageEvents: async () =>
          dbUsage(
            [
              historyEvent('b', '2026-06-23T15:59:59.000Z', 'gemini-old', 30),
              historyEvent('c', '2026-06-23T16:00:00.000Z', 'gemini-new', 40)
            ],
            2
          )
      })

      expect(snapshots).toEqual([expect.objectContaining({ model: 'gemini-new', inputTokens: 40 })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects an incomplete first bounded scan without persisting partial usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-since-incomplete-'))
    try {
      await expect(
        collectAntigravityCliUsage({
          stateDir: root,
          timezone: 'UTC',
          since: '20260630',
          readDbUsageEvents: async () => ({
            ...dbUsage([historyEvent('b', '2026-06-30T12:00:00.000Z', 'gemini', 10)], 1),
            completeDirectoryScan: false
          })
        })
      ).rejects.toThrow('requires --since all before a bounded scan can complete an incomplete SQLite directory scan')

      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects an incomplete full-history scan without marking its cursor complete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-since-incomplete-full-'))
    try {
      await expect(
        collectAntigravityCliUsage({
          stateDir: root,
          timezone: 'UTC',
          since: 'all',
          readDbUsageEvents: async () => ({
            ...dbUsage([historyEvent('b', '2026-06-30T12:00:00.000Z', 'gemini', 10)], 1),
            completeDirectoryScan: false
          })
        })
      ).rejects.toThrow('requires a complete SQLite directory scan')

      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects an empty incomplete first bounded scan without persisting scan state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-since-empty-incomplete-'))
    try {
      await expect(
        collectAntigravityCliUsage({
          stateDir: root,
          timezone: 'UTC',
          since: '20260630',
          readDbUsageEvents: async () => ({
            ...dbUsage([], 0),
            completeDirectoryScan: false
          })
        })
      ).rejects.toThrow('requires --since all before a bounded scan can complete an incomplete SQLite directory scan')

      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects in-range pending snapshot retries from an incomplete bounded scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-since-pending-incomplete-'))
    try {
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: '20260630',
        maxDbFiles: null,
        readDbUsageEvents: async () => ({
          ...dbUsage([historyEvent('b', '2026-06-30T12:00:00.000Z', 'gemini', 10)], 1),
          completeDirectoryScan: true
        })
      })
      const cursorPath = join(root, 'antigravity-cli-cursor.json')
      const before = await readFile(cursorPath, 'utf8')

      await expect(
        collectAntigravityCliUsage({
          stateDir: root,
          timezone: 'UTC',
          since: '20260630',
          readDbUsageEvents: async () => ({
            ...dbUsage([], 1),
            completeDirectoryScan: false
          })
        })
      ).rejects.toThrow('requires --since all before a bounded scan can complete an incomplete SQLite directory scan')

      expect(await readFile(cursorPath, 'utf8')).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('allows bounded increments after a completed full-history baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-since-baseline-'))
    try {
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents: async () => ({
          ...dbUsage([historyEvent('b', '2026-06-30T12:00:00.000Z', 'gemini-old', 10)], 1),
          completeDirectoryScan: true
        })
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })

      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: '20260630',
        readDbUsageEvents: async () => ({
          ...dbUsage([historyEvent('c', '2026-07-01T12:00:00.000Z', 'gemini-new', 20)], 1),
          completeDirectoryScan: false
        })
      })

      expect(snapshots).toEqual([
        expect.objectContaining({
          usageDate: '2026-07-01',
          model: 'gemini-new',
          inputTokens: 20
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retries a pending SQLite group outside the active bounded range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-since-pending-'))
    const old = historyEvent('b', '2026-06-23T16:00:00.000Z', 'gemini', 10)
    try {
      await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'Asia/Shanghai',
        since: 'all',
        readDbUsageEvents: async () => dbUsage([old], 1)
      })
      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity-cli',
        since: '20260625',
        timezone: 'Asia/Shanghai'
      })

      const retry = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'Asia/Shanghai',
        since: '20260625',
        readDbUsageEvents: async () => dbUsage([], 1)
      })

      expect(retry).toEqual([expect.objectContaining({ inputTokens: 10, totalTokens: 12 })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('performs a fresh all-scope row scan after a bounded cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-since-full-'))
    const cursorSizes: number[] = []
    const events = [
      historyEvent('b', '2026-06-23T15:59:59.000Z', 'gemini', 10),
      historyEvent('c', '2026-06-23T16:00:00.000Z', 'gemini', 20)
    ]
    try {
      const bounded = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'Asia/Shanghai',
        since: '20260624',
        readDbUsageEvents: async ({ lastSeenRowIndexByCascadeHash }) => {
          cursorSizes.push(lastSeenRowIndexByCascadeHash.size)
          return dbUsage(events, 2)
        }
      })
      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity-cli',
        timezone: 'Asia/Shanghai'
      })
      const full = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'Asia/Shanghai',
        since: 'all',
        readDbUsageEvents: async ({ lastSeenRowIndexByCascadeHash }) => {
          cursorSizes.push(lastSeenRowIndexByCascadeHash.size)
          return dbUsage(events, 2)
        }
      })

      expect(cursorSizes).toEqual([0, 0])
      expect(bounded).toEqual([expect.objectContaining({ inputTokens: 20 })])
      expect(full).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ usageDate: '2026-06-23', inputTokens: 10, sessionCount: 1 }),
          expect.objectContaining({ usageDate: '2026-06-24', inputTokens: 20, sessionCount: 1 })
        ])
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function historyEvent(hash: string, createdAt: string, model: string, inputTokens: number) {
  return {
    cascadeHash,
    eventHash: hash.repeat(64),
    createdAt,
    model,
    inputTokens,
    outputTokens: 2,
    cacheCreationTokens: 0,
    cacheReadTokens: 0
  }
}

function dbUsage(events: ReturnType<typeof historyEvent>[], rowIndex: number) {
  return {
    cascadeIds: new Set(events.length > 0 ? ['cascade-a'] : []),
    events,
    completeDirectoryScan: true,
    lastReadRowIndexByCascade: new Map([['cascade-a', rowIndex]])
  }
}
