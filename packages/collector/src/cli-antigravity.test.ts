import { describe, expect, test } from 'vitest'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runCollectorCli } from './cli'
import { AntigravityPartialUsageError } from './providers/antigravity-gui'

const antigravitySnapshot: UsageSnapshot = {
  source: 'antigravity-cli',
  usageDate: '2026-06-23',
  timezone: 'Asia/Shanghai',
  model: 'Gemini 3.5 Flash (Medium)',
  inputTokens: 10,
  outputTokens: 2,
  cacheCreationTokens: 0,
  cacheReadTokens: 5,
  totalTokens: 17,
  costUsd: 0,
  sessionCount: 1,
  collectedAt: '2026-06-23T10:00:00.000Z'
}

const claudeSnapshot: UsageSnapshot = {
  ...antigravitySnapshot,
  source: 'claude-code',
  model: 'claude-sonnet-4-5',
  costUsd: 0.01
}

const codexSnapshot: UsageSnapshot = {
  ...antigravitySnapshot,
  source: 'codex',
  model: 'gpt-5',
  costUsd: 0.02
}

describe('runCollectorCli Antigravity source', () => {
  test('previews the selected Antigravity CLI source', async () => {
    const stdout: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'antigravity-cli'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai', TOKENBOARD_STATE_DIR: '/state' },
      deps({
        stdout: (line) => stdout.push(line),
        collectAntigravityCliUsage: async (options) => {
          expect(options?.stateDir).toBe('/state')
          return [antigravitySnapshot]
        }
      })
    )

    expect(result).toBe(0)
    expect(JSON.parse(stdout[0])).toEqual([antigravitySnapshot])
  })

  test('acknowledges only Antigravity snapshot groups uploaded in the current sync', async () => {
    const acknowledgements: Array<{ source: string; groups: string[] | undefined }> = []

    const result = await runCollectorCli(
      ['sync', '--source', 'antigravity-cli'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_STATE_DIR: '/state'
      },
      deps({
        collectAntigravityCliUsage: async () => [antigravitySnapshot],
        uploadSnapshots: async () => ({ upserted: 1, skipped: 0 }),
        clearPendingUploadCursors: async (input) => {
          acknowledgements.push({ source: input.source, groups: input.acknowledgedSnapshotGroups })
        }
      })
    )

    expect(result).toBe(0)
    expect(acknowledgements).toEqual([
      {
        source: 'antigravity-cli',
        groups: [
          [
            antigravitySnapshot.source,
            antigravitySnapshot.usageDate,
            antigravitySnapshot.timezone,
            antigravitySnapshot.model
          ].join('\0')
        ]
      }
    ])
  })

  test('previews the standalone Antigravity source', async () => {
    const stdout: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'antigravity'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai', TOKENBOARD_STATE_DIR: '/state' },
      deps({
        stdout: (line) => stdout.push(line),
        collectAntigravityUsage: async (options) => {
          expect(options?.stateDir).toBe('/state')
          return [{ ...antigravitySnapshot, source: 'antigravity' }]
        }
      })
    )

    expect(result).toBe(0)
    expect(JSON.parse(stdout[0])).toEqual([{ ...antigravitySnapshot, source: 'antigravity' }])
  })

  test.each([
    {
      label: 'environment endpoint',
      args: ['preview', '--source', 'antigravity'],
      env: { TOKENBOARD_ENDPOINT: 'not a URL', TOKENBOARD_STATE_DIR: '/state' }
    },
    {
      label: 'command endpoint',
      args: ['preview', '--source', 'antigravity', '--endpoint', 'not a URL'],
      env: { TOKENBOARD_STATE_DIR: '/state' }
    }
  ])('previews Antigravity without parsing an invalid $label', async ({ args, env }) => {
    const stdout: string[] = []
    const cursorScopes: Array<string | undefined> = []

    const result = await runCollectorCli(
      args,
      env,
      deps({
        stdout: (line) => stdout.push(line),
        collectAntigravityUsage: async (options) => {
          cursorScopes.push(options?.cursorScope)
          return [{ ...antigravitySnapshot, source: 'antigravity' }]
        }
      })
    )

    expect(result).toBe(0)
    expect(cursorScopes).toEqual([undefined])
    expect(JSON.parse(stdout[0])).toEqual([{ ...antigravitySnapshot, source: 'antigravity' }])
  })

  test('previews the standalone Antigravity IDE source', async () => {
    const stdout: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'antigravity-ide'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai', TOKENBOARD_STATE_DIR: '/state' },
      deps({
        stdout: (line) => stdout.push(line),
        collectAntigravityIdeUsage: async (options) => {
          expect(options?.stateDir).toBe('/state')
          return [{ ...antigravitySnapshot, source: 'antigravity-ide' }]
        }
      })
    )

    expect(result).toBe(0)
    expect(JSON.parse(stdout[0])).toEqual([{ ...antigravitySnapshot, source: 'antigravity-ide' }])
  })

  test('treats missing Antigravity CLI history as optional in all mode', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      deps({
        stderr: (line) => stderr.push(line),
        collectAntigravityCliUsage: async () => {
          throw new Error('Antigravity conversations directory not found: /state/antigravity-cli/conversations')
        }
      })
    )

    expect(result).toBe(0)
    expect(stderr).toEqual([
      'Antigravity collection: source=antigravity-cli status=unavailable category=history-unavailable'
    ])
  })

  test.each([
    {
      label: 'endpoint',
      env: { TOKENBOARD_STATE_DIR: '/state', TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token' },
      missing: 'TOKENBOARD_ENDPOINT'
    },
    {
      label: 'upload token',
      env: { TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest', TOKENBOARD_STATE_DIR: '/state' },
      missing: 'TOKENBOARD_UPLOAD_TOKEN'
    }
  ])('does not collect Antigravity before a required sync $label is validated', async ({ env, missing }) => {
    const stderr: string[] = []
    const calls: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'antigravity'],
      env,
      deps({
        stderr: (line) => stderr.push(line),
        collectAntigravityUsage: async () => {
          calls.push('antigravity')
          return [{ ...antigravitySnapshot, source: 'antigravity' }]
        }
      })
    )

    expect(result).toBe(1)
    expect(calls).toEqual([])
    expect(stderr[0]).toContain(missing)
  })

  test('does not fail strict all mode when Antigravity products are not installed', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_FAIL_ON_SOURCE_ERROR: '1'
      },
      deps({
        stderr: (line) => stderr.push(line),
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length, skipped: 0 }
        },
        collectAntigravityCliUsage: async () => {
          throw new Error('Antigravity conversations directory not found: /state/antigravity-cli/conversations')
        },
        collectAntigravityUsage: async () => {
          throw new Error(
            'Antigravity conversations directory not found: /Users/test/.gemini/antigravity/conversations'
          )
        },
        collectAntigravityIdeUsage: async () => {
          throw new Error('No Antigravity conversations found in /Users/test/.gemini/antigravity-ide/conversations')
        }
      })
    )

    expect(result).toBe(0)
    expect(uploaded).toEqual([[]])
    expect(stderr).toEqual([
      'Antigravity collection: source=antigravity-cli status=unavailable category=history-unavailable',
      'Antigravity collection: source=antigravity status=unavailable category=history-unavailable',
      'Antigravity collection: source=antigravity-ide status=unavailable category=history-unavailable'
    ])
  })

  test('does not fail strict all mode when the optional Antigravity SQLite reader is unavailable', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_FAIL_ON_SOURCE_ERROR: '1'
      },
      deps({
        stderr: (line) => stderr.push(line),
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length, skipped: 0 }
        },
        collectAntigravityUsage: async () => {
          throw new Error('Antigravity SQLite reader unavailable: sqlite3 not found')
        }
      })
    )

    expect(result).toBe(0)
    expect(uploaded).toEqual([[]])
    expect(stderr).toEqual([
      'Antigravity collection: source=antigravity status=unavailable category=sqlite-reader-unavailable'
    ])
  })

  test('fails strict all mode when installed Antigravity language-server startup is unavailable', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_FAIL_ON_SOURCE_ERROR: '1'
      },
      deps({
        stderr: (line) => stderr.push(line),
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length, skipped: 0 }
        },
        collectAntigravityUsage: async () => {
          throw new Error('spawn /missing/tokenboard-antigravity-language-server ENOENT')
        }
      })
    )

    expect(result).toBe(1)
    expect(uploaded).toEqual([[]])
    expect(stderr).toEqual([
      'Antigravity collection: source=antigravity status=failed category=language-server-unavailable',
      'One or more sources failed: antigravity: status=failed category=language-server-unavailable'
    ])
  })

  test('fails strict all mode when an installed Antigravity language-server path contains spaces', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_FAIL_ON_SOURCE_ERROR: '1'
      },
      deps({
        stderr: (line) => stderr.push(line),
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length, skipped: 0 }
        },
        collectAntigravityUsage: async () => {
          throw new Error('spawn /Applications/Antigravity Beta.app/Contents/Resources/app/bin/language_server ENOENT')
        }
      })
    )

    expect(result).toBe(1)
    expect(uploaded).toEqual([[]])
    expect(stderr).toEqual([
      'Antigravity collection: source=antigravity status=failed category=language-server-unavailable',
      'One or more sources failed: antigravity: status=failed category=language-server-unavailable'
    ])
  })

  test('sanitizes optional Antigravity errors before writing stderr', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      {},
      deps({
        stderr: (line) => stderr.push(line),
        collectAntigravityUsage: async () => {
          throw new Error(
            'Antigravity language server exited before it was ready: /Users/private/conversations/session.db RAW_PROCESS_OUTPUT'
          )
        }
      })
    )

    expect(result).toBe(0)
    expect(stderr).toEqual([
      'Antigravity collection: source=antigravity status=unavailable category=language-server-unavailable'
    ])
    expect(stderr.join('\n')).not.toContain('/Users/private')
    expect(stderr.join('\n')).not.toContain('RAW_PROCESS_OUTPUT')
  })

  test.each(['0', 'false'])('treats TOKENBOARD_FAIL_ON_SOURCE_ERROR=%s as disabled', async (value) => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      { TOKENBOARD_FAIL_ON_SOURCE_ERROR: value },
      deps({
        stderr: (line) => stderr.push(line),
        collectAntigravityUsage: async () => {
          throw new Error('Antigravity language server exited before it was ready')
        }
      })
    )

    expect(result).toBe(0)
    expect(stderr).toEqual([
      'Antigravity collection: source=antigravity status=unavailable category=language-server-unavailable'
    ])
  })

  test('sanitizes partial Antigravity errors before writing stderr', async () => {
    const stderr: string[] = []
    const snapshot = { ...antigravitySnapshot, source: 'antigravity' as const }

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      {},
      deps({
        stderr: (line) => stderr.push(line),
        collectAntigravityUsage: async () => {
          throw new AntigravityPartialUsageError(
            'Antigravity language server unavailable after DB history was collected: /private/bin/language_server RAW_PROCESS_OUTPUT',
            [snapshot]
          )
        }
      })
    )

    expect(result).toBe(0)
    expect(stderr).toEqual([
      'Antigravity collection: source=antigravity status=partial category=language-server-unavailable'
    ])
    expect(stderr.join('\n')).not.toContain('/private/bin')
    expect(stderr.join('\n')).not.toContain('RAW_PROCESS_OUTPUT')
  })

  test('sanitizes fatal Antigravity errors before writing stderr', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'antigravity'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token'
      },
      deps({
        stderr: (line) => stderr.push(line),
        collectAntigravityUsage: async () => {
          throw new Error(
            'Failed to read Antigravity SQLite metadata from /Users/private/conversations/session.db: RAW_SQLITE_OUTPUT'
          )
        }
      })
    )

    expect(result).toBe(1)
    expect(stderr).toEqual(['Antigravity collection: source=antigravity status=failed category=sqlite-read-failed'])
    expect(stderr.join('\n')).not.toContain('/Users/private')
    expect(stderr.join('\n')).not.toContain('RAW_SQLITE_OUTPUT')
  })

  test('sanitizes Antigravity cursor acknowledgement errors before writing stderr', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'antigravity-cli'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_STATE_DIR: '/Users/private/.tokenboard'
      },
      deps({
        stderr: (line) => stderr.push(line),
        collectAntigravityCliUsage: async () => [antigravitySnapshot],
        uploadSnapshots: async () => ({ upserted: 1, skipped: 0 }),
        clearPendingUploadCursors: async () => {
          throw new Error('Invalid antigravity-cli cursor file: /Users/private/.tokenboard/private-cursor.json')
        }
      })
    )

    expect(result).toBe(1)
    expect(stderr).toEqual([
      'Antigravity collection: source=antigravity-cli status=failed category=cursor-state-failed'
    ])
    expect(stderr.join('\n')).not.toContain('/Users/private')
  })

  test('uploads partial DB snapshots and warns when optional Antigravity language server is unavailable', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []
    const snapshot = { ...antigravitySnapshot, source: 'antigravity' as const }

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token'
      },
      deps({
        stderr: (line) => stderr.push(line),
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length, skipped: 0 }
        },
        collectAntigravityUsage: async () => {
          throw new AntigravityPartialUsageError(
            'Antigravity language server unavailable after DB history was collected: spawn /missing/tokenboard-antigravity-language-server ENOENT',
            [snapshot]
          )
        }
      })
    )

    expect(result).toBe(0)
    expect(uploaded).toEqual([[snapshot]])
    expect(stderr).toEqual([
      'Antigravity collection: source=antigravity status=partial category=language-server-unavailable'
    ])
  })

  test('uploads fatal partial Antigravity snapshots before failing all sync', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []
    const snapshot = { ...antigravitySnapshot, source: 'antigravity' as const }

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token'
      },
      deps({
        stderr: (line) => stderr.push(line),
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length, skipped: 0 }
        },
        collectAntigravityUsage: async () => {
          throw new AntigravityPartialUsageError(
            'Antigravity language server collection failed after DB history was collected: Invalid Antigravity generator metadata item 3',
            [snapshot],
            undefined,
            true
          )
        }
      })
    )

    expect(result).toBe(1)
    expect(uploaded).toEqual([[snapshot]])
    expect(stderr).toEqual([
      'Antigravity collection: source=antigravity status=partial category=invalid-metadata',
      'One or more sources failed: antigravity: status=partial category=invalid-metadata'
    ])
  })

  test('fails all preview after printing healthy snapshots for a hard Antigravity error', async () => {
    const stdout: string[] = []
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      {},
      deps({
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        collectAntigravityUsage: async () => {
          throw new Error('Invalid Antigravity generator metadata item 3')
        }
      })
    )

    expect(result).toBe(1)
    expect(JSON.parse(stdout[0])).toEqual([claudeSnapshot, codexSnapshot])
    expect(stderr).toEqual([
      'Antigravity collection: source=antigravity status=failed category=invalid-metadata',
      'One or more sources failed: antigravity: status=failed category=invalid-metadata'
    ])
  })

  test('uploads healthy sources before failing all sync for a hard Antigravity error', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token'
      },
      deps({
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => [claudeSnapshot],
        collectCodexUsage: async () => [codexSnapshot],
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length, skipped: 0 }
        },
        collectAntigravityUsage: async () => {
          throw new Error('Invalid Antigravity generator metadata item 3')
        }
      })
    )

    expect(result).toBe(1)
    expect(uploaded).toEqual([[claudeSnapshot, codexSnapshot]])
    expect(stderr).toEqual([
      'Antigravity collection: source=antigravity status=failed category=invalid-metadata',
      'One or more sources failed: antigravity: status=failed category=invalid-metadata'
    ])
  })

  test('fails strict all mode after uploading partial Antigravity DB snapshots', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []
    const snapshot = { ...antigravitySnapshot, source: 'antigravity' as const }

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_FAIL_ON_SOURCE_ERROR: '1'
      },
      deps({
        stderr: (line) => stderr.push(line),
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length, skipped: 0 }
        },
        collectAntigravityUsage: async () => {
          throw new AntigravityPartialUsageError(
            'Antigravity language server unavailable after DB history was collected: spawn /missing/tokenboard-antigravity-language-server ENOENT',
            [snapshot]
          )
        }
      })
    )

    expect(result).toBe(1)
    expect(uploaded).toEqual([[snapshot]])
    expect(stderr).toEqual([
      'Antigravity collection: source=antigravity status=partial category=language-server-unavailable',
      'One or more sources failed: antigravity: status=partial category=language-server-unavailable'
    ])
  })

  test('uploads partial DB snapshots then fails an explicit Antigravity sync', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []
    const acks: string[] = []
    const snapshot = { ...antigravitySnapshot, source: 'antigravity' as const }

    const result = await runCollectorCli(
      ['sync', '--source', 'antigravity'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_STATE_DIR: '/state'
      },
      deps({
        stderr: (line) => stderr.push(line),
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length, skipped: 0 }
        },
        clearPendingUploadCursors: async (input) => {
          acks.push(`${input.stateDir}:${input.source}`)
        },
        collectAntigravityUsage: async () => {
          throw new AntigravityPartialUsageError(
            'Antigravity language server unavailable after DB history was collected: spawn /missing/tokenboard-antigravity-language-server ENOENT',
            [snapshot]
          )
        }
      })
    )

    expect(result).toBe(1)
    expect(uploaded).toEqual([[snapshot]])
    expect(acks).toEqual(['/state:antigravity'])
    expect(stderr).toEqual([
      'Antigravity collection: source=antigravity status=partial category=language-server-unavailable',
      'One or more sources failed: antigravity: status=partial category=language-server-unavailable'
    ])
  })

  test('fails strict all mode when an installed Antigravity source has a real parse error', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_FAIL_ON_SOURCE_ERROR: '1'
      },
      deps({
        stderr: (line) => stderr.push(line),
        collectAntigravityUsage: async () => {
          throw new Error(
            'Invalid Antigravity generator metadata item 3: inputTokens must be a bounded nonnegative integer'
          )
        }
      })
    )

    expect(result).toBe(1)
    expect(stderr).toEqual([
      'Antigravity collection: source=antigravity status=failed category=invalid-metadata',
      'One or more sources failed: antigravity: status=failed category=invalid-metadata'
    ])
  })

  test.each([
    {
      label: 'metadata response size-limit errors',
      message: 'Antigravity metadata response exceeded the 8388608-byte limit for antigravity',
      category: 'metadata-limit-exceeded'
    },
    {
      label: 'metadata item-limit errors',
      message: 'Antigravity generator metadata response exceeded the 8192-item limit',
      category: 'metadata-limit-exceeded'
    },
    {
      label: 'metadata total-event limit errors',
      message: 'Antigravity language server metadata exceeded the 32768 usage-event limit',
      category: 'metadata-limit-exceeded'
    },
    {
      label: 'metadata invalid JSON errors',
      message: 'Antigravity metadata request returned invalid JSON for antigravity: Unexpected token',
      category: 'invalid-metadata'
    },
    {
      label: 'metadata HTTP errors',
      message: 'Antigravity metadata request failed for antigravity: HTTP 500',
      category: 'language-server-unavailable'
    },
    {
      label: 'bounded SQLite scans that require a full baseline',
      message:
        'Antigravity CLI requires --since all before a bounded scan can complete an incomplete SQLite directory scan',
      category: 'sqlite-full-baseline-required'
    },
    {
      label: 'SQLite metadata cursor resets that require a full baseline',
      message:
        'Antigravity SQLite metadata cursor reset detected for /Users/private/conversations/session.db; rerun with --since all',
      category: 'sqlite-full-baseline-required'
    },
    {
      label: 'incomplete explicit full-history SQLite scans',
      message: 'Antigravity CLI --since all requires a complete SQLite directory scan',
      category: 'sqlite-directory-incomplete'
    },
    {
      label: 'incomplete GUI full-history SQLite scans',
      message: 'Antigravity GUI --since all requires a complete SQLite directory scan',
      category: 'sqlite-directory-incomplete'
    },
    {
      label: 'unstable SQLite directories during full-history reads',
      message:
        'Antigravity CLI full history scan could not read every enumerated SQLite database; retry after the conversations directory is stable',
      category: 'sqlite-directory-incomplete'
    }
  ])('classifies $label as $category', async ({ message, category }) => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'antigravity'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token'
      },
      deps({
        stderr: (line) => stderr.push(line),
        collectAntigravityUsage: async () => {
          throw new Error(message)
        }
      })
    )

    expect(result).toBe(1)
    expect(stderr).toEqual([`Antigravity collection: source=antigravity status=failed category=${category}`])
  })

  test.each([
    {
      message: 'Antigravity metadata response exceeded the 8388608-byte limit for antigravity',
      category: 'metadata-limit-exceeded'
    },
    {
      message: 'Antigravity generator metadata response exceeded the 8192-item limit',
      category: 'metadata-limit-exceeded'
    },
    {
      message: 'Antigravity language server metadata exceeded the 32768 usage-event limit',
      category: 'metadata-limit-exceeded'
    },
    {
      message: 'Antigravity metadata request returned invalid JSON for antigravity: Unexpected token',
      category: 'invalid-metadata'
    }
  ])('fails default all mode for fatal metadata failures: $message', async ({ message, category }) => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token'
      },
      deps({
        stderr: (line) => stderr.push(line),
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length, skipped: 0 }
        },
        collectAntigravityUsage: async () => {
          throw new Error(message)
        }
      })
    )

    expect(result).toBe(1)
    expect(uploaded).toEqual([[]])
    expect(stderr).toEqual([
      `Antigravity collection: source=antigravity status=failed category=${category}`,
      `One or more sources failed: antigravity: status=failed category=${category}`
    ])
  })

  test.each([
    {
      message:
        'Antigravity language server collection failed after DB history was collected: Antigravity metadata response exceeded the 8388608-byte limit for antigravity',
      category: 'metadata-limit-exceeded'
    },
    {
      message:
        'Antigravity language server collection failed after DB history was collected: Antigravity generator metadata response exceeded the 8192-item limit',
      category: 'metadata-limit-exceeded'
    },
    {
      message:
        'Antigravity language server collection failed after DB history was collected: Antigravity language server metadata exceeded the 32768 usage-event limit',
      category: 'metadata-limit-exceeded'
    },
    {
      message:
        'Antigravity language server collection failed after DB history was collected: Antigravity metadata request returned invalid JSON for antigravity: Unexpected token',
      category: 'invalid-metadata'
    }
  ])(
    'uploads partial DB snapshots then fails default all mode for fatal metadata failures: $category',
    async ({ message, category }) => {
      const stderr: string[] = []
      const uploaded: UsageSnapshot[][] = []
      const snapshot = { ...antigravitySnapshot, source: 'antigravity' as const }

      const result = await runCollectorCli(
        ['sync', '--source', 'all'],
        {
          TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
          TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token'
        },
        deps({
          stderr: (line) => stderr.push(line),
          uploadSnapshots: async (_config, snapshots) => {
            uploaded.push(snapshots)
            return { upserted: snapshots.length, skipped: 0 }
          },
          collectAntigravityUsage: async () => {
            throw new AntigravityPartialUsageError(message, [snapshot], undefined, true)
          }
        })
      )

      expect(result).toBe(1)
      expect(uploaded).toEqual([[snapshot]])
      expect(stderr).toEqual([
        `Antigravity collection: source=antigravity status=partial category=${category}`,
        `One or more sources failed: antigravity: status=partial category=${category}`
      ])
    }
  )

  test('fails default all mode when an installed Antigravity source has a real parse error', async () => {
    const stderr: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token'
      },
      deps({
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => [],
        collectCodexUsage: async () => [],
        collectAntigravityUsage: async () => {
          throw new Error(
            'Invalid Antigravity generator metadata item 3: inputTokens must be a bounded nonnegative integer'
          )
        },
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length, skipped: 0 }
        }
      })
    )

    expect(result).toBe(1)
    expect(stderr).toEqual([
      'Antigravity collection: source=antigravity status=failed category=invalid-metadata',
      'One or more sources failed: antigravity: status=failed category=invalid-metadata'
    ])
    expect(uploaded).toEqual([[]])
  })

  test('fails strict all mode for real Antigravity ENOENT failures', async () => {
    const stderr: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_FAIL_ON_SOURCE_ERROR: '1'
      },
      deps({
        stderr: (line) => stderr.push(line),
        collectAntigravityUsage: async () => {
          throw new Error(
            'Failed to read Antigravity metadata from /Users/test/.gemini/antigravity/conversations/cascade.pb: ENOENT'
          )
        }
      })
    )

    expect(result).toBe(1)
    expect(stderr).toEqual([
      'Antigravity collection: source=antigravity status=failed category=metadata-read-failed',
      'One or more sources failed: antigravity: status=failed category=metadata-read-failed'
    ])
  })

  test('scopes all Antigravity collectors and upload acknowledgements to the endpoint origin', async () => {
    const collected: Array<{ source: string; cursorScope: string | undefined }> = []
    const acknowledged: Array<{ source: string; cursorScope: string | undefined }> = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/custom/ingest?region=cn',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_STATE_DIR: '/state'
      },
      deps({
        collectAntigravityCliUsage: async (options) => {
          collected.push({ source: 'antigravity-cli', cursorScope: options?.cursorScope })
          return []
        },
        collectAntigravityUsage: async (options) => {
          collected.push({ source: 'antigravity', cursorScope: options?.cursorScope })
          return []
        },
        collectAntigravityIdeUsage: async (options) => {
          collected.push({ source: 'antigravity-ide', cursorScope: options?.cursorScope })
          return []
        },
        clearPendingUploadCursors: async (input) => {
          acknowledged.push({ source: input.source, cursorScope: input.cursorScope })
        }
      })
    )

    expect(result).toBe(0)
    expect(collected).toEqual([
      { source: 'antigravity-cli', cursorScope: 'https://tokenboard.example.com' },
      { source: 'antigravity', cursorScope: 'https://tokenboard.example.com' },
      { source: 'antigravity-ide', cursorScope: 'https://tokenboard.example.com' }
    ])
    expect(acknowledged).toEqual(collected)
  })

  test.each(['20260708', '2026-07-08', 'all'])(
    'passes an explicit since value of %s to every collector',
    async (since) => {
      const seen: Array<{ source: string; since: string | undefined }> = []

      const result = await runCollectorCli(
        ['preview', '--source', 'all', '--since', since],
        { TOKENBOARD_STATE_DIR: '/state' },
        deps({
          collectClaudeCodeUsage: async (options) => {
            seen.push({ source: 'claude-code', since: options?.since })
            return []
          },
          collectCodexUsage: async (options) => {
            seen.push({ source: 'codex', since: options?.since })
            return []
          },
          collectAntigravityCliUsage: async (options) => {
            seen.push({ source: 'antigravity-cli', since: options?.since })
            return []
          },
          collectAntigravityUsage: async (options) => {
            seen.push({ source: 'antigravity', since: options?.since })
            return []
          },
          collectAntigravityIdeUsage: async (options) => {
            seen.push({ source: 'antigravity-ide', since: options?.since })
            return []
          }
        })
      )

      expect(result).toBe(0)
      expect(seen).toEqual([
        { source: 'claude-code', since },
        { source: 'codex', since },
        { source: 'antigravity-cli', since },
        { source: 'antigravity', since },
        { source: 'antigravity-ide', since }
      ])
    }
  )

  test('uses the default since window when the primary environment value is empty', async () => {
    const seen: Array<{ source: string; since: string | undefined }> = []

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      {
        TOKENBOARD_SINCE: '',
        TOKENBOARD_DEFAULT_SINCE: '20260501',
        TOKENBOARD_STATE_DIR: '/state'
      },
      deps({
        collectClaudeCodeUsage: async (options) => {
          seen.push({ source: 'claude-code', since: options?.since })
          return []
        },
        collectCodexUsage: async (options) => {
          seen.push({ source: 'codex', since: options?.since })
          return []
        },
        collectAntigravityCliUsage: async (options) => {
          seen.push({ source: 'antigravity-cli', since: options?.since })
          return []
        },
        collectAntigravityUsage: async (options) => {
          seen.push({ source: 'antigravity', since: options?.since })
          return []
        },
        collectAntigravityIdeUsage: async (options) => {
          seen.push({ source: 'antigravity-ide', since: options?.since })
          return []
        }
      })
    )

    expect(result).toBe(0)
    expect(seen).toEqual([
      { source: 'claude-code', since: '20260501' },
      { source: 'codex', since: '20260501' },
      { source: 'antigravity-cli', since: '20260501' },
      { source: 'antigravity', since: '20260501' },
      { source: 'antigravity-ide', since: '20260501' }
    ])
  })

  test('passes an explicit since date to selected Claude and Codex collectors', async () => {
    const seen: Array<{ source: string; since: string | undefined }> = []
    const collectorDeps = deps({
      collectClaudeCodeUsage: async (options) => {
        seen.push({ source: 'claude-code', since: options?.since })
        return []
      },
      collectCodexUsage: async (options) => {
        seen.push({ source: 'codex', since: options?.since })
        return []
      }
    })

    const claudeResult = await runCollectorCli(
      ['preview', '--source', 'claude-code', '--since', '20260708'],
      { TOKENBOARD_STATE_DIR: '/state' },
      collectorDeps
    )
    const codexResult = await runCollectorCli(
      ['preview', '--source', 'codex', '--since', '20260708'],
      { TOKENBOARD_STATE_DIR: '/state' },
      collectorDeps
    )

    expect([claudeResult, codexResult]).toEqual([0, 0])
    expect(seen).toEqual([
      { source: 'claude-code', since: '20260708' },
      { source: 'codex', since: '20260708' }
    ])
  })

  test('acks Antigravity cursors after a successful non-hook upload', async () => {
    const acks: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'antigravity-ide'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_STATE_DIR: '/state'
      },
      deps({
        collectAntigravityIdeUsage: async () => [{ ...antigravitySnapshot, source: 'antigravity-ide' }],
        uploadSnapshots: async () => ({ upserted: 1, skipped: 0 }),
        clearPendingUploadCursors: async (input) => {
          acks.push(`${input.stateDir}:${input.source}`)
        }
      })
    )

    expect(result).toBe(0)
    expect(acks).toEqual(['/state:antigravity-ide'])
  })

  test('does not ack Antigravity cursors when upload fails', async () => {
    const stderr: string[] = []
    const acks: string[] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'antigravity-cli'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_STATE_DIR: '/state'
      },
      deps({
        stderr: (line) => stderr.push(line),
        collectAntigravityCliUsage: async () => [antigravitySnapshot],
        uploadSnapshots: async () => {
          throw new Error('upload failed')
        },
        clearPendingUploadCursors: async (input) => {
          acks.push(`${input.stateDir}:${input.source}`)
        }
      })
    )

    expect(result).toBe(1)
    expect(stderr).toEqual(['upload failed'])
    expect(acks).toEqual([])
  })

  test('skips Antigravity sources in hook all mode', async () => {
    const stderr: string[] = []
    const calls: string[] = []
    const uploaded: UsageSnapshot[][] = []

    const result = await runCollectorCli(
      ['sync', '--source', 'all'],
      {
        TOKENBOARD_ENDPOINT: 'https://tokenboard.example.com/api/v1/ingest',
        TOKENBOARD_UPLOAD_TOKEN: 'test-upload-token',
        TOKENBOARD_HOOK_MODE: '1'
      },
      deps({
        stderr: (line) => stderr.push(line),
        collectClaudeCodeUsage: async () => [],
        collectCodexUsage: async () => [],
        collectAntigravityUsage: async () => {
          calls.push('antigravity')
          throw new Error(
            'Invalid Antigravity generator metadata item 3: inputTokens must be a bounded nonnegative integer'
          )
        },
        collectAntigravityIdeUsage: async () => {
          calls.push('antigravity-ide')
          return [{ ...antigravitySnapshot, source: 'antigravity-ide' }]
        },
        collectAntigravityCliUsage: async () => {
          calls.push('antigravity-cli')
          return [antigravitySnapshot]
        },
        uploadSnapshots: async (_config, snapshots) => {
          uploaded.push(snapshots)
          return { upserted: snapshots.length, skipped: 0 }
        }
      })
    )

    expect(result).toBe(0)
    expect(calls).toEqual([])
    expect(uploaded).toEqual([[]])
    expect(stderr).toEqual([])
  })

  test('collects all three Antigravity products in all mode', async () => {
    const calls: string[] = []

    const result = await runCollectorCli(
      ['preview', '--source', 'all'],
      { TOKENBOARD_TIMEZONE: 'Asia/Shanghai' },
      deps({
        stderr: (line) => calls.push(`stderr:${line}`),
        collectAntigravityCliUsage: async () => {
          calls.push('cli')
          return []
        },
        collectAntigravityUsage: async () => {
          calls.push('gui')
          return []
        },
        collectAntigravityIdeUsage: async () => {
          calls.push('ide')
          return []
        }
      })
    )

    expect(result).toBe(0)
    expect(calls).toEqual(['cli', 'gui', 'ide'])
  })
})

function deps(overrides: Partial<Parameters<typeof runCollectorCli>[2]> = {}) {
  return {
    stdout: () => undefined,
    stderr: () => undefined,
    collectClaudeCodeUsage: async () => [],
    collectCodexUsage: async () => [],
    uploadSnapshots: async () => ({ upserted: 0, skipped: 0 }),
    ...overrides
  }
}
