import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { usageSources } from '@tokenboard/usage-core'
import { describe, expect, test } from 'vitest'
import { cursorFileName, readCursor, writeCursor } from './session-cursor-store'

const snapshot = {
  usageDate: '2026-08-14',
  timezone: 'Asia/Shanghai',
  model: 'some-model',
  inputTokens: 10,
  outputTokens: 2,
  cacheCreationTokens: 0,
  cacheReadTokens: 5,
  totalTokens: 17,
  costUsd: 0,
  sessionCount: 1
}

describe('cursor state across usage sources', () => {
  test('keeps the established cursor file name for every existing source', () => {
    // These names address cursor state already on disk: changing one would
    // orphan a user's saved state and re-collect history as new usage.
    expect(cursorFileName('claude-code')).toBe('claude-code-cursor.json')
    expect(cursorFileName('codex')).toBe('codex-cursor.json')
    expect(cursorFileName('antigravity-cli')).toBe('antigravity-cli-cursor.json')
    expect(cursorFileName('antigravity')).toBe('antigravity-cursor.json')
    expect(cursorFileName('antigravity-ide')).toBe('antigravity-ide-cursor.json')
  })

  test('names a distinct cursor file for every source', () => {
    const names = usageSources.map((source) => cursorFileName(source))

    expect(new Set(names).size).toBe(usageSources.length)
    expect(names.every((name) => name.endsWith('-cursor.json'))).toBe(true)
  })

  test('scopes a cursor file per server or profile without colliding across sources', () => {
    const scoped = usageSources.map((source) => cursorFileName(source, 'https://example.test'))

    expect(new Set(scoped).size).toBe(usageSources.length)
    // Codex scopes its cursor per CODEX_HOME profile; every other source scopes per server.
    expect(
      usageSources.every((source, index) => scoped[index].includes(source === 'codex' ? '.profile-' : '.server-'))
    ).toBe(true)
    expect(cursorFileName('opencode', 'https://a.test')).not.toBe(cursorFileName('opencode', 'https://b.test'))
    expect(cursorFileName('codex', 'profile-a')).not.toBe(cursorFileName('codex', 'profile-b'))
  })

  test('round-trips cursor state for every source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-source-'))

    for (const source of usageSources) {
      const cursorPath = join(root, cursorFileName(source))
      await writeCursor(cursorPath, {
        version: 1,
        source,
        files: {
          'session-a': {
            size: 10,
            mtimeMs: 1,
            sha256: 'abc',
            snapshots: [{ ...snapshot, source }],
            missingCost: false,
            updatedAt: '2026-08-14T00:00:00.000Z'
          }
        }
      })

      const restored = await readCursor(cursorPath, source)

      expect(restored.source).toBe(source)
      expect(restored.files['session-a'].snapshots[0].source).toBe(source)
    }
  })

  test('rejects a cursor snapshot naming an unknown source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cursor-unknown-'))
    const cursorPath = join(root, 'opencode-cursor.json')
    await writeCursor(cursorPath, {
      version: 1,
      source: 'opencode',
      files: {
        'session-a': {
          size: 10,
          mtimeMs: 1,
          sha256: 'abc',
          snapshots: [{ ...snapshot, source: 'open-code' as never }],
          missingCost: false,
          updatedAt: '2026-08-14T00:00:00.000Z'
        }
      }
    })

    await expect(readCursor(cursorPath, 'opencode')).rejects.toThrow('Invalid opencode cursor file')
  })
})
