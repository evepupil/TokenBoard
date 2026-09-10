import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { collectAntigravityCliUsage } from './antigravity-cli'
import { cursorSnapshotGroupKey, clearPendingUploadCursors } from './session-cursor'

const conversationHash = 'a'.repeat(64)
const eventHash = 'b'.repeat(64)

describe('Antigravity CLI history authority', () => {
  test('returns no snapshots when SQLite history has no events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-authority-'))
    try {
      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        readDbUsageEvents: emptyDbUsage
      })

      expect(snapshots).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('propagates unavailable SQLite history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-unavailable-'))
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
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('collects delayed SQLite history after a prior empty read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-delayed-'))
    try {
      let historyAvailable = false
      const readDbUsageEvents = async () => ({
        cascadeIds: historyAvailable ? new Set(['cascade-a']) : new Set<string>(),
        events: historyAvailable ? [historyEvent(12, 4)] : [],
        lastReadRowIndexByCascade: historyAvailable ? new Map([['cascade-a', 1]]) : new Map<string, number>()
      })

      const beforeHistory = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-07-20T10:00:00.000Z',
        readDbUsageEvents
      })
      historyAvailable = true
      const afterHistory = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        collectedAt: '2026-07-20T10:01:00.000Z',
        readDbUsageEvents
      })

      expect(beforeHistory).toEqual([])
      expect(afterHistory).toEqual([
        expect.objectContaining({
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16,
          sessionCount: 1
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rebuilds legacy statusline state only after a successful full SQLite history scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-migration-'))
    const cursorPath = join(root, 'antigravity-cli-cursor.json')
    try {
      await writeFile(cursorPath, `${JSON.stringify(legacyCursor(), null, 2)}\n`)
      const before = await readFile(cursorPath, 'utf8')
      let reads = 0

      await expect(
        collectAntigravityCliUsage({
          stateDir: root,
          timezone: 'UTC',
          since: '20260701',
          readDbUsageEvents: async () => {
            reads += 1
            return emptyDbUsage()
          }
        })
      ).rejects.toThrow('requires --since all')
      expect(reads).toBe(0)
      expect(await readFile(cursorPath, 'utf8')).toBe(before)

      await expect(
        collectAntigravityCliUsage({
          stateDir: root,
          timezone: 'UTC',
          since: 'all',
          readDbUsageEvents: async () => {
            throw new Error('Antigravity SQLite reader unavailable: sqlite3 not found')
          }
        })
      ).rejects.toThrow('Antigravity SQLite reader unavailable: sqlite3 not found')
      expect(await readFile(cursorPath, 'utf8')).toBe(before)

      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents: async ({ lastSeenRowIndexByCascadeHash }) => {
          expect(lastSeenRowIndexByCascadeHash).toEqual(new Map())
          return {
            cascadeIds: new Set(['cascade-a']),
            events: [historyEvent(12, 4)],
            lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
          }
        }
      })
      const migrated = JSON.parse(await readFile(cursorPath, 'utf8')) as {
        antigravityCliMeteringVersion?: number
        files: Record<string, unknown>
      }

      expect(snapshots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            model: 'Gemini 3.5 Flash (Medium)',
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            sessionCount: 0
          }),
          expect.objectContaining({
            model: 'gemini-3-flash-a',
            inputTokens: 12,
            outputTokens: 4,
            totalTokens: 16,
            sessionCount: 1
          })
        ])
      )
      expect(migrated.antigravityCliMeteringVersion).toBe(3)
      expect(
        Object.keys(migrated.files).some(
          (key) => key.startsWith('aggregate\0') || key.startsWith('statusline-') || key.startsWith('event\0')
        )
      ).toBe(false)

      const correction = snapshots.find((snapshot) => snapshot.model === 'Gemini 3.5 Flash (Medium)')
      const history = snapshots.find((snapshot) => snapshot.model === 'gemini-3-flash-a')
      expect(correction).toBeDefined()
      expect(history).toBeDefined()
      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity-cli',
        timezone: 'UTC',
        acknowledgedSnapshotGroups: [cursorSnapshotGroupKey(history!)]
      })
      const afterHistoryAcknowledgement = JSON.parse(await readFile(cursorPath, 'utf8')) as {
        files: Record<string, { pendingUpload?: boolean; snapshots: Array<{ model: string }> }>
      }
      expect(
        Object.values(afterHistoryAcknowledgement.files).some(
          (entry) =>
            entry.pendingUpload === true &&
            entry.snapshots.some((snapshot) => snapshot.model === 'Gemini 3.5 Flash (Medium)')
        )
      ).toBe(true)

      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity-cli',
        timezone: 'UTC',
        acknowledgedSnapshotGroups: [cursorSnapshotGroupKey(correction!)]
      })
      const afterAllAcknowledgements = JSON.parse(await readFile(cursorPath, 'utf8')) as {
        files: Record<string, { pendingUpload?: boolean }>
      }
      expect(Object.values(afterAllAcknowledgements.files).some((entry) => entry.pendingUpload)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('merges a legacy correction with authoritative history when both use the same model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-same-model-migration-'))
    const cursorPath = join(root, 'antigravity-cli-cursor.json')
    try {
      await writeFile(cursorPath, `${JSON.stringify(legacyCursor('gemini-3-flash-a'), null, 2)}\n`)

      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['cascade-a']),
          events: [historyEvent(12, 4)],
          lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
        })
      })

      expect(snapshots).toEqual([
        expect.objectContaining({
          model: 'gemini-3-flash-a',
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16,
          sessionCount: 1
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('removes a 64,000-entry legacy alias map after an acknowledged canonical rebuild', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-history-alias-migration-'))
    const cursorPath = join(root, 'antigravity-cli-cursor.json')
    const oldCreatedAt = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString()
    try {
      await writeFile(
        cursorPath,
        `${JSON.stringify(
          {
            ...legacyCursor(),
            antigravityHistoryAliasMtimes: legacyAliases(64_000)
          },
          null,
          2
        )}\n`
      )

      const snapshots = await collectAntigravityCliUsage({
        stateDir: root,
        timezone: 'UTC',
        since: 'all',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['cascade-a']),
          events: [historyEvent(12, 4, oldCreatedAt)],
          lastReadRowIndexByCascade: new Map([['cascade-a', 1]])
        })
      })
      const history = snapshots.find((snapshot) => snapshot.model === 'gemini-3-flash-a')
      expect(history).toMatchObject({ inputTokens: 12, outputTokens: 4, totalTokens: 16, sessionCount: 1 })

      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity-cli', timezone: 'UTC' })
      const migrated = JSON.parse(await readFile(cursorPath, 'utf8')) as {
        antigravityHistoryAliasMtimes?: unknown
        files: Record<string, unknown>
      }

      expect(migrated.antigravityHistoryAliasMtimes).toBeUndefined()
      const persistedKeys = Object.keys(migrated.files)
      expect(persistedKeys).toHaveLength(2)
      expect(persistedKeys).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^db-row\0antigravity-cli\0[a-f0-9]{64}$/),
          expect.stringMatching(/^aggregate\0[a-f0-9]{64}$/)
        ])
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)
})

