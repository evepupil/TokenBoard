import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { AntigravityDbRowCursorResetError, readAntigravityDbUsageEvents } from './antigravity-history-db'
import type { AntigravityFileScanState } from './antigravity-file-scan'

describe('readAntigravityDbUsageEvents', () => {
  test('fails visibly when the conversations directory is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-missing-db-'))
    try {
      await expect(
        readAntigravityDbUsageEvents({
          conversationDir: join(root, 'missing')
        })
      ).rejects.toThrow(`Antigravity conversations directory not found: ${join(root, 'missing')}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails visibly instead of truncating database directories beyond the safety bound', async () => {
    let listed = 0

    await expect(
      readAntigravityDbUsageEvents({
        conversationDir: '/tmp/tokenboard-antigravity-overflow-databases',
        maxDbFiles: 2,
        listFiles: async function* () {
          for (let index = 0; index <= 10_000; index += 1) {
            listed += 1
            yield { name: `${cascadeId(index)}.db`, isFile: () => true }
          }
        },
        statFile: async () => ({ mtimeMs: 1 })
      })
    ).rejects.toThrow('Antigravity conversations directory exceeds the 10000-entry scan limit')
    expect(listed).toBe(10_001)
  })

  test('does not mark cascades as covered when no usable events are parsed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-empty-db-'))
    try {
      const dir = join(root, 'conversations')
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')
      const result = await readAntigravityDbUsageEvents({
        conversationDir: dir,
        readSqlite: async () => '7|\n'
      })

      expect(result.events).toHaveLength(0)
      expect(result.cascadeIds).toHaveLength(0)
      expect(result.completeDirectoryScan).toBe(true)
      expect(result.knownCascadeIds).toEqual(new Set([cascadeId]))
      expect(result.lastReadRowIndexByCascade?.get(cascadeId)).toBe(7)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('considers a newer SQLite WAL mtime when applying a since file filter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-wal-mtime-'))
    try {
      const dir = join(root, 'conversations')
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      const walPath = join(dir, `${cascadeId}.db-wal`)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')
      await writeFile(walPath, 'wal')
      await utimes(walPath, new Date('2026-06-24T00:00:00.000Z'), new Date('2026-06-24T00:00:00.000Z'))
      const result = await readAntigravityDbUsageEvents({
        conversationDir: dir,
        readSqlite: async () => '',
        sinceDate: '2026-06-24',
        timezone: 'UTC',
        statFile: async () => ({ mtimeMs: Date.parse('2026-06-23T00:00:00.000Z'), size: 0 })
      })

      expect(result.lastReadRowIndexByCascade?.get(cascadeId)).toBe(-1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reads an unprocessed database when its mtime predates the bounded since date', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-unprocessed-old-mtime-'))
    try {
      const dir = join(root, 'conversations')
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')

      const result = await readAntigravityDbUsageEvents({
        conversationDir: dir,
        readSqlite: async () => '7|\n',
        sinceDate: '2026-06-24',
        timezone: 'UTC',
        statFile: async () => ({ mtimeMs: Date.parse('2026-06-23T00:00:00.000Z'), size: 0 })
      })

      expect(result.lastReadRowIndexByCascade?.get(cascadeId)).toBe(7)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('records a successful empty database scan so bounded backlog selection can advance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-empty-db-cursor-'))
    try {
      const dir = join(root, 'conversations')
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      const scanState: AntigravityFileScanState = { nextSequence: 0, files: {} }
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')

      const result = await readAntigravityDbUsageEvents({
        conversationDir: dir,
        readSqlite: async () => '',
        scanState
      })

      expect(result.lastReadRowIndexByCascade?.get(cascadeId)).toBe(-1)
      const scanEntry = scanState.files[hash(cascadeId)] as {
        metadataCursorRowIndex?: number
        metadataCursorRowSha256?: string
      }
      expect(scanEntry.metadataCursorRowIndex).toBe(-1)
      expect(scanEntry.metadataCursorRowSha256).toBe(createHash('sha256').update(Buffer.alloc(0)).digest('hex'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('returns every enumerated cascade as known even when a bounded read selects only one empty database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-known-db-directory-'))
    try {
      const dir = join(root, 'conversations')
      const cascadeIds = [cascadeId(1), cascadeId(2), cascadeId(3)]
      await mkdir(dir, { recursive: true })
      for (const cascade of cascadeIds) {
        await writeFile(join(dir, `${cascade}.db`), '')
      }

      const result = await readAntigravityDbUsageEvents({
        conversationDir: dir,
        readSqlite: async () => '',
        maxDbFiles: 1
      })

      expect(result.knownCascadeIds).toEqual(new Set(cascadeIds))
      expect(result.completeDirectoryScan).toBe(false)
      expect(result.lastReadRowIndexByCascade?.size).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('bounds metadata reads by the stored per-cascade row cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-bounded-db-'))
    try {
      const dir = join(root, 'conversations')
      let actualQuery = ''
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')

      await readAntigravityDbUsageEvents({
        conversationDir: dir,
        readSqlite: async (_dbFile, sql) => {
          actualQuery = sql
          return ''
        },
        lastSeenRowIndexByCascadeHash: new Map([[hash(cascadeId), 41]])
      })

      expect(actualQuery).toBe('select idx, hex(data) from gen_metadata where idx > 41 order by idx limit 500')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails explicitly when a compacted cursor is ahead of a recreated database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-reset-db-'))
    try {
      const dir = join(root, 'conversations')
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')

      await expect(
        readAntigravityDbUsageEvents({
          conversationDir: dir,
          readSqlite: async (_dbFile, sql) => (sql.includes('max(idx)') ? '7\n' : ''),
          lastSeenRowIndexByCascadeHash: new Map([[hash(cascadeId), 41]]),
          detectRowCursorReset: true
        })
      ).rejects.toBeInstanceOf(AntigravityDbRowCursorResetError)
      await expect(
        readAntigravityDbUsageEvents({
          conversationDir: dir,
          readSqlite: async (_dbFile, sql) => (sql.includes('max(idx)') ? '7\n' : ''),
          lastSeenRowIndexByCascadeHash: new Map([[hash(cascadeId), 41]]),
          detectRowCursorReset: true
        })
      ).rejects.toThrow(`Antigravity SQLite metadata cursor reset detected for ${join(dir, `${cascadeId}.db`)}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('checks for a reset before acknowledging a non-empty cursor page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-reset-db-page-'))
    try {
      const dir = join(root, 'conversations')
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      const queries: string[] = []
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')

      await expect(
        readAntigravityDbUsageEvents({
          conversationDir: dir,
          readSqlite: async (_dbFile, sql) => {
            queries.push(sql)
            if (sql.includes('max(idx)')) return '7\n'
            return '42|\n43|\n'
          },
          lastSeenRowIndexByCascadeHash: new Map([[hash(cascadeId), 41]]),
          detectRowCursorReset: true
        })
      ).rejects.toThrow(`Antigravity SQLite metadata cursor reset detected for ${join(dir, `${cascadeId}.db`)}`)

      expect(queries).toEqual([
        'select idx, hex(data) from gen_metadata where idx > 41 order by idx limit 500',
        'select max(idx) from gen_metadata'
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('detects a rebuilt database when the recreated high-water still exceeds the cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-reset-db-high-water-'))
    try {
      const dir = join(root, 'conversations')
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      const dbFile = join(dir, `${cascadeId}.db`)
      const scanState: AntigravityFileScanState = { nextSequence: 0, files: {} }
      const queries: string[] = []
      await mkdir(dir, { recursive: true })
      await writeFile(dbFile, '')

      await readAntigravityDbUsageEvents({
        conversationDir: dir,
        scanState,
        readSqlite: async (_dbFile, sql) => {
          queries.push(sql)
          if (sql.includes('max(idx)')) return '100\n'
          return `${Array.from({ length: 101 }, (_, index) => `${index}|`).join('\n')}\n`
        }
      })
      const scanEntry = scanState.files[hash(cascadeId)] as { metadataRowHighWater?: number }
      expect(scanEntry.metadataRowHighWater).toBe(100)
      Object.assign(scanEntry, {
        metadataCursorRowIndex: 41,
        metadataCursorRowSha256: hashBytes(Buffer.alloc(0))
      })

      await expect(
        readAntigravityDbUsageEvents({
          conversationDir: dir,
          scanState,
          readSqlite: async (_dbFile, sql) => {
            queries.push(sql)
            if (sql.includes('max(idx)')) return '50\n'
            if (sql.includes('where idx in')) return '41|\n'
            return '42|\n43|\n'
          },
          lastSeenRowIndexByCascadeHash: new Map([[hash(cascadeId), 41]]),
          detectRowCursorReset: true
        })
      ).rejects.toThrow(`Antigravity SQLite metadata cursor reset detected for ${dbFile}`)

      expect(queries).toEqual([
        'select idx, hex(data) from gen_metadata where idx > -1 order by idx limit 500',
        'select idx, hex(data) from gen_metadata where idx in (41) order by idx',
        'select idx, hex(data) from gen_metadata where idx > 41 order by idx limit 500',
        'select max(idx) from gen_metadata'
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps the high-water mark at the end of a multi-page incremental read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-paged-reset-db-'))
    try {
      const dir = join(root, 'conversations')
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      const scanState: AntigravityFileScanState = { nextSequence: 0, files: {} }
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')

      await readAntigravityDbUsageEvents({
        conversationDir: dir,
        scanState,
        readSqlite: async (_dbFile, sql) => rowsForQuery(sql, 0, 1000)
      })
      const scanEntry = scanState.files[hash(cascadeId)] as {
        metadataRowHighWater?: number
        metadataCursorRowIndex?: number
      }
      expect(scanEntry.metadataRowHighWater).toBe(1000)
      expect(scanEntry.metadataCursorRowIndex).toBe(1000)

      await readAntigravityDbUsageEvents({
        conversationDir: dir,
        scanState,
        readSqlite: async (_dbFile, sql) => {
          if (sql.includes('where idx in')) return '1000|\n'
          if (sql.includes('max(idx)')) return '1500\n'
          return rowsForQuery(sql, 1001, 1500)
        },
        lastSeenRowIndexByCascadeHash: new Map([[hash(cascadeId), 1000]]),
        detectRowCursorReset: true
      })

      const updatedScanEntry = scanState.files[hash(cascadeId)] as {
        metadataRowHighWater?: number
        metadataCursorRowIndex?: number
      }
      expect(updatedScanEntry.metadataRowHighWater).toBe(1500)
      expect(updatedScanEntry.metadataCursorRowIndex).toBe(1500)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails closed for a legacy scan state without a row continuity anchor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-reset-db-legacy-scan-state-'))
    try {
      const dir = join(root, 'conversations')
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      const scanState: AntigravityFileScanState = { nextSequence: 0, files: {} }
      const queries: string[] = []
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')

      await readAntigravityDbUsageEvents({
        conversationDir: dir,
        scanState,
        readSqlite: async (_dbFile, sql) => (sql.includes('max(idx)') ? '41\n' : '41|\n')
      })
      const entry = scanState.files[hash(cascadeId)] as Record<string, unknown>
      delete entry.metadataCursorRowIndex
      delete entry.metadataCursorRowSha256

      await expect(
        readAntigravityDbUsageEvents({
          conversationDir: dir,
          scanState,
          readSqlite: async (_dbFile, sql) => {
            queries.push(sql)
            return '42|\n'
          },
          lastSeenRowIndexByCascadeHash: new Map([[hash(cascadeId), 41]]),
          detectRowCursorReset: true
        })
      ).rejects.toThrow(`Antigravity SQLite metadata cursor reset detected for ${join(dir, `${cascadeId}.db`)}`)

      expect(queries).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails closed when a row continuity anchor is only partially persisted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-reset-db-partial-anchor-'))
    try {
      const dir = join(root, 'conversations')
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      const scanState: AntigravityFileScanState = { nextSequence: 0, files: {} }
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')

      await readAntigravityDbUsageEvents({
        conversationDir: dir,
        scanState,
        readSqlite: async (_dbFile, sql) => (sql.includes('max(idx)') ? '41\n' : '41|\n')
      })
      const entry = scanState.files[hash(cascadeId)] as Record<string, unknown>
      delete entry.metadataCursorRowSha256

      await expect(
        readAntigravityDbUsageEvents({
          conversationDir: dir,
          scanState,
          readSqlite: async () => {
            throw new Error('SQLite must not be queried with a partial anchor')
          },
          lastSeenRowIndexByCascadeHash: new Map([[hash(cascadeId), 41]]),
          detectRowCursorReset: true
        })
      ).rejects.toThrow(`Antigravity SQLite metadata cursor reset detected for ${join(dir, `${cascadeId}.db`)}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not persist an unpaired cursor index when an unanchored incremental page is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-unpaired-cursor-'))
    try {
      const dir = join(root, 'conversations')
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      const scanState: AntigravityFileScanState = {
        nextSequence: 0,
        files: {
          [hash(cascadeId)]: {
            mtimeMs: 1,
            size: 0,
            hasDatabaseFile: true,
            checkedSequence: 0,
            metadataRowHighWater: 41,
            metadataCursorRowIndex: 40,
            metadataCursorRowSha256: hashBytes(Buffer.alloc(0))
          }
        }
      }
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')

      await readAntigravityDbUsageEvents({
        conversationDir: dir,
        scanState,
        lastSeenRowIndexByCascadeHash: new Map([[hash(cascadeId), 41]]),
        detectRowCursorReset: false,
        readSqlite: async (_dbFile, sql) => (sql.includes('max(idx)') ? '41\n' : '')
      })

      const entry = scanState.files[hash(cascadeId)] as Record<string, unknown>
      expect(entry.metadataRowHighWater).toBe(41)
      expect(entry.metadataCursorRowIndex).toBeUndefined()
      expect(entry.metadataCursorRowSha256).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects a changed cursor anchor before reading a non-empty rebuilt page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-reset-db-anchor-'))
    try {
      const dir = join(root, 'conversations')
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      const dbFile = join(dir, `${cascadeId}.db`)
      const scanState: AntigravityFileScanState = { nextSequence: 0, files: {} }
      const queries: string[] = []
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')

      await readAntigravityDbUsageEvents({
        conversationDir: dir,
        scanState,
        readSqlite: async (_dbFile, sql) => (sql.includes('max(idx)') ? '41\n' : '41|\n')
      })

      await expect(
        readAntigravityDbUsageEvents({
          conversationDir: dir,
          scanState,
          readSqlite: async (_dbFile, sql) => {
            queries.push(sql)
            if (sql.includes('where idx in')) return '41|AA\n'
            if (sql.includes('max(idx)')) return '50\n'
            return '42|\n43|\n'
          },
          lastSeenRowIndexByCascadeHash: new Map([[hash(cascadeId), 41]]),
          detectRowCursorReset: true
        })
      ).rejects.toThrow(`Antigravity SQLite metadata cursor reset detected for ${dbFile}`)

      expect(queries).toEqual(['select idx, hex(data) from gen_metadata where idx in (41) order by idx'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not acknowledge a row when a nested SQLite usage block is semantically invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-invalid-nested-db-'))
    try {
      const dir = join(root, 'conversations')
      const queries: string[] = []
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      const lastSeenRowIndexByCascadeHash = new Map([[hash(cascadeId), 41]])
      const invalidNestedUsageHex =
        '0A472216100A18025A10726573706F6E73652D7072696D6172798A01191217108194EBDC035A0F726573706F6E73652D6E65737465649A011067656D696E692D332D666C6173682D61220B657865637574696F6E2D61'
      const query = 'select idx, hex(data) from gen_metadata where idx > 41 order by idx limit 500'
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')

      const read = () =>
        readAntigravityDbUsageEvents({
          conversationDir: dir,
          readSqlite: async (_dbFile, sql) => {
            queries.push(sql)
            return `42|${invalidNestedUsageHex}\n`
          },
          lastSeenRowIndexByCascadeHash
        })

      await expect(read()).rejects.toThrow('token field 2 is invalid')
      await expect(read()).rejects.toThrow('token field 2 is invalid')

      expect(lastSeenRowIndexByCascadeHash.get(hash(cascadeId))).toBe(41)
      expect(queries).toEqual([query, query])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects a non-integer SQLite metadata row index instead of truncating it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-invalid-row-index-'))
    try {
      const dir = join(root, 'conversations')
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')

      await expect(
        readAntigravityDbUsageEvents({
          conversationDir: dir,
          readSqlite: async () => '7invalid|\n'
        })
      ).rejects.toThrow(`Invalid Antigravity SQLite metadata row in ${join(dir, `${cascadeId}.db`)}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('pages large metadata backlogs and advances the row cursor between sqlite calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-paged-db-'))
    try {
      const dir = join(root, 'conversations')
      const queries: string[] = []
      const cascadeId = '00000000-0000-0000-0000-000000000001'
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascadeId}.db`), '')

      const result = await readAntigravityDbUsageEvents({
        conversationDir: dir,
        readSqlite: async (_dbFile, sql) => {
          queries.push(sql)
          if (sql.includes('idx > 41 ')) {
            return `${Array.from({ length: 500 }, (_, index) => `${index + 42}|`).join('\n')}\n`
          }
          return sql.includes('idx > 541 ') ? '542|\n' : ''
        },
        lastSeenRowIndexByCascadeHash: new Map([[hash(cascadeId), 41]])
      })

      expect(queries).toEqual([
        'select idx, hex(data) from gen_metadata where idx > 41 order by idx limit 500',
        'select idx, hex(data) from gen_metadata where idx > 541 order by idx limit 500'
      ])
      expect(result.events).toHaveLength(0)
      expect(result.lastReadRowIndexByCascade?.get(cascadeId)).toBe(542)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reads only the most recent bounded db files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-recent-db-'))
    try {
      const dir = join(root, 'conversations')
      const calls: string[] = []
      const oldCascadeId = '00000000-0000-0000-0000-000000000001'
      const middleCascadeId = '00000000-0000-0000-0000-000000000002'
      const recentCascadeId = '00000000-0000-0000-0000-000000000003'
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${oldCascadeId}.db`), '')
      await writeFile(join(dir, `${middleCascadeId}.db`), '')
      await writeFile(join(dir, `${recentCascadeId}.db`), '')
      await utimes(
        join(dir, `${oldCascadeId}.db`),
        new Date('2026-04-28T10:00:00.000Z'),
        new Date('2026-04-28T10:00:00.000Z')
      )
      await utimes(
        join(dir, `${middleCascadeId}.db`),
        new Date('2026-04-28T10:01:00.000Z'),
        new Date('2026-04-28T10:01:00.000Z')
      )
      await utimes(
        join(dir, `${recentCascadeId}.db`),
        new Date('2026-04-28T10:02:00.000Z'),
        new Date('2026-04-28T10:02:00.000Z')
      )
      await readAntigravityDbUsageEvents({
        conversationDir: dir,
        readSqlite: recordSqliteCalls(calls),
        maxDbFiles: 2
      })

      expect(calls).toEqual([join(dir, `${recentCascadeId}.db`), join(dir, `${middleCascadeId}.db`)])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rebuilds only an unanchored database within the bounded file budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-unanchored-bounded-'))
    try {
      const dir = join(root, 'conversations')
      const cascade = cascadeId(1)
      const other = cascadeId(2)
      const queries: string[] = []
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascade}.db`), '')
      await writeFile(join(dir, `${other}.db`), '')

      const result = await readAntigravityDbUsageEvents({
        conversationDir: dir,
        maxDbFiles: 1,
        scanState: { nextSequence: 0, files: {} },
        lastSeenRowIndexByCascadeHash: new Map([[hash(cascade), 41]]),
        detectRowCursorReset: true,
        forceFullScanCascadeHashes: new Set([hash(cascade)]),
        readSqlite: async (_dbFile, sql) => {
          queries.push(sql)
          return ''
        }
      })

      expect(result.lastReadRowIndexByCascade?.get(cascade)).toBe(-1)
      expect(queries).toEqual(['select idx, hex(data) from gen_metadata where idx > -1 order by idx limit 500'])
      expect(result.completeDirectoryScan).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not truncate forced database repairs at the metadata scan limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-forced-scan-limit-'))
    try {
      const dir = join(root, 'conversations')
      const ids = Array.from({ length: 20 }, (_, index) => cascadeId(index + 1))
      const statted: string[] = []
      await mkdir(dir, { recursive: true })
      for (const id of ids) await writeFile(join(dir, `${id}.db`), '')

      const result = await readAntigravityDbUsageEvents({
        conversationDir: dir,
        maxDbFiles: 1,
        scanState: { nextSequence: 0, files: {} },
        forceFullScanCascadeHashes: new Set(ids.map(hash)),
        statFile: async (filePath) => {
          statted.push(filePath)
          return { mtimeMs: 1 }
        },
        readSqlite: recordSqliteCalls([])
      })

      expect(statted).toHaveLength(ids.length)
      expect(result.completeDirectoryScan).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('prioritizes unread database backlog before revisiting recent files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-backlog-'))
    try {
      const dir = join(root, 'conversations')
      const calls: string[] = []
      const oldCascadeId = '00000000-0000-0000-0000-000000000001'
      const middleCascadeId = '00000000-0000-0000-0000-000000000002'
      const recentCascadeId = '00000000-0000-0000-0000-000000000003'
      const oldDb = join(dir, `${oldCascadeId}.db`)
      const middleDb = join(dir, `${middleCascadeId}.db`)
      const recentDb = join(dir, `${recentCascadeId}.db`)
      await mkdir(dir, { recursive: true })
      await writeFile(oldDb, '')
      await writeFile(middleDb, '')
      await writeFile(recentDb, '')
      await utimes(oldDb, new Date('2026-04-28T10:00:00.000Z'), new Date('2026-04-28T10:00:00.000Z'))
      await utimes(middleDb, new Date('2026-04-28T10:01:00.000Z'), new Date('2026-04-28T10:01:00.000Z'))
      await utimes(recentDb, new Date('2026-04-28T10:02:00.000Z'), new Date('2026-04-28T10:02:00.000Z'))
      const first = await readAntigravityDbUsageEvents({
        conversationDir: dir,
        readSqlite: recordSqliteCalls(calls),
        maxDbFiles: 2
      })
      expect(calls).toEqual([recentDb, middleDb])
      const acknowledgedRows = new Map(
        [...(first.lastReadRowIndexByCascade ?? [])].map(([cascadeId, rowIndex]) => [hash(cascadeId), rowIndex])
      )
      calls.length = 0

      await readAntigravityDbUsageEvents({
        conversationDir: dir,
        readSqlite: recordSqliteCalls(calls),
        maxDbFiles: 2,
        lastSeenRowIndexByCascadeHash: acknowledgedRows
      })

      expect(calls).toEqual([oldDb, recentDb])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reserves read capacity for processed databases while unread files remain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-read-fairness-'))
    try {
      const dir = join(root, 'conversations')
      const calls: string[] = []
      const unreadOldId = cascadeId(1)
      const unreadNewId = cascadeId(2)
      const processedId = cascadeId(3)
      await mkdir(dir, { recursive: true })
      for (const id of [unreadOldId, unreadNewId, processedId]) {
        await writeFile(join(dir, `${id}.db`), '')
      }
      await readAntigravityDbUsageEvents({
        conversationDir: dir,
        readSqlite: recordSqliteCalls(calls),
        maxDbFiles: 2,
        lastSeenRowIndexByCascadeHash: new Map([[hash(processedId), 0]]),
        statFile: async (filePath) => ({
          mtimeMs: Number(basename(filePath, '.db').slice(-12))
        })
      })

      expect(calls).toEqual([join(dir, `${unreadNewId}.db`), join(dir, `${processedId}.db`)])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('bounds db metadata stats while selecting recent files from a large directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-bounded-stat-'))
    try {
      const dir = join(root, 'conversations')
      const calls: string[] = []
      const scanState: AntigravityFileScanState = { nextSequence: 0, files: {} }
      await mkdir(dir, { recursive: true })
      for (let index = 0; index < 200; index += 1) {
        await writeFile(join(dir, `${cascadeId(index)}.db`), '')
      }
      let statCount = 0

      await readAntigravityDbUsageEvents({
        conversationDir: dir,
        readSqlite: recordSqliteCalls(calls),
        maxDbFiles: 2,
        listFiles: async function* () {
          for (let index = 0; index < 200; index += 1) {
            yield { name: `${cascadeId(index)}.db`, isFile: () => true }
          }
        },
        statFile: async (filePath) => {
          statCount += 1
          return { mtimeMs: Number(basename(filePath, '.db').slice(-12)) }
        },
        scanState
      })

      expect(statCount).toBeLessThanOrEqual(16)
      expect(calls).toEqual([join(dir, `${cascadeId(199)}.db`), join(dir, `${cascadeId(198)}.db`)])
      expect(Object.keys(scanState.files)).toHaveLength(16)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rotates bounded db metadata scans until middle files are selected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-db-rotating-stat-'))
    try {
      const calls: string[] = []
      const scanState: AntigravityFileScanState = { nextSequence: 0, files: {} }

      for (let run = 0; run < 24; run += 1) {
        let statCount = 0
        await readAntigravityDbUsageEvents({
          conversationDir: '/tmp/tokenboard-antigravity-rotating-databases',
          readSqlite: recordSqliteCalls(calls),
          maxDbFiles: 2,
          listFiles: async function* () {
            for (let index = 0; index < 200; index += 1) {
              yield { name: `${cascadeId(index)}.db`, isFile: () => true }
            }
          },
          statFile: async (filePath) => {
            statCount += 1
            const index = Number(basename(filePath, '.db').slice(-12))
            return { mtimeMs: index === 100 ? 10_000 : index }
          },
          scanState
        })
        expect(statCount).toBeLessThanOrEqual(16)
      }

      expect(Object.keys(scanState.files)).toHaveLength(200)
      expect(calls).toContain(join('/tmp/tokenboard-antigravity-rotating-databases', `${cascadeId(100)}.db`))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips db files that disappear before stat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-stat-race-'))
    try {
      const dir = join(root, 'conversations')
      const calls: string[] = []
      const skippedCascadeId = '00000000-0000-0000-0000-000000000004'
      const keptCascadeId = '00000000-0000-0000-0000-000000000005'
      const skippedDb = join(dir, `${skippedCascadeId}.db`)
      const keptDb = join(dir, `${keptCascadeId}.db`)
      await mkdir(dir, { recursive: true })
      await writeFile(skippedDb, '')
      await writeFile(keptDb, '')
      const result = await readAntigravityDbUsageEvents({
        conversationDir: dir,
        readSqlite: recordSqliteCalls(calls),
        statFile: async (filePath) => {
          if (filePath === skippedDb) {
            throw Object.assign(new Error('file disappeared'), { code: 'ENOENT' })
          }
          return { mtimeMs: filePath === keptDb ? 2000 : 1000 }
        }
      })

      expect(calls).toEqual([keptDb])
      expect(result.completeDirectoryScan).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails a required complete scan when an enumerated database disappears before stat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-complete-db-race-'))
    try {
      const dir = join(root, 'conversations')
      const skippedCascadeId = cascadeId(4)
      const keptCascadeId = cascadeId(5)
      const skippedDb = join(dir, `${skippedCascadeId}.db`)
      await mkdir(dir, { recursive: true })
      await writeFile(skippedDb, '')
      await writeFile(join(dir, `${keptCascadeId}.db`), '')

      await expect(
        readAntigravityDbUsageEvents({
          conversationDir: dir,
          maxDbFiles: null,
          requireCompleteDirectoryScan: true,
          statFile: async (filePath) => {
            if (filePath === skippedDb) {
              throw Object.assign(new Error('file disappeared'), { code: 'ENOENT' })
            }
            return { mtimeMs: 2000 }
          }
        })
      ).rejects.toThrow(
        'Antigravity CLI full history scan could not read every enumerated SQLite database; retry after the conversations directory is stable'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reports an injected sqlite reader ENOENT as a metadata read failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-reader-enoent-'))
    try {
      const dir = join(root, 'conversations')
      const dbFile = join(dir, `${cascadeId(6)}.db`)
      await mkdir(dir, { recursive: true })
      await writeFile(dbFile, '')

      await expect(
        readAntigravityDbUsageEvents({
          conversationDir: dir,
          readSqlite: async () => {
            throw Object.assign(new Error('database disappeared'), { code: 'ENOENT' })
          }
        })
      ).rejects.toThrow(`Failed to read Antigravity SQLite metadata from ${dbFile}: database disappeared`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails visibly when db file metadata cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-stat-error-'))
    try {
      const dir = join(root, 'conversations')
      const cascade = cascadeId(6)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${cascade}.db`), '')

      await expect(
        readAntigravityDbUsageEvents({
          conversationDir: dir,
          statFile: async () => {
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
          }
        })
      ).rejects.toThrow('permission denied')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function hashBytes(value: Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function rowsForQuery(sql: string, minimum: number, maximum: number) {
  const match = /idx > (-?\d+)/.exec(sql)
  if (!match) return ''
  const cursor = Number(match[1])
  const start = Math.max(cursor + 1, minimum)
  if (start > maximum) return ''
  const end = Math.min(start + 499, maximum)
  return `${Array.from({ length: end - start + 1 }, (_, offset) => `${start + offset}|`).join('\n')}\n`
}

function cascadeId(index: number) {
  return `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`
}

function recordSqliteCalls(calls: string[]) {
  return async (dbFile: string) => {
    calls.push(dbFile)
    return ''
  }
}
