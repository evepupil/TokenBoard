import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

const fallbackMessage = 'Codex copy-on-write clone is unavailable; using a bounded standard file copy'

describe('createCodexSessionScope copy races', () => {
  test('closes the session cloner after creating a scope instead of retaining a helper during collection', async () => {
    const copy = vi.fn(async (source: string, target: string) => {
      await writeFile(target, await readFile(source))
    })
    const close = vi.fn(async () => {})
    const { createCodexSessionScope, restore } = await loadScopeModule(() => ({ copy, close }))
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    const firstFile = join(codexHome, 'sessions', '2026', '05', 'first.jsonl')
    const secondFile = join(codexHome, 'sessions', '2026', '05', 'second.jsonl')

    try {
      await writeJsonl(firstFile, [tokenCountEvent('2026-05-09T04:24:07.234Z')])
      await writeJsonl(secondFile, [tokenCountEvent('2026-05-09T04:25:07.234Z')])

      const scope = await createCodexSessionScope({ codexHome, since: 'all' })

      expect(scope).not.toBeNull()
      expect(copy).toHaveBeenCalledTimes(2)
      expect(close).toHaveBeenCalledTimes(1)
      await scope?.cleanup()
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      restore()
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('reports a supported fallback once even when the cloner signals it for multiple files', async () => {
    const messages: string[] = []
    const { createCodexSessionScope, restore } = await loadScopeModule((options) => ({
      copy: async (source, target) => {
        options.onFallback?.()
        await writeFile(target, await readFile(source))
      },
      close: async () => {}
    }))
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    const firstFile = join(codexHome, 'sessions', '2026', '05', 'first.jsonl')
    const secondFile = join(codexHome, 'sessions', '2026', '05', 'second.jsonl')

    try {
      await writeJsonl(firstFile, [tokenCountEvent('2026-05-09T04:24:07.234Z')])
      await writeJsonl(secondFile, [tokenCountEvent('2026-05-09T04:25:07.234Z')])

      const scope = await createCodexSessionScope({
        codexHome,
        since: 'all',
        onCopyFallback: (message) => messages.push(message)
      })

      expect(scope).not.toBeNull()
      expect(messages).toEqual([fallbackMessage])
      await scope?.cleanup()
    } finally {
      restore()
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('does not hide a non-fallback clone error', async () => {
    const close = vi.fn(async () => {})
    const { createCodexSessionScope, restore } = await loadScopeModule(() => ({
      copy: async () => {
        throw Object.assign(new Error('clone permission denied'), { code: 'EACCES' })
      },
      close
    }))
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    const activeFile = join(codexHome, 'sessions', '2026', '05', 'active.jsonl')

    try {
      await writeJsonl(activeFile, [tokenCountEvent('2026-05-09T04:24:07.234Z')])

      await expect(createCodexSessionScope({ codexHome, since: 'all' })).rejects.toThrow('clone permission denied')
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      restore()
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('skips only a source file that actually disappears during the clone race', async () => {
    const { createCodexSessionScope, restore } = await loadScopeModule(() => ({
      copy: async (source, target) => {
        if (source.endsWith('disappearing.jsonl')) {
          await unlink(source)
          throw Object.assign(new Error('source disappeared'), { code: 'ENOENT' })
        }
        await writeFile(target, await readFile(source))
      },
      close: async () => {}
    }))
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    const activeFile = join(codexHome, 'sessions', '2026', '05', 'active.jsonl')
    const disappearingFile = join(codexHome, 'sessions', '2026', '05', 'disappearing.jsonl')
    const skippedFiles: string[] = []

    try {
      await writeJsonl(activeFile, [tokenCountEvent('2026-05-09T04:24:07.234Z')])
      await writeJsonl(disappearingFile, [tokenCountEvent('2026-05-09T04:25:07.234Z')])

      const scope = await createCodexSessionScope({
        codexHome,
        since: 'all',
        onMissingSessionFile: (file) => skippedFiles.push(file)
      })

      expect(scope).not.toBeNull()
      expect(skippedFiles).toEqual(['2026/05/disappearing.jsonl'])
      await expect(
        readFile(join(scope!.codexHome, 'sessions', '2026', '05', 'active.jsonl'), 'utf8')
      ).resolves.toContain('token_count')
      await scope?.cleanup()
    } finally {
      restore()
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('does not treat an unrelated ENOENT clone failure as a missing source file', async () => {
    const skippedFiles: string[] = []
    const { createCodexSessionScope, restore } = await loadScopeModule(() => ({
      copy: async () => {
        throw Object.assign(new Error('target vanished'), { code: 'ENOENT' })
      },
      close: async () => {}
    }))
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-scope-test-'))
    const activeFile = join(codexHome, 'sessions', '2026', '05', 'active.jsonl')

    try {
      await writeJsonl(activeFile, [tokenCountEvent('2026-05-09T04:24:07.234Z')])

      await expect(
        createCodexSessionScope({
          codexHome,
          since: 'all',
          onMissingSessionFile: (file) => skippedFiles.push(file)
        })
      ).rejects.toThrow('target vanished')
      expect(skippedFiles).toEqual([])
    } finally {
      restore()
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})

type ClonerFactoryOptions = { onFallback?: () => void }
type TestCloner = {
  copy: (source: string, target: string) => Promise<void>
  close: () => Promise<void>
}

async function loadScopeModule(createCloner: (options: ClonerFactoryOptions) => TestCloner) {
  vi.resetModules()
  vi.doMock('./codex-session-cloner', () => ({
    CODEX_SESSION_COPY_FALLBACK_MESSAGE: fallbackMessage,
    createCodexSessionCloner: createCloner
  }))
  const module = await import('./codex-session-scope')
  return {
    createCodexSessionScope: module.createCodexSessionScope,
    restore: () => {
      vi.doUnmock('./codex-session-cloner')
      vi.resetModules()
    }
  }
}

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
