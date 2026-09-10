import { mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { collectChangedSessionFiles } from './session-cursor'

describe('session cursor file identity', () => {
  test('rejects a same-size replacement between scanning and reading before a cursor can acknowledge it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-race-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const sessionFile = join(sessionsDir, '2026', '07', '25', 'session.jsonl')
    const replacementFile = join(root, 'replacement.jsonl')
    const original = '{"type":"event_msg","payload":"first"}\n'
    const replacement = '{"type":"event_msg","payload":"other"}\n'
    const timestamp = new Date('2026-07-25T01:00:00.000Z')

    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original))

    try {
      await mkdir(dirname(sessionFile), { recursive: true })
      await writeFile(sessionFile, original)
      await utimes(sessionFile, timestamp, timestamp)
      const changed = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      await writeFile(replacementFile, replacement)
      await utimes(replacementFile, timestamp, timestamp)
      await rename(replacementFile, sessionFile)

      await expect(readAllLines(changed.files[0])).rejects.toThrow('Session file changed before reading')
      expect(() => changed.commit()).toThrow('session cursor cannot commit after a changed file read failure')
      await expect(readFile(cursorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects an in-place same-size rewrite between scanning and reading before a cursor can acknowledge it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-race-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const sessionFile = join(sessionsDir, '2026', '07', '25', 'session.jsonl')
    const original = '{"type":"event_msg","payload":"first"}\n'
    const replacement = '{"type":"event_msg","payload":"other"}\n'

    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original))

    try {
      await mkdir(dirname(sessionFile), { recursive: true })
      await writeFile(sessionFile, original)
      const changed = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })

      await writeFile(sessionFile, replacement)

      await expect(readAllLines(changed.files[0])).rejects.toThrow('Session file changed while reading')
      expect(() => changed.commit()).toThrow('session cursor cannot commit after a changed file read failure')
      await expect(readFile(cursorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')(
    'rejects a symbolic-link replacement between scanning and reading',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-race-'))
      const sessionsDir = join(root, 'sessions')
      const cursorPath = join(root, 'codex-cursor.json')
      const sessionFile = join(sessionsDir, '2026', '07', '25', 'session.jsonl')
      const outsideFile = join(root, 'outside.jsonl')
      const timestamp = new Date('2026-07-25T01:00:00.000Z')

      try {
        await mkdir(dirname(sessionFile), { recursive: true })
        await writeFile(sessionFile, '{"type":"event_msg"}\n')
        await utimes(sessionFile, timestamp, timestamp)
        const changed = await collectChangedSessionFiles({
          source: 'codex',
          sessionsDir,
          cursorPath
        })

        await writeFile(outsideFile, '{"type":"event_msg"}\n')
        await rm(sessionFile)
        await symlink(outsideFile, sessionFile)

        await expect(readAllLines(changed.files[0])).rejects.toThrow('Session file changed before reading')
        expect(() => changed.commit()).toThrow('session cursor cannot commit after a changed file read failure')
        await expect(readFile(cursorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  test('does not allow a cursor commit after a consumer stops before the verified read completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-race-'))
    const sessionsDir = join(root, 'sessions')
    const cursorPath = join(root, 'codex-cursor.json')
    const sessionFile = join(sessionsDir, '2026', '07', '25', 'session.jsonl')

    try {
      await mkdir(dirname(sessionFile), { recursive: true })
      await writeFile(sessionFile, '{"type":"event_msg"}\n{"type":"event_msg"}\n')
      const changed = await collectChangedSessionFiles({
        source: 'codex',
        sessionsDir,
        cursorPath
      })
      const iterator = changed.files[0]?.readLines()[Symbol.asyncIterator]()
      if (!iterator) throw new Error('Expected a changed session file iterator')

      await expect(iterator.next()).resolves.toMatchObject({ done: false })
      await iterator.return?.()

      expect(() => changed.commit()).toThrow('session cursor cannot commit after a changed file read failure')
      await expect(readFile(cursorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function readAllLines(file: { readLines: () => AsyncIterable<unknown> } | undefined) {
  if (!file) throw new Error('Expected one changed session file')
  const lines: unknown[] = []
  for await (const line of file.readLines()) lines.push(line)
  return lines
}
