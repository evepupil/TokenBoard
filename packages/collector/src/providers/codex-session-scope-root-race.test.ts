import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

const race = vi.hoisted(() => ({
  path: '',
  calls: 0,
  statPath: '',
  statCalls: 0,
  statMissing: false
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const details = await fs.lstat(...args)
      if (args[0] === race.path) {
        race.calls += 1
        if (race.calls === 2) {
          const error = new Error('session root disappeared') as NodeJS.ErrnoException
          error.code = 'ENOENT'
          throw error
        }
      }
      return details
    },
    stat: async (...args: Parameters<typeof fs.stat>) => {
      if (race.statMissing && args[0] === race.statPath) {
        race.statCalls += 1
        if (race.statCalls === 1) {
          const error = new Error('resolved session root disappeared') as NodeJS.ErrnoException
          error.code = 'ENOENT'
          throw error
        }
      }
      return fs.stat(...args)
    }
  }
})

import { createCodexSessionScope } from './codex-session-scope'

describe('Codex session scope root races', () => {
  test('skips a session root removed after it was resolved', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-codex-session-root-race-'))
    race.path = join(codexHome, 'sessions')
    race.calls = 0
    race.statPath = ''
    race.statCalls = 0
    race.statMissing = false
    try {
      await mkdir(race.path)

      await expect(
        createCodexSessionScope({
          codexHome,
          since: 'all'
        })
      ).resolves.toBeNull()
      expect(race.calls).toBe(2)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  test('skips a non-symlink session root removed after realpath resolution', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-codex-session-root-race-'))
    race.path = ''
    race.calls = 0
    race.statPath = join(codexHome, 'sessions')
    race.statCalls = 0
    race.statMissing = true
    try {
      await mkdir(race.statPath)
      race.statPath = await realpath(race.statPath)

      await expect(
        createCodexSessionScope({
          codexHome,
          since: 'all'
        })
      ).resolves.toBeNull()
      expect(race.statCalls).toBe(1)
    } finally {
      race.statMissing = false
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})
