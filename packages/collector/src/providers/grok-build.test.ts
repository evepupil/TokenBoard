import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { collectGrokBuildUsage } from './grok-build'

const sessionId = '019fb7fc-11bd-7da0-91a4-44be3dbd35e6'
// Field names, the epoch-seconds timestamp and the cache-inclusive input below
// were taken from real ~/.grok/sessions/**/updates.jsonl events.
const eventSeconds = 1_785_498_182

function turnCompleted(usage: Record<string, unknown>, timestamp: number = eventSeconds) {
  return JSON.stringify({
    method: '_x.ai/session/update',
    timestamp,
    params: { update: { sessionUpdate: 'turn_completed', usage } }
  })
}

function counters(overrides: Record<string, unknown> = {}) {
  return {
    inputTokens: 22_037,
    outputTokens: 181,
    totalTokens: 22_218,
    cachedReadTokens: 22_016,
    reasoningTokens: 75,
    modelCalls: 1,
    apiDurationMs: 2428,
    ...overrides
  }
}

async function grokHome(files: Record<string, string[]>) {
  const home = await mkdtemp(join(tmpdir(), 'tokenboard-grok-'))
  for (const [relative, lines] of Object.entries(files)) {
    const filePath = join(home, ...relative.split('/'))
    await mkdir(join(filePath, '..'), { recursive: true })
    await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8')
  }
  return home
}

function collect(home: string, options: Record<string, unknown> = {}) {
  return collectGrokBuildUsage({
    grokHome: home,
    timezone: 'Asia/Shanghai',
    collectedAt: '2026-07-30T10:00:00.000Z',
    since: 'all',
    ...options
  })
}

