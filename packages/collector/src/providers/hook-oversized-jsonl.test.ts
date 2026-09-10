import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { collectClaudeCodeUsage } from './claude-code'
import { collectHookIncremental } from './hook-incremental'

describe('oversized hook session JSONL rows', () => {
  test('skips a non-usage row, advances the cursor, and reports a content-free diagnostic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-oversized-jsonl-'))
    const sessionsDir = join(root, 'codex', 'sessions')
    const stateDir = join(root, 'state')
    const cursorPath = join(stateDir, 'codex-cursor.json')
    const sessionFile = join(sessionsDir, '2026', '05', '22', 'oversized.jsonl')
    const warnings: string[] = []
    const oversized = JSON.stringify({
      type: 'response_item',
      payload: { text: 'x'.repeat(1024 * 1024 + 64) }
    })
    const input = {
      source: 'codex' as const,
      sessionsDir,
      cursorName: 'codex-cursor.json',
      stateDir,
      stderr: (line: string) => warnings.push(line),
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-05-22T10:00:00.000Z'
    }

    try {
      await mkdir(dirname(sessionFile), { recursive: true })
      await writeFile(sessionFile, `${oversized}\n`)

      await expect(collectHookIncremental(input)).resolves.toEqual({
        rangeArgs: [],
        changed: false,
        changedDates: [],
        changedKeys: [],
        cachedSnapshots: []
      })
      expect(warnings).toEqual([
        `Skipped 1 oversized codex session JSONL row without token or usage metadata (largest ${Buffer.byteLength(oversized)} bytes)`
      ])

      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(cursor.files['2026/05/22/oversized.jsonl']).toMatchObject({
        size: Buffer.byteLength(`${oversized}\n`),
        snapshots: []
      })
      expect(cursor.files['2026/05/22/oversized.jsonl'].pendingUpload).toBeUndefined()
      await expect(collectHookIncremental(input)).resolves.toEqual({
        rangeArgs: [],
        changed: false,
        changedDates: [],
        changedKeys: [],
        cachedSnapshots: []
      })
      expect(warnings).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not commit a cursor when usage metadata appears after the line limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-oversized-jsonl-'))
    const sessionsDir = join(root, 'codex', 'sessions')
    const stateDir = join(root, 'state')
    const cursorPath = join(stateDir, 'codex-cursor.json')
    const sessionFile = join(sessionsDir, '2026', '05', '22', 'usage-after-limit.jsonl')
    const oversized = JSON.stringify({
      type: 'event_msg',
      padding: 'x'.repeat(1024 * 1024 + 64),
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 1 } }
      }
    })
    const input = {
      source: 'codex' as const,
      sessionsDir,
      cursorName: 'codex-cursor.json',
      stateDir,
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-05-22T10:00:00.000Z'
    }

    try {
      await mkdir(dirname(sessionFile), { recursive: true })
      await writeFile(sessionFile, `${oversized}\n`)

      await expect(collectHookIncremental(input)).rejects.toThrow(
        'Session JSONL contains an oversized line with token or usage metadata'
      )
      await expect(readFile(cursorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not commit a cursor when a short row has invalid UTF-8', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-oversized-jsonl-'))
    const sessionsDir = join(root, 'codex', 'sessions')
    const stateDir = join(root, 'state')
    const cursorPath = join(stateDir, 'codex-cursor.json')
    const sessionFile = join(sessionsDir, '2026', '05', '22', 'invalid-utf8.jsonl')
    const malformed = Buffer.concat([
      Buffer.from('{"type":"response_item","payload":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}\n')
    ])
    const input = {
      source: 'codex' as const,
      sessionsDir,
      cursorName: 'codex-cursor.json',
      stateDir,
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-05-22T10:00:00.000Z'
    }

    try {
      await mkdir(dirname(sessionFile), { recursive: true })
      await writeFile(sessionFile, malformed)

      await expect(collectHookIncremental(input)).rejects.toThrow('Session JSONL contains invalid UTF-8')
      await expect(readFile(cursorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('lets the Claude hook advance past an oversized assistant row without a usage object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-oversized-jsonl-'))
    const claudeHome = join(root, 'claude')
    const stateDir = join(root, 'state')
    const cursorPath = join(stateDir, 'claude-code-cursor.json')
    const sessionFile = join(claudeHome, 'projects', 'project-a', 'oversized.jsonl')
    const warnings: string[] = []
    const oversized = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-22T02:00:00.000Z',
      message: { content: 'x'.repeat(1024 * 1024 + 64) }
    })

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await mkdir(dirname(sessionFile), { recursive: true })
      await writeFile(sessionFile, `${oversized}\n`)

      await expect(
        collectClaudeCodeUsage({
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:00:00.000Z',
          stderr: (line) => warnings.push(line),
          async runner() {
            throw new Error('ccusage must not run when no usage rows changed')
          }
        })
      ).resolves.toEqual([])

      expect(warnings).toEqual([
        `Skipped 1 oversized claude-code session JSONL row without token or usage metadata (largest ${Buffer.byteLength(oversized)} bytes)`
      ])
      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(cursor.files['project-a/oversized.jsonl']).toMatchObject({
        size: Buffer.byteLength(`${oversized}\n`),
        snapshots: []
      })
      await expect(
        collectClaudeCodeUsage({
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:00:00.000Z',
          stderr: (line) => warnings.push(line),
          async runner() {
            throw new Error('ccusage must not run when no usage rows changed')
          }
        })
      ).resolves.toEqual([])
      expect(warnings).toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })
})
