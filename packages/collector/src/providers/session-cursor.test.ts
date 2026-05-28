import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { clearPendingUploadCursors, collectChangedSessionFiles, warmHookCursorHighWater } from './session-cursor'

const canDenyFileReadWithModeBits = process.platform !== 'win32' && process.getuid?.() !== 0

describe('collectChangedSessionFiles', () => {
  test('returns only new or changed session files after the cursor is written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const first = join(sessionsDir, '2026', '05', '22', 'first.jsonl')
    const second = join(sessionsDir, '2026', '05', '22', 'second.jsonl')

    try {
      await writeSession(first, 'one', '2026-05-22T01:00:00.000Z')
      let result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(result.files.map((file) => file.relativePath)).toEqual(['2026/05/22/first.jsonl'])
      await result.commit()
      expect(JSON.parse(await readFile(cursorPath, 'utf8')).version).toBe(1)

      result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })
      expect(result.files).toEqual([])

      await writeSession(second, 'two', '2026-05-22T02:00:00.000Z')
      await writeSession(first, 'one changed', '2026-05-22T03:00:00.000Z')
      result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(result.files.map((file) => file.relativePath)).toEqual([
        '2026/05/22/first.jsonl',
        '2026/05/22/second.jsonl'
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps cursor unchanged when commit is not called', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T01:00:00.000Z')
      await collectChangedSessionFiles({
        source: 'claude-code',
        sessionsDir,
        cursorPath
      })

      const result = await collectChangedSessionFiles({
        source: 'claude-code',
        sessionsDir,
        cursorPath
      })

      expect(result.files.map((item) => item.relativePath)).toEqual(['2026/05/22/session.jsonl'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails visibly when cursor files have invalid file maps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T01:00:00.000Z')
      await writeFile(cursorPath, JSON.stringify({ version: 1, source: 'codex', files: [] }))
      await expect(collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })).rejects.toThrow('Invalid codex cursor file')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails visibly when cursor files have invalid entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T01:00:00.000Z')
      await writeFile(cursorPath, JSON.stringify({
        version: 1,
        source: 'codex',
        files: { 'missing.jsonl': null }
      }))
      await expect(collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })).rejects.toThrow('Invalid codex cursor file')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails visibly when cursor files have invalid cached snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T01:00:00.000Z')
      await writeFile(cursorPath, JSON.stringify({
        version: 1,
        source: 'codex',
        files: {
          'old.jsonl': {
            size: 1,
            mtimeMs: 1,
            sha256: 'abc',
            snapshots: [null],
            missingCost: false,
            updatedAt: '2026-05-22T01:00:00.000Z'
          }
        }
      }))
      await expect(collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })).rejects.toThrow('Invalid codex cursor file')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails visibly when cursor high-water is invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T01:00:00.000Z')
      await writeFile(cursorPath, JSON.stringify({
        version: 1,
        source: 'codex',
        lastScanHighWaterMs: -1,
        files: {}
      }))
      await expect(collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })).rejects.toThrow('Invalid codex cursor file')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails visibly when cursor path is not readable as a file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T01:00:00.000Z')
      await symlink(sessionsDir, cursorPath)

      await expect(collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails visibly when cursor JSON is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T01:00:00.000Z')
      await writeFile(cursorPath, '{')

      await expect(collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })).rejects.toThrow('Invalid codex cursor JSON')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('exposes changed session content as a line stream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'first\nsecond\n', '2026-05-22T01:00:00.000Z')
      const result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      const lines = []
      for await (const line of result.files[0].readLines()) {
        lines.push(line)
      }

      expect(lines).toEqual(['first', 'second'])
      expect('content' in result.files[0]).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps pending upload files eligible until upload ack clears them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T01:00:00.000Z')
      let result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      result.markPendingUpload()
      await result.commit()

      result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })
      expect(result.files.map((item) => item.relativePath)).toEqual(['2026/05/22/session.jsonl'])

      await clearPendingUploadCursors({ stateDir: root, source: 'codex' })
      result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath: join(root, 'codex-cursor.json')
      })
      expect(result.files).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('drops pending upload entries without snapshots when the session file disappears before retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T01:00:00.000Z')
      const first = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })
      first.markPendingUpload()
      await first.commit()
      await rm(file)

      const retry = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })
      await retry.commit()

      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(retry.files).toEqual([])
      expect(retry.hasPendingUpload).toBe(false)
      expect(retry.hasUnreadablePendingUpload).toBe(false)
      expect(retry.hasCursorCleanup).toBe(true)
      expect(cursor.files['2026/05/22/session.jsonl']).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('drops snapshotless missing pending upload entries when other changed files are readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const pendingFile = join(sessionsDir, '2026', '05', '22', 'pending.jsonl')
    const changedFile = join(sessionsDir, '2026', '05', '22', 'changed.jsonl')

    try {
      await writeSession(pendingFile, 'pending', '2026-05-22T01:00:00.000Z')
      const first = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })
      first.markPendingUpload()
      await first.commit()
      await rm(pendingFile)
      await writeSession(changedFile, 'changed', '2026-05-22T02:00:00.000Z')

      const retry = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(retry.files.map((item) => item.relativePath)).toEqual(['2026/05/22/changed.jsonl'])
      expect(retry.hasPendingUpload).toBe(false)
      expect(retry.hasUnreadablePendingUpload).toBe(false)
      expect(retry.hasCursorCleanup).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reports missing pending upload entries that still have parsed snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const changedFile = join(sessionsDir, '2026', '05', '23', 'changed.jsonl')

    try {
      await mkdir(dirname(cursorPath), { recursive: true })
      await writeFile(cursorPath, `${JSON.stringify({
        version: 1,
        source: 'codex',
        files: {
          '2026/05/22/missing.jsonl': {
            size: 123,
            mtimeMs: Date.parse('2026-05-22T01:00:00.000Z'),
            sha256: 'missing',
            snapshots: [
              {
                source: 'codex',
                usageDate: '2026-05-22',
                timezone: 'Asia/Shanghai',
                model: 'gpt-5',
                inputTokens: 10,
                outputTokens: 5,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                totalTokens: 15,
                costUsd: 0.03,
                sessionCount: 1
              }
            ],
            missingCost: false,
            pendingUpload: true,
            updatedAt: '2026-05-22T01:00:00.000Z'
          }
        },
        lastScanHighWaterMs: Date.parse('2026-05-22T01:00:00.000Z')
      }, null, 2)}\n`)
      await writeSession(changedFile, 'changed', '2026-05-23T02:00:00.000Z')

      const retry = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(retry.files.map((item) => item.relativePath)).toEqual(['2026/05/23/changed.jsonl'])
      expect(retry.hasPendingUpload).toBe(true)
      expect(retry.hasUnreadablePendingUpload).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(!canDenyFileReadWithModeBits)('reports unreadable new changed files instead of silently advancing the scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const unreadableFile = join(sessionsDir, '2026', '05', '22', 'unreadable.jsonl')

    try {
      await writeSession(unreadableFile, 'unreadable', '2026-05-22T01:00:00.000Z')
      await chmod(unreadableFile, 0o000)

      const result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(result.files).toEqual([])
      expect(result.hasUnreadableChangedFile).toBe(true)
      await expect(readFile(cursorPath, 'utf8')).rejects.toThrow()
    } finally {
      await chmod(unreadableFile, 0o600).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips old unchanged files after high-water scan advances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const first = join(sessionsDir, '2026', '05', '22', 'first.jsonl')
    const second = join(sessionsDir, '2026', '05', '22', 'second.jsonl')

    try {
      await writeSession(first, 'one', '2026-05-22T01:00:00.000Z')
      const initial = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath,
        scanSafetyMs: 0
      })
      await initial.commit()

      await writeSession(second, 'two', '2026-05-22T02:00:00.000Z')
      const result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath,
        scanSafetyMs: 0
      })

      expect(result.files.map((file) => file.relativePath)).toEqual(['2026/05/22/second.jsonl'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('warms high-water from collection start time instead of current file mtimes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'one', '2026-05-22T02:00:00.000Z')
      await warmHookCursorHighWater({
        stateDir: root,
        source: 'codex',
        sessionsDir,
        highWaterMs: Date.parse('2026-05-22T01:00:00.000Z')
      })

      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(cursor.lastScanHighWaterMs).toBe(Date.parse('2026-05-22T01:00:00.000Z'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeSession(file: string, content: string, timestamp: string) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
  const date = new Date(timestamp)
  await utimes(file, date, date)
}
