import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { applyCodexSubagentUsageCorrections } from './codex-subagent-usage'
import { createEmptyCodexHome, writeJsonl } from './codex-test-helpers'
import { inheritedSessionResult, subagentSessionMeta } from './codex-subagent-usage-test-helpers'

describe('Codex subagent session file boundaries', () => {
  test.skipIf(process.platform === 'win32')('rejects a symbolic link child session before reading it', async () => {
    const codexHome = await createEmptyCodexHome()
    const outsideDir = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-outside-'))
    const outsideFile = join(outsideDir, 'outside-child.jsonl')
    const linkedFile = join(codexHome, 'sessions', '2026', '05', '25', 'rollout-child-thread.jsonl')
    let reads = 0

    try {
      await writeJsonl(outsideFile, [subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z')])
      await mkdir(join(codexHome, 'sessions', '2026', '05', '25'), { recursive: true })
      await symlink(outsideFile, linkedFile)

      await expect(
        applyCorrections({
          codexHome,
          onRead: () => {
            reads += 1
          }
        })
      ).rejects.toThrow(/symbolic links are not supported/i)
      expect(reads).toBe(0)
    } finally {
      await Promise.all([
        rm(codexHome, { recursive: true, force: true }),
        rm(outsideDir, { recursive: true, force: true })
      ])
    }
  })

  test.skipIf(process.platform === 'win32')(
    'rejects an intermediate symbolic link before reading a child session',
    async () => {
      const codexHome = await createEmptyCodexHome()
      const outsideDir = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-outside-'))
      const outsideFile = join(outsideDir, '05', '25', 'rollout-child-thread.jsonl')
      const linkedDirectory = join(codexHome, 'sessions', '2026')
      let reads = 0

      try {
        await writeJsonl(outsideFile, [
          subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z')
        ])
        await symlink(outsideDir, linkedDirectory)

        await expect(
          applyCorrections({
            codexHome,
            onRead: () => {
              reads += 1
            }
          })
        ).rejects.toThrow(/symbolic links are not supported/i)
        expect(reads).toBe(0)
      } finally {
        await Promise.all([
          rm(codexHome, { recursive: true, force: true }),
          rm(outsideDir, { recursive: true, force: true })
        ])
      }
    }
  )

  test.skipIf(process.platform === 'win32')('reads an allowed root symlink through its validated target', async () => {
    const codexHome = await createEmptyCodexHome()
    const targetRoot = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-allowed-root-'))
    const linkedRoot = join(codexHome, 'archived_sessions')
    const targetFile = join(targetRoot, '2026', '05', '25', 'rollout-child-thread.jsonl')
    const reads: string[] = []

    try {
      await writeJsonl(targetFile, [subagentSessionMeta('child-thread', 'parent-thread', '2026-05-25T01:00:00.000Z')])
      await symlink(targetRoot, linkedRoot)

      await applyCodexSubagentUsageCorrections({
        snapshots: [codexSnapshot()],
        sessions: inheritedSessionResult(),
        codexHomes: [codexHome],
        timezone: 'Asia/Shanghai',
        codexSymlinkRoots: [targetRoot],
        readChildUsageByDate: async (filePath) => {
          reads.push(filePath)
          return []
        }
      })

      expect(reads).toEqual([await realpath(targetFile)])
    } finally {
      await Promise.all([
        rm(codexHome, { recursive: true, force: true }),
        rm(targetRoot, { recursive: true, force: true })
      ])
    }
  })
})

function applyCorrections(input: { codexHome: string; onRead: () => void }) {
  return applyCodexSubagentUsageCorrections({
    snapshots: [codexSnapshot()],
    sessions: inheritedSessionResult(),
    codexHomes: [input.codexHome],
    timezone: 'Asia/Shanghai',
    readChildUsageByDate: async () => {
      input.onRead()
      return []
    }
  })
}

function codexSnapshot(): UsageSnapshot {
  return {
    source: 'codex',
    usageDate: '2026-05-25',
    timezone: 'Asia/Shanghai',
    model: 'gpt-5',
    inputTokens: 1100,
    outputTokens: 120,
    cacheCreationTokens: 0,
    cacheReadTokens: 1950,
    totalTokens: 3170,
    costUsd: 3.17,
    sessionCount: 1,
    collectedAt: '2026-05-25T01:20:00.000Z'
  }
}
