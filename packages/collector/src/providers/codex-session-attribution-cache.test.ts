import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

const fingerprintRace = vi.hoisted(() => ({
  enabled: false,
  filePath: '',
  lstatCalls: 0,
  shortReadPath: '',
  shortReadLimit: 0,
  shortReadCalls: 0
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      if (args[0] !== fingerprintRace.shortReadPath) return handle
      const originalRead = handle.read.bind(handle)
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property !== 'read') return Reflect.get(target, property, receiver)
          return async (buffer: Buffer, offset: number, length: number, position: number) => {
            fingerprintRace.shortReadCalls += 1
            return originalRead(buffer, offset, Math.min(length, fingerprintRace.shortReadLimit), position)
          }
        }
      })
    },
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const details = await fs.lstat(...args)
      if (fingerprintRace.enabled && args[0] === fingerprintRace.filePath) {
        fingerprintRace.lstatCalls += 1
        if (fingerprintRace.lstatCalls === 2) {
          return Object.assign(Object.create(details), { ctimeMs: Number(details.ctimeMs) + 1 })
        }
      }
      return details
    }
  }
})
import {
  fingerprintCodexSessionFile,
  retainCacheEntries,
  withCodexSessionAttributionCache
} from './codex-session-attribution-cache'

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

describe('Codex session attribution cache', () => {
  test('rejects a cache hit when its source session changes before the transaction finishes', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-state-'))
    const sourceDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-source-'))
    const sessionFile = join(sourceDir, 'session.jsonl')

    try {
      await writeFile(sessionFile, '{"type":"event_msg"}\n')
      await withCodexSessionAttributionCache({
        stateDir,
        timezone: 'Asia/Shanghai',
        callback: async (cache) => {
          const cached = await cache.lookup(sessionFile)
          expect(cached.attribution).toBeNull()
          await cache.store({
            filePath: sessionFile,
            fingerprint: cached.fingerprint,
            attribution: { usageDate: '2026-05-21', model: 'gpt-5.6' }
          })
        }
      })

      await expect(
        withCodexSessionAttributionCache({
          stateDir,
          timezone: 'Asia/Shanghai',
          callback: async (cache) => {
            const cached = await cache.lookup(sessionFile)
            expect(cached.attribution).toEqual({ usageDate: '2026-05-21', model: 'gpt-5.6' })
            await writeFile(sessionFile, '{"type":"event_msg","updated":true}\n')
          }
        })
      ).rejects.toThrow('Codex session changed while resolving canonical attribution; retry the sync')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  test('reports a retryable change when an observed source disappears before commit', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-state-'))
    const sourceDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-source-'))
    const sessionFile = join(sourceDir, 'session.jsonl')

    try {
      await writeFile(sessionFile, '{"type":"event_msg"}\n')

      await expect(
        withCodexSessionAttributionCache({
          stateDir,
          timezone: 'Asia/Shanghai',
          callback: async (cache) => {
            await cache.lookup(sessionFile)
            await unlink(sessionFile)
          }
        })
      ).rejects.toThrow('Codex session changed while resolving canonical attribution; retry the sync')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  test('fills a session tail across short reads before hashing it', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-source-'))
    const sessionFile = join(sourceDir, 'session.jsonl')
    try {
      await writeFile(sessionFile, 'x'.repeat(128 * 1024))
      fingerprintRace.shortReadPath = sessionFile
      fingerprintRace.shortReadLimit = 97
      fingerprintRace.shortReadCalls = 0

      const fingerprint = await fingerprintCodexSessionFile(sessionFile)

      expect(fingerprint.tailSha256).toBe(
        createHash('sha256')
          .update('x'.repeat(64 * 1024))
          .digest('hex')
      )
      expect(fingerprintRace.shortReadCalls).toBeGreaterThan(1)
    } finally {
      fingerprintRace.shortReadPath = ''
      fingerprintRace.shortReadLimit = 0
      fingerprintRace.shortReadCalls = 0
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  test('skips an optional prewarm write when its source changed after a frozen copy', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-state-'))
    const sourceDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-source-'))
    const sessionFile = join(sourceDir, 'session.jsonl')

    try {
      await writeFile(sessionFile, '{"type":"event_msg"}\n')
      const frozenFingerprint = await fingerprintCodexSessionFile(sessionFile)
      await writeFile(sessionFile, '{"type":"event_msg","updated":true}\n')

      await withCodexSessionAttributionCache({
        stateDir,
        timezone: 'Asia/Shanghai',
        callback: async (cache) => {
          await expect(
            cache.storeIfUnchanged({
              filePath: sessionFile,
              fingerprint: frozenFingerprint,
              attribution: { usageDate: '2026-05-21', model: 'gpt-5.6' }
            })
          ).resolves.toBe(false)
        }
      })
    } finally {
      await rm(stateDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  test('skips an optional prewarm write when its source disappeared after a frozen copy', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-state-'))
    const sourceDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-source-'))
    const sessionFile = join(sourceDir, 'session.jsonl')

    try {
      await writeFile(sessionFile, '{"type":"event_msg"}\n')
      const frozenFingerprint = await fingerprintCodexSessionFile(sessionFile)
      await unlink(sessionFile)

      await withCodexSessionAttributionCache({
        stateDir,
        timezone: 'Asia/Shanghai',
        callback: async (cache) => {
          await expect(
            cache.storeIfUnchanged({
              filePath: sessionFile,
              fingerprint: frozenFingerprint,
              attribution: { usageDate: '2026-05-21', model: 'gpt-5.6' }
            })
          ).resolves.toBe(false)
        }
      })
    } finally {
      await rm(stateDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  test('skips an optional prewarm write when the source changes while fingerprinting', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-state-'))
    const sourceDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-source-'))
    const sessionFile = join(sourceDir, 'session.jsonl')

    try {
      await writeFile(sessionFile, '{"type":"event_msg"}\n')
      const frozenFingerprint = await fingerprintCodexSessionFile(sessionFile)
      fingerprintRace.enabled = true
      fingerprintRace.filePath = sessionFile
      fingerprintRace.lstatCalls = 0

      await withCodexSessionAttributionCache({
        stateDir,
        timezone: 'Asia/Shanghai',
        callback: async (cache) => {
          await expect(
            cache.storeIfUnchanged({
              filePath: sessionFile,
              fingerprint: frozenFingerprint,
              attribution: { usageDate: '2026-05-21', model: 'gpt-5.6' }
            })
          ).resolves.toBe(false)
        }
      })
    } finally {
      fingerprintRace.enabled = false
      fingerprintRace.filePath = ''
      fingerprintRace.lstatCalls = 0
      await rm(stateDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  test('reuses an attribution that matches a frozen fingerprint after the live source changes', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-state-'))
    const sourceDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-source-'))
    const sessionFile = join(sourceDir, 'session.jsonl')

    try {
      await writeFile(sessionFile, '{"type":"event_msg"}\n')
      const frozenFingerprint = await fingerprintCodexSessionFile(sessionFile)
      await withCodexSessionAttributionCache({
        stateDir,
        timezone: 'Asia/Shanghai',
        callback: async (cache) => {
          await cache.store({
            filePath: sessionFile,
            fingerprint: frozenFingerprint,
            attribution: { usageDate: '2026-05-21', model: 'gpt-5.6' }
          })
        }
      })
      await writeFile(sessionFile, '{"type":"event_msg","updated":true}\n')

      await withCodexSessionAttributionCache({
        stateDir,
        timezone: 'Asia/Shanghai',
        callback: async (cache) => {
          expect(cache.lookupByFingerprint({ filePath: sessionFile, fingerprint: frozenFingerprint })).toEqual({
            usageDate: '2026-05-21',
            model: 'gpt-5.6'
          })
        }
      })
    } finally {
      await rm(stateDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  test('does not reuse a legacy attribution cache entry without persisted file identity', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-state-'))
    const sourceDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-source-'))
    const sessionFile = join(sourceDir, 'session.jsonl')
    const cachePath = join(stateDir, 'codex-session-attribution-cache.json')

    try {
      await writeFile(sessionFile, '{"type":"event_msg"}\n')
      const details = await stat(sessionFile)
      const content = await readFile(sessionFile)
      const key = createHash('sha256').update(sessionFile).digest('hex')
      await writeFile(
        cachePath,
        `${JSON.stringify({
          version: 1,
          timezone: 'Asia/Shanghai',
          entries: {
            [key]: {
              size: details.size,
              mtimeMs: details.mtimeMs,
              ctimeMs: details.ctimeMs,
              tailSha256: createHash('sha256').update(content).digest('hex'),
              updatedAt: '2026-07-20T00:00:00.000Z',
              usageDate: '2026-07-20',
              model: 'gpt-5.6'
            }
          }
        })}\n`
      )

      await withCodexSessionAttributionCache({
        stateDir,
        timezone: 'Asia/Shanghai',
        callback: async (cache) => {
          const cached = await cache.lookup(sessionFile)
          expect(cached.attribution).toBeNull()
        }
      })
    } finally {
      await rm(stateDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  test.skipIf(!canCreateSymlinks)('rejects a symbolic link substituted for an attribution cache source', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-state-'))
    const sourceDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-source-'))
    const sessionFile = join(sourceDir, 'session.jsonl')
    const targetFile = join(sourceDir, 'session-target.jsonl')

    try {
      await writeFile(sessionFile, '{"type":"event_msg"}\n')
      await withCodexSessionAttributionCache({
        stateDir,
        timezone: 'Asia/Shanghai',
        callback: async (cache) => {
          const cached = await cache.lookup(sessionFile)
          await cache.store({
            filePath: sessionFile,
            fingerprint: cached.fingerprint,
            attribution: { usageDate: '2026-05-21', model: 'gpt-5.6' }
          })
        }
      })
      await rename(sessionFile, targetFile)
      await symlink(targetFile, sessionFile)

      await expect(
        withCodexSessionAttributionCache({
          stateDir,
          timezone: 'Asia/Shanghai',
          callback: (cache) => cache.lookup(sessionFile)
        })
      ).rejects.toThrow('Unable to inspect Codex session file: symbolic links are not supported')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
      await rm(sourceDir, { recursive: true, force: true })
    }
  })

  test('rejects a malformed cache instead of silently ignoring it', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-state-'))

    try {
      await writeFile(join(stateDir, 'codex-session-attribution-cache.json'), '{invalid')
      await expect(
        withCodexSessionAttributionCache({
          stateDir,
          timezone: 'Asia/Shanghai',
          callback: async () => undefined
        })
      ).rejects.toThrow('Invalid Codex session attribution cache JSON')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('rejects an oversized cache before parsing it', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'tokenboard-codex-attribution-state-'))

    try {
      await writeFile(join(stateDir, 'codex-session-attribution-cache.json'), 'x'.repeat(9 * 1024 * 1024))
      await expect(
        withCodexSessionAttributionCache({
          stateDir,
          timezone: 'Asia/Shanghai',
          callback: async () => undefined
        })
      ).rejects.toThrow('Codex session attribution cache exceeds the 8388608-byte limit')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('bounds retained entries by serialized size as well as entry count', () => {
    const nowMs = Date.parse('2026-09-02T00:00:00.000Z')
    const entries = Object.fromEntries(
      Array.from({ length: 20_000 }, (_, index) => {
        const key = index.toString(16).padStart(64, '0')
        return [
          key,
          {
            dev: 1,
            ino: index + 1,
            size: 1,
            mtimeMs: 1,
            ctimeMs: 1,
            tailSha256: 'a'.repeat(64),
            updatedAt: new Date(nowMs - 20_000 + index).toISOString(),
            usageDate: '2026-09-01',
            model: 'model-' + 'x'.repeat(500)
          }
        ]
      })
    )
    const usedKeys = new Set(Object.keys(entries))

    const retained = retainCacheEntries(entries, usedKeys, nowMs, 'UTC')
    const serialized = JSON.stringify({ version: 1, timezone: 'UTC', entries: retained }) + '\n'

    expect(Object.keys(retained).length).toBeLessThanOrEqual(20_000)
    expect(Object.keys(retained).length).toBeLessThan(20_000)
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(retained['0'.repeat(64)]).toBeUndefined()
    expect(retained[(19_999).toString(16).padStart(64, '0')]).toBeDefined()
  })
})
