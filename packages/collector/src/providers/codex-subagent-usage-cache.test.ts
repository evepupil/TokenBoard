import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { retainCacheEntries, withCodexSubagentUsageCache } from './codex-subagent-usage-cache'

// Creating symbolic links requires elevated privileges on Windows; skip the
// symlink-rejection coverage when the environment cannot create one.
const canCreateSymlinks = await (async () => {
  const probeDir = await mkdtemp(join(tmpdir(), 'tokenboard-symlink-probe-'))
  try {
    await symlink(join(probeDir, 'target.jsonl'), join(probeDir, 'link.jsonl'))
    return true
  } catch {
    return false
  } finally {
    await rm(probeDir, { recursive: true, force: true })
  }
})()

describe('Codex subagent usage cache', () => {
  test('bounds entries when one correction uses more than the cache capacity', () => {
    const entries = Object.fromEntries(
      Array.from({ length: 2_001 }, (_, index) => [
        `child-${index}`,
        {
          size: 1,
          mtimeMs: 1,
          tailSha256: 'a'.repeat(64),
          updatedAt: '2026-07-18T00:00:00.000Z',
          usages: []
        }
      ])
    )
    const usedKeys = new Set(Object.keys(entries))

    const retained = retainCacheEntries(entries, usedKeys, Date.parse('2026-07-18T00:00:00.000Z'))

    expect(Object.keys(retained)).toHaveLength(2_000)
  })

  test('rejects an oversized cache before parsing it or invoking the correction callback', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-cache-oversized-'))
    const cachePath = join(stateDir, 'codex-subagent-usage-cache.json')
    let callbackCalled = false

    try {
      await writeFile(cachePath, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20))

      await expect(
        withCodexSubagentUsageCache({
          stateDir,
          timezone: 'UTC',
          readChildUsageByDate: async () => [],
          callback: async () => {
            callbackCalled = true
            return []
          }
        })
      ).rejects.toThrow('Codex subagent usage cache exceeds the 8388608-byte limit')

      expect(callbackCalled).toBe(false)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('rejects an oversized cache before persisting it', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-cache-write-oversized-'))
    const childPath = join(stateDir, 'child.jsonl')
    const cachePath = join(stateDir, 'codex-subagent-usage-cache.json')
    let callbackCalled = false

    try {
      await writeFile(childPath, '{"type":"event_msg"}\n')
      const oversizedUsages = Array.from({ length: 80_000 }, (_, index) => ({
        usageDate: '2026-07-20',
        inputTokens: index,
        outputTokens: index,
        cacheCreationTokens: index,
        cacheReadTokens: index,
        totalTokens: index * 4
      }))

      await expect(
        withCodexSubagentUsageCache({
          stateDir,
          timezone: 'UTC',
          readChildUsageByDate: async () => oversizedUsages,
          callback: async (reader) => {
            callbackCalled = true
            await reader.read(childPath, '2026-07-20T00:00:00.000Z', 'UTC')
          }
        })
      ).rejects.toThrow('Codex subagent usage cache exceeds the 8388608-byte limit')

      expect(callbackCalled).toBe(true)
      await expect(stat(cachePath)).rejects.toMatchObject({ code: 'ENOENT' })

      let recoveryCallbackCalled = false
      const recovered = await withCodexSubagentUsageCache({
        stateDir,
        timezone: 'UTC',
        readChildUsageByDate: async () => [],
        callback: async (reader) => {
          recoveryCallbackCalled = true
          return reader.read(childPath, '2026-07-20T00:00:00.000Z', 'UTC')
        }
      })

      expect(recoveryCallbackCalled).toBe(true)
      expect(recovered).toEqual([])
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('normalizes cache entries written before cache creation token tracking', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-cache-legacy-'))
    const childPath = join(stateDir, 'child.jsonl')
    const cachePath = join(stateDir, 'codex-subagent-usage-cache.json')

    try {
      await writeFile(childPath, '{"type":"event_msg"}\n')
      const content = await readFile(childPath)
      const details = await stat(childPath)
      const key = createHash('sha256').update(childPath).digest('hex')
      await writeFile(
        cachePath,
        `${JSON.stringify({
          version: 1,
          timezone: 'UTC',
          entries: {
            [key]: {
              dev: details.dev,
              ino: details.ino,
              size: details.size,
              mtimeMs: details.mtimeMs,
              ctimeMs: details.ctimeMs,
              tailSha256: createHash('sha256').update(content).digest('hex'),
              updatedAt: '2026-05-25T01:20:00.000Z',
              usages: [
                {
                  usageDate: '2026-05-25',
                  inputTokens: 50,
                  outputTokens: 20,
                  cacheReadTokens: 150,
                  totalTokens: 220
                }
              ]
            }
          }
        })}\n`
      )
      let uncachedReads = 0

      const usages = await withCodexSubagentUsageCache({
        stateDir,
        timezone: 'UTC',
        readChildUsageByDate: async () => {
          uncachedReads += 1
          return []
        },
        callback: (reader) => reader.read(childPath, '2026-05-25T01:00:00.000Z', 'UTC')
      })

      expect(uncachedReads).toBe(0)
      expect(usages).toEqual([
        {
          usageDate: '2026-05-25',
          inputTokens: 50,
          outputTokens: 20,
          cacheCreationTokens: 0,
          cacheReadTokens: 150,
          totalTokens: 220
        }
      ])
      const persisted = JSON.parse(await readFile(cachePath, 'utf8')) as {
        entries: Record<string, { usages: Array<{ cacheCreationTokens?: number }> }>
      }
      expect(persisted.entries[key].usages[0].cacheCreationTokens).toBe(0)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('recomputes a legacy cache entry without persisted file identity', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-cache-identity-'))
    const childPath = join(stateDir, 'child.jsonl')
    const cachePath = join(stateDir, 'codex-subagent-usage-cache.json')
    let uncachedReads = 0

    try {
      await writeFile(childPath, '{"type":"event_msg"}\n')
      await withCodexSubagentUsageCache({
        stateDir,
        timezone: 'UTC',
        readChildUsageByDate: async () => [],
        callback: (reader) => reader.read(childPath, '2026-07-20T00:00:00.000Z', 'UTC')
      })
      const persisted = JSON.parse(await readFile(cachePath, 'utf8')) as {
        entries: Record<string, { dev?: number; ino?: number }>
      }
      const [key] = Object.keys(persisted.entries)
      delete persisted.entries[key].dev
      delete persisted.entries[key].ino
      await writeFile(cachePath, `${JSON.stringify(persisted)}\n`)

      const usages = await withCodexSubagentUsageCache({
        stateDir,
        timezone: 'UTC',
        readChildUsageByDate: async () => {
          uncachedReads += 1
          return [
            {
              usageDate: '2026-07-20',
              inputTokens: 1,
              outputTokens: 2,
              cacheCreationTokens: 3,
              cacheReadTokens: 4,
              totalTokens: 10
            }
          ]
        },
        callback: (reader) => reader.read(childPath, '2026-07-20T00:00:00.000Z', 'UTC')
      })

      expect(uncachedReads).toBe(1)
      expect(usages).toEqual([
        {
          usageDate: '2026-07-20',
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationTokens: 3,
          cacheReadTokens: 4,
          totalTokens: 10
        }
      ])
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('retries an uncached child read once when the session changes during the first read', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-cache-retry-'))
    const childPath = join(stateDir, 'child.jsonl')
    let reads = 0

    try {
      await writeFile(childPath, '{"type":"event_msg"}\n')
      const first = await withCodexSubagentUsageCache({
        stateDir,
        timezone: 'UTC',
        readChildUsageByDate: async () => {
          reads += 1
          if (reads === 1) {
            await appendFile(childPath, '{"type":"event_msg"}\n')
          }
          return [
            {
              usageDate: '2026-07-20',
              inputTokens: 1,
              outputTokens: 2,
              cacheCreationTokens: 3,
              cacheReadTokens: 4,
              totalTokens: 10
            }
          ]
        },
        callback: (reader) => reader.read(childPath, '2026-07-20T00:00:00.000Z', 'UTC')
      })

      const second = await withCodexSubagentUsageCache({
        stateDir,
        timezone: 'UTC',
        readChildUsageByDate: async () => {
          reads += 1
          return []
        },
        callback: (reader) => reader.read(childPath, '2026-07-20T00:00:00.000Z', 'UTC')
      })

      expect(reads).toBe(2)
      expect(second).toEqual(first)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('fails without caching an uncached child session that keeps changing', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-cache-unstable-'))
    const childPath = join(stateDir, 'child.jsonl')
    const cachePath = join(stateDir, 'codex-subagent-usage-cache.json')
    let reads = 0

    try {
      await writeFile(childPath, '{"type":"event_msg"}\n')
      await expect(
        withCodexSubagentUsageCache({
          stateDir,
          timezone: 'UTC',
          readChildUsageByDate: async () => {
            reads += 1
            await appendFile(childPath, '{"type":"event_msg"}\n')
            return []
          },
          callback: (reader) => reader.read(childPath, '2026-07-20T00:00:00.000Z', 'UTC')
        })
      ).rejects.toThrow('Codex child session changed while correcting; retry the sync')

      expect(reads).toBe(2)
      await expect(stat(cachePath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test.skipIf(!canCreateSymlinks)(
    'rejects a symbolic link even when it resolves to an unchanged cached child session',
    async () => {
      const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-cache-symlink-'))
      const childPath = join(stateDir, 'child.jsonl')
      const targetPath = join(stateDir, 'child-target.jsonl')

      try {
        await writeFile(childPath, '{"type":"event_msg"}\n')
        await withCodexSubagentUsageCache({
          stateDir,
          timezone: 'UTC',
          readChildUsageByDate: async () => [],
          callback: (reader) => reader.read(childPath, '2026-07-20T00:00:00.000Z', 'UTC')
        })
        await rename(childPath, targetPath)
        await symlink(targetPath, childPath)

        await expect(
          withCodexSubagentUsageCache({
            stateDir,
            timezone: 'UTC',
            readChildUsageByDate: async () => {
              throw new Error('cache lookup must reject the symbolic link before reading it')
            },
            callback: (reader) => reader.read(childPath, '2026-07-20T00:00:00.000Z', 'UTC')
          })
        ).rejects.toThrow('Unable to fingerprint Codex child session: symbolic links are not supported')
      } finally {
        await rm(stateDir, { recursive: true, force: true })
      }
    }
  )
})
