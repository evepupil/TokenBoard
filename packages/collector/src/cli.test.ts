import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import { usageSources, type UsageSnapshot } from '@tokenboard/usage-core'
import { runCollectorCli, transientSyncExitCode } from './cli'
import { attachCodexHookAcknowledgement } from './providers/codex-hook-profiles'
import { cursorSnapshotGroupKey } from './providers/session-cursor'

const claudeSnapshot: UsageSnapshot = {
  source: 'claude-code',
  usageDate: '2026-04-28',
  timezone: 'Asia/Shanghai',
  model: 'claude-sonnet-4-5',
  inputTokens: 1,
  outputTokens: 2,
  cacheCreationTokens: 3,
  cacheReadTokens: 4,
  totalTokens: 10,
  costUsd: 0.01,
  sessionCount: 1,
  collectedAt: '2026-04-28T10:00:00.000Z'
}

const codexSnapshot: UsageSnapshot = {
  ...claudeSnapshot,
  source: 'codex',
  model: 'gpt-5'
}

describe('runCollectorCli', () => {
  test('previews all sources without uploading', async () => {
    const stdout: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      {
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        collectCcusageToolUsage: async () => [],
        uploadSnapshots: async (_config, snapshots) => uploaded.push(snapshots)
      }
    )

    expect(result).toBe(0)
    expect(JSON.parse(stdout[0])).toEqual([claudeSnapshot, codexSnapshot])
    expect(uploaded).toEqual([])
  })

  test('collects a ccusage tool source through the shared provider and reports it as collected', async () => {
    const stdout: string[] = []
    const kimiSnapshot: UsageSnapshot = { ...claudeSnapshot, source: 'kimi', model: 'kimi-k3' }
    const collected: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'kimi'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      {
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => {
          throw new Error('kimi-only test must not collect Claude Code')
        },
        collectCodexUsage: async () => {
          throw new Error('kimi-only test must not collect Codex')
        },
        collectCcusageToolUsage: async (source) => {
          collected.push(source)
          return [kimiSnapshot]
        },
        uploadSnapshots: async () => {
          throw new Error('preview must not upload')
        }
      }
    )

    expect(result).toBe(0)
    expect(collected).toEqual(['kimi'])
    expect(JSON.parse(stdout[0])).toEqual([kimiSnapshot])
  })

  test('skips an empty ccusage tool source as collected with no snapshots', async () => {
    const stdout: string[] = []
    const collected: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'zcode'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      {
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => {
          throw new Error('zcode-only test must not collect Claude Code')
        },
        collectCodexUsage: async () => {
          throw new Error('zcode-only test must not collect Codex')
        },
        collectCcusageToolUsage: async (source) => {
          collected.push(source)
          return []
        },
        uploadSnapshots: async () => {
          throw new Error('preview must not upload')
        }
      }
    )

    expect(result).toBe(0)
    expect(collected).toEqual(['zcode'])
    expect(JSON.parse(stdout[0])).toEqual([])
  })

  test('reports a ccusage tool failure as a source failure instead of crashing the run', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'amp'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => {
          throw new Error('amp-only test must not collect Claude Code')
        },
        collectCodexUsage: async () => {
          throw new Error('amp-only test must not collect Codex')
        },
        collectCcusageToolUsage: async () => {
          throw new Error('ccusage amp command failed')
        },
        uploadSnapshots: async () => {
          throw new Error('preview must not upload')
        }
      }
    )

    expect(result).toBe(1)
    expect(stderr.join('\n')).toContain('amp')
  })

  test('passes explicit date bounds to the Codex provider', async () => {
    const received: Array<{ since?: string; until?: string }> = []

    const result = await runCollectorCli(
      ['preview', '--source', 'codex', '--since', '20260718', '--until', '20260719'],
      {
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_SINCE: '20260101',
        TOKENBOARD_UNTIL: '20260102'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => {
          throw new Error('codex-only test must not collect Claude Code')
        },
        collectCodexUsage: async (options) => {
          received.push({ since: options?.since, until: options?.until })
          return [codexSnapshot]
        },
        uploadSnapshots: async () => {
          throw new Error('preview must not upload')
        }
      }
    )

    expect(result).toBe(0)
    expect(received).toEqual([{ since: '20260718', until: '20260719' }])
  })

  test('passes the configured until environment value to the Codex provider', async () => {
    const received: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'codex'],
      {
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_UNTIL: '20260719'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => {
          throw new Error('codex-only test must not collect Claude Code')
        },
        collectCodexUsage: async (options) => {
          received.push(options?.until ?? '')
          return [codexSnapshot]
        },
        uploadSnapshots: async () => {
          throw new Error('preview must not upload')
        }
      }
    )

    expect(result).toBe(0)
    expect(received).toEqual(['20260719'])
  })

  test('ignores an environment until bound for all-source collection without a CLI flag', async () => {
    const received: Array<{ source: string; until?: string }> = []

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      {
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_UNTIL: '20260719'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async (options) => {
          received.push({ source: 'claude-code', until: options?.until })
          return [claudeSnapshot]
        },
        collectCodexUsage: async (options) => {
          received.push({ source: 'codex', until: options?.until })
          return [codexSnapshot]
        },
        collectCcusageToolUsage: async () => [],
        uploadSnapshots: async () => {
          throw new Error('preview must not upload')
        }
      }
    )

    expect(result).toBe(0)
    expect(received).toEqual([
      { source: 'claude-code', until: '' },
      { source: 'codex', until: '' }
    ])
  })

  test('accepts every source from the shared enum and rejects an unknown one', async () => {
    // `concreteCliSources` is derived from `usageSources`, so each member must parse; the list is
    // read from the package rather than restated here so a new source fails this test, not silently
    // diverges from what the collector accepts.
    for (const source of usageSources) {
      const result = await runCollectorCli(
        ['preview', '--source', source],
        { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
        {
          stdout: () => undefined,
          stderr: () => undefined,
          collectClaudeCodeUsage: async () => [claudeSnapshot],
          collectCodexUsage: async () => [codexSnapshot],
          // A per-source run only invokes this for the ccusage tool family; the real
          // default would spawn the pinned ccusage binary inside the test.
          collectCcusageToolUsage: async () => [],
          uploadSnapshots: async () => {
            throw new Error('preview must not upload')
          }
        }
      )
      expect(result, source).toBe(0)
    }

    const stderr: string[] = []
    const result = await runCollectorCli(
      ['preview', '--source', 'not-a-source'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => {
          throw new Error('preview must not upload')
        }
      }
    )
    expect(result).not.toBe(0)
    expect(stderr.join('\n')).toContain('Invalid source: not-a-source')
  })

  test('builds the usage line from the shared source list', async () => {
    // The help text is the one place a hand-maintained source list used to drift; derive it and
    // assert every shared member shows up, so a new source cannot be missing from the Usage.
    const stderr: string[] = []
    const result = await runCollectorCli(
      ['not-a-command'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => {
          throw new Error('preview must not upload')
        }
      }
    )
    expect(result).not.toBe(0)
    const usage = stderr.join('\n')
    expect(usage).toContain('Usage: tokenboard <preview|sync|warm-hooks>')
    for (const source of usageSources) expect(usage, source).toContain(source)
    expect(usage).toContain('all')
  })

  test.each([
    { source: 'all', label: 'all sources' },
    { source: 'antigravity-cli', label: 'Antigravity' },
    { source: 'pi', label: 'Pi' },
    { source: 'opencode', label: 'OpenCode' },
    { source: 'grok-build', label: 'Grok Build' },
    { source: 'deepseek-harness', label: 'DeepSeek Harness' }
  ])('rejects --until for $label because no upper-bound collector exists', async ({ source }) => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', source, '--until', '20260719'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => {
          throw new Error('unsupported source must not collect Claude Code')
        },
        collectCodexUsage: async () => {
          throw new Error('unsupported source must not collect Codex')
        },
        uploadSnapshots: async () => {
          throw new Error('unsupported source must not upload')
        }
      }
    )

    expect(result).toBe(1)
    expect(stderr).toEqual(['--until is only supported for Claude Code and Codex sources'])
  })

  test('rejects --until in hook mode instead of silently dropping it', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'codex', '--until', '20260719'],
      { TOKENBOARD_HOOK_MODE: '1', TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => {
          throw new Error('hook rejection must happen before collection')
        },
        collectCodexUsage: async () => {
          throw new Error('hook rejection must happen before collection')
        },
        uploadSnapshots: async () => {
          throw new Error('hook rejection must happen before upload')
        }
      }
    )

    expect(result).toBe(1)
    expect(stderr).toEqual(['--until is not supported in hook mode; hook sync computes its own incremental window'])
  })

  test('rejects --until for warm-hooks instead of silently ignoring it', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['warm-hooks', '--source', 'codex', '--until', '20260719'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => {
          throw new Error('warm-hooks must not collect Claude Code')
        },
        collectCodexUsage: async () => {
          throw new Error('warm-hooks must not collect Codex')
        },
        uploadSnapshots: async () => {
          throw new Error('warm-hooks must not upload')
        }
      }
    )

    expect(result).toBe(1)
    expect(stderr).toEqual(['--until is not supported for warm-hooks; the command does not collect usage'])
  })

  test('passes the collector state directory to the Codex provider', async () => {
    const stateDirs: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'codex'],
      { TOKENBOARD_STATE_DIR: '/isolated-state', TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => {
          throw new Error('codex-only test must not collect Claude Code')
        },
        collectCodexUsage: async (options) => {
          stateDirs.push(options?.stateDir ?? '')
          return [codexSnapshot]
        },
        uploadSnapshots: async () => {
          throw new Error('preview must not upload')
        }
      }
    )

    expect(result).toBe(0)
    expect(stateDirs).toEqual(['/isolated-state'])
  })

  test('passes unambiguous JSON Codex homes to the provider', async () => {
    const configuredHomes = ['/profiles/primary,work', '/profiles/secondary']
    const receivedHomes: string[][] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'codex'],
      {
        CODEX_HOME: '/ignored/legacy-home',
        TOKENBOARD_CODEX_HOMES_JSON: JSON.stringify(configuredHomes),
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => {
          throw new Error('codex-only test must not collect Claude Code')
        },
        collectCodexUsage: async (options) => {
          receivedHomes.push(options?.codexHomes ?? [])
          return [codexSnapshot]
        },
        uploadSnapshots: async () => {
          throw new Error('preview must not upload')
        }
      }
    )

    expect(result).toBe(0)
    expect(receivedHomes).toEqual([configuredHomes.map((home) => resolve(home))])
  })

  test('passes the configured Codex symlink roots to the provider', async () => {
    const receivedRoots: Array<readonly string[]> = []

    const result = await runCollectorCli(
      ['preview', '--source', 'codex'],
      {
        TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON: JSON.stringify(['/profiles/archive']),
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => {
          throw new Error('codex-only test must not collect Claude Code')
        },
        collectCodexUsage: async (options) => {
          receivedRoots.push(options?.codexSymlinkRoots ?? [])
          return [codexSnapshot]
        },
        uploadSnapshots: async () => {
          throw new Error('preview must not upload')
        }
      }
    )

    expect(result).toBe(0)
    expect(receivedRoots).toEqual([[resolve('/profiles/archive')]])
  })

  test('leaves Codex symlink roots unset when no configuration is provided', async () => {
    let receivedRoots: readonly string[] | undefined

    const result = await runCollectorCli(
      ['preview', '--source', 'codex'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => {
          throw new Error('codex-only test must not collect Claude Code')
        },
        collectCodexUsage: async (options) => {
          receivedRoots = options?.codexSymlinkRoots
          return [codexSnapshot]
        },
        uploadSnapshots: async () => {
          throw new Error('preview must not upload')
        }
      }
    )

    expect(result).toBe(0)
    expect(receivedRoots).toBeUndefined()
  })

  test('isolates an invalid Codex symlink configuration from other all-source collectors', async () => {
    const stdout: string[] = []
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      {
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON: '{broken-json'
      },
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => {
          throw new Error('Codex collector should not be entered with invalid roots')
        },
        collectCcusageToolUsage: async () => [],
        uploadSnapshots: async () => {
          throw new Error('preview must not upload')
        }
      }
    )

    expect(result).toBe(0)
    expect(JSON.parse(stdout[0])).toEqual([claudeSnapshot])
    expect(stderr.join('\n')).toContain('Invalid TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON')
  })

  test.each([
    {
      label: 'environment endpoint',
      args: ['preview', '--source', 'codex'],
      env: { TOKENBOARD_ENDPOINT: 'not a URL', TOKENBOARD_TIMEZONE: 'Asia/Shanghai' }
    },
    {
      label: 'command endpoint',
      args: ['preview', '--source', 'codex', '--endpoint', 'not a URL'],
      env: { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' }
    }
  ])('previews when the $label is invalid', async ({ args, env }) => {
    const stdout: string[] = []

    const result = await runCollectorCli(args, env, {
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
      collectClaudeCodeUsage: async () => [claudeSnapshot],
      collectCodexUsage: async () => [codexSnapshot],
      uploadSnapshots: async () => {
        throw new Error('preview must not upload')
      }
    })

    expect(result).toBe(0)
    expect(JSON.parse(stdout[0])).toEqual([codexSnapshot])
  })

  // The sync result is the only machine-readable record of a run, and the
  // upload response alone cannot say whether the run spent its time in ccusage
  // or in the upload. Timings ride alongside the upload result, without
  // replacing it.
  test('reports per-phase timings next to the upload result on sync', async () => {
    const stdout: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai'
      },
      {
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => {
          throw new Error('codex-only test must not collect Claude Code')
        },
        collectCodexUsage: async (options) => {
          options?.timings?.record('ccusageDaily', 12.4)
          return [codexSnapshot]
        },
        uploadSnapshots: async () => ({ upserted: 1 })
      }
    )

    expect(result).toBe(0)
    expect(JSON.parse(stdout[0])).toEqual({
      upserted: 1,
      timings: expect.objectContaining({ ccusageDaily: 12, upload: expect.any(Number) })
    })
  })

  test('keeps the preview output a bare snapshot array', async () => {
    const stdout: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'codex'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      {
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => {
          throw new Error('codex-only test must not collect Claude Code')
        },
        collectCodexUsage: async (options) => {
          options?.timings?.record('ccusageDaily', 12.4)
          return [codexSnapshot]
        },
        uploadSnapshots: async () => {
          throw new Error('preview must not upload')
        }
      }
    )

    expect(result).toBe(0)
    expect(JSON.parse(stdout[0])).toEqual([codexSnapshot])
  })

  test('syncs selected source to the configured endpoint with the upload token', async () => {
    const uploaded: Array<{ endpoint: string; uploadToken: string; snapshots: UsageSnapshot[] }> = []

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => {
          throw new Error('codex-only test must not collect Claude Code')
        },
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async (config, snapshots) => {
          uploaded.push({
            endpoint: config.endpoint,
            uploadToken: config.uploadToken,
            snapshots
          })
          return { upserted: snapshots.length }
        }
      }
    )

    expect(result).toBe(0)
    expect(uploaded).toEqual([
      {
        endpoint: 'https://tokenboard.example.com/api/v1/ingest',
        uploadToken: 'test-upload-token',
        snapshots: [codexSnapshot]
      }
    ])
  })

  test('normalizes empty top-level upload errors', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai'
      },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => [],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => {
          throw new Error('')
        }
      }
    )

    expect(result).toBe(1)
    // The empty error message is not transient, so it counts toward the upload
    // pause before the plain normalized line is printed.
    expect(stderr).toEqual(['TokenBoard upload failed (1 consecutive non-transient failures)', 'Error'])
  })

  test('keeps the deferrable exit code in sync with the skill scripts', async () => {
    // The skill scripts cannot import this TypeScript constant, so assert the
    // literal they declare still matches. A drift here would silently disable
    // the scheduled retry fallback for transient network failures.
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const scriptPath = join(__dirname, '..', '..', '..', 'skills', 'tokenboard', 'scripts', 'scheduled-retry.mjs')
    const source = readFileSync(scriptPath, 'utf8')
    const match = /export const transientSyncExitCode = (\d+)/.exec(source)

    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBe(transientSyncExitCode)
  })

  test('reports a transient upload failure as a deferrable sync exit code', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai'
      },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => [],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => {
          throw new Error('fetch failed')
        }
      }
    )

    expect(result).toBe(transientSyncExitCode)
    expect(stderr).toEqual(['fetch failed'])
  })

  test('reports a retryable gateway status as a deferrable sync exit code', async () => {
    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => [],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => {
          throw new Error('Upload failed with status 503')
        }
      }
    )

    expect(result).toBe(transientSyncExitCode)
  })

  test('keeps a non-transient upload rejection a plain failure', async () => {
    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => [],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => {
          throw new Error('Upload failed with status 401')
        }
      }
    )

    expect(result).toBe(1)
  })

  test('hook sync never reports the deferrable exit code', async () => {
    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_HOOK_MODE: '1'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => [],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => {
          throw new Error('fetch failed')
        }
      }
    )

    expect(result).toBe(1)
  })

  test('preview never reports the deferrable exit code for a transient failure', async () => {
    const result = await runCollectorCli(
      ['preview', '--source', 'codex'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => [],
        collectCodexUsage: async () => {
          throw new Error('fetch failed')
        },
        uploadSnapshots: async () => {
          throw new Error('preview must not upload')
        }
      }
    )

    expect(result).toBe(1)
  })

  test('warms hook cursor high-water after a non-hook sync succeeds', async () => {
    const warmed: string[] = []
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1234).mockReturnValue(9999)

    try {
      const result = await runCollectorCli(
        ['sync', '--source', 'codex'],
        {
          CODEX_HOME: '/codex-home',
          TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
          TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
          TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
          TOKENBOARD_SINCE: 'all',
          TOKENBOARD_STATE_DIR: '/state'
        },
        {
          stdout: () => undefined,
          stderr: () => undefined,
          collectClaudeCodeUsage: async () => {
            throw new Error('codex-only test must not collect Claude Code')
          },
          collectCodexUsage: async () => [codexSnapshot],
          uploadSnapshots: async () => ({ upserted: 1 }),
          warmHookCursorHighWater: async (input) => {
            warmed.push(`${input.stateDir}:${input.source}:${input.sessionsDir}:${input.highWaterMs}`)
          }
        }
      )

      expect(result).toBe(0)
      expect(warmed).toEqual([`/state:codex:${join(resolve('/codex-home'), 'sessions')}:1234`])
    } finally {
      now.mockRestore()
    }
  })

  test('warms hook cursor high-water in configured config dir when state dir is unset', async () => {
    const warmed: string[] = []
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1234).mockReturnValue(9999)

    try {
      const result = await runCollectorCli(
        ['sync', '--source', 'codex'],
        {
          CODEX_HOME: '/codex-home',
          TOKENBOARD_CONFIG_DIR: '/custom-tokenboard',
          TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
          TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
          TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
          TOKENBOARD_SINCE: 'all'
        },
        {
          stdout: () => undefined,
          stderr: () => undefined,
          collectClaudeCodeUsage: async () => {
            throw new Error('codex-only test must not collect Claude Code')
          },
          collectCodexUsage: async () => [codexSnapshot],
          uploadSnapshots: async () => ({ upserted: 1 }),
          warmHookCursorHighWater: async (input) => {
            warmed.push(`${input.stateDir}:${input.source}:${input.sessionsDir}:${input.highWaterMs}`)
          }
        }
      )

      expect(result).toBe(0)
      expect(warmed).toEqual([`/custom-tokenboard:codex:${join(resolve('/codex-home'), 'sessions')}:1234`])
    } finally {
      now.mockRestore()
    }
  })

  test('does not warm hook cursor high-water after a bounded non-hook sync', async () => {
    const warmed: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        CODEX_HOME: '/codex-home',
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_SINCE: '20260517',
        TOKENBOARD_STATE_DIR: '/state'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => ({ upserted: 1 }),
        warmHookCursorHighWater: async (input) => {
          warmed.push(`${input.stateDir}:${input.source}`)
        }
      }
    )

    expect(result).toBe(0)
    expect(warmed).toEqual([])
  })

  test('does not warm hook cursor high-water after a full sync bounded by until', async () => {
    const warmed: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        CODEX_HOME: '/codex-home',
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_SINCE: 'all',
        TOKENBOARD_UNTIL: '20260719',
        TOKENBOARD_STATE_DIR: '/state'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => ({ upserted: 1 }),
        warmHookCursorHighWater: async (input) => {
          warmed.push(`${input.stateDir}:${input.source}`)
        }
      }
    )

    expect(result).toBe(0)
    expect(warmed).toEqual([])
  })

  test('does not warm hook cursor high-water during hook sync', async () => {
    const warmed: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        CODEX_HOME: '/codex-home',
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_HOOK_MODE: '1',
        TOKENBOARD_SINCE: 'all',
        TOKENBOARD_STATE_DIR: '/state'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => ({ upserted: 1 }),
        warmHookCursorHighWater: async (input) => {
          warmed.push(`${input.stateDir}:${input.source}`)
        }
      }
    )

    expect(result).toBe(0)
    expect(warmed).toEqual([])
  })

  // The guard above makes a hook run skip the warm, which is right — but applying it to the
  // `warm-hooks` command itself made that command a silent no-op that still printed its
  // `{"warmed":[...]}` payload and exited 0. Nothing distinguished it from a real warm, so an
  // operator could not tell the cursors were never advanced. The combination is meaningless
  // (only the scheduled scan warms), so it is refused the way `--until` already is.
  test('rejects warm-hooks in hook mode instead of reporting a warm it did not do', async () => {
    const stdout: string[] = []
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['warm-hooks', '--source', 'all'],
      { TOKENBOARD_HOOK_MODE: '1', TOKENBOARD_STATE_DIR: '/state' },
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => {
          throw new Error('a rejected warm-hooks run must not collect')
        },
        collectCodexUsage: async () => {
          throw new Error('a rejected warm-hooks run must not collect')
        },
        uploadSnapshots: async () => {
          throw new Error('a rejected warm-hooks run must not upload')
        },
        warmHookCursorHighWater: async () => {
          throw new Error('a rejected warm-hooks run must not touch a cursor')
        }
      }
    )

    expect(result).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toEqual([
      'warm-hooks is not supported in hook mode; a hook run consumes the hook cursors instead of advancing them'
    ])
  })

  test('warms hook cursors without collecting or uploading', async () => {
    const warmed: string[] = []
    const output: string[] = []
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1234).mockReturnValue(9999)

    try {
      const result = await runCollectorCli(
        ['warm-hooks', '--source', 'all'],
        {
          CLAUDE_CONFIG_DIR: '/claude',
          CODEX_HOME: '/codex',
          TOKENBOARD_STATE_DIR: '/state'
        },
        {
          stdout: (line) => output.push(line),
          stderr: () => undefined,
          collectClaudeCodeUsage: async () => {
            throw new Error('should not collect claude')
          },
          collectCodexUsage: async () => {
            throw new Error('should not collect codex')
          },
          uploadSnapshots: async () => {
            throw new Error('should not upload')
          },
          warmHookCursorHighWater: async (input) => {
            warmed.push(`${input.stateDir}:${input.source}:${input.sessionsDir}:${input.highWaterMs}`)
          }
        }
      )

      expect(result).toBe(0)
      expect(warmed).toEqual([
        `/state:claude-code:${join('/claude', 'projects')}:1234`,
        `/state:codex:${join(resolve('/codex'), 'sessions')}:1234`
      ])
      expect(JSON.parse(output[0])).toEqual({ warmed: ['claude-code', 'codex'] })
    } finally {
      now.mockRestore()
    }
  })

  test('warms every configured Codex profile cursor independently', async () => {
    const warmed: Array<{
      cursorScope: string | undefined
      highWaterMs: number
      sessionsDir: string | undefined
      source: string
      stateDir: string
    }> = []
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1234).mockReturnValue(9999)

    try {
      const result = await runCollectorCli(
        ['warm-hooks', '--source', 'codex'],
        {
          CODEX_HOME: '/profiles/first,/profiles/second',
          TOKENBOARD_STATE_DIR: '/state'
        },
        {
          stdout: () => undefined,
          stderr: () => undefined,
          collectClaudeCodeUsage: async () => {
            throw new Error('warm-hooks must not collect Claude Code')
          },
          collectCodexUsage: async () => {
            throw new Error('warm-hooks must not collect Codex')
          },
          uploadSnapshots: async () => {
            throw new Error('warm-hooks must not upload')
          },
          warmHookCursorHighWater: async (input) => {
            warmed.push({
              cursorScope: input.cursorScope,
              highWaterMs: input.highWaterMs,
              sessionsDir: input.sessionsDir,
              source: input.source,
              stateDir: input.stateDir
            })
          }
        }
      )

      expect(result).toBe(0)
      expect(warmed).toEqual([
        {
          cursorScope: resolve('/profiles/first'),
          highWaterMs: 1234,
          sessionsDir: join(resolve('/profiles/first'), 'sessions'),
          source: 'codex',
          stateDir: '/state'
        },
        {
          cursorScope: resolve('/profiles/second'),
          highWaterMs: 1234,
          sessionsDir: join(resolve('/profiles/second'), 'sessions'),
          source: 'codex',
          stateDir: '/state'
        }
      ])
    } finally {
      now.mockRestore()
    }
  })

  test('acks hook cursor only after upload succeeds', async () => {
    const acks: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_HOOK_MODE: '1',
        TOKENBOARD_STATE_DIR: '/state'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => {
          throw new Error('codex-only test must not collect Claude Code')
        },
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => ({ upserted: 1 }),
        clearPendingUploadCursors: async (input) => {
          acks.push(`${input.stateDir}:${input.source}`)
        }
      }
    )

    expect(result).toBe(0)
    expect(acks).toEqual(['/state:codex'])
  })

  test('limits Codex hook acknowledgement to snapshot groups uploaded in the current run', async () => {
    let acknowledged: string[] | undefined

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_HOOK_MODE: '1',
        TOKENBOARD_STATE_DIR: '/state'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => {
          throw new Error('codex-only test must not collect Claude Code')
        },
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => ({ upserted: 1 }),
        clearPendingUploadCursors: async (input) => {
          acknowledged = input.acknowledgedSnapshotGroups
        }
      }
    )

    expect(result).toBe(0)
    expect(acknowledged).toEqual([cursorSnapshotGroupKey(codexSnapshot)])
  })

  test('forwards Codex file-level acknowledgement metadata without snapshot groups', async () => {
    let acknowledgedFiles: ReadonlyArray<{ relativePath: string; sha256: string }> | undefined
    let acknowledgedGroups: string[] | undefined
    const taggedSnapshots = attachCodexHookAcknowledgement(
      [{ ...codexSnapshot }],
      [{ files: [{ relativePath: 'current.jsonl', sha256: 'b'.repeat(64) }] }]
    )

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_HOOK_MODE: '1',
        TOKENBOARD_STATE_DIR: '/state'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => {
          throw new Error('codex-only test must not collect Claude Code')
        },
        collectCodexUsage: async () => taggedSnapshots,
        uploadSnapshots: async () => ({ upserted: 1 }),
        clearPendingUploadCursors: async (input) => {
          acknowledgedFiles = input.acknowledgedSnapshotFiles
          acknowledgedGroups = input.acknowledgedSnapshotGroups
        }
      }
    )

    expect(result).toBe(0)
    expect(acknowledgedFiles).toEqual([{ relativePath: 'current.jsonl', sha256: 'b'.repeat(64) }])
    expect(acknowledgedGroups).toBeUndefined()
  })

  test('keeps Codex hook acknowledgement attachment idempotent', async () => {
    const snapshots = [{ ...codexSnapshot }]
    const files = [{ files: [{ relativePath: 'current.jsonl', sha256: 'c'.repeat(64) }] }]

    expect(() => attachCodexHookAcknowledgement(snapshots, files)).not.toThrow()
    expect(() => attachCodexHookAcknowledgement(snapshots, files)).not.toThrow()
  })

  test('acks legacy and every configured Codex profile cursor after a hook upload succeeds', async () => {
    const acks: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        CODEX_HOME: '/profiles/first,/profiles/second',
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_HOOK_MODE: '1',
        TOKENBOARD_STATE_DIR: '/state'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => {
          throw new Error('codex-only test must not collect Claude Code')
        },
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => ({ upserted: 1 }),
        clearPendingUploadCursors: async (input) => {
          acks.push(`${input.stateDir}:${input.source}:${input.cursorScope ?? 'legacy'}`)
        }
      }
    )

    expect(result).toBe(0)
    expect(acks).toEqual([
      '/state:codex:legacy',
      `/state:codex:${resolve('/profiles/first')}`,
      `/state:codex:${resolve('/profiles/second')}`
    ])
  })

  test('acks the legacy and active profile cursor after a single-profile legacy migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cli-codex-legacy-ack-'))
    const stateDir = join(root, 'state')
    const codexHome = join(root, 'codex')
    const acks: string[] = []

    try {
      await mkdir(stateDir, { recursive: true })
      await writeFile(
        join(stateDir, 'codex-cursor.json'),
        `${JSON.stringify({
          version: 1,
          source: 'codex',
          files: {}
        })}\n`
      )

      const result = await runCollectorCli(
        ['sync', '--source', 'codex'],
        {
          CODEX_HOME: codexHome,
          TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
          TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
          TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
          TOKENBOARD_HOOK_MODE: '1',
          TOKENBOARD_STATE_DIR: stateDir
        },
        {
          stdout: () => undefined,
          stderr: () => undefined,
          collectClaudeCodeUsage: async () => {
            throw new Error('codex-only test must not collect Claude Code')
          },
          collectCodexUsage: async () => [codexSnapshot],
          uploadSnapshots: async () => ({ upserted: 1 }),
          clearPendingUploadCursors: async (input) => {
            acks.push(input.cursorScope ?? 'legacy')
          }
        }
      )

      expect(result).toBe(0)
      expect(acks).toEqual(['legacy', resolve(codexHome)])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('holds the collector run lock through collection, upload, and acknowledgement', async () => {
    const events: string[] = []
    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_HOOK_MODE: '1',
        TOKENBOARD_STATE_DIR: '/state'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        withCursorLock: async (path, callback) => {
          events.push(`lock:${path}`)
          const value = await callback()
          events.push('unlock')
          return value
        },
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => {
          events.push('collect')
          return [codexSnapshot]
        },
        uploadSnapshots: async () => {
          events.push('upload')
          return { upserted: 1 }
        },
        clearPendingUploadCursors: async () => {
          events.push('ack')
        }
      }
    )

    expect(result).toBe(0)
    expect(events).toEqual([`lock:${join('/state', 'collector-run')}`, 'collect', 'upload', 'ack', 'unlock'])
  })

  test('acks hook cursor in configured config dir when state dir is unset', async () => {
    const acks: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_CONFIG_DIR: '/custom-tokenboard',
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_HOOK_MODE: '1'
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => ({ upserted: 1 }),
        clearPendingUploadCursors: async (input) => {
          acks.push(`${input.stateDir}:${input.source}`)
        }
      }
    )

    expect(result).toBe(0)
    expect(acks).toEqual(['/custom-tokenboard:codex'])
  })

  test('does not ack hook cursor when upload fails', async () => {
    const stderr: string[] = []
    const acks: string[] = []
    const stateDir = await mkdtemp(join(tmpdir(), 'cli-ack-fail-'))

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_HOOK_MODE: '1',
        TOKENBOARD_STATE_DIR: stateDir
      },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => {
          throw new Error('upload failed')
        },
        clearPendingUploadCursors: async (input) => {
          acks.push(`${input.stateDir}:${input.source}`)
        }
      }
    )

    expect(result).toBe(1)
    // The non-transient failure records the backoff against the (writable) temp state
    // directory before the normalized error is re-emitted.
    expect(stderr.length).toBe(2)
    expect(stderr[0]).toContain('1 consecutive non-transient failures')
    expect(stderr[1]).toBe('upload failed')
    expect(acks).toEqual([])
    await rm(stateDir, { recursive: true, force: true })
  })

  test('does not ack hook cursor when sync config is missing', async () => {
    const stderr: string[] = []
    const acks: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'codex'],
      {
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_HOOK_MODE: '1',
        TOKENBOARD_STATE_DIR: '/state'
      },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => ({ upserted: 1 }),
        clearPendingUploadCursors: async (input) => {
          acks.push(`${input.stateDir}:${input.source}`)
        }
      }
    )

    expect(result).toBe(1)
    expect(stderr[0]).toContain('TOKENBOARD_ENDPOINT')
    expect(stderr[0]).toContain('TOKENBOARD_UPLOAD_TOKEN')
    expect(acks).toEqual([])
  })

  test('returns an error when sync is missing endpoint or token', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['sync'],
      {},
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => ({ upserted: 0 })
      }
    )

    expect(result).toBe(1)
    expect(stderr[0]).toContain('TOKENBOARD_ENDPOINT')
    expect(stderr[0]).toContain('TOKENBOARD_UPLOAD_TOKEN')
  })

  test('warns and continues when one source is unavailable in all mode', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai'
      },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => {
          throw new Error('No valid Claude data directories found')
        },
        collectCodexUsage: async () => [codexSnapshot],
        collectCcusageToolUsage: async () => [],
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length }
        }
      }
    )

    expect(result).toBe(0)
    expect(stderr).toEqual(['Skipping claude-code source: No valid Claude data directories found'])
    expect(uploaded).toEqual([[codexSnapshot]])
  })

  test('returns failure after uploading available sources when strict source errors are enabled', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_FAIL_ON_SOURCE_ERROR: '1'
      },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => {
          throw new Error('No valid Claude data directories found')
        },
        collectCodexUsage: async () => [codexSnapshot],
        collectCcusageToolUsage: async () => [],
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length }
        }
      }
    )

    expect(result).toBe(1)
    expect(stderr).toEqual([
      'Skipping claude-code source: No valid Claude data directories found',
      'One or more sources failed: claude-code: No valid Claude data directories found'
    ])
    expect(uploaded).toEqual([[codexSnapshot]])
  })

  test('fails instead of skipping a source in hook all mode', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai',
        TOKENBOARD_HOOK_MODE: '1',
        TOKENBOARD_STATE_DIR: '/state'
      },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => {
          throw new Error('Claude hook reconciliation returned no snapshots')
        },
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length }
        }
      }
    )

    expect(result).toBe(1)
    expect(stderr).toEqual(['Claude hook reconciliation returned no snapshots'])
    expect(uploaded).toEqual([])
  })

  test('fails when the selected source is unavailable', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'claude-code'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_TIMEZONE: 'Asia/Shanghai'
      },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => {
          throw new Error('No valid Claude data directories found')
        },
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async () => ({ upserted: 0 })
      }
    )

    expect(result).toBe(1)
    expect(stderr).toEqual(['No valid Claude data directories found'])
  })

  test('collapses repeated unpriced-model diagnostics into one summary per provider', async () => {
    const stderr: string[] = []
    const unpriced = (model: string) =>
      `TokenBoard model pricing unavailable for Claude Code model ${model}; preserving ccusage result`

    const collectClaudeCodeUsage = async (options?: { stderr?: (line: string) => void }) => {
      options?.stderr?.(unpriced('a'))
      options?.stderr?.(unpriced('a'))
      options?.stderr?.(unpriced('b'))
      return []
    }

    const result = await runCollectorCli(
      ['preview', '--source', 'claude-code'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage,
        collectCodexUsage: async () => [],
        uploadSnapshots: async () => ({ upserted: 0 })
      }
    )

    expect(result).toBe(0)
    const summaries = stderr.filter((line) => line.includes('model pricing unavailable'))
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toContain('2 Claude Code models')
    expect(summaries[0]).toContain('a, b')
  })

  test('a single unpriced-model diagnostic keeps its original single-model wording', async () => {
    const stderr: string[] = []
    const unpriced = (model: string) =>
      `TokenBoard model pricing unavailable for Claude Code model ${model}; preserving ccusage result`

    const collectClaudeCodeUsage = async (options?: { stderr?: (line: string) => void }) => {
      options?.stderr?.(unpriced('only-model'))
      return []
    }

    const result = await runCollectorCli(
      ['preview', '--source', 'claude-code'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      {
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage,
        collectCodexUsage: async () => [],
        uploadSnapshots: async () => ({ upserted: 0 })
      }
    )

    expect(result).toBe(0)
    expect(stderr.filter((line) => line.includes('model pricing unavailable'))).toEqual([
      'TokenBoard model pricing unavailable for Claude Code model only-model; preserving ccusage result'
    ])
  })
})