function historyEvent(inputTokens: number, outputTokens: number, createdAt = '2026-07-20T10:00:00.000Z') {
  return {
    cascadeHash: conversationHash,
    eventHash,
    createdAt,
    model: 'gemini-3-flash-a',
    inputTokens,
    outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0
  }
}

function legacyAliases(count: number) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [index.toString(16).padStart(64, '0'), [index]])
  )
}

function legacyCursor(model = 'Gemini 3.5 Flash (Medium)') {
  const snapshot = {
    source: 'antigravity-cli',
    usageDate: '2026-07-20',
    timezone: 'UTC',
    model,
    inputTokens: 900,
    outputTokens: 300,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 1200,
    costUsd: 0,
    sessionCount: 1
  }
  const entry = (snapshots: unknown[]) => ({
    size: 0,
    mtimeMs: Date.parse('2026-07-20T10:00:00.000Z'),
    sha256: 'c'.repeat(64),
    snapshots,
    missingCost: true,
    pendingUpload: false,
    updatedAt: '2026-07-20T10:00:00.000Z'
  })
  return {
    version: 1,
    source: 'antigravity-cli',
    lastScanOffsetBytes: 100,
    lastScanGeneration: 'd'.repeat(32),
    antigravityStatuslineReplayReady: true,
    files: {
      ['statusline-event\0' + 'e'.repeat(64)]: entry([snapshot]),
      ['aggregate\0' + 'f'.repeat(64)]: entry([snapshot]),
      ['db-row\0antigravity-cli\0' + '0'.repeat(64)]: entry([])
    }
  }
}

async function emptyDbUsage() {
  return {
    cascadeIds: new Set<string>(),
    events: [],
    lastReadRowIndexByCascade: new Map<string, number>()
  }
}
