import { glob, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createCodexSessionScope, createCodexSessionScopeBatches } from './codex-session-scope'

describe('createCodexSessionScope', () => {
  test('returns null when no date filter is configured', async () => {
    await expect(createCodexSessionScope()).resolves.toBeNull()
  })

  test('selects sessions by token_count timestamp before directory date', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    try {
      await writeJsonl(
        join(codexHome, 'sessions', '2026', '03', '25', 'still-active.jsonl'),
        [tokenCountEvent('2026-05-09T04:24:07.234Z')]
      )
      await writeJsonl(
        join(codexHome, 'sessions', '2026', '03', '20', 'inactive.jsonl'),
        [tokenCountEvent('2026-03-20T04:24:07.234Z')]
      )
      await utimes(
        join(codexHome, 'sessions', '2026', '03', '20', 'inactive.jsonl'),
        new Date('2026-03-20T04:24:07.234Z'),
        new Date('2026-03-20T04:24:07.234Z')
      )

      const scope = await createCodexSessionScope({ codexHome, since: '20260508' })
      expect(scope).not.toBeNull()
      try {
        await expect(
          readFile(join(scope!.codexHome, 'sessions', '2026', '03', '25', 'still-active.jsonl'), 'utf8')
        ).resolves.toContain('token_count')
        await expect(
          stat(join(scope!.codexHome, 'sessions', '2026', '03', '20', 'inactive.jsonl'))
        ).rejects.toThrow()
      } finally {
        await scope?.cleanup()
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('falls back to file mtime when no token_count timestamp is available', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    const activeFile = join(codexHome, 'sessions', '2026', '03', '25', 'mtime-active.jsonl')
    const inactiveFile = join(codexHome, 'sessions', '2026', '03', '25', 'mtime-inactive.jsonl')
    try {
      await writeJsonl(activeFile, [{ type: 'event_msg', payload: { type: 'token_count' } }])
      await writeJsonl(inactiveFile, [{ type: 'event_msg', payload: { type: 'token_count' } }])
      await utimes(activeFile, new Date('2026-05-09T04:24:07.234Z'), new Date('2026-05-09T04:24:07.234Z'))
      await utimes(inactiveFile, new Date('2026-03-20T04:24:07.234Z'), new Date('2026-03-20T04:24:07.234Z'))

      const scope = await createCodexSessionScope({ codexHome, since: '20260508' })
      expect(scope).not.toBeNull()
      try {
        await expect(
          readFile(join(scope!.codexHome, 'sessions', '2026', '03', '25', 'mtime-active.jsonl'), 'utf8')
        ).resolves.toContain('token_count')
        await expect(
          stat(join(scope!.codexHome, 'sessions', '2026', '03', '25', 'mtime-inactive.jsonl'))
        ).rejects.toThrow()
      } finally {
        await scope?.cleanup()
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('treats until as inclusive for the entire local day', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    try {
      await writeJsonl(
        join(codexHome, 'sessions', '2026', '05', '09', 'included.jsonl'),
        [tokenCountEvent('2026-05-09T23:59:59.999Z')]
      )
      await writeJsonl(
        join(codexHome, 'sessions', '2026', '05', '10', 'excluded.jsonl'),
        [tokenCountEvent('2026-05-10T00:00:00.000Z')]
      )

      const scope = await createCodexSessionScope({ codexHome, until: '20260509' })
      expect(scope).not.toBeNull()
      try {
        await expect(
          readFile(join(scope!.codexHome, 'sessions', '2026', '05', '09', 'included.jsonl'), 'utf8')
        ).resolves.toContain('token_count')
        await expect(
          stat(join(scope!.codexHome, 'sessions', '2026', '05', '10', 'excluded.jsonl'))
        ).rejects.toThrow()
      } finally {
        await scope?.cleanup()
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('rejects invalid date filters', async () => {
    await expect(createCodexSessionScope({ since: '2026/05/09' })).rejects.toThrow(/Invalid Codex usage date filter/)
  })

  test('streams full scans in bounded batches', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '03', '20', 'first.jsonl'), [
        tokenCountEvent('2026-03-20T04:24:07.234Z')
      ])
      await writeJsonl(join(codexHome, 'sessions', '2026', '04', '20', 'second.jsonl'), [
        tokenCountEvent('2026-04-20T04:24:07.234Z')
      ])
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '09', 'third.jsonl'), [
        tokenCountEvent('2026-05-09T04:24:07.234Z')
      ])

      const batches = []
      for await (const scope of createCodexSessionScopeBatches({ codexHome, since: 'all', batchSize: 2 })) {
        try {
          batches.push({
            first: await fileExists(join(scope.codexHome, 'sessions', '2026', '03', '20', 'first.jsonl')),
            second: await fileExists(join(scope.codexHome, 'sessions', '2026', '04', '20', 'second.jsonl')),
            third: await fileExists(join(scope.codexHome, 'sessions', '2026', '05', '09', 'third.jsonl'))
          })
        } finally {
          await scope.cleanup()
        }
      }

      expect(batches).toHaveLength(2)
      expect(batches.flatMap((batch) => Object.values(batch)).filter(Boolean)).toHaveLength(3)
      expect(batches.every((batch) => Object.values(batch).filter(Boolean).length <= 2)).toBe(true)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('combines every matching file in the compatibility scope API', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    try {
      for (let index = 0; index < 3; index += 1) {
        await writeJsonl(join(codexHome, 'sessions', '2026', '05', `${index}.jsonl`), [
          tokenCountEvent('2026-05-09T04:24:07.234Z')
        ])
      }

      const scope = await createCodexSessionScope({ codexHome, since: 'all', batchSize: 2 })
      expect(scope).not.toBeNull()
      try {
        const scopedFiles = []
        for await (const file of glob('**/*.jsonl', { cwd: join(scope!.codexHome, 'sessions') })) {
          scopedFiles.push(file)
        }
        expect(scopedFiles).toHaveLength(3)
      } finally {
        await scope?.cleanup()
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('cleans up a failed batch scope copy', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    const before = await listScopeTempDirs()
    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', 'ok.jsonl'), [
        tokenCountEvent('2026-05-09T04:24:07.234Z')
      ])
      await mkdir(join(codexHome, 'sessions', '2026', '05', 'broken.jsonl'))

      await expect(
        collectBatches(createCodexSessionScopeBatches({ codexHome, since: 'all', batchSize: 2 }))
      ).rejects.toThrow()

      const after = await listScopeTempDirs()
      expect(after.filter((entry) => !before.includes(entry))).toHaveLength(0)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})

async function writeJsonl(file: string, rows: unknown[]) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

function tokenCountEvent(timestamp: string) {
  return {
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 10,
          output_tokens: 0,
          total_tokens: 10
        }
      }
    }
  }
}

async function fileExists(file: string) {
  return stat(file)
    .then(() => true)
    .catch(() => false)
}

async function collectBatches(source: AsyncGenerator<unknown>) {
  const batches = []
  for await (const batch of source) {
    batches.push(batch)
  }
  return batches
}

async function listScopeTempDirs() {
  const entries = await readdir(tmpdir())
  return entries.filter((entry) => entry.startsWith('tokenboard-codex-home-'))
}
