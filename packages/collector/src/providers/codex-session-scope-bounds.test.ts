import { appendFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createCodexSessionScope, createCodexSessionScopeBatches, writeFileHandleFully } from './codex-session-scope'

describe('Codex session scope bounds', () => {
  test('completes partial file-handle writes without truncating projected JSONL', async () => {
    const chunks: Buffer[] = []
    const handle = {
      async write(data: Uint8Array) {
        const bytesWritten = Math.min(2, data.byteLength)
        chunks.push(Buffer.from(data.subarray(0, bytesWritten)))
        return { bytesWritten, buffer: data }
      }
    } as unknown as FileHandle

    await writeFileHandleFully(handle, Buffer.from('{"type":"token_count"}\n', 'utf8'))

    expect(Buffer.concat(chunks).toString('utf8')).toBe('{"type":"token_count"}\n')
  })

  test('fails closed when a file handle reports a zero-byte write', async () => {
    const handle = {
      async write(data: Uint8Array) {
        return { bytesWritten: 0, buffer: data }
      }
    } as unknown as FileHandle

    await expect(writeFileHandleFully(handle, Buffer.from('data'))).rejects.toThrow(/made no valid progress/i)
  })

  test('allows a session file exactly at the configured scope limit', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    try {
      await writeSizedFile(join(codexHome, 'sessions', '2026', '07', 'limit.jsonl'), 128)

      const scope = await createCodexSessionScope({
        codexHome,
        since: 'all',
        maxFileBytes: 128,
        maxBatchBytes: 128,
        maxGroupBytes: 128
      })
      expect(scope).not.toBeNull()
      await scope?.cleanup()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')(
    'rejects symbolic link session files before creating a scoped home',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
      const codexHome = join(root, 'codex')
      const outside = join(root, 'outside.jsonl')
      const linkedSession = join(codexHome, 'archived_sessions', '2026', '07', 'linked.jsonl')
      try {
        await writeSizedFile(outside, 128)
        await mkdir(dirname(linkedSession), { recursive: true })
        await symlink(outside, linkedSession)

        await expect(createCodexSessionScope({ codexHome, since: 'all' })).rejects.toThrow(/symbolic link/i)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  test.skipIf(process.platform === 'win32')('allows a configured symbolic link session root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const codexHome = join(root, 'codex')
    const target = join(root, 'archive-target')
    const linkedRoot = join(codexHome, 'archived_sessions')
    try {
      await writeSizedFile(join(target, '2026', '07', 'linked.jsonl'), 128)
      await mkdir(codexHome, { recursive: true })
      await symlink(target, linkedRoot)

      const scope = await createCodexSessionScope({
        codexHome,
        since: 'all',
        codexSymlinkRoots: [target]
      })
      expect(scope).not.toBeNull()
      await scope?.cleanup()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')(
    'accepts an explicitly selected file through the resolved symlink target',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
      const codexHome = join(root, 'codex')
      const target = join(root, 'archive-target')
      const linkedRoot = join(codexHome, 'archived_sessions')
      const targetFile = join(target, '2026', '07', 'linked.jsonl')
      try {
        await writeSizedFile(targetFile, 128)
        await mkdir(codexHome, { recursive: true })
        await symlink(target, linkedRoot)

        const scope = await createCodexSessionScope({
          codexHome,
          files: [await realpath(targetFile)],
          codexSymlinkRoots: [target]
        })
        expect(scope).not.toBeNull()
        await scope?.cleanup()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  test('rejects symbolic link or junction session roots before scanning them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const codexHome = join(root, 'codex')
    const linkedRoot = join(codexHome, 'sessions')
    const outsideRoot = join(root, 'outside-sessions')
    try {
      await writeSizedFile(join(outsideRoot, '2026', '07', 'outside.jsonl'), 128)
      await mkdir(codexHome, { recursive: true })
      await symlink(outsideRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')

      await expect(createCodexSessionScope({ codexHome, since: 'all' })).rejects.toThrow(
        /session directory.*symbolic link/i
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('splits full-history scope batches before their copied bytes exceed the configured limit', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    try {
      for (const name of ['first', 'second', 'third']) {
        await writeSizedFile(join(codexHome, 'sessions', '2026', '07', `${name}.jsonl`), 180)
      }

      const copiedFileCounts: number[] = []
      for await (const scope of createCodexSessionScopeBatches({
        codexHome,
        since: 'all',
        batchSize: 3,
        maxBatchBytes: 300,
        maxFileBytes: 256
      })) {
        try {
          copiedFileCounts.push(scope.sourceFiles.size)
        } finally {
          await scope.cleanup()
        }
      }

      expect(copiedFileCounts).toEqual([1, 1, 1])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('projects a valid oversized session file into bounded usage metadata', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const session = join(codexHome, 'sessions', '2026', '07', 'oversized.jsonl')
    try {
      await mkdir(dirname(session), { recursive: true })
      await writeFile(
        session,
        [
          JSON.stringify({ type: 'session_meta', id: 'session' }),
          JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5' } }),
          JSON.stringify({
            type: 'event_msg',
            timestamp: '2026-07-01T00:00:00.000Z',
            payload: {
              type: 'token_count',
              info: { last_token_usage: { input_tokens: 2, output_tokens: 3 } }
            }
          }),
          JSON.stringify({ type: 'response_item', payload: 'x'.repeat(4096) })
        ].join('\n') + '\n'
      )

      const scope = await createCodexSessionScope({
        codexHome,
        since: 'all',
        maxFileBytes: 128,
        maxBatchBytes: 2048,
        maxGroupBytes: 2048
      })
      expect(scope).not.toBeNull()
      try {
        const projected = await readFile(join(scope!.codexHome, 'sessions', '2026', '07', 'oversized.jsonl'), 'utf8')
        expect(projected).toContain('token_count')
        expect(projected).not.toContain('response_item')
        expect(scope!.projectedSourceFiles.has(session)).toBe(true)
      } finally {
        await scope?.cleanup()
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('fails explicitly when an oversized session file contains malformed JSONL', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    try {
      await writeSizedFile(join(codexHome, 'sessions', '2026', '07', 'oversized.jsonl'), 256)

      await expect(
        createCodexSessionScope({
          codexHome,
          since: 'all',
          maxFileBytes: 128
        })
      ).rejects.toThrow(/malformed JSONL row/i)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('fails if an oversized session changes while it is being projected', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const session = join(codexHome, 'sessions', '2026', '07', 'changing.jsonl')
    try {
      await mkdir(dirname(session), { recursive: true })
      await writeFile(session, oversizedRows().join('\n') + '\n')

      let changed = false
      await expect(
        createCodexSessionScope({
          codexHome,
          since: 'all',
          maxFileBytes: 128,
          maxBatchBytes: 4096,
          onProjectionDiagnostic: () => {
            if (changed) return
            changed = true
            appendFileSync(session, `${JSON.stringify({ type: 'response_item', payload: 'changed' })}\n`)
          }
        })
      ).rejects.toThrow(/session changed during scoped collection/i)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('fails explicitly when projected usage metadata would exceed the batch limit', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const session = join(codexHome, 'sessions', '2026', '07', 'projected-limit.jsonl')
    try {
      await mkdir(dirname(session), { recursive: true })
      await writeFile(
        session,
        [
          JSON.stringify({ type: 'session_meta', id: 'session' }),
          JSON.stringify({
            type: 'event_msg',
            timestamp: '2026-07-01T00:00:00.000Z',
            payload: {
              type: 'token_count',
              info: { last_token_usage: { input_tokens: 2, output_tokens: 3 } },
              padding: 'x'.repeat(1024)
            }
          })
        ].join('\n') + '\n'
      )

      await expect(
        createCodexSessionScope({
          codexHome,
          since: 'all',
          maxFileBytes: 128,
          maxBatchBytes: 256,
          maxGroupBytes: 256
        })
      ).rejects.toThrow(/projected session file exceeds scoped collection byte limit/i)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('fails explicitly when an oversized usage row exceeds the line limit', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const session = join(codexHome, 'sessions', '2026', '07', 'oversized-usage.jsonl')
    try {
      await mkdir(dirname(session), { recursive: true })
      await writeFile(
        session,
        [
          JSON.stringify({ type: 'session_meta', id: 'session' }),
          JSON.stringify({
            type: 'event_msg',
            timestamp: '2026-07-01T00:00:00.000Z',
            payload: {
              type: 'token_count',
              info: { last_token_usage: { input_tokens: 2, output_tokens: 3 } },
              padding: 'x'.repeat(2 * 1024 * 1024)
            }
          })
        ].join('\n') + '\n'
      )

      await expect(
        createCodexSessionScope({
          codexHome,
          since: 'all',
          maxFileBytes: 128,
          maxBatchBytes: 4096,
          maxGroupBytes: 4096
        })
      ).rejects.toThrow(/oversized line with usage or subagent metadata/i)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('keeps projected files mapped to their physical paths across profiles', async () => {
    const firstHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const secondHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const firstSession = join(firstHome, 'sessions', '2026', '07', 'shared.jsonl')
    const secondSession = join(secondHome, 'sessions', '2026', '07', 'shared.jsonl')
    try {
      await Promise.all([
        mkdir(dirname(firstSession), { recursive: true }),
        mkdir(dirname(secondSession), { recursive: true })
      ])
      await Promise.all([
        writeFile(firstSession, oversizedRows().join('\n') + '\n', { flag: 'w' }),
        writeFile(secondSession, oversizedRows().join('\n') + '\n', { flag: 'w' })
      ])

      const batches = createCodexSessionScopeBatches({
        codexHomes: [firstHome, secondHome],
        since: 'all',
        maxFileBytes: 128,
        maxBatchBytes: 4096,
        maxGroupBytes: 8192
      })
      const batch = await batches.next()
      expect(batch.done).toBe(false)
      if (!batch.done) {
        try {
          expect(new Set(batch.value.projectedSourceFiles)).toEqual(new Set([firstSession, secondSession]))
          expect(new Set(batch.value.sourceFiles.values())).toEqual(new Set([firstSession, secondSession]))
        } finally {
          await batch.value.cleanup()
        }
      }
      expect((await batches.next()).done).toBe(true)
    } finally {
      await Promise.all([
        rm(firstHome, { recursive: true, force: true }),
        rm(secondHome, { recursive: true, force: true })
      ])
    }
  })

  test.skipIf(process.platform === 'win32')('supports projection through an approved root symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const codexHome = join(root, 'codex')
    const targetRoot = join(root, 'archive-target')
    const session = join(targetRoot, '2026', '07', 'linked.jsonl')
    try {
      await mkdir(dirname(session), { recursive: true })
      await writeFile(session, oversizedRows().join('\n') + '\n')
      await mkdir(codexHome, { recursive: true })
      await symlink(targetRoot, join(codexHome, 'archived_sessions'))

      const scope = await createCodexSessionScope({
        codexHome,
        since: 'all',
        codexSymlinkRoots: [targetRoot],
        maxFileBytes: 128,
        maxBatchBytes: 4096,
        maxGroupBytes: 4096
      })
      try {
        expect(scope).not.toBeNull()
        expect(scope?.projectedSourceFiles.has(await realpath(session))).toBe(true)
      } finally {
        await scope?.cleanup()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps a multi-profile group together when it exceeds the normal batch byte limit', async () => {
    const firstHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const secondHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    try {
      await Promise.all([
        writeSizedFile(join(firstHome, 'sessions', '2026', '07', 'shared.jsonl'), 180),
        writeSizedFile(join(secondHome, 'sessions', '2026', '07', 'shared.jsonl'), 180)
      ])

      const batches = createCodexSessionScopeBatches({
        codexHomes: [firstHome, secondHome],
        since: 'all',
        maxFileBytes: 256,
        maxBatchBytes: 300,
        maxGroupBytes: 400
      })
      const batch = await batches.next()
      expect(batch.done).toBe(false)
      if (!batch.done) {
        try {
          expect(new Set(batch.value.sourceFiles.values())).toEqual(
            new Set([
              join(firstHome, 'sessions', '2026', '07', 'shared.jsonl'),
              join(secondHome, 'sessions', '2026', '07', 'shared.jsonl')
            ])
          )
        } finally {
          await batch.value.cleanup()
        }
      }
      expect((await batches.next()).done).toBe(true)
    } finally {
      await Promise.all([
        rm(firstHome, { recursive: true, force: true }),
        rm(secondHome, { recursive: true, force: true })
      ])
    }
  })

  test('fails explicitly when a multi-profile group exceeds the configured group byte limit', async () => {
    const firstHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const secondHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    try {
      await Promise.all([
        writeSizedFile(join(firstHome, 'sessions', '2026', '07', 'shared.jsonl'), 180),
        writeSizedFile(join(secondHome, 'sessions', '2026', '07', 'shared.jsonl'), 180)
      ])

      const batches = createCodexSessionScopeBatches({
        codexHomes: [firstHome, secondHome],
        since: 'all',
        maxFileBytes: 256,
        maxBatchBytes: 300,
        maxGroupBytes: 300
      })
      await expect(batches.next()).rejects.toThrow(/group exceeds.*group byte limit/i)
    } finally {
      await Promise.all([
        rm(firstHome, { recursive: true, force: true }),
        rm(secondHome, { recursive: true, force: true })
      ])
    }
  })

  test('skips a dated session whose path and mtime are both outside the bounded window', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const session = join(codexHome, 'sessions', '2026', '01', '01', 'large.jsonl')
    try {
      await writeSizedFile(session, 256)
      await utimes(session, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'))

      await expect(
        createCodexSessionScope({
          codexHome,
          since: '20260701',
          maxPrefilterBytes: 128
        })
      ).resolves.toBeNull()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('skips an archived rollout filename whose start date and mtime are outside the bounded window', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const session = join(codexHome, 'archived_sessions', 'rollout-2026-01-01T00-00-00-session.jsonl')
    try {
      await writeSizedFile(session, 256)
      await utimes(session, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'))

      await expect(
        createCodexSessionScope({
          codexHome,
          since: '20260701',
          maxPrefilterBytes: 128
        })
      ).resolves.toBeNull()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('keeps a dated long-running session whose activity interval overlaps the bounded window', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const session = join(codexHome, 'sessions', '2026', '01', '01', 'long-running.jsonl')
    try {
      await writeSizedFile(session, 256)
      await utimes(session, new Date('2026-08-03T00:00:00.000Z'), new Date('2026-08-03T00:00:00.000Z'))

      const scope = await createCodexSessionScope({
        codexHome,
        since: '20260701',
        until: '20260731',
        maxPrefilterBytes: 128
      })
      expect(scope).not.toBeNull()
      await scope?.cleanup()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('falls back to exact collection when an undated prefilter exceeds its read limit', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const session = join(codexHome, 'sessions', 'large.jsonl')
    try {
      await writeSizedFile(session, 256)
      await utimes(session, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'))

      const scope = await createCodexSessionScope({
        codexHome,
        since: '20260701',
        maxPrefilterBytes: 128
      })
      expect(scope).not.toBeNull()
      await scope?.cleanup()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('accepts an in-range token count before the bounded date prefilter read limit', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const session = join(codexHome, 'sessions', 'early-token.jsonl')
    const tokenCount = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-01T00:00:00.000Z',
      payload: { type: 'token_count' }
    })
    try {
      await mkdir(dirname(session), { recursive: true })
      await writeFile(session, `${tokenCount}\n${'x'.repeat(512)}`)
      await utimes(session, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'))

      const scope = await createCodexSessionScope({
        codexHome,
        since: '20260701',
        maxPrefilterBytes: Buffer.byteLength(`${tokenCount}\n`)
      })
      expect(scope).not.toBeNull()
      await scope?.cleanup()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('falls back to exact collection when a bounded prefilter encounters an oversized JSONL line', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-bounds-'))
    const session = join(codexHome, 'sessions', 'long-line.jsonl')
    try {
      await writeSizedFile(session, 256)
      await utimes(session, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'))

      const scope = await createCodexSessionScope({
        codexHome,
        since: '20260701',
        maxPrefilterBytes: 512,
        maxPrefilterLineBytes: 64
      })
      expect(scope).not.toBeNull()
      await scope?.cleanup()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})

async function writeSizedFile(file: string, size: number) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${'x'.repeat(size - 1)}\n`)
}

function oversizedRows() {
  return [
    JSON.stringify({ type: 'session_meta', id: 'session' }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5' } }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-01T00:00:00.000Z',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 2, output_tokens: 3 } }
      }
    }),
    JSON.stringify({ type: 'response_item', payload: 'x'.repeat(4096) })
  ]
}
