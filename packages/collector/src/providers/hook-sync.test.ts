import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { collectCodexUsage } from './codex'
import { assertHookReconciliationSnapshots } from './hook-incremental'
import { clearPendingUploadCursors } from './session-cursor'

const canDenyFileReadWithModeBits = process.platform !== 'win32' && process.getuid?.() !== 0

describe('hook sync collection', () => {
  test('reconciles explicitly provided keys even when expected dates are empty', () => {
    expect(() => assertHookReconciliationSnapshots({
      sourceLabel: 'Codex',
      expectedDates: [],
      expectedKeys: [{ usageDate: '2026-05-22', model: 'gpt-5' }],
      snapshots: []
    })).toThrow(/Codex hook reconciliation returned no snapshots/)
  })

  test('uses configured config dir as hook state dir when state dir is unset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-config-state-'))
    const codexHome = join(root, 'codex')
    const configDir = join(root, 'config')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '22', 'session.jsonl')

    vi.stubEnv('HOME', join(root, 'home'))
    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_CONFIG_DIR', configDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionFile, [
        {
          type: 'event_msg',
          timestamp: '2026-05-22T01:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              model: 'gpt-5',
              last_token_usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                cost_usd: 0.03
              }
            }
          }
        }
      ])

      await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args) {
          if (args.includes('session')) {
            return { data: [{ sessionId: 's1', lastActivity: '2026-05-22T01:00:00.000Z' }] }
          }
          return { data: [{ date: '2026-05-22', model: 'gpt-5', totalTokens: 15, costUSD: 0.03 }] }
        }
      })

      await expect(readFile(join(configDir, 'codex-cursor.json'), 'utf8')).resolves.toContain('session.jsonl')
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses changed Codex session files to run narrow ccusage reconciliation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-sync-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '22', 'session.jsonl')
    const calls: string[][] = []

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionFile, [
        {
          type: 'event_msg',
          timestamp: '2026-05-22T01:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              model: 'gpt-5',
              last_token_usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                cost_usd: 0.03
              }
            }
          }
        }
      ])

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args) {
          calls.push(args)
          if (args.includes('session')) {
            return {
              data: [
                {
                  sessionId: 's1',
                  lastActivity: '2026-05-22T01:00:00.000Z',
                  models: {
                    'gpt-5': {
                      inputTokens: 20,
                      outputTokens: 10
                    }
                  }
                }
              ]
            }
          }
          return {
            data: [
              {
                date: '2026-05-22',
                model: 'gpt-5',
                inputTokens: 20,
                outputTokens: 10,
                totalTokens: 30,
                costUSD: 0.06
              }
            ]
          }
        }
      })

      expect(calls).toEqual([
        ['ccusage@latest', 'codex', 'daily', '--json', '--since', '20260522', '--until', '20260522', '--timezone', 'Asia/Shanghai'],
        ['ccusage@latest', 'codex', 'session', '--json', '--since', '20260522', '--until', '20260522', '--timezone', 'Asia/Shanghai']
      ])
      expect(snapshots).toEqual([
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-22',
          model: 'gpt-5',
          inputTokens: 20,
          outputTokens: 10,
          totalTokens: 30,
          costUsd: 0.06,
          sessionCount: 1
        })
      ])
      await clearPendingUploadCursors({ stateDir, source: 'codex' })

      const second = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:01:00.000Z',
        async runner(_command, args) {
          calls.push(args)
          return { data: [] }
        }
      })

      expect(second).toEqual([])
      expect(calls).toHaveLength(2)
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('runs narrow ccusage reconciliation when Codex parsed cost is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-sync-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '22', 'session.jsonl')
    const calls: string[][] = []

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionFile, [
        {
          type: 'event_msg',
          timestamp: '2026-05-22T01:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              model: 'gpt-5',
              last_token_usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15
              }
            }
          }
        }
      ])

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args) {
          calls.push(args)
          if (args.includes('session')) {
            return {
              data: [
                {
                  sessionId: 's1',
                  lastActivity: '2026-05-22T01:00:00.000Z',
                  models: {
                    'gpt-5': {
                      inputTokens: 10,
                      outputTokens: 5
                    }
                  }
                }
              ]
            }
          }
          return {
            data: [
              {
                date: '2026-05-22',
                model: 'gpt-5',
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15,
                costUSD: 0.03
              }
            ]
          }
        }
      })

      expect(calls).toEqual([
        ['ccusage@latest', 'codex', 'daily', '--json', '--since', '20260522', '--until', '20260522', '--timezone', 'Asia/Shanghai'],
        ['ccusage@latest', 'codex', 'session', '--json', '--since', '20260522', '--until', '20260522', '--timezone', 'Asia/Shanghai']
      ])
      expect(snapshots).toEqual([
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-22',
          model: 'gpt-5',
          totalTokens: 15,
          costUsd: 0.03,
          sessionCount: 1
        })
      ])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('ignores Codex cumulative token_count metadata during hook parsing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-sync-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '22', 'session.jsonl')
    const calls: string[][] = []

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionFile, [
        {
          type: 'event_msg',
          timestamp: '2026-05-22T01:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              model: 'gpt-5',
              total_token_usage: {
                input_tokens: 100,
                output_tokens: 20,
                total_tokens: 120
              }
            }
          }
        },
        {
          type: 'event_msg',
          timestamp: '2026-05-22T01:05:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              model: 'gpt-5',
              last_token_usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                cost_usd: 0.03
              }
            }
          }
        }
      ])

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args) {
          calls.push(args)
          if (args.includes('session')) {
            return {
              data: [
                {
                  sessionId: 's1',
                  lastActivity: '2026-05-22T01:05:00.000Z',
                  models: {
                    'gpt-5': {
                      inputTokens: 10,
                      outputTokens: 5
                    }
                  }
                }
              ]
            }
          }
          return {
            data: [
              {
                date: '2026-05-22',
                model: 'gpt-5',
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15,
                costUSD: 0.03
              }
            ]
          }
        }
      })

      expect(calls).toHaveLength(2)
      expect(snapshots).toEqual([
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-22',
          model: 'gpt-5',
          totalTokens: 15
        })
      ])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not mark metadata-only changed files as pending upload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-sync-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const metadataFile = join(codexHome, 'sessions', '2026', '05', '22', 'metadata.jsonl')
    const usageFile = join(codexHome, 'sessions', '2026', '05', '22', 'usage.jsonl')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')

    try {
      await writeJsonl(metadataFile, [{ type: 'metadata', value: 'no usage' }])
      await writeJsonl(usageFile, [
        {
          type: 'event_msg',
          timestamp: '2026-05-22T01:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              model: 'gpt-5',
              last_token_usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                cost_usd: 0.03
              }
            }
          }
        }
      ])

      await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args) {
          if (args.includes('session')) {
            return {
              data: [
                {
                  sessionId: 's1',
                  lastActivity: '2026-05-22T01:00:00.000Z',
                  models: {
                    'gpt-5': {
                      inputTokens: 10,
                      outputTokens: 5
                    }
                  }
                }
              ]
            }
          }
          return {
            data: [
              {
                date: '2026-05-22',
                model: 'gpt-5',
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15,
                costUSD: 0.03
              }
            ]
          }
        }
      })

      const cursor = JSON.parse(await readFile(join(stateDir, 'codex-cursor.json'), 'utf8'))
      expect(cursor.files['2026/05/22/metadata.jsonl'].pendingUpload).toBeUndefined()
      expect(cursor.files['2026/05/22/usage.jsonl'].pendingUpload).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('recovers from stale missing pending entries that never parsed snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-sync-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const cursorPath = join(stateDir, 'codex-cursor.json')
    const changedFile = join(codexHome, 'sessions', '2026', '05', '23', 'changed.jsonl')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')

    try {
      await mkdir(dirname(cursorPath), { recursive: true })
      await writeFile(cursorPath, `${JSON.stringify({
        version: 1,
        source: 'codex',
        files: {
          '2026/05/22/missing.jsonl': {
            size: 123,
            mtimeMs: Date.parse('2026-05-22T01:00:00.000Z'),
            sha256: 'missing',
            snapshots: [],
            missingCost: false,
            pendingUpload: true,
            updatedAt: '2026-05-22T01:00:00.000Z'
          }
        },
        lastScanHighWaterMs: Date.parse('2026-05-22T01:00:00.000Z')
      }, null, 2)}\n`)
      await writeJsonl(changedFile, [
        {
          type: 'event_msg',
          timestamp: '2026-05-23T01:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              model: 'gpt-5',
              last_token_usage: {
                input_tokens: 20,
                output_tokens: 10,
                total_tokens: 30,
                cost_usd: 0.06
              }
            }
          }
        }
      ])

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-23T10:00:00.000Z',
        async runner(_command, args) {
          if (args.includes('session')) {
            return {
              data: [
                {
                  sessionId: 's2',
                  lastActivity: '2026-05-23T01:00:00.000Z',
                  models: {
                    'gpt-5': {
                      inputTokens: 20,
                      outputTokens: 10
                    }
                  }
                }
              ]
            }
          }
          return {
            data: [
              {
                date: '2026-05-23',
                model: 'gpt-5',
                inputTokens: 20,
                outputTokens: 10,
                totalTokens: 30,
                costUSD: 0.06
              }
            ]
          }
        }
      })

      expect(snapshots).toEqual([
        expect.objectContaining({
          usageDate: '2026-05-23',
          model: 'gpt-5',
          totalTokens: 30
        })
      ])
      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(cursor.files['2026/05/22/missing.jsonl']).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails Codex hook reconciliation when ccusage returns no snapshots for parsed usage dates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-sync-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '22', 'session.jsonl')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')

    try {
      await writeJsonl(sessionFile, [
        {
          type: 'event_msg',
          timestamp: '2026-05-22T01:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              model: 'gpt-5',
              last_token_usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                cost_usd: 0.03
              }
            }
          }
        }
      ])

      await expect(collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner() {
          return { data: [] }
        }
      })).rejects.toThrow(/Codex hook reconciliation returned no snapshots/)

      const cursor = JSON.parse(await readFile(join(stateDir, 'codex-cursor.json'), 'utf8'))
      expect(cursor.files['2026/05/22/session.jsonl'].pendingUpload).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(!canDenyFileReadWithModeBits)('fails Codex hook sync when a new changed session file is unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-sync-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '22', 'session.jsonl')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')

    try {
      await writeJsonl(sessionFile, [
        {
          type: 'event_msg',
          timestamp: '2026-05-22T01:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              model: 'gpt-5',
              last_token_usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                cost_usd: 0.03
              }
            }
          }
        }
      ])
      await chmod(sessionFile, 0o000)

      await expect(collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner() {
          return { data: [] }
        }
      })).rejects.toThrow(/not readable/)

      await expect(readFile(join(stateDir, 'codex-cursor.json'), 'utf8')).rejects.toThrow()
    } finally {
      await chmod(sessionFile, 0o600).catch(() => undefined)
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails Codex hook sync when changed files contain unparsed token-like rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-sync-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '22', 'session.jsonl')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')

    try {
      await writeJsonl(sessionFile, [
        {
          type: 'usage_summary',
          timestamp: '2026-05-22T01:00:00.000Z',
          token_usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            cost_usd: 0.03
          }
        }
      ])

      await expect(collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner() {
          return { data: [] }
        }
      })).rejects.toThrow(/unparsed token-like rows/)

      await expect(readFile(join(stateDir, 'codex-cursor.json'), 'utf8')).rejects.toThrow()
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails Codex hook sync when changed files contain malformed JSONL rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-sync-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '22', 'session.jsonl')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')

    try {
      await mkdir(dirname(sessionFile), { recursive: true })
      await writeFile(sessionFile, '{"type":"event_msg"\n')

      await expect(collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner() {
          return { data: [] }
        }
      })).rejects.toThrow(/malformed JSONL rows/)

      await expect(readFile(join(stateDir, 'codex-cursor.json'), 'utf8')).rejects.toThrow()
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails Codex hook reconciliation when ccusage misses a parsed date and model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-sync-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '22', 'session.jsonl')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')

    try {
      await writeJsonl(sessionFile, [
        {
          type: 'event_msg',
          timestamp: '2026-05-22T01:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              model: 'gpt-5-new',
              last_token_usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                cost_usd: 0.03
              }
            }
          }
        }
      ])

      await expect(collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args) {
          if (args.includes('session')) {
            return {
              data: [
                {
                  sessionId: 's1',
                  lastActivity: '2026-05-22T01:00:00.000Z',
                  models: {
                    'gpt-5-old': {
                      inputTokens: 20,
                      outputTokens: 10
                    }
                  }
                }
              ]
            }
          }
          return {
            data: [
              {
                date: '2026-05-22',
                model: 'gpt-5-old',
                inputTokens: 20,
                outputTokens: 10,
                totalTokens: 30,
                costUSD: 0.06
              }
            ]
          }
        }
      })).rejects.toThrow(/gpt-5-new/)

      const cursor = JSON.parse(await readFile(join(stateDir, 'codex-cursor.json'), 'utf8'))
      expect(cursor.files['2026/05/22/session.jsonl'].pendingUpload).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('allows Codex hook reconciliation by date when the parsed model is unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-sync-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '22', 'session.jsonl')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')

    try {
      await writeJsonl(sessionFile, [
        {
          type: 'event_msg',
          timestamp: '2026-05-22T01:00:00.000Z',
          payload: {
            type: 'token_count',
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
              cost_usd: 0.03
            }
          }
        }
      ])

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args) {
          if (args.includes('session')) {
            return {
              data: [
                {
                  sessionId: 's1',
                  lastActivity: '2026-05-22T01:00:00.000Z',
                  models: {
                    'gpt-5': {
                      inputTokens: 10,
                      outputTokens: 5
                    }
                  }
                }
              ]
            }
          }
          return {
            data: [
              {
                date: '2026-05-22',
                model: 'gpt-5',
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15,
                costUSD: 0.03
              }
            ]
          }
        }
      })

      expect(snapshots).toEqual([
        expect.objectContaining({
          usageDate: '2026-05-22',
          model: 'gpt-5',
          totalTokens: 15
        })
      ])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('recovers Codex hook sync from cached snapshots when pending upload files disappeared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-sync-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '22', 'session.jsonl')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')

    try {
      await writeJsonl(sessionFile, [
        {
          type: 'event_msg',
          timestamp: '2026-05-22T01:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              model: 'gpt-5',
              last_token_usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                cost_usd: 0.03
              }
            }
          }
        }
      ])

      await expect(collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner() {
          return { data: [] }
        }
      })).rejects.toThrow(/Codex hook reconciliation returned no snapshots/)

      await rm(sessionFile)

      const runner = vi.fn(async () => ({ data: [] }))
      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:01:00.000Z',
        runner
      })

      expect(runner).not.toHaveBeenCalled()
      expect(snapshots).toEqual([
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-22',
          model: 'gpt-5',
          totalTokens: 15,
          collectedAt: '2026-05-22T10:01:00.000Z'
        })
      ])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps pending upload entries when retry parses no usage snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-sync-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '22', 'session.jsonl')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')

    try {
      await writeJsonl(sessionFile, [
        {
          type: 'event_msg',
          timestamp: '2026-05-22T01:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              model: 'gpt-5',
              last_token_usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                cost_usd: 0.03
              }
            }
          }
        }
      ])

      await expect(collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner() {
          return { data: [] }
        }
      })).rejects.toThrow(/Codex hook reconciliation returned no snapshots/)

      await writeJsonl(sessionFile, [{ type: 'metadata', value: 'still no usage' }])

      await expect(collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:01:00.000Z',
        async runner() {
          return { data: [] }
        }
      })).rejects.toThrow(/pending upload files with no parsed usage snapshots/)

      const cursor = JSON.parse(await readFile(join(stateDir, 'codex-cursor.json'), 'utf8'))
      expect(cursor.files['2026/05/22/session.jsonl'].pendingUpload).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps pending upload entries when another changed file parses usage snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-sync-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const pendingFile = join(codexHome, 'sessions', '2026', '05', '22', 'pending.jsonl')
    const changedFile = join(codexHome, 'sessions', '2026', '05', '23', 'changed.jsonl')
    const calls: string[][] = []

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')

    try {
      await writeJsonl(pendingFile, [
        {
          type: 'event_msg',
          timestamp: '2026-05-22T01:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              model: 'gpt-5',
              last_token_usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                cost_usd: 0.03
              }
            }
          }
        }
      ])

      await expect(collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner() {
          return { data: [] }
        }
      })).rejects.toThrow(/Codex hook reconciliation returned no snapshots/)

      await writeJsonl(pendingFile, [{ type: 'metadata', value: 'still no usage' }])
      await writeJsonl(changedFile, [
        {
          type: 'event_msg',
          timestamp: '2026-05-23T01:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              model: 'gpt-5',
              last_token_usage: {
                input_tokens: 20,
                output_tokens: 5,
                total_tokens: 25,
                cost_usd: 0.05
              }
            }
          }
        }
      ])

      await expect(collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-23T10:00:00.000Z',
        async runner(_command, args) {
          calls.push(args)
          return { data: [] }
        }
      })).rejects.toThrow(/pending upload files with no parsed usage snapshots/)

      const cursor = JSON.parse(await readFile(join(stateDir, 'codex-cursor.json'), 'utf8'))
      expect(cursor.files['2026/05/22/pending.jsonl'].pendingUpload).toBe(true)
      expect(calls).toEqual([])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('recovers missing pending Codex snapshots while reconciling readable changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-sync-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const pendingFile = join(codexHome, 'sessions', '2026', '05', '22', 'pending.jsonl')
    const changedFile = join(codexHome, 'sessions', '2026', '05', '23', 'changed.jsonl')
    const calls: string[][] = []

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')

    try {
      await writeJsonl(pendingFile, [
        {
          type: 'event_msg',
          timestamp: '2026-05-22T01:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              model: 'gpt-5',
              last_token_usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                cost_usd: 0.03
              }
            }
          }
        }
      ])

      await expect(collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner() {
          return { data: [] }
        }
      })).rejects.toThrow(/Codex hook reconciliation returned no snapshots/)

      await rm(pendingFile)
      await writeJsonl(changedFile, [
        {
          type: 'event_msg',
          timestamp: '2026-05-23T01:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              model: 'gpt-5',
              last_token_usage: {
                input_tokens: 20,
                output_tokens: 10,
                total_tokens: 30,
                cost_usd: 0.06
              }
            }
          }
        }
      ])

      const snapshots = await collectCodexUsage({
        codexHome,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-23T10:00:00.000Z',
        async runner(_command, args) {
          calls.push(args)
          if (args.includes('session')) {
            return {
              data: [
                {
                  sessionId: 's2',
                  lastActivity: '2026-05-23T01:00:00.000Z',
                  models: {
                    'gpt-5': {
                      inputTokens: 20,
                      outputTokens: 10
                    }
                  }
                }
              ]
            }
          }
          return {
            data: [
              {
                date: '2026-05-23',
                model: 'gpt-5',
                inputTokens: 20,
                outputTokens: 10,
                totalTokens: 30,
                costUSD: 0.06
              }
            ]
          }
        }
      })

      expect(calls.length).toBeGreaterThan(0)
      expect(snapshots).toEqual([
        expect.objectContaining({
          usageDate: '2026-05-22',
          model: 'gpt-5',
          totalTokens: 15
        }),
        expect.objectContaining({
          usageDate: '2026-05-23',
          model: 'gpt-5',
          totalTokens: 30
        })
      ])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeJsonl(file: string, rows: unknown[]) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}
