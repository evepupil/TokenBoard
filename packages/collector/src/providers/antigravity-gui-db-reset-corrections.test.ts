import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { collectAntigravityGuiUsage } from './antigravity-gui'
import { AntigravityDbRowCursorResetError } from './antigravity-history-db'
import { clearPendingUploadCursors } from './session-cursor'

describe('Antigravity GUI database reset corrections', () => {
  test('retries a persisted zero replacement when a recreated database removes an acknowledged daily model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-reset-zero-retry-'))
    try {
      let reads = 0
      const readDbUsageEvents = async (input?: { lastSeenRowIndexByCascadeHash?: Map<string, number> }) => {
        reads += 1
        if (reads === 1) {
          return {
            cascadeIds: new Set(['conversation-db']),
            events: [dbEvent('a', 'gemini-removed', 10)],
            lastReadRowIndexByCascade: new Map([['conversation-db', 41]])
          }
        }
        if (reads === 2 && (input?.lastSeenRowIndexByCascadeHash?.size ?? 0) > 0) {
          throw new AntigravityDbRowCursorResetError('recreated.db')
        }
        return {
          cascadeIds: new Set<string>(),
          events: [],
          lastReadRowIndexByCascade: new Map([['conversation-db', -1]])
        }
      }
      const options = {
        ...baseOptions(root),
        collectedAt: '2026-06-24T02:00:00.000Z',
        readDbUsageEvents
      }

      await collectAntigravityGuiUsage(options)
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity', timezone: 'Asia/Shanghai' })
      const replacement = await collectAntigravityGuiUsage(options)
      const retry = await collectAntigravityGuiUsage(options)

      expect(replacement).toEqual([
        expect.objectContaining({
          model: 'gemini-removed',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          sessionCount: 0
        })
      ])
      expect(retry).toEqual(replacement)

      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity',
        timezone: 'Asia/Shanghai',
        acknowledgedSnapshotGroups: [['antigravity', '2026-06-24', 'Asia/Shanghai', 'gemini-removed'].join('\0')]
      })

      expect(await collectAntigravityGuiUsage(options)).toEqual([])
      expect(reads).toBe(5)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps the prior cursor on disk when a database reset recovery read fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-reset-recovery-failure-'))
    const cursorPath = join(root, 'antigravity-cursor.json')
    try {
      let reads = 0
      const readDbUsageEvents = async (input?: { lastSeenRowIndexByCascadeHash?: Map<string, number> }) => {
        reads += 1
        if (reads === 1) {
          return {
            cascadeIds: new Set(['conversation-db']),
            events: [dbEvent('a', 'gemini-preserved', 10)],
            lastReadRowIndexByCascade: new Map([['conversation-db', 41]])
          }
        }
        if ((input?.lastSeenRowIndexByCascadeHash?.size ?? 0) > 0) {
          throw new AntigravityDbRowCursorResetError('recreated.db')
        }
        throw new Error('Antigravity SQLite reader unavailable: sqlite3 not found')
      }
      const options = { ...baseOptions(root), readDbUsageEvents }

      await collectAntigravityGuiUsage(options)
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity', timezone: 'Asia/Shanghai' })
      const before = await readFile(cursorPath, 'utf8')

      await expect(collectAntigravityGuiUsage(options)).rejects.toThrow(
        'Antigravity SQLite metadata cursor reset recovery failed: Antigravity SQLite reader unavailable: sqlite3 not found'
      )

      expect(await readFile(cursorPath, 'utf8')).toBe(before)
      expect(reads).toBe(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rebuilds a daily model from retained language-server state and recreated database state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-reset-shared-group-'))
    const databaseCascade = 'conversation-db'
    const languageServerCascade = 'conversation-language-server'
    try {
      let reads = 0
      const readDbUsageEvents = async (input?: { lastSeenRowIndexByCascadeHash?: Map<string, number> }) => {
        reads += 1
        if (reads === 1) {
          return {
            cascadeIds: new Set([databaseCascade]),
            events: [dbEvent('a', 'gemini-shared', 10, databaseCascade)],
            lastReadRowIndexByCascade: new Map([[databaseCascade, 41]])
          }
        }
        if ((input?.lastSeenRowIndexByCascadeHash?.size ?? 0) > 0) {
          throw new AntigravityDbRowCursorResetError('recreated.db')
        }
        return {
          cascadeIds: new Set([databaseCascade]),
          events: [dbEvent('c', 'gemini-shared', 20, databaseCascade)],
          lastReadRowIndexByCascade: new Map([[databaseCascade, 2]])
        }
      }
      const options = {
        ...baseOptions(root),
        listCascades: async () => [
          {
            id: languageServerCascade,
            mtimeMs: Date.parse('2026-06-24T01:00:00.000Z'),
            size: 20
          }
        ],
        readDbUsageEvents,
        requestGeneratorMetadata: async () => ({
          generatorMetadata: [metadataItem('gemini-shared', '30', 'response-ls')]
        })
      }

      const first = await collectAntigravityGuiUsage(options)
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity', timezone: 'Asia/Shanghai' })
      const rebuilt = await collectAntigravityGuiUsage(options)

      expect(first).toEqual([expect.objectContaining({ model: 'gemini-shared', inputTokens: 40, sessionCount: 2 })])
      expect(rebuilt).toEqual([expect.objectContaining({ model: 'gemini-shared', inputTokens: 50, sessionCount: 2 })])
      expect(reads).toBe(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retains same-model language-server usage when a recreated database removes its old event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-reset-retained-language-server-'))
    const databaseCascade = 'conversation-db'
    const languageServerCascade = 'conversation-language-server'
    try {
      let reads = 0
      const readDbUsageEvents = async (input?: { lastSeenRowIndexByCascadeHash?: Map<string, number> }) => {
        reads += 1
        if (reads === 1) {
          return {
            cascadeIds: new Set([databaseCascade]),
            events: [dbEvent('a', 'gemini-shared', 10, databaseCascade)],
            lastReadRowIndexByCascade: new Map([[databaseCascade, 41]])
          }
        }
        if ((input?.lastSeenRowIndexByCascadeHash?.size ?? 0) > 0) {
          throw new AntigravityDbRowCursorResetError('recreated.db')
        }
        return {
          cascadeIds: new Set<string>(),
          events: [],
          lastReadRowIndexByCascade: new Map([[databaseCascade, -1]])
        }
      }
      const options = {
        ...baseOptions(root),
        listCascades: async () => [
          {
            id: languageServerCascade,
            mtimeMs: Date.parse('2026-06-24T01:00:00.000Z'),
            size: 20
          }
        ],
        readDbUsageEvents,
        requestGeneratorMetadata: async () => ({
          generatorMetadata: [metadataItem('gemini-shared', '30', 'response-ls')]
        })
      }

      const first = await collectAntigravityGuiUsage(options)
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity', timezone: 'Asia/Shanghai' })
      const rebuilt = await collectAntigravityGuiUsage(options)

      expect(first).toEqual([expect.objectContaining({ model: 'gemini-shared', inputTokens: 40, sessionCount: 2 })])
      expect(rebuilt).toEqual([expect.objectContaining({ model: 'gemini-shared', inputTokens: 30, sessionCount: 1 })])
      expect(reads).toBe(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.each(['event', 'aggregate'] as const)(
    'refuses a reset when a legacy %s entry has no source origin',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), `tokenboard-antigravity-db-reset-legacy-${kind}-`))
      const cascadeId = 'conversation-db'
      const cascadeHash = createHash('sha256').update(cascadeId).digest('hex')
      const cursorPath = join(root, 'antigravity-cursor.json')
      const snapshot = {
        source: 'antigravity',
        usageDate: '2026-06-24',
        timezone: 'Asia/Shanghai',
        model: 'gemini-legacy',
        inputTokens: 10,
        outputTokens: 2,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 12,
        costUsd: 0,
        sessionCount: 1
      }
      const entry = {
        size: 0,
        mtimeMs: Date.parse('2026-06-24T00:00:00.000Z'),
        sha256: 'a'.repeat(64),
        snapshots: [snapshot],
        missingCost: true,
        pendingUpload: false,
        updatedAt: '2026-06-24T00:00:00.000Z'
      }
      const legacyKey =
        kind === 'event' ? ['event', cascadeHash, 'b'.repeat(64)].join('\0') : ['aggregate', 'b'.repeat(64)].join('\0')
      try {
        await writeFile(
          cursorPath,
          `${JSON.stringify(
            {
              version: 1,
              source: 'antigravity',
              files: {
                [`db\0antigravity\0${cascadeHash}`]: { ...entry, snapshots: [] },
                [legacyKey]: entry
              }
            },
            null,
            2
          )}\n`
        )
        const before = await readFile(cursorPath, 'utf8')

        await expect(
          collectAntigravityGuiUsage({
            ...baseOptions(root),
            readDbUsageEvents: async (input) => {
              if ((input?.lastSeenRowIndexByCascadeHash?.size ?? 0) > 0) {
                throw new AntigravityDbRowCursorResetError('recreated.db')
              }
              return { cascadeIds: new Set<string>(), events: [] }
            }
          })
        ).rejects.toThrow('cannot safely classify legacy database or language-server usage state')

        expect(await readFile(cursorPath, 'utf8')).toBe(before)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})

function baseOptions(stateDir: string) {
  return {
    source: 'antigravity' as const,
    stateDir,
    timezone: 'Asia/Shanghai',
    since: 'all',
    listCascades: async () => []
  }
}

function dbEvent(hash: string, model: string, inputTokens: number, cascadeId = 'conversation-db') {
  return {
    cascadeHash: createHash('sha256').update(cascadeId).digest('hex'),
    eventHash: hash.repeat(64),
    createdAt: '2026-06-24T00:00:00.000Z',
    model,
    inputTokens,
    outputTokens: 2,
    cacheCreationTokens: 0,
    cacheReadTokens: 0
  }
}

function metadataItem(model: string, inputTokens: string, responseId: string) {
  return {
    executionId: responseId,
    stepIndices: [3],
    chatModel: {
      model,
      chatStartMetadata: { createdAt: '2026-06-24T00:00:00.000Z' },
      usage: { model, inputTokens, outputTokens: '2', cacheReadTokens: '0', responseId }
    }
  }
}