// The entry guard must canonicalize both paths. Node resolves `import.meta.url` through symlinks
// while `argv[1]` is the typed path, and `resolve()` follows neither — so a symlinked invocation
// made the CLI exit 0 with no output, doing nothing. `sync.mjs` reaches this file through a
// relative path under a `cwd` (which arrives canonicalized), so only a direct symlinked call
// exposes it; that is what this runs.
test('runs when reached through a symlinked path', { timeout: 90_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'tokenboard-cli-symlink-'))
  try {
    const link = join(root, 'cli-linked.ts')
    symlinkSync(fileURLToPath(new URL('./cli.ts', import.meta.url)), link)

    const result = spawnSync(process.execPath, ['--import', 'tsx', link], { encoding: 'utf8', timeout: 90_000 })

    // No command argument, so the CLI reports usage and exits non-zero — the point is that it
    // ran at all, rather than the silent exit 0 a broken guard produces.
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('Usage: tokenboard')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('upload backoff integration', () => {
  test('a paused upload skips uploading, keeps the cursor, and says so', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'cli-backoff-'))
    const stderr: string[] = []
    try {
      // Five consecutive prior failures recorded through the real helper.
      const { recordUploadFailure } = await import('./upload-backoff')
      for (let index = 0; index < 5; index += 1) {
        await recordUploadFailure(stateDir, new Error('status 400 from server'))
      }
      const result = await runCollectorCli(
        ['sync', '--source', 'claude-code', '--endpoint', 'https://collector.example/api/v1/ingest'],
        { TOKENBOARD_TIMEZONE: 'Asia/Shanghai', TOKENBOARD_UPLOAD_TOKEN: 'tb_test', TOKENBOARD_STATE_DIR: stateDir },
        {
          stdout: () => undefined,
          stderr: (line) => stderr.push(line),
          collectClaudeCodeUsage: async () => [claudeSnapshot],
          collectCodexUsage: async () => [],
          uploadSnapshots: async () => {
            throw new Error('upload must be skipped while paused')
          },
          clearPendingUploadCursors: async () => undefined
        }
      )
      expect(result).toBe(0)
      expect(stderr.some((line) => line.includes('upload paused until'))).toBe(true)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('a non-transient upload failure counts toward the pause; success clears', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'cli-backoff-count-'))
    const stderr: string[] = []
    try {
      const uploadSnapshots = async () => {
        throw new Error('status 400 from server')
      }
      const result = await runCollectorCli(
        ['sync', '--source', 'claude-code', '--endpoint', 'https://collector.example/api/v1/ingest'],
        { TOKENBOARD_TIMEZONE: 'Asia/Shanghai', TOKENBOARD_UPLOAD_TOKEN: 'tb_test', TOKENBOARD_STATE_DIR: stateDir },
        {
          stdout: () => undefined,
          stderr: (line) => stderr.push(line),
          collectClaudeCodeUsage: async () => [claudeSnapshot],
          collectCodexUsage: async () => [],
          uploadSnapshots
        }
      )
      expect(result).toBe(1)
      expect(stderr.some((line) => line.includes('1 consecutive non-transient failures'))).toBe(true)
      const { loadUploadBackoff, recordUploadSuccess } = await import('./upload-backoff')
      expect((await loadUploadBackoff(stateDir))?.consecutiveFailures).toBe(1)
      await recordUploadSuccess(stateDir)
      expect(await loadUploadBackoff(stateDir)).toBeNull()
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})
