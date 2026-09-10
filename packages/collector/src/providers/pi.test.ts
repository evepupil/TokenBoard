import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { collectPiUsage } from './pi'

// Entry types, the `message.usage` shape and the cost breakdown below follow
// Pi's session JSONL: entries form an id/parentId tree, and usage rides on
// assistant messages, tool results, compactions and branch summaries.
const timestamp = '2026-06-15T10:06:38.654Z'

function usage(overrides: Record<string, unknown> = {}) {
  return {
    input: 3272,
    output: 383,
    cacheRead: 52_480,
    cacheWrite: 0,
    cost: { input: 0.0009, output: 0.0014, cacheRead: 0.0001, cacheWrite: 0, total: 0.0024 },
    ...overrides
  }
}

function assistantEntry(overrides: Record<string, unknown> = {}) {
  const { messageOverrides, ...entryOverrides } = overrides as {
    messageOverrides?: Record<string, unknown>
  } & Record<string, unknown>
  return JSON.stringify({
    type: 'message',
    id: 'entry-1',
    parentId: 'entry-0',
    timestamp,
    message: {
      role: 'assistant',
      api: 'anthropic',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      usage: usage(),
      ...messageOverrides
    },
    ...entryOverrides
  })
}

async function piAgentDir(files: Record<string, string[]>) {
  const agentDir = await mkdtemp(join(tmpdir(), 'tokenboard-pi-'))
  for (const [relative, lines] of Object.entries(files)) {
    const filePath = join(agentDir, 'sessions', ...relative.split('/'))
    await mkdir(join(filePath, '..'), { recursive: true })
    await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8')
  }
  return agentDir
}

function collect(agentDir: string, options: Record<string, unknown> = {}) {
  return collectPiUsage({
    agentDir,
    timezone: 'Asia/Shanghai',
    collectedAt: '2026-06-15T12:00:00.000Z',
    since: 'all',
    ...options
  })
}

