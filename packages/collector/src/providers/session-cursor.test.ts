import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  clearPendingUploadCursors,
  collectChangedSessionFiles,
  cursorSnapshotGroupKey,
  selectPendingCursorSnapshotGroups,
  updateCursorFile,
  warmHookCursorHighWater
} from './session-cursor'
import type { SessionJsonlLine } from './session-jsonl-line-reader'

const canDenyFileReadWithModeBits = process.platform !== 'win32' && process.getuid?.() !== 0

describe('collectChangedSessionFiles', () => {
  test.skipIf(process.platform === 'win32')('preserves literal backslashes in POSIX cursor identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const literalName = join(sessionsDir, 'literal\\name.jsonl')
    const nestedName = join(sessionsDir, 'literal', 'name.jsonl')

    try {
      await writeSession(literalName, 'literal', '2026-05-22T01:00:00.000Z')
      await writeSession(nestedName, 'nested', '2026-05-22T02:00:00.000Z')
      const result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(result.files.map((file) => file.relativePath).sort()).toEqual(
        ['literal/name.jsonl', 'literal\\name.jsonl'].sort()
      )
      expect(Object.keys(result.cursor.files)).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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
      await consumeFiles(result.files)
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
      await expect(
        collectChangedSessionFiles({
          source: 'codex',
          sessionsDir,
          cursorPath
        })
      ).rejects.toThrow('Invalid codex cursor file')
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
      await writeFile(
        cursorPath,
        JSON.stringify({
          version: 1,
          source: 'codex',
          files: { 'missing.jsonl': null }
        })
      )
      await expect(
        collectChangedSessionFiles({
          source: 'codex',
          sessionsDir,
          cursorPath
        })
      ).rejects.toThrow('Invalid codex cursor file')
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
      await writeFile(
        cursorPath,
        JSON.stringify({
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
        })
      )
      await expect(
        collectChangedSessionFiles({
          source: 'codex',
          sessionsDir,
          cursorPath
        })
      ).rejects.toThrow('Invalid codex cursor file')
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
      await writeFile(
        cursorPath,
        JSON.stringify({
          version: 1,
          source: 'codex',
          lastScanHighWaterMs: -1,
          files: {}
        })
      )
      await expect(
        collectChangedSessionFiles({
          source: 'codex',
          sessionsDir,
          cursorPath
        })
      ).rejects.toThrow('Invalid codex cursor file')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails visibly when the cursor scan offset is not a non-negative safe integer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')

    try {
      await mkdir(sessionsDir, { recursive: true })
      await writeFile(
        cursorPath,
        JSON.stringify({
          version: 1,
          source: 'codex',
          lastScanOffsetBytes: 0.5,
          files: {}
        })
      )
      await expect(
        collectChangedSessionFiles({
          source: 'codex',
          sessionsDir,
          cursorPath
        })
      ).rejects.toThrow('Invalid codex cursor file')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails visibly when Antigravity file scan state is invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    try {
      await writeFile(
        cursorPath,
        JSON.stringify({
          version: 1,
          source: 'codex',
          antigravityDbFileScan: {
            nextSequence: 1,
            files: {
              'raw-conversation-id': {
                mtimeMs: 1,
                size: 1,
                hasDatabaseFile: false,
                checkedSequence: 0
              }
            }
          },
          files: {}
        })
      )
      await expect(
        collectChangedSessionFiles({
          source: 'codex',
          sessionsDir,
          cursorPath
        })
      ).rejects.toThrow('Invalid codex cursor file')
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
      await symlink(sessionsDir, cursorPath, process.platform === 'win32' ? 'junction' : 'dir')

      await expect(
        collectChangedSessionFiles({
          source: 'codex',
          sessionsDir,
          cursorPath
        })
      ).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')(
    'rejects symbolic link session files instead of following their targets',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
      const sessionsDir = join(root, 'sessions')
      const cursorPath = join(root, 'codex-cursor.json')
      const outside = join(root, 'outside.jsonl')
      const linkedSession = join(sessionsDir, '2026', '05', '22', 'linked.jsonl')

      try {
        await writeSession(outside, 'outside', '2026-05-22T01:00:00.000Z')
        await mkdir(dirname(linkedSession), { recursive: true })
        await symlink(outside, linkedSession)

        await expect(
          collectChangedSessionFiles({
            source: 'codex',
            sessionsDir,
            cursorPath
          })
        ).rejects.toThrow(/symbolic links are not supported/i)
        await expect(readFile(cursorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  test('rejects a caller-supplied symbolic link or junction session root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const firstSessionsDir = join(root, 'first-sessions')
    const secondSessionsDir = join(root, 'second-sessions')
    const linkedSessionsDir = join(root, 'linked-sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const relativeSessionPath = join('2026', '05', '22', 'session.jsonl')
    const firstSession = join(firstSessionsDir, relativeSessionPath)
    const secondSession = join(secondSessionsDir, relativeSessionPath)

    try {
      await writeSession(firstSession, 'first', '2026-05-22T01:00:00.000Z')
      await writeSession(secondSession, 'second', '2026-05-22T02:00:00.000Z')
      await symlink(firstSessionsDir, linkedSessionsDir, process.platform === 'win32' ? 'junction' : 'dir')

      await expect(
        collectChangedSessionFiles({
          source: 'codex',
          sessionsDir: linkedSessionsDir,
          cursorPath
        })
      ).rejects.toThrow(/symbolic links are not supported/i)
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

      await expect(
        collectChangedSessionFiles({
          source: 'codex',
          sessionsDir,
          cursorPath
        })
      ).rejects.toThrow('Invalid codex cursor JSON')
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

      const lines: string[] = []
      for await (const line of result.files[0].readLines()) {
        if (typeof line !== 'string') throw new Error('Expected a regular session JSONL line')
        lines.push(line)
      }

      expect(lines).toEqual(['first', 'second'])
      expect('content' in result.files[0]).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reads only the appended JSONL suffix and falls back to a full read after truncation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')
    const firstContent = 'first\n'

    try {
      await writeSession(file, firstContent, '2026-05-22T01:00:00.000Z')
      let result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })
      await consumeFiles(result.files)
      await result.commit()

      const legacyCursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      delete legacyCursor.files['2026/05/22/session.jsonl'].endsWithNewline
      await writeFile(cursorPath, `${JSON.stringify(legacyCursor)}\n`)
      result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })
      expect(result.files).toEqual([])
      await result.commit()
      const upgradedCursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(upgradedCursor.files['2026/05/22/session.jsonl'].endsWithNewline).toBe(true)

      await writeFile(file, 'second\n', { flag: 'a' })
      result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(result.files).toHaveLength(1)
      expect(result.files[0].appendOnly).toBe(true)
      expect(result.files[0].readOffsetBytes).toBe(Buffer.byteLength(firstContent))
      await expect(readLines(result.files[0])).resolves.toEqual(['second'])
      updateCursorFile(result.cursor, result.files[0], { snapshots: [], missingCost: false })
      await result.commit()

      await writeFile(file, 'replacement-longer-than-before\n')
      result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(result.files).toHaveLength(1)
      expect(result.files[0].appendOnly).toBe(false)
      expect(result.files[0].readOffsetBytes).toBe(0)
      await expect(readLines(result.files[0])).resolves.toEqual(['replacement-longer-than-before'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retains real pending snapshots when a rewritten file contains only safe synthetic rows', () => {
    const pendingSnapshot = {
      source: 'claude-code' as const,
      usageDate: '2026-05-22',
      timezone: 'UTC',
      model: 'claude-sonnet-4-5',
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 15,
      costUsd: 0.03,
      sessionCount: 1
    }
    const cursor = {
      version: 1 as const,
      source: 'claude-code' as const,
      files: {
        'session.jsonl': {
          size: 100,
          mtimeMs: 1,
          sha256: 'old',
          endsWithNewline: true,
          snapshots: [pendingSnapshot],
          missingCost: false,
          pendingUpload: true,
          updatedAt: '2026-05-22T10:00:00.000Z'
        }
      }
    }

    updateCursorFile(
      cursor,
      {
        relativePath: 'session.jsonl',
        size: 20,
        mtimeMs: 2,
        sha256: 'new',
        endsWithNewline: true,
        appendOnly: false
      },
      {
        snapshots: [],
        missingCost: false,
        ignoredUploadSafeRows: 1
      },
      '2026-05-23T10:00:00.000Z'
    )

    expect(cursor.files['session.jsonl'].snapshots).toEqual([pendingSnapshot])
    expect(cursor.files['session.jsonl'].pendingUpload).toBe(true)
  })

  test('bounds an append-only read to the file size captured during scanning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'first\n', '2026-05-22T01:00:00.000Z')
      let result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })
      await consumeFiles(result.files)
      await result.commit()

      await writeFile(file, 'second\n', { flag: 'a' })
      result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(result.files).toHaveLength(1)
      expect(result.files[0].appendOnly).toBe(true)
      await writeFile(file, 'third\n', { flag: 'a' })
      await expect(readLines(result.files[0])).resolves.toEqual(['second'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('falls back to a full read when an older prefix changes before a matching tail is appended', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')
    const filler = 'x'.repeat(70 * 1024)
    const original = `first-${filler}\n`

    try {
      await writeSession(file, original, '2026-05-22T01:00:00.000Z')
      let result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })
      await consumeFiles(result.files)
      await result.commit()

      await writeFile(file, `other-${filler}\nsecond\n`)
      result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(result.files).toHaveLength(1)
      expect(result.files[0].appendOnly).toBe(false)
      expect(result.files[0].readOffsetBytes).toBe(0)
      await expect(readLines(result.files[0])).resolves.toEqual([`other-${filler}`, 'second'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('bounds a full read to the file size captured during scanning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, 'first\n', '2026-05-22T01:00:00.000Z')
      const result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(result.files).toHaveLength(1)
      expect(result.files[0].appendOnly).toBe(false)
      await writeFile(file, 'second\n', { flag: 'a' })
      await expect(readLines(result.files[0])).resolves.toEqual(['first'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not read bytes appended after an empty file scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')

    try {
      await writeSession(file, '', '2026-05-22T01:00:00.000Z')
      const result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(result.files).toHaveLength(1)
      await writeFile(file, 'later\n', { flag: 'a' })
      await expect(readLines(result.files[0])).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('falls back to a full JSONL read when the prior file has no trailing newline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')
    const first = JSON.stringify({ type: 'event', text: 'first' })
    const second = JSON.stringify({ type: 'event', text: 'second' })

    try {
      await writeSession(file, first, '2026-05-22T01:00:00.000Z')
      let result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })
      await consumeFiles(result.files)
      await result.commit()

      const initialCursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(initialCursor.files['2026/05/22/session.jsonl'].endsWithNewline).toBe(false)

      await writeFile(file, `\n${second}\n`, { flag: 'a' })
      result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(result.files).toHaveLength(1)
      expect(result.files[0].appendOnly).toBe(false)
      expect(result.files[0].readOffsetBytes).toBe(0)
      await expect(readLines(result.files[0])).resolves.toEqual([first, second])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses the append-only JSONL read when the prior file ends with a CR separator', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')
    const first = JSON.stringify({ type: 'event', text: 'first' })
    const second = JSON.stringify({ type: 'event', text: 'second' })

    try {
      await writeSession(file, `${first}\r`, '2026-05-22T01:00:00.000Z')
      let result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })
      await consumeFiles(result.files)
      await result.commit()

      expect(JSON.parse(await readFile(cursorPath, 'utf8')).files['2026/05/22/session.jsonl'].endsWithNewline).toBe(
        true
      )

      await writeFile(file, `${second}\r`, { flag: 'a' })
      result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(result.files).toHaveLength(1)
      expect(result.files[0].appendOnly).toBe(true)
      expect(result.files[0].readOffsetBytes).toBe(Buffer.byteLength(`${first}\r`))
      await expect(readLines(result.files[0])).resolves.toEqual([second])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not emit an empty record when an appended suffix completes a prior CRLF separator', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')
    const first = JSON.stringify({ type: 'event', text: 'first' })
    const second = JSON.stringify({ type: 'event', text: 'second' })

    try {
      await writeSession(file, `${first}\r`, '2026-05-22T01:00:00.000Z')
      let result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })
      await consumeFiles(result.files)
      await result.commit()

      await writeFile(file, `\n${second}\r\n`, { flag: 'a' })
      result = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(result.files).toHaveLength(1)
      expect(result.files[0].appendOnly).toBe(true)
      await expect(readLines(result.files[0])).resolves.toEqual([second])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps Unicode line-separator characters inside a JSONL record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const file = join(sessionsDir, '2026', '05', '22', 'session.jsonl')
    const first = JSON.stringify({ type: 'event', text: 'before\u2028middle\u2029after' })
    const second = JSON.stringify({ type: 'event', text: 'next' })

    try {
      await writeSession(file, `${first}\r\n${second}\n`, '2026-05-22T01:00:00.000Z')
      const result = await collectChangedSessionFiles({
        source: 'claude-code',
        sessionsDir,
        cursorPath
      })

      const lines: string[] = []
      for await (const line of result.files[0].readLines()) {
        if (typeof line !== 'string') throw new Error('Expected a regular session JSONL line')
        lines.push(line)
      }

      expect(lines).toEqual([first, second])
      expect(lines.map((line) => JSON.parse(line).text)).toEqual(['before\u2028middle\u2029after', 'next'])
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

      await consumeFiles(result.files)
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

  test('acknowledges Codex pending files by path and hash instead of a shared snapshot group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-file-ack-'))
    const cursorPath = join(root, 'codex-cursor.json')
    const snapshot = {
      source: 'codex',
      usageDate: '2026-06-24',
      timezone: 'UTC',
      model: 'gpt-5.6-luna',
      inputTokens: 10,
      outputTokens: 2,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 12,
      costUsd: 0.01,
      sessionCount: 1
    }

    try {
      await writeFile(
        cursorPath,
        `${JSON.stringify(
          {
            version: 1,
            source: 'codex',
            files: {
              'missing.jsonl': {
                size: 10,
                mtimeMs: Date.parse('2026-06-24T10:00:00.000Z'),
                sha256: 'a'.repeat(64),
                snapshots: [snapshot],
                missingCost: false,
                pendingUpload: true,
                updatedAt: new Date().toISOString()
              },
              'current.jsonl': {
                size: 20,
                mtimeMs: Date.parse('2026-06-24T11:00:00.000Z'),
                sha256: 'b'.repeat(64),
                snapshots: [snapshot],
                missingCost: false,
                pendingUpload: true,
                updatedAt: new Date().toISOString()
              }
            }
          },
          null,
          2
        )}\n`
      )

      await clearPendingUploadCursors({
        stateDir: root,
        source: 'codex',
        acknowledgedSnapshotFiles: [{ relativePath: 'current.jsonl', sha256: 'b'.repeat(64) }]
      })

      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(cursor.files['missing.jsonl'].pendingUpload).toBe(true)
      expect(cursor.files['current.jsonl'].pendingUpload).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps pending Antigravity snapshots outside a bounded acknowledgement range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-bounded-ack-'))
    const cursorPath = join(root, 'antigravity-cursor.json')
    const snapshot = (usageDate: string) => ({
      source: 'antigravity' as const,
      usageDate,
      timezone: 'UTC',
      model: 'gemini',
      inputTokens: 10,
      outputTokens: 2,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 12,
      costUsd: 0,
      sessionCount: 1
    })
    const entry = (usageDate: string) => ({
      size: 0,
      mtimeMs: Date.parse(`${usageDate}T10:00:00.000Z`),
      sha256: 'a'.repeat(64),
      snapshots: [snapshot(usageDate)],
      missingCost: true,
      pendingUpload: true,
      updatedAt: new Date().toISOString()
    })
    const oldSessionKey = ['session', 'antigravity', '2026-06-23', 'gemini', 'old-session'].join('\0')

    try {
      await writeFile(
        cursorPath,
        `${JSON.stringify(
          {
            version: 1,
            source: 'antigravity',
            files: {
              'event\0old': entry('2026-06-23'),
              'event\0current': entry('2026-06-24'),
              [oldSessionKey]: {
                size: 0,
                mtimeMs: Date.parse('2026-06-23T10:00:00.000Z'),
                sha256: 'b'.repeat(64),
                snapshots: [],
                missingCost: true,
                pendingUpload: true,
                updatedAt: new Date().toISOString()
              }
            }
          },
          null,
          2
        )}\n`
      )

      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity',
        since: '20260624',
        timezone: 'UTC'
      })

      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(cursor.files['event\0old'].pendingUpload).toBe(true)
      expect(cursor.files['event\0current'].pendingUpload).toBe(false)

      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity',
        since: '20260624',
        timezone: 'UTC',
        acknowledgedSnapshotGroups: [cursorSnapshotGroupKey(snapshot('2026-06-23'))]
      })

      const retried = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(retried.files['event\0old'].pendingUpload).toBe(false)
      expect(retried.files[oldSessionKey].pendingUpload).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('requires an explicit timezone for Antigravity cursor acknowledgement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-ack-timezone-'))

    try {
      await expect(
        clearPendingUploadCursors({
          stateDir: root,
          source: 'antigravity'
        })
      ).rejects.toThrow('Antigravity cursor acknowledgement requires an explicit timezone')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps a mixed pending cursor entry until every snapshot group is acknowledged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-mixed-ack-'))
    const cursorPath = join(root, 'antigravity-cursor.json')
    const snapshot = (usageDate: string, model: string) => ({
      source: 'antigravity' as const,
      usageDate,
      timezone: 'UTC',
      model,
      inputTokens: 10,
      outputTokens: 2,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 12,
      costUsd: 0,
      sessionCount: 1
    })
    const oldSnapshot = snapshot('2026-06-23', 'gemini-old')
    const currentSnapshot = snapshot('2026-06-24', 'gemini-current')

    try {
      await writeFile(
        cursorPath,
        `${JSON.stringify(
          {
            version: 1,
            source: 'antigravity',
            files: {
              'event\0mixed': {
                size: 0,
                mtimeMs: Date.parse('2026-06-24T10:00:00.000Z'),
                sha256: 'a'.repeat(64),
                snapshots: [oldSnapshot, currentSnapshot],
                missingCost: true,
                pendingUpload: true,
                updatedAt: new Date().toISOString()
              }
            }
          },
          null,
          2
        )}\n`
      )

      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity',
        since: '20260624',
        timezone: 'UTC',
        acknowledgedSnapshotGroups: [cursorSnapshotGroupKey(currentSnapshot)]
      })

      const partiallyAcknowledged = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(partiallyAcknowledged.files['event\0mixed'].pendingUpload).toBe(true)

      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity',
        since: '20260624',
        timezone: 'UTC',
        acknowledgedSnapshotGroups: [cursorSnapshotGroupKey(oldSnapshot), cursorSnapshotGroupKey(currentSnapshot)]
      })

      const fullyAcknowledged = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(fullyAcknowledged.files['event\0mixed'].pendingUpload).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps a current Antigravity session marker until its daily model group is acknowledged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-session-marker-'))
    const cursorPath = join(root, 'antigravity-cursor.json')
    const usageDate = '2026-06-24'
    const model = 'gemini-current'
    const sessionKey = ['session', 'antigravity', usageDate, model, 'cascade-hash'].join('\0')
    const snapshotGroup = ['antigravity', usageDate, 'UTC', model].join('\0')

    try {
      await writeFile(
        cursorPath,
        `${JSON.stringify(
          {
            version: 1,
            source: 'antigravity',
            files: {
              [sessionKey]: {
                size: 0,
                mtimeMs: Date.parse(`${usageDate}T10:00:00.000Z`),
                sha256: 'a'.repeat(64),
                snapshots: [],
                missingCost: true,
                pendingUpload: true,
                updatedAt: new Date().toISOString()
              }
            }
          },
          null,
          2
        )}\n`
      )

      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity',
        since: '20260624',
        timezone: 'UTC',
        acknowledgedSnapshotGroups: []
      })

      let cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(cursor.files[sessionKey].pendingUpload).toBe(true)

      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity',
        since: '20260624',
        timezone: 'UTC',
        acknowledgedSnapshotGroups: [snapshotGroup]
      })

      cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(cursor.files[sessionKey].pendingUpload).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('bounds stale pending snapshot groups selected for retry', () => {
    const snapshot = (usageDate: string, model: string) => ({
      source: 'antigravity-cli' as const,
      usageDate,
      timezone: 'UTC',
      model,
      inputTokens: 1,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 1,
      costUsd: 0,
      sessionCount: 1
    })
    const entry = (value: ReturnType<typeof snapshot>) => ({
      size: 0,
      mtimeMs: Date.parse(`${value.usageDate}T10:00:00.000Z`),
      sha256: 'a'.repeat(64),
      snapshots: [value],
      missingCost: true,
      pendingUpload: true,
      updatedAt: '2026-07-17T00:00:00.000Z'
    })
    const oldFirst = snapshot('2026-06-21', 'gemini-a')
    const oldSecond = snapshot('2026-06-22', 'gemini-b')
    const current = snapshot('2026-06-24', 'gemini-c')

    const selected = selectPendingCursorSnapshotGroups({
      cursor: {
        version: 1,
        source: 'antigravity-cli',
        files: {
          first: entry(oldFirst),
          second: entry(oldSecond),
          current: entry(current)
        }
      },
      sinceDate: '2026-06-24',
      limit: 1
    })

    expect([...selected]).toEqual([cursorSnapshotGroupKey(oldFirst)])
  })

  test('rotates bounded pending snapshot retries so a failed group cannot starve later groups', () => {
    const snapshot = (index: number) => ({
      source: 'antigravity-cli' as const,
      usageDate: `2026-06-${String(index + 1).padStart(2, '0')}`,
      timezone: 'UTC',
      model: `gemini-${index}`,
      inputTokens: 1,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 1,
      costUsd: 0,
      sessionCount: 1
    })
    const cursor = {
      version: 1 as const,
      source: 'antigravity-cli' as const,
      files: Object.fromEntries(
        Array.from({ length: 4 }, (_, index) => {
          const value = snapshot(index)
          return [
            `file-${index}`,
            {
              size: 0,
              mtimeMs: index,
              sha256: 'a'.repeat(64),
              snapshots: [value],
              missingCost: true,
              pendingUpload: true,
              updatedAt: '2026-07-17T00:00:00.000Z'
            }
          ]
        })
      )
    }

    const first = selectPendingCursorSnapshotGroups({ cursor, sinceDate: '2026-07-01', limit: 2 })
    const second = selectPendingCursorSnapshotGroups({ cursor, sinceDate: '2026-07-01', limit: 2 })

    expect([...first]).not.toEqual([...second])
    expect(new Set([...first, ...second]).size).toBe(4)
  })

  test('acks snapshotless Antigravity entries with unknown mtime in a bounded range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-zero-mtime-'))
    const cursorPath = join(root, 'antigravity-cursor.json')
    try {
      await writeFile(
        cursorPath,
        `${JSON.stringify(
          {
            version: 1,
            source: 'antigravity',
            files: {
              'event\0unknown-time': {
                size: 0,
                mtimeMs: 0,
                sha256: 'a'.repeat(64),
                snapshots: [],
                missingCost: true,
                pendingUpload: true,
                updatedAt: new Date().toISOString()
              }
            }
          },
          null,
          2
        )}\n`
      )

      await clearPendingUploadCursors({
        stateDir: root,
        source: 'antigravity',
        since: '20260624',
        timezone: 'UTC'
      })

      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(cursor.files['event\0unknown-time'].pendingUpload).toBe(false)
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
      await consumeFiles(first.files)
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
      await consumeFiles(first.files)
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

  test('returns missing pending upload snapshots for cached recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const changedFile = join(sessionsDir, '2026', '05', '23', 'changed.jsonl')

    try {
      await mkdir(dirname(cursorPath), { recursive: true })
      await writeFile(
        cursorPath,
        `${JSON.stringify(
          {
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
          },
          null,
          2
        )}\n`
      )
      await writeSession(changedFile, 'changed', '2026-05-23T02:00:00.000Z')

      const retry = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      expect(retry.files.map((item) => item.relativePath)).toEqual(['2026/05/23/changed.jsonl'])
      expect(retry.hasPendingUpload).toBe(true)
      expect(retry.hasUnreadablePendingUpload).toBe(false)
      expect(retry.missingPendingSnapshots).toEqual([
        {
          relativePath: '2026/05/22/missing.jsonl',
          snapshots: [
            expect.objectContaining({
              usageDate: '2026-05-22',
              model: 'gpt-5',
              totalTokens: 15
            })
          ]
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(!canDenyFileReadWithModeBits)(
    'reports unreadable new changed files instead of silently advancing the scan',
    async () => {
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
    }
  )

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
      await consumeFiles(initial.files)
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

async function readLines(file: { readLines: () => AsyncIterable<SessionJsonlLine> }) {
  const lines: string[] = []
  for await (const line of file.readLines()) {
    if (typeof line !== 'string') throw new Error('Expected a regular session JSONL line')
    lines.push(line)
  }
  return lines
}

async function consumeFiles(files: Array<{ readLines: () => AsyncIterable<SessionJsonlLine> }>) {
  for (const file of files) {
    for await (const _line of file.readLines()) {
    }
  }
}