describe('collectGrokBuildUsage', () => {
  test('subtracts cached reads out of the reported input', async () => {
    const home = await grokHome({
      [`sessions/enc-cwd/${sessionId}/updates.jsonl`]: [
        turnCompleted({ ...counters(), modelUsage: { 'grok-4.5': counters() } })
      ]
    })

    const snapshots = await collect(home)

    expect(snapshots).toEqual([
      {
        source: 'grok-build',
        usageDate: '2026-07-31',
        timezone: 'Asia/Shanghai',
        model: 'grok-4.5',
        // Grok folds cache reads into inputTokens; TokenBoard keeps them disjoint.
        inputTokens: 21,
        outputTokens: 181,
        cacheCreationTokens: 0,
        cacheReadTokens: 22_016,
        // Matches the turn's own totalTokens of 22,218.
        totalTokens: 22_218,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-07-30T10:00:00.000Z'
      }
    ])
  })

  test('records each completed turn at face value', async () => {
    // Two turns reporting identical numbers are two real turns, not a repeated
    // cumulative snapshot: differencing them would drop the second turn.
    const home = await grokHome({
      [`sessions/enc-cwd/${sessionId}/updates.jsonl`]: [
        turnCompleted({ modelUsage: { 'grok-4.5': counters() } }),
        turnCompleted({ modelUsage: { 'grok-4.5': counters() } }, eventSeconds + 60)
      ]
    })

    const [snapshot] = await collect(home)

    expect(snapshot.inputTokens).toBe(42)
    expect(snapshot.outputTokens).toBe(362)
    expect(snapshot.cacheReadTokens).toBe(44_032)
  })

  test('never reports a cost for Grok Build', async () => {
    const home = await grokHome({
      [`sessions/enc-cwd/${sessionId}/updates.jsonl`]: [
        turnCompleted({ modelUsage: { 'grok-4.5': counters({ costUsdTicks: 23_113_000 }) } })
      ]
    })

    const [snapshot] = await collect(home)

    expect(snapshot.costUsd).toBe(0)
  })

  test('splits a turn across the models it used', async () => {
    const home = await grokHome({
      [`sessions/enc-cwd/${sessionId}/updates.jsonl`]: [
        turnCompleted({
          modelUsage: {
            'grok-4.5': counters({ inputTokens: 1000, cachedReadTokens: 0, outputTokens: 10 }),
            'deepseek-v4-flash': counters({ inputTokens: 500, cachedReadTokens: 0, outputTokens: 5 })
          }
        })
      ]
    })

    const snapshots = await collect(home)

    expect(snapshots.map((item) => item.model)).toEqual(['deepseek-v4-flash', 'grok-4.5'])
    expect(snapshots.find((item) => item.model === 'grok-4.5')?.inputTokens).toBe(1000)
  })

  test('keeps top-level totals when no model breakdown is present', async () => {
    const home = await grokHome({
      [`sessions/enc-cwd/${sessionId}/updates.jsonl`]: [
        turnCompleted(counters({ inputTokens: 1000, cachedReadTokens: 0, outputTokens: 10 }))
      ]
    })

    const [snapshot] = await collect(home)

    expect(snapshot.model).toBe('unknown')
    expect(snapshot.inputTokens).toBe(1000)
  })

  test('ignores updates that are not completed turns', async () => {
    // A mid-turn snapshot alongside the turn's final event would double-count.
    const home = await grokHome({
      [`sessions/enc-cwd/${sessionId}/updates.jsonl`]: [
        JSON.stringify({
          method: '_x.ai/session/update',
          timestamp: eventSeconds,
          params: { update: { sessionUpdate: 'agent_message_chunk', usage: counters() } }
        }),
        JSON.stringify({
          method: 'session/update',
          timestamp: eventSeconds,
          params: { update: { usage: counters() } }
        }),
        turnCompleted({ modelUsage: { 'grok-4.5': counters() } })
      ]
    })

    const snapshots = await collect(home)

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].cacheReadTokens).toBe(22_016)
  })

  test('skips events without a usable timestamp or usage object', async () => {
    const home = await grokHome({
      [`sessions/enc-cwd/${sessionId}/updates.jsonl`]: [
        JSON.stringify({
          method: '_x.ai/session/update',
          params: { update: { sessionUpdate: 'turn_completed', usage: counters() } }
        }),
        JSON.stringify({
          method: '_x.ai/session/update',
          timestamp: eventSeconds,
          params: { update: { sessionUpdate: 'turn_completed' } }
        }),
        'not-json',
        ''
      ]
    })

    await expect(collect(home)).resolves.toEqual([])
  })

  test('reads both live and archived session roots', async () => {
    const home = await grokHome({
      [`sessions/enc-cwd/${sessionId}/updates.jsonl`]: [
        turnCompleted({
          modelUsage: { 'grok-4.5': counters({ inputTokens: 1000, cachedReadTokens: 0, outputTokens: 1 }) }
        })
      ],
      'archived_sessions/enc-cwd/older-session/updates.jsonl': [
        turnCompleted({
          modelUsage: { 'grok-4.5': counters({ inputTokens: 2000, cachedReadTokens: 0, outputTokens: 2 }) }
        })
      ]
    })

    const [snapshot] = await collect(home)

    expect(snapshot.inputTokens).toBe(3000)
    expect(snapshot.sessionCount).toBe(2)
  })

  test('accepts millisecond and ISO timestamps', async () => {
    const home = await grokHome({
      [`sessions/a/${sessionId}/updates.jsonl`]: [
        turnCompleted({ modelUsage: { m: counters({ cachedReadTokens: 0 }) } }, Date.parse('2026-07-27T17:30:00.000Z'))
      ],
      'sessions/b/other/updates.jsonl': [
        JSON.stringify({
          method: '_x.ai/session/update',
          timestamp: '2026-07-27T17:30:00.000Z',
          params: {
            update: { sessionUpdate: 'turn_completed', usage: { modelUsage: { m: counters({ cachedReadTokens: 0 }) } } }
          }
        })
      ]
    })

    const snapshots = await collect(home)

    // 17:30Z is already the next day in Shanghai.
    expect(snapshots.map((item) => item.usageDate)).toEqual(['2026-07-28'])
    expect(snapshots[0].sessionCount).toBe(2)
  })

  test('applies the since window and rejects an invalid value', async () => {
    const home = await grokHome({
      [`sessions/enc-cwd/${sessionId}/updates.jsonl`]: [
        turnCompleted({ modelUsage: { m: counters({ cachedReadTokens: 0 }) } }, Date.parse('2026-07-20T02:00:00.000Z')),
        turnCompleted({ modelUsage: { m: counters({ cachedReadTokens: 0 }) } }, Date.parse('2026-07-27T02:00:00.000Z'))
      ]
    })

    expect(await collect(home, { since: '2026-07-25' })).toHaveLength(1)
    expect(await collect(home, { since: '20260725' })).toHaveLength(1)
    expect(await collect(home, { since: 'all' })).toHaveLength(2)
    await expect(collect(home, { since: 'yesterday' })).rejects.toThrow('Invalid Grok Build since value')
  })

  test('reports no sessions instead of empty usage when nothing is scanned', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tokenboard-grok-empty-'))

    await expect(collect(home)).rejects.toThrow('No Grok Build sessions found')
  })

  test('does not follow symlinked session directories', async () => {
    const home = await grokHome({
      [`sessions/real/${sessionId}/updates.jsonl`]: [
        turnCompleted({ modelUsage: { m: counters({ cachedReadTokens: 0 }) } })
      ]
    })
    const skipped: string[] = []
    try {
      // A cycle back to the root would recurse forever if links were followed.
      await symlink(join(home, 'sessions'), join(home, 'sessions', 'loop'), 'dir')
    } catch {
      return // Unprivileged Windows sessions cannot create directory symlinks.
    }

    const snapshots = await collect(home, { stderr: (line: string) => skipped.push(line) })

    expect(snapshots).toHaveLength(1)
    expect(skipped.join('\n')).toContain('(symlink)')
  })
})