describe('collectPiUsage', () => {
  test('normalizes an assistant message into a daily snapshot', async () => {
    const agentDir = await piAgentDir({ '--C--Users-lenovo--/session-a.jsonl': [assistantEntry()] })

    const snapshots = await collect(agentDir)

    expect(snapshots).toEqual([
      {
        source: 'pi',
        usageDate: '2026-06-15',
        timezone: 'Asia/Shanghai',
        model: 'deepseek-v4-pro',
        inputTokens: 3272,
        outputTokens: 383,
        cacheCreationTokens: 0,
        cacheReadTokens: 52_480,
        totalTokens: 56_135,
        costUsd: 0.0024,
        sessionCount: 1,
        collectedAt: '2026-06-15T12:00:00.000Z'
      }
    ])
  })

  test('counts tool-result, compaction and branch-summary usage', async () => {
    const agentDir = await piAgentDir({
      'project/session-a.jsonl': [
        JSON.stringify({
          type: 'message',
          id: 'tool-1',
          timestamp,
          message: {
            role: 'toolResult',
            model: 'deepseek-v4-pro',
            usage: usage({ input: 100, output: 10, cacheRead: 0, cost: { total: 0.001 } })
          }
        }),
        JSON.stringify({
          type: 'compaction',
          id: 'compact-1',
          timestamp,
          usage: usage({ input: 200, output: 20, cacheRead: 0, cost: { total: 0.002 } })
        }),
        JSON.stringify({
          type: 'branch_summary',
          id: 'branch-1',
          timestamp,
          usage: usage({ input: 300, output: 30, cacheRead: 0, cost: { total: 0.003 } })
        })
      ]
    })

    const snapshots = await collect(agentDir)

    // The tool result names its model; compaction and branch-summary entries
    // carry no message, so their usage lands under the unknown-model row.
    expect(snapshots.map((item) => item.model)).toEqual(['deepseek-v4-pro', 'unknown'])
    const totals = snapshots.reduce(
      (sum, item) => ({
        input: sum.input + item.inputTokens,
        output: sum.output + item.outputTokens,
        cost: sum.cost + item.costUsd
      }),
      { input: 0, output: 0, cost: 0 }
    )

    expect(totals.input).toBe(600)
    expect(totals.output).toBe(60)
    expect(totals.cost).toBeCloseTo(0.006, 10)
  })

  test('ignores user messages and entries without usage', async () => {
    const agentDir = await piAgentDir({
      'project/session-a.jsonl': [
        JSON.stringify({ type: 'session', id: 's', timestamp, cwd: '/work' }),
        JSON.stringify({ type: 'model_change', id: 'm', timestamp, provider: 'google', modelId: 'gemini' }),
        JSON.stringify({ type: 'message', id: 'u', timestamp, message: { role: 'user' } }),
        JSON.stringify({ type: 'message', id: 'a', timestamp, message: { role: 'assistant', model: 'm' } }),
        assistantEntry()
      ]
    })

    const snapshots = await collect(agentDir)

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].inputTokens).toBe(3272)
  })

  test('counts a forked entry id only once', async () => {
    // A fork copies shared history, so the same entry id can appear twice.
    const agentDir = await piAgentDir({
      'project/session-a.jsonl': [assistantEntry()],
      'project/session-b.jsonl': [assistantEntry()]
    })

    const [snapshot] = await collect(agentDir)

    expect(snapshot.inputTokens).toBe(3272)
  })

  test('keeps distinct entries that report identical usage', async () => {
    const agentDir = await piAgentDir({
      'project/session-a.jsonl': [assistantEntry(), assistantEntry({ id: 'entry-2' })]
    })

    const [snapshot] = await collect(agentDir)

    expect(snapshot.inputTokens).toBe(6544)
  })

  test('prefers the model that answered over the one requested', async () => {
    const agentDir = await piAgentDir({
      'project/session-a.jsonl': [
        assistantEntry({ messageOverrides: { model: 'requested-model', responseModel: 'served-model' } })
      ]
    })

    const [snapshot] = await collect(agentDir)

    expect(snapshot.model).toBe('served-model')
  })

  test('falls back to the session timestamp and a placeholder model', async () => {
    const agentDir = await piAgentDir({
      'project/session-a.jsonl': [
        JSON.stringify({ type: 'session', id: 's', timestamp, cwd: '/work' }),
        JSON.stringify({ type: 'compaction', id: 'c', usage: usage({ cacheRead: 0, cost: { total: 0.001 } }) })
      ]
    })

    const [snapshot] = await collect(agentDir)

    expect(snapshot.usageDate).toBe('2026-06-15')
    expect(snapshot.model).toBe('unknown')
  })

  test('sums cost buckets when no total is reported', async () => {
    const agentDir = await piAgentDir({
      'project/session-a.jsonl': [
        assistantEntry({
          messageOverrides: {
            usage: usage({ cost: { input: 0.001, output: 0.002, cacheRead: 0.0005, cacheWrite: 0 } })
          }
        })
      ]
    })

    const [snapshot] = await collect(agentDir)

    expect(snapshot.costUsd).toBeCloseTo(0.0035, 10)
  })

  test('includes the extended cache-write tier in bucket cost fallback', async () => {
    const agentDir = await piAgentDir({
      'project/session-a.jsonl': [
        assistantEntry({
          messageOverrides: {
            usage: {
              input: 100,
              output: 10,
              cacheRead: 0,
              cacheWrite: 200,
              cacheWrite1h: 300,
              cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0.004, cacheWrite1h: 0.005 }
            }
          }
        })
      ]
    })

    const [snapshot] = await collect(agentDir)

    expect(snapshot.costUsd).toBeCloseTo(0.012, 10)
  })

  test('trims served model identifiers before aggregation', async () => {
    const agentDir = await piAgentDir({
      'project/session-a.jsonl': [
        assistantEntry({
          messageOverrides: { model: '  requested-model  ', responseModel: '  served-model  ' }
        })
      ]
    })

    const [snapshot] = await collect(agentDir)

    expect(snapshot.model).toBe('served-model')
  })

  test('aggregates across sessions and dates, counting distinct sessions', async () => {
    const agentDir = await piAgentDir({
      'project-a/session-a.jsonl': [assistantEntry()],
      'project-b/session-b.jsonl': [assistantEntry({ id: 'entry-2', timestamp: '2026-06-16T02:00:00.000Z' })]
    })

    const snapshots = await collect(agentDir)

    expect(snapshots.map((item) => item.usageDate)).toEqual(['2026-06-15', '2026-06-16'])
    expect(snapshots.every((item) => item.sessionCount === 1)).toBe(true)
  })

  test('applies the since window and rejects an invalid value', async () => {
    const agentDir = await piAgentDir({
      'project/session-a.jsonl': [
        assistantEntry({ timestamp: '2026-06-10T02:00:00.000Z' }),
        assistantEntry({ id: 'entry-2', timestamp: '2026-06-20T02:00:00.000Z' })
      ]
    })

    expect(await collect(agentDir, { since: '2026-06-15' })).toHaveLength(1)
    expect(await collect(agentDir, { since: '20260615' })).toHaveLength(1)
    expect(await collect(agentDir, { since: 'all' })).toHaveLength(2)
    await expect(collect(agentDir, { since: 'today' })).rejects.toThrow('Invalid Pi since value')
  })

  test('reports no sessions instead of empty usage when nothing is scanned', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'tokenboard-pi-empty-'))

    await expect(collect(agentDir)).rejects.toThrow('No Pi sessions found')
  })

  test('skips malformed lines without failing the scan', async () => {
    const agentDir = await piAgentDir({
      'project/session-a.jsonl': ['not-json', '[]', '', assistantEntry()]
    })

    expect(await collect(agentDir)).toHaveLength(1)
  })
  test('matches the shape a real Pi session writes', async () => {
    // Taken from real ~/.pi/agent/sessions files: `usage` carries `totalTokens`
    // and a per-bucket `cost` alongside the counts, assistant and toolResult
    // entries both carry usage, and `responseModel` names the model that served
    // the call.
    const home = await piAgentDir({
      '--C--Users-lenovo--/session-real.jsonl': [
        JSON.stringify({ type: 'session', id: 's', timestamp, cwd: 'C:/Users/lenovo' }),
        JSON.stringify({ type: 'model_change', id: 'mc', timestamp, provider: 'xai', modelId: 'grok-4.5' }),
        JSON.stringify({
          type: 'message',
          id: 'a1',
          timestamp,
          message: {
            role: 'assistant',
            provider: 'xai',
            model: 'grok-4.5',
            responseModel: 'grok-4.5',
            usage: {
              input: 23_785,
              output: 15_670,
              cacheRead: 559_488,
              cacheWrite: 0,
              cacheWrite1h: 0,
              totalTokens: 598_943,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            }
          }
        }),
        JSON.stringify({
          type: 'message',
          id: 't1',
          timestamp,
          message: {
            role: 'toolResult',
            responseModel: 'grok-4.5',
            usage: {
              input: 23_785,
              output: 15_671,
              cacheRead: 559_488,
              cacheWrite: 0,
              cacheWrite1h: 0,
              totalTokens: 598_944,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            }
          }
        })
      ]
    })

    const snapshots = await collect(home)

    expect(snapshots).toEqual([
      {
        source: 'pi',
        usageDate: '2026-06-15',
        timezone: 'Asia/Shanghai',
        model: 'grok-4.5',
        inputTokens: 47_570,
        outputTokens: 31_341,
        cacheCreationTokens: 0,
        cacheReadTokens: 1_118_976,
        totalTokens: 1_197_887,
        // Subscription-tier models report a zero cost breakdown, which is a real
        // zero rather than an absent figure.
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-06-15T12:00:00.000Z'
      }
    ])
  })

  test('counts both cache-write tiers as cache creation', async () => {
    // Pi splits cache writes by TTL; ignoring the 1h tier would under-report.
    const home = await piAgentDir({
      'project/session-a.jsonl': [
        assistantEntry({
          messageOverrides: {
            usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 200, cacheWrite1h: 300, cost: { total: 0 } }
          }
        })
      ]
    })

    const [snapshot] = await collect(home)

    expect(snapshot.cacheCreationTokens).toBe(500)
    expect(snapshot.totalTokens).toBe(610)
  })

  test('keeps session content out of the snapshot', async () => {
    const secrets = ['a real user prompt', 'the assistant reply', 'C:/Users/lenovo/secret']
    const home = await piAgentDir({
      'project/session-a.jsonl': [
        JSON.stringify({ type: 'session', id: 's', timestamp, cwd: secrets[2] }),
        JSON.stringify({
          type: 'message',
          id: 'u',
          timestamp,
          message: { role: 'user', content: [{ type: 'text', text: secrets[0] }] }
        }),
        JSON.stringify({
          type: 'message',
          id: 'a',
          timestamp,
          message: {
            role: 'assistant',
            model: 'm',
            content: [{ type: 'text', text: secrets[1] }],
            usage: { input: 10, output: 2, cost: { total: 0 } }
          }
        })
      ]
    })

    const emitted = JSON.stringify(await collect(home))

    for (const secret of secrets) {
      expect(emitted).not.toContain(secret)
    }
  })
})
