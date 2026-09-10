import { appendFile, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { fingerprintCodexSessionFile } from './codex-session-attribution-cache'
import { withCodexSubagentUsageCache, type CodexSubagentUsageCacheFile } from './codex-subagent-usage-cache'

const usage = [
  {
    usageDate: '2026-07-25',
    inputTokens: 1,
    outputTokens: 2,
    cacheCreationTokens: 3,
    cacheReadTokens: 4,
    totalTokens: 10
  }
]

describe('Codex frozen subagent usage cache', () => {
  test('looks up a frozen file by its original path and copy-time fingerprint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-frozen-hit-'))
    const stateDir = join(root, 'state')
    const source = join(root, 'source.jsonl')
    const frozen = join(root, 'frozen.jsonl')

    try {
      await writeFile(source, '{"type":"event_msg"}\n')
      await copyFile(source, frozen)
      const sourceFingerprint = await fingerprintCodexSessionFile(source)
      await withCodexSubagentUsageCache({
        stateDir,
        timezone: 'UTC',
        readChildUsageByDate: async () => usage,
        callback: (reader) => reader.read(source, '2026-07-25T00:00:00.000Z', 'UTC')
      })
      let uncachedReads = 0

      const result = await withCodexSubagentUsageCache({
        stateDir,
        timezone: 'UTC',
        cacheFiles: frozenCacheFiles(frozen, source, sourceFingerprint),
        readChildUsageByDate: async () => {
          uncachedReads += 1
          return []
        },
        callback: (reader) => reader.read(frozen, '2026-07-25T00:00:00.000Z', 'UTC')
      })

      expect(uncachedReads).toBe(0)
      expect(result).toEqual(usage)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses a stable frozen result without caching it after the source changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-frozen-stale-'))
    const stateDir = join(root, 'state')
    const source = join(root, 'source.jsonl')
    const frozen = join(root, 'frozen.jsonl')
    const warnings: string[] = []

    try {
      await writeFile(source, '{"type":"event_msg"}\n')
      await copyFile(source, frozen)
      const sourceFingerprint = await fingerprintCodexSessionFile(source)
      await appendFile(source, '{"type":"event_msg"}\n')

      const result = await withCodexSubagentUsageCache({
        stateDir,
        timezone: 'UTC',
        cacheFiles: frozenCacheFiles(frozen, source, sourceFingerprint),
        readChildUsageByDate: async () => usage,
        callback: (reader) => reader.read(frozen, '2026-07-25T00:00:00.000Z', 'UTC', (line) => warnings.push(line))
      })

      expect(result).toEqual(usage)
      expect(warnings).toEqual([
        'Skipping stale Codex subagent usage cache write for a session that changed after copy'
      ])
      const cache = JSON.parse(await readFile(join(stateDir, 'codex-subagent-usage-cache.json'), 'utf8')) as {
        entries: Record<string, unknown>
      }
      expect(cache.entries).toEqual({})
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function frozenCacheFiles(
  frozen: string,
  source: string,
  sourceFingerprint: Awaited<ReturnType<typeof fingerprintCodexSessionFile>>
) {
  return new Map<string, CodexSubagentUsageCacheFile>([
    [
      frozen,
      {
        sourceFile: source,
        sourceFingerprint
      }
    ]
  ])
}
