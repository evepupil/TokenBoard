import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { createCodexSessionScope, createCodexSessionScopeBatches } from './codex-session-scope'
import { walkJsonlFiles } from './session-file-walk'

describe('createCodexSessionScope', () => {
  test('returns null when no date filter is configured', async () => {
    await expect(createCodexSessionScope()).resolves.toBeNull()
  })

  test('defaults to the OS home Codex directory when env overrides are absent', async () => {
    vi.resetModules()
    const previousCodexHome = process.env.CODEX_HOME
    const previousHome = process.env.HOME
    const previousCwd = process.cwd()
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-scope-home-'))
    const fakeHome = join(root, 'home')
    const fakeCwd = join(root, 'cwd')
    try {
      await writeJsonl(join(fakeHome, '.codex', 'sessions', '2026', '05', 'home.jsonl'), [
        tokenCountEvent('2026-05-09T04:24:07.234Z')
      ])
      await writeJsonl(join(fakeCwd, '.codex', 'sessions', '2026', '05', 'cwd.jsonl'), [
        tokenCountEvent('2026-05-09T04:24:07.234Z')
      ])
      delete process.env.CODEX_HOME
      delete process.env.HOME
      process.chdir(fakeCwd)

      vi.doMock('node:os', async () => ({
        ...(await vi.importActual<typeof import('node:os')>('node:os')),
        homedir: () => fakeHome
      }))
      const { createCodexSessionScope: createScopedWithMockedHome } = await import('./codex-session-scope')

      const scope = await createScopedWithMockedHome({ since: 'all' })
      expect(scope).not.toBeNull()
      try {
        await expect(
          readFile(join(scope!.codexHome, 'sessions', '2026', '05', 'home.jsonl'), 'utf8')
        ).resolves.toContain('token_count')
        await expect(stat(join(scope!.codexHome, 'sessions', '2026', '05', 'cwd.jsonl'))).rejects.toThrow()
      } finally {
        await scope?.cleanup()
      }
    } finally {
      process.chdir(previousCwd)
      restoreEnv('CODEX_HOME', previousCodexHome)
      restoreEnv('HOME', previousHome)
      vi.doUnmock('node:os')
      vi.resetModules()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('preserves a comma in an explicitly configured Codex home array', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-scope-comma-home-'))
    const codexHome = join(root, 'profile,primary')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '09', 'session.jsonl')

    try {
      await writeJsonl(sessionFile, [tokenCountEvent('2026-05-09T04:24:07.234Z')])
      const scope = await createCodexSessionScope({ codexHomes: [codexHome], since: 'all' })

      try {
        expect(scope?.codexHomes).toHaveLength(1)
        await expect(
          readFile(join(scope!.codexHome, 'sessions', '2026', '05', '09', 'session.jsonl'), 'utf8')
        ).resolves.toContain('token_count')
      } finally {
        await scope?.cleanup()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects an existing comma-containing legacy CODEX_HOME as ambiguous', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-scope-ambiguous-home-'))
    const codexHome = join(root, 'profile,primary')

    try {
      await mkdir(codexHome, { recursive: true })
      await expect(createCodexSessionScope({ codexHome, since: 'all' })).rejects.toThrow(
        'CODEX_HOME is ambiguous because the configured path contains a comma'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects and cleans up a temporary scope when TMPDIR contains a comma', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    const tempRoot = await mkdtemp(join(tmpdir(), 'tokenboard-scope-comma-root-'))
    const commaTmpdir = join(tempRoot, 'temporary,scope')
    const temporaryDirectoryVariables = process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR']
    const previousTemporaryDirectoryValues = temporaryDirectoryVariables.map((name) => process.env[name])

    try {
      await mkdir(commaTmpdir)
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '09', 'session.jsonl'), [
        tokenCountEvent('2026-05-09T04:24:07.234Z')
      ])
      for (const name of temporaryDirectoryVariables) process.env[name] = commaTmpdir

      await expect(createCodexSessionScope({ codexHome, since: 'all' })).rejects.toThrow(
        'Temporary Codex session scope path contains a comma'
      )
      await expect(listScopeTempDirs(commaTmpdir)).resolves.toEqual([])
    } finally {
      temporaryDirectoryVariables.forEach((name, index) => restoreEnv(name, previousTemporaryDirectoryValues[index]))
      await rm(codexHome, { recursive: true, force: true })
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  test('reads comma-containing Codex homes from an unambiguous JSON environment value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-scope-json-homes-'))
    const codexHome = join(root, 'profile,primary')
    const ignoredLegacyHome = join(root, 'legacy')
    const previousCodexHome = process.env.CODEX_HOME
    const previousCodexHomesJson = process.env.TOKENBOARD_CODEX_HOMES_JSON

    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '09', 'session.jsonl'), [
        tokenCountEvent('2026-05-09T04:24:07.234Z')
      ])
      process.env.CODEX_HOME = ignoredLegacyHome
      process.env.TOKENBOARD_CODEX_HOMES_JSON = JSON.stringify([codexHome])

      const scope = await createCodexSessionScope({ since: 'all' })
      try {
        expect(scope?.codexHomes).toHaveLength(1)
        await expect(
          readFile(join(scope!.codexHome, 'sessions', '2026', '05', '09', 'session.jsonl'), 'utf8')
        ).resolves.toContain('token_count')
      } finally {
        await scope?.cleanup()
      }
    } finally {
      restoreEnv('CODEX_HOME', previousCodexHome)
      restoreEnv('TOKENBOARD_CODEX_HOMES_JSON', previousCodexHomesJson)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('selects sessions by token_count timestamp before directory date', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '03', '25', 'still-active.jsonl'), [
        tokenCountEvent('2026-05-09T04:24:07.234Z')
      ])
      await writeJsonl(join(codexHome, 'sessions', '2026', '03', '20', 'inactive.jsonl'), [
        tokenCountEvent('2026-03-20T04:24:07.234Z')
      ])
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
        await expect(stat(join(scope!.codexHome, 'sessions', '2026', '03', '20', 'inactive.jsonl'))).rejects.toThrow()
      } finally {
        await scope?.cleanup()
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('keeps the previous UTC-day candidate for downstream positive-timezone filtering', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    const edgeFile = join(codexHome, 'sessions', '2026', '07', '07', 'positive-offset-edge.jsonl')
    try {
      await writeJsonl(edgeFile, [tokenCountEvent('2026-07-07T16:30:00.000Z')])
      await utimes(edgeFile, new Date('2026-07-01T00:00:00.000Z'), new Date('2026-07-01T00:00:00.000Z'))

      const scope = await createCodexSessionScope({ codexHome, since: '20260708' })
      expect(scope).not.toBeNull()
      try {
        await expect(
          readFile(join(scope!.codexHome, 'sessions', '2026', '07', '07', 'positive-offset-edge.jsonl'), 'utf8')
        ).resolves.toContain('token_count')
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

  test('keeps the next UTC-day candidate for downstream negative-timezone filtering', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '09', 'included.jsonl'), [
        tokenCountEvent('2026-05-09T23:59:59.999Z')
      ])
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '10', 'negative-offset-edge.jsonl'), [
        tokenCountEvent('2026-05-10T07:30:00.000Z')
      ])
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', '11', 'excluded.jsonl'), [
        tokenCountEvent('2026-05-11T00:00:00.000Z')
      ])

      const scope = await createCodexSessionScope({ codexHome, until: '20260509' })
      expect(scope).not.toBeNull()
      try {
        await expect(
          readFile(join(scope!.codexHome, 'sessions', '2026', '05', '09', 'included.jsonl'), 'utf8')
        ).resolves.toContain('token_count')
        await expect(
          readFile(join(scope!.codexHome, 'sessions', '2026', '05', '10', 'negative-offset-edge.jsonl'), 'utf8')
        ).resolves.toContain('token_count')
        await expect(stat(join(scope!.codexHome, 'sessions', '2026', '05', '11', 'excluded.jsonl'))).rejects.toThrow()
      } finally {
        await scope?.cleanup()
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test.each(['2026/05/09', '2026--05-09', '20260230'])('rejects invalid date filter %s', async (since) => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    try {
      await expect(createCodexSessionScope({ codexHome, since })).rejects.toThrow(/Invalid Codex usage date filter/)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
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

  test('groups complete relative paths across profiles when a nested directory sorts beside a sibling file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-scope-order-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const firstSibling = join(firstHome, 'sessions', 'a.jsonl')
    const secondSibling = join(secondHome, 'sessions', 'a.jsonl')
    const firstNested = join(firstHome, 'sessions', 'a', 'nested.jsonl')

    try {
      await Promise.all([
        writeJsonl(firstSibling, [tokenCountEvent('2026-05-09T04:24:07.234Z')]),
        writeJsonl(secondSibling, [tokenCountEvent('2026-05-09T04:24:07.234Z')]),
        writeJsonl(firstNested, [tokenCountEvent('2026-05-09T04:24:07.234Z')])
      ])

      const batches: string[][] = []
      for await (const scope of createCodexSessionScopeBatches({
        codexHomes: [firstHome, secondHome],
        since: 'all',
        batchSize: 1
      })) {
        try {
          batches.push([...scope.sourceFiles.values()].sort())
        } finally {
          await scope.cleanup()
        }
      }

      expect(batches).toEqual([[firstSibling, secondSibling].sort(), [firstNested]])
    } finally {
      await rm(root, { recursive: true, force: true })
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
        for await (const file of walkJsonlFiles(join(scope!.codexHome, 'sessions'))) {
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

  test('copies an explicitly selected archived session and retains its original-file mapping', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    const archived = join(codexHome, 'archived_sessions', '2026', '05', 'archived.jsonl')
    try {
      await writeJsonl(archived, [tokenCountEvent('2026-05-09T04:24:07.234Z')])

      const scope = await createCodexSessionScope({ codexHome, files: [archived] })
      expect(scope).not.toBeNull()
      try {
        const scopedFile = join(scope!.codexHome, 'archived_sessions', '2026', '05', 'archived.jsonl')
        await expect(readFile(scopedFile, 'utf8')).resolves.toContain('token_count')
        expect(scope!.sourceFiles.get(scopedFile)).toBe(archived)
      } finally {
        await scope?.cleanup()
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('includes archive-only sessions in full scan scopes', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    const archived = join(codexHome, 'archived_sessions', '2026', '05', 'archive-only.jsonl')
    try {
      await writeJsonl(archived, [tokenCountEvent('2026-05-09T04:24:07.234Z')])

      const scope = await createCodexSessionScope({ codexHome, since: 'all' })
      expect(scope).not.toBeNull()
      try {
        await expect(
          readFile(join(scope!.codexHome, 'archived_sessions', '2026', '05', 'archive-only.jsonl'), 'utf8')
        ).resolves.toContain('token_count')
      } finally {
        await scope?.cleanup()
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('prefers an active session when an archive has the same relative path', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    const active = join(codexHome, 'sessions', '2026', '05', 'shared.jsonl')
    const archived = join(codexHome, 'archived_sessions', '2026', '05', 'shared.jsonl')
    try {
      await writeJsonl(active, [{ source: 'active' }])
      await writeJsonl(archived, [{ source: 'archived' }])

      const scope = await createCodexSessionScope({ codexHome, files: [archived, active] })
      expect(scope).not.toBeNull()
      try {
        const scoped = join(scope!.codexHome, 'sessions', '2026', '05', 'shared.jsonl')
        await expect(readFile(scoped, 'utf8')).resolves.toContain('"source":"active"')
        expect(scope!.sourceFiles.get(scoped)).toBe(active)
      } finally {
        await scope?.cleanup()
      }
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('rejects explicit session files outside active and archived session directories', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    const outside = join(codexHome, 'outside.jsonl')
    try {
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', 'valid.jsonl'), [
        tokenCountEvent('2026-05-09T04:24:07.234Z')
      ])
      await writeJsonl(outside, [tokenCountEvent('2026-05-09T04:24:07.234Z')])

      await expect(createCodexSessionScope({ codexHome, files: [outside] })).rejects.toThrow(
        'Invalid Codex session file path for canonical session attribution'
      )
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')('cleans up a failed batch scope copy', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    const sandboxTmpdir = await mkdtemp(join(tmpdir(), 'tokenboard-scope-root-'))
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = sandboxTmpdir
    const brokenFile = join(codexHome, 'sessions', '2026', '05', 'broken.jsonl')
    try {
      const before = await listScopeTempDirs(sandboxTmpdir)
      await writeJsonl(join(codexHome, 'sessions', '2026', '05', 'ok.jsonl'), [
        tokenCountEvent('2026-05-09T04:24:07.234Z')
      ])
      await writeJsonl(brokenFile, [tokenCountEvent('2026-05-09T04:24:07.234Z')])
      await chmod(brokenFile, 0o000)

      await expect(
        collectBatches(createCodexSessionScopeBatches({ codexHome, since: 'all', batchSize: 2 }))
      ).rejects.toThrow()

      const after = await listScopeTempDirs(sandboxTmpdir)
      expect(after.filter((entry) => !before.includes(entry))).toHaveLength(0)
    } finally {
      restoreTmpdir(previousTmpdir)
      await chmod(brokenFile, 0o600).catch(() => {})
      await rm(codexHome, { recursive: true, force: true })
      await rm(sandboxTmpdir, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')(
    'fails visibly when an active session candidate cannot be read',
    async () => {
      const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
      const unreadable = join(codexHome, 'sessions', '2026', '05', 'unreadable.jsonl')
      try {
        await writeJsonl(unreadable, [tokenCountEvent('2026-05-09T04:24:07.234Z')])
        await utimes(unreadable, new Date('2026-03-20T04:24:07.234Z'), new Date('2026-03-20T04:24:07.234Z'))
        await chmod(unreadable, 0o000)

        await expect(createCodexSessionScope({ codexHome, since: '20260508' })).rejects.toThrow(
          /Unable to read Codex session file/
        )
      } finally {
        await chmod(unreadable, 0o600).catch(() => {})
        await rm(codexHome, { recursive: true, force: true })
      }
    }
  )
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

function restoreTmpdir(value: string | undefined) {
  restoreEnv('TMPDIR', value)
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
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

async function listScopeTempDirs(root: string) {
  const entries = await readdir(root)
  return entries.filter((entry) => entry.startsWith('tokenboard-codex-home-'))
}
