import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { collectAntigravityGuiUsage } from './antigravity-gui'
import { AntigravityDbRowCursorResetError } from './antigravity-history-db'
import {
  hasUnanchoredDbRowCursor,
  lastSeenDbRowIndexByCascadeHash,
  prepareGuiHistoryScope
} from './antigravity-gui-cursor'
import { resolveAntigravityCollectionRange } from './antigravity-since'
import { clearPendingUploadCursors } from './session-cursor'

describe('collectAntigravityGuiUsage since ranges', () => {
  test('max-merges reusable bounded DB cursors across residual scopes', () => {
    const earlierScope = resolveAntigravityCollectionRange({ since: '20260601', timezone: 'UTC' }).historyScope
    const residualScope = resolveAntigravityCollectionRange({ since: '20260620', timezone: 'UTC' }).historyScope
    const currentScope = resolveAntigravityCollectionRange({ since: '20260624', timezone: 'UTC' }).historyScope
    const cascadeId = 'conversation-a'
    const cascadeHash = createHash('sha256').update(cascadeId).digest('hex')
    const entry = (rowIndex: number) => ({
      size: 0,
      mtimeMs: rowIndex,
      sha256: 'a'.repeat(64),
      snapshots: [],
      missingCost: true,
      pendingUpload: false,
      updatedAt: '2026-06-24T00:00:00.000Z'
    })
    const cursor = {
      version: 1 as const,
      source: 'antigravity' as const,
      files: {
        [`db\0antigravity\0since:${earlierScope}\0${cascadeHash}`]: entry(7),
        [`db\0antigravity\0since:${residualScope}\0${cascadeHash}`]: entry(5)
      }
    }

    prepareGuiHistoryScope({ cursor, source: 'antigravity', historyScope: currentScope })

    expect(
      lastSeenDbRowIndexByCascadeHash({
        cursor,
        source: 'antigravity',
        historyScope: currentScope
      }).get(cascadeHash)
    ).toBe(7)
  })

  test('detects a legacy bounded DB cursor without a SQLite continuity anchor', () => {
    const cascadeHash = createHash('sha256').update('conversation-a').digest('hex')
    const cursor = {
      version: 1 as const,
      source: 'antigravity' as const,
      files: {
        [`db\0antigravity\0${cascadeHash}`]: {
          size: 0,
          mtimeMs: 41,
          sha256: 'a'.repeat(64),
          snapshots: [],
          missingCost: true,
          pendingUpload: false,
          updatedAt: '2026-06-24T00:00:00.000Z'
        }
      },
      antigravityDbFileScan: { nextSequence: 0, files: {} }
    }

    expect(hasUnanchoredDbRowCursor({ cursor, source: 'antigravity' })).toBe(true)
    const scanFiles = cursor.antigravityDbFileScan.files as Record<
      string,
      {
        mtimeMs: number
        size: number
        hasDatabaseFile: true
        checkedSequence: number
        metadataCursorRowIndex?: number
        metadataCursorRowSha256?: string
      }
    >
    scanFiles[cascadeHash] = {
      mtimeMs: 1,
      size: 0,
      hasDatabaseFile: true,
      checkedSequence: 0,
      metadataCursorRowIndex: 41,
      metadataCursorRowSha256: 'b'.repeat(64)
    }
    expect(hasUnanchoredDbRowCursor({ cursor, source: 'antigravity' })).toBe(false)
  })

  test('excludes SQLite and language-server events before the configured date', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-'))
    try {
      const snapshots = await collectAntigravityGuiUsage({
        ...baseOptions(root),
        since: '20260624',
        readDbUsageEvents: async () => ({
          cascadeIds: new Set(['conversation-db']),
          events: [
            dbEvent('b', '2026-06-23T15:59:59.000Z', 'gemini-db-old', 10),
            dbEvent('c', '2026-06-23T16:00:00.000Z', 'gemini-db-new', 20)
          ]
        }),
        requestGeneratorMetadata: async () => metadataResponse()
      })

      expect(snapshots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ model: 'gemini-db-new', inputTokens: 20 }),
          expect.objectContaining({ model: 'gemini-ls-new', inputTokens: 40 })
        ])
      )
      expect(snapshots).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('can backfill SQLite rows after an earlier bounded cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-db-backfill-'))
    try {
      const cursorSizes: number[] = []
      const readDbUsageEvents = async (input?: { lastSeenRowIndexByCascadeHash?: Map<string, number> }) => {
        const cursorSize = input?.lastSeenRowIndexByCascadeHash?.size ?? 0
        cursorSizes.push(cursorSize)
        if (cursorSize > 0) return { cascadeIds: new Set<string>(), events: [] }
        return {
          cascadeIds: new Set(['conversation-a']),
          events: [
            dbEvent('b', '2026-06-23T15:59:59.000Z', 'gemini-old', 10),
            dbEvent('c', '2026-06-23T16:00:00.000Z', 'gemini-new', 20)
          ],
          lastReadRowIndexByCascade: new Map([['conversation-a', 2]])
        }
      }

      const bounded = await collectAntigravityGuiUsage({
        ...baseOptions(root),
        since: '20260624',
        listCascades: async () => [],
        readDbUsageEvents
      })
      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity',
        timezone: 'Asia/Shanghai'
      })
      const full = await collectAntigravityGuiUsage({
        ...baseOptions(root),
        since: 'all',
        listCascades: async () => [],
        readDbUsageEvents
      })

      expect(cursorSizes).toEqual([0, 0])
      expect(bounded).toEqual([expect.objectContaining({ model: 'gemini-new' })])
      expect(full).toEqual([expect.objectContaining({ model: 'gemini-old' })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retries a pending GUI snapshot group outside the current bounded range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-pending-retry-'))
    try {
      const options = {
        ...baseOptions(root),
        readDbUsageEvents: async () => ({ cascadeIds: new Set<string>(), events: [] }),
        requestGeneratorMetadata: async () => metadataResponse()
      }
      await collectAntigravityGuiUsage({ ...options, since: 'all' })
      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity',
        since: '20260624',
        timezone: 'Asia/Shanghai'
      })

      const retry = await collectAntigravityGuiUsage({ ...options, since: '20260624' })

      expect(retry).toEqual([expect.objectContaining({ model: 'gemini-ls-old', inputTokens: 30 })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not reuse a bounded SQLite cursor across timezones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-timezone-'))
    try {
      const cursorSizes: number[] = []
      const readDbUsageEvents = async (input?: { lastSeenRowIndexByCascadeHash?: Map<string, number> }) => {
        const cursorSize = input?.lastSeenRowIndexByCascadeHash?.size ?? 0
        cursorSizes.push(cursorSize)
        if (cursorSize > 0) return { cascadeIds: new Set<string>(), events: [] }
        return {
          cascadeIds: new Set(['conversation-a']),
          events: [dbEvent('b', '2026-06-23T16:00:00.000Z', 'gemini', 20)],
          lastReadRowIndexByCascade: new Map([['conversation-a', 1]])
        }
      }

      const utc = await collectAntigravityGuiUsage({
        ...baseOptions(root),
        timezone: 'UTC',
        since: '20260624',
        listCascades: async () => [],
        readDbUsageEvents
      })
      const shanghai = await collectAntigravityGuiUsage({
        ...baseOptions(root),
        timezone: 'Asia/Shanghai',
        since: '20260624',
        listCascades: async () => [],
        readDbUsageEvents
      })

      expect(cursorSizes).toEqual([0, 0])
      expect(utc).toEqual([])
      expect(shanghai).toEqual([expect.objectContaining({ inputTokens: 20 })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rebuilds a recreated GUI database during an explicit full history scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-db-reset-'))
    try {
      let reads = 0
      const diagnostics: string[] = []
      const readDbUsageEvents = async (input?: {
        lastSeenRowIndexByCascadeHash?: Map<string, number>
        detectRowCursorReset?: boolean
        requireCompleteDirectoryScan?: boolean
      }) => {
        reads += 1
        expect(input?.requireCompleteDirectoryScan).toBe(true)
        if (reads === 1) {
          return {
            cascadeIds: new Set(['conversation-db']),
            events: [dbEvent('a', '2026-06-24T00:00:00.000Z', 'gemini-retained', 10, 'conversation-db')],
            lastReadRowIndexByCascade: new Map([['conversation-db', 41]])
          }
        }
        if ((input?.lastSeenRowIndexByCascadeHash?.size ?? 0) > 0) {
          expect(input?.detectRowCursorReset).toBe(true)
          throw new AntigravityDbRowCursorResetError('recreated.db')
        }
        expect(input?.detectRowCursorReset).toBe(false)
        return {
          cascadeIds: new Set(['conversation-db']),
          events: [
            dbEvent('a', '2026-06-24T00:00:00.000Z', 'gemini-retained', 10, 'conversation-db'),
            dbEvent('c', '2026-06-24T00:00:00.000Z', 'gemini-rebuilt', 20, 'conversation-db')
          ],
          lastReadRowIndexByCascade: new Map([['conversation-db', 2]])
        }
      }

      await collectAntigravityGuiUsage({
        ...baseOptions(root),
        since: 'all',
        listCascades: async () => [],
        readDbUsageEvents,
        stderr: (line) => diagnostics.push(line)
      })
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity', timezone: 'Asia/Shanghai' })

      const rebuilt = await collectAntigravityGuiUsage({
        ...baseOptions(root),
        since: 'all',
        listCascades: async () => [],
        readDbUsageEvents,
        stderr: (line) => diagnostics.push(line)
      })

      expect(reads).toBe(3)
      expect(diagnostics).toEqual([
        'Antigravity SQLite metadata cursor reset detected; rebuilding full local database history once'
      ])
      expect(rebuilt).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ model: 'gemini-retained', inputTokens: 10 }),
          expect.objectContaining({ model: 'gemini-rebuilt', inputTokens: 20 })
        ])
      )
      expect(rebuilt).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects an incomplete GUI SQLite full history scan before committing the cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-incomplete-db-scan-'))
    try {
      let requireCompleteDirectoryScan: boolean | undefined
      const readDbUsageEvents = async (input?: { requireCompleteDirectoryScan?: boolean }) => {
        requireCompleteDirectoryScan = input?.requireCompleteDirectoryScan
        return {
          cascadeIds: new Set(['conversation-db']),
          events: [dbEvent('a', '2026-06-24T00:00:00.000Z', 'gemini-incomplete', 10, 'conversation-db')],
          completeDirectoryScan: false,
          lastReadRowIndexByCascade: new Map([['conversation-db', 41]])
        }
      }

      await expect(
        collectAntigravityGuiUsage({
          ...baseOptions(root),
          since: 'all',
          listCascades: async () => [],
          readDbUsageEvents
        })
      ).rejects.toThrow('Antigravity GUI --since all requires a complete SQLite directory scan')

      expect(requireCompleteDirectoryScan).toBe(true)
      await expect(readFile(join(root, 'antigravity-cursor.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not discard a recreated database row cursor during a bounded scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-bounded-db-reset-'))
    try {
      let reads = 0
      const readDbUsageEvents = async (input?: { lastSeenRowIndexByCascadeHash?: Map<string, number> }) => {
        reads += 1
        if (reads === 1) {
          return {
            cascadeIds: new Set<string>(),
            events: [],
            lastReadRowIndexByCascade: new Map([['conversation-db', 41]])
          }
        }
        expect(input?.lastSeenRowIndexByCascadeHash?.size).toBe(1)
        throw new AntigravityDbRowCursorResetError('recreated.db')
      }

      await collectAntigravityGuiUsage({
        ...baseOptions(root),
        since: '20260624',
        listCascades: async () => [],
        readDbUsageEvents
      })

      await expect(
        collectAntigravityGuiUsage({
          ...baseOptions(root),
          since: '20260624',
          listCascades: async () => [],
          readDbUsageEvents
        })
      ).rejects.toThrow('Antigravity SQLite metadata cursor reset detected for recreated.db')

      expect(reads).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reopens stale database coverage after a full database reset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-db-reset-coverage-'))
    const cascade = { id: 'conversation-db', mtimeMs: Date.parse('2026-06-24T00:00:00.000Z'), size: 20 }
    try {
      let reads = 0
      const requests: string[] = []
      const readDbUsageEvents = async (input?: { lastSeenRowIndexByCascadeHash?: Map<string, number> }) => {
        reads += 1
        if (reads === 1) {
          return {
            cascadeIds: new Set([cascade.id]),
            events: [dbEvent('a', '2026-06-24T00:00:00.000Z', 'gemini-retained', 10, cascade.id)],
            lastReadRowIndexByCascade: new Map([[cascade.id, 41]])
          }
        }
        if ((input?.lastSeenRowIndexByCascadeHash?.size ?? 0) > 0) {
          throw new AntigravityDbRowCursorResetError('recreated.db')
        }
        return {
          cascadeIds: new Set<string>(),
          events: [],
          lastReadRowIndexByCascade: new Map([[cascade.id, -1]])
        }
      }
      const options = {
        ...baseOptions(root),
        since: 'all',
        listCascades: async () => [cascade],
        readDbUsageEvents,
        requestGeneratorMetadata: async (input: { cascadeId: string }) => {
          requests.push(input.cascadeId)
          return {
            generatorMetadata: [
              metadataItem('2026-06-24T00:00:00.000Z', 'gemini-recovered', '20', 'response-recovered')
            ]
          }
        }
      }

      await collectAntigravityGuiUsage(options)
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity', timezone: 'Asia/Shanghai' })
      const recovered = await collectAntigravityGuiUsage(options)

      expect(reads).toBe(3)
      expect(requests).toEqual([cascade.id])
      expect(recovered).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ model: 'gemini-recovered', inputTokens: 20 }),
          expect.objectContaining({
            model: 'gemini-retained',
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            sessionCount: 0
          })
        ])
      )
      expect(recovered).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rebuilds an acknowledged daily model total without duplicating old database events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-db-reset-acknowledged-'))
    try {
      let reads = 0
      const readDbUsageEvents = async (input?: { lastSeenRowIndexByCascadeHash?: Map<string, number> }) => {
        reads += 1
        if (reads === 1) {
          return {
            cascadeIds: new Set(['conversation-db']),
            events: [dbEvent('a', '2026-06-24T00:00:00.000Z', 'gemini-rebuilt', 10, 'conversation-db')],
            lastReadRowIndexByCascade: new Map([['conversation-db', 41]])
          }
        }
        if ((input?.lastSeenRowIndexByCascadeHash?.size ?? 0) > 0) {
          throw new AntigravityDbRowCursorResetError('recreated.db')
        }
        return {
          cascadeIds: new Set(['conversation-db']),
          events: [
            dbEvent('a', '2026-06-24T00:00:00.000Z', 'gemini-rebuilt', 10, 'conversation-db'),
            dbEvent('c', '2026-06-24T00:01:00.000Z', 'gemini-rebuilt', 20, 'conversation-db')
          ],
          lastReadRowIndexByCascade: new Map([['conversation-db', 2]])
        }
      }
      const options = {
        ...baseOptions(root),
        since: 'all',
        listCascades: async () => [],
        readDbUsageEvents
      }

      await collectAntigravityGuiUsage(options)
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity', timezone: 'Asia/Shanghai' })
      const rebuilt = await collectAntigravityGuiUsage(options)

      expect(reads).toBe(3)
      expect(rebuilt).toEqual([
        expect.objectContaining({
          model: 'gemini-rebuilt',
          inputTokens: 30,
          sessionCount: 1
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('replaces an acknowledged daily model total when a recreated database no longer has the old event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-db-reset-replace-'))
    try {
      let reads = 0
      const readDbUsageEvents = async (input?: { lastSeenRowIndexByCascadeHash?: Map<string, number> }) => {
        reads += 1
        if (reads === 1) {
          return {
            cascadeIds: new Set(['conversation-db']),
            events: [dbEvent('a', '2026-06-24T00:00:00.000Z', 'gemini-rebuilt', 10, 'conversation-db')],
            lastReadRowIndexByCascade: new Map([['conversation-db', 41]])
          }
        }
        if ((input?.lastSeenRowIndexByCascadeHash?.size ?? 0) > 0) {
          throw new AntigravityDbRowCursorResetError('recreated.db')
        }
        return {
          cascadeIds: new Set(['conversation-db']),
          events: [dbEvent('c', '2026-06-24T00:01:00.000Z', 'gemini-rebuilt', 20, 'conversation-db')],
          lastReadRowIndexByCascade: new Map([['conversation-db', 2]])
        }
      }
      const options = {
        ...baseOptions(root),
        since: 'all',
        listCascades: async () => [],
        readDbUsageEvents
      }

      await collectAntigravityGuiUsage(options)
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity', timezone: 'Asia/Shanghai' })
      const rebuilt = await collectAntigravityGuiUsage(options)

      expect(reads).toBe(3)
      expect(rebuilt).toEqual([
        expect.objectContaining({
          model: 'gemini-rebuilt',
          inputTokens: 20,
          sessionCount: 1
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('refuses a database reset while an affected database event is pending upload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-db-reset-pending-'))
    try {
      let reads = 0
      const readDbUsageEvents = async (input?: { lastSeenRowIndexByCascadeHash?: Map<string, number> }) => {
        reads += 1
        if (reads === 1) {
          return {
            cascadeIds: new Set(['conversation-db']),
            events: [dbEvent('a', '2026-06-24T00:00:00.000Z', 'gemini-rebuilt', 10, 'conversation-db')],
            lastReadRowIndexByCascade: new Map([['conversation-db', 41]])
          }
        }
        if ((input?.lastSeenRowIndexByCascadeHash?.size ?? 0) > 0) {
          throw new AntigravityDbRowCursorResetError('recreated.db')
        }
        throw new Error('A pending database reset must stop before an uncursorized reread')
      }
      const options = {
        ...baseOptions(root),
        since: 'all',
        listCascades: async () => [],
        readDbUsageEvents
      }

      await collectAntigravityGuiUsage(options)
      await expect(collectAntigravityGuiUsage(options)).rejects.toThrow(
        'Antigravity SQLite metadata cursor reset cannot discard pending database usage'
      )

      expect(reads).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('preserves language-server state while replacing database history after a reset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-db-reset-mixed-'))
    const databaseCascade = 'conversation-db'
    const languageServerCascade = 'conversation-language-server'
    try {
      let reads = 0
      let requests = 0
      const readDbUsageEvents = async (input?: { lastSeenRowIndexByCascadeHash?: Map<string, number> }) => {
        reads += 1
        if (reads === 1) {
          return {
            cascadeIds: new Set([databaseCascade]),
            events: [dbEvent('a', '2026-06-24T00:00:00.000Z', 'gemini-db', 10, databaseCascade)],
            lastReadRowIndexByCascade: new Map([[databaseCascade, 41]])
          }
        }
        if ((input?.lastSeenRowIndexByCascadeHash?.size ?? 0) > 0) {
          throw new AntigravityDbRowCursorResetError('recreated.db')
        }
        return {
          cascadeIds: new Set([databaseCascade]),
          events: [dbEvent('c', '2026-06-24T00:01:00.000Z', 'gemini-db', 20, databaseCascade)],
          lastReadRowIndexByCascade: new Map([[databaseCascade, 2]])
        }
      }
      const options = {
        ...baseOptions(root),
        since: 'all',
        listCascades: async () => [
          {
            id: languageServerCascade,
            mtimeMs: Date.parse('2026-06-24T01:00:00.000Z'),
            size: 20
          }
        ],
        readDbUsageEvents,
        requestGeneratorMetadata: async () => {
          requests += 1
          return {
            generatorMetadata: [metadataItem('2026-06-24T00:00:00.000Z', 'gemini-ls', '30', 'response-ls')]
          }
        }
      }

      await collectAntigravityGuiUsage(options)
      await clearPendingUploadCursors({ stateDir: root, source: 'antigravity', timezone: 'Asia/Shanghai' })
      const rebuilt = await collectAntigravityGuiUsage(options)

      expect(reads).toBe(3)
      expect(requests).toBe(1)
      expect(rebuilt).toEqual([expect.objectContaining({ model: 'gemini-db', inputTokens: 20, sessionCount: 1 })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('can backfill language-server events after an earlier bounded cascade cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-ls-backfill-'))
    try {
      let requests = 0
      const options = {
        ...baseOptions(root),
        readDbUsageEvents: async () => ({ cascadeIds: new Set<string>(), events: [] }),
        requestGeneratorMetadata: async () => {
          requests += 1
          return metadataResponse()
        }
      }

      const bounded = await collectAntigravityGuiUsage({ ...options, since: '20260624' })
      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity',
        timezone: 'Asia/Shanghai'
      })
      const full = await collectAntigravityGuiUsage({ ...options, since: 'all' })

      expect(requests).toBe(2)
      expect(bounded).toEqual([expect.objectContaining({ model: 'gemini-ls-new' })])
      expect(full).toEqual([expect.objectContaining({ model: 'gemini-ls-old' })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not let out-of-range SQLite rows hide current language-server events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-since-db-cover-'))
    const cascadeId = 'conversation-shared'
    try {
      let requests = 0
      const snapshots = await collectAntigravityGuiUsage({
        source: 'antigravity',
        stateDir: root,
        timezone: 'Asia/Shanghai',
        since: '20260624',
        listCascades: async () => [{ id: cascadeId, mtimeMs: Date.parse('2026-06-24T01:00:00.000Z'), size: 20 }],
        readDbUsageEvents: async () => ({
          cascadeIds: new Set([cascadeId]),
          events: [
            {
              ...dbEvent('b', '2026-06-23T15:59:59.000Z', 'gemini-old', 10),
              cascadeHash: createHash('sha256').update(cascadeId).digest('hex')
            }
          ],
          lastReadRowIndexByCascade: new Map([[cascadeId, 1]])
        }),
        requestGeneratorMetadata: async () => {
          requests += 1
          return {
            generatorMetadata: [metadataItem('2026-06-23T16:00:00.000Z', 'gemini-current', '40', 'response-current')]
          }
        }
      })

      expect(requests).toBe(1)
      expect(snapshots).toEqual([expect.objectContaining({ model: 'gemini-current', inputTokens: 40 })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function baseOptions(stateDir: string) {
  return {
    source: 'antigravity' as const,
    stateDir,
    timezone: 'Asia/Shanghai',
    listCascades: async () => [
      { id: 'conversation-language-server', mtimeMs: Date.parse('2026-06-24T01:00:00.000Z'), size: 20 }
    ]
  }
}

function dbEvent(hash: string, createdAt: string, model: string, inputTokens: number, cascadeId?: string) {
  return {
    cascadeHash: cascadeId ? createHash('sha256').update(cascadeId).digest('hex') : 'a'.repeat(64),
    eventHash: hash.repeat(64),
    createdAt,
    model,
    inputTokens,
    outputTokens: 2,
    cacheCreationTokens: 0,
    cacheReadTokens: 0
  }
}

function metadataResponse() {
  return {
    generatorMetadata: [
      metadataItem('2026-06-23T15:59:59.000Z', 'gemini-ls-old', '30', 'response-old'),
      metadataItem('2026-06-23T16:00:00.000Z', 'gemini-ls-new', '40', 'response-new')
    ]
  }
}

function metadataItem(createdAt: string, model: string, inputTokens: string, responseId: string) {
  return {
    executionId: responseId,
    stepIndices: [3],
    chatModel: {
      model,
      chatStartMetadata: { createdAt },
      usage: { model, inputTokens, outputTokens: '2', cacheReadTokens: '0', responseId }
    }
  }
}
