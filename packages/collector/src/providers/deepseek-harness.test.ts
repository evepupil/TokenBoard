import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import { collectDeepSeekHarnessUsage } from './deepseek-harness'

// The event envelope `{ type, seq, time, data }` with `time` in epoch
// milliseconds, and `usage` on `assistant/message`, follow DSH's session types.
const eventMs = Date.parse('2026-08-14T11:42:00.000Z')
// DSH writes frames with a content checksum, as this helper does.
const zstdOptions = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

function assistantMessage(overrides: Record<string, unknown> = {}, time = eventMs) {
  const { usage, model, ...rest } = overrides as {
    usage?: Record<string, unknown>
    model?: string
  } & Record<string, unknown>
  return JSON.stringify({
    type: 'assistant/message',
    seq: 12,
    time,
    data: {
      turn: 1,
      step: 0,
      message: {
        id: 'msg-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'reply text that must never be uploaded' }],
        source: { kind: 'model', provider: 'deepseek', model: model ?? 'deepseek-v4-pro' }
      },
      usage: {
        inputTokens: 3272,
        outputTokens: 802,
        cacheReadTokens: 52_480,
        cacheWriteTokens: 0,
        reasoningTokens: 419,
        ...usage
      },
      ...rest
    }
  })
}

async function dshHome(files: Record<string, { lines: string[]; compress?: boolean }>) {
  const home = await mkdtemp(join(tmpdir(), 'tokenboard-dsh-'))
  for (const [relative, spec] of Object.entries(files)) {
    const filePath = join(home, 'sessions', ...relative.split('/'))
    await mkdir(join(filePath, '..'), { recursive: true })
    const text = `${spec.lines.join('\n')}\n`
    if (spec.compress) {
      // Each append is its own frame, so the artifact holds concatenated frames.
      const frames = spec.lines.map((line) => zstdCompressSync(Buffer.from(`${line}\n`), zstdOptions))
      await writeFile(filePath, Buffer.concat(frames))
      continue
    }
    await writeFile(filePath, text, 'utf8')
  }
  return home
}

function collect(home: string, options: Record<string, unknown> = {}) {
  return collectDeepSeekHarnessUsage({
    dshHome: home,
    timezone: 'Asia/Shanghai',
    collectedAt: '2026-08-14T12:00:00.000Z',
    since: 'all',
    ...options
  })
}

describe('collectDeepSeekHarnessUsage', () => {
  test('normalizes an assistant message into a daily snapshot', async () => {
    const home = await dshHome({
      'project/session-a/session.jsonl': { lines: [assistantMessage()] }
    })

    const snapshots = await collect(home)

    expect(snapshots).toEqual([
      {
        source: 'deepseek-harness',
        usageDate: '2026-08-14',
        timezone: 'Asia/Shanghai',
        model: 'deepseek-v4-pro',
        inputTokens: 3272,
        // reasoningTokens is already inside outputTokens and is not added again.
        outputTokens: 802,
        cacheCreationTokens: 0,
        cacheReadTokens: 52_480,
        totalTokens: 56_554,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-08-14T12:00:00.000Z'
      }
    ])
  })

  test('reads every frame of a compressed log', async () => {
    // Node's own zstd decompress stops after the first frame; all three must land.
    const home = await dshHome({
      'project/session-a/session.jsonl.zstd': {
        compress: true,
        lines: [
          assistantMessage({ usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 } }),
          assistantMessage({ usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0 } }, eventMs + 1000),
          assistantMessage({ usage: { inputTokens: 300, outputTokens: 30, cacheReadTokens: 0 } }, eventMs + 2000)
        ]
      }
    })

    const [snapshot] = await collect(home)

    expect(snapshot.inputTokens).toBe(600)
    expect(snapshot.outputTokens).toBe(60)
  })

  test('never reports a cost for DeepSeek Harness', async () => {
    const home = await dshHome({
      'project/session-a/session.jsonl': {
        lines: [assistantMessage({ costUsd: 1.23, cost: { total: 4.56 } })]
      }
    })

    const [snapshot] = await collect(home)

    expect(snapshot.costUsd).toBe(0)
  })

  test('keeps cache reads and writes in their own buckets', async () => {
    const home = await dshHome({
      'project/session-a/session.jsonl': {
        lines: [
          assistantMessage({
            usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 300 }
          })
        ]
      }
    })

    const [snapshot] = await collect(home)

    expect(snapshot.inputTokens).toBe(1000)
    expect(snapshot.cacheReadTokens).toBe(5000)
    expect(snapshot.cacheCreationTokens).toBe(300)
    expect(snapshot.totalTokens).toBe(6500)
  })

  test('ignores events other than assistant messages with usage', async () => {
    const home = await dshHome({
      'project/session-a/session.jsonl': {
        lines: [
          JSON.stringify({ type: 'session', version: 1, id: 's', createdAt: eventMs, cwd: '/work' }),
          JSON.stringify({ type: 'turn/start', seq: 1, time: eventMs, data: { turn: 1 } }),
          JSON.stringify({ type: 'user/message', seq: 2, time: eventMs, data: { content: 'a prompt' } }),
          JSON.stringify({ type: 'assistant/chunk', seq: 3, time: eventMs, data: { chunk: { text: 'delta' } } }),
          JSON.stringify({ type: 'assistant/message', seq: 4, time: eventMs, data: { turn: 1, step: 0, message: {} } }),
          assistantMessage()
        ]
      }
    })

    const snapshots = await collect(home)

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].inputTokens).toBe(3272)
  })

  test('aggregates across sessions and dates, counting distinct sessions', async () => {
    const home = await dshHome({
      'project-a/session-a/session.jsonl': { lines: [assistantMessage()] },
      'project-b/session-b/session.jsonl.zstd': {
        compress: true,
        lines: [assistantMessage({}, Date.parse('2026-08-15T02:00:00.000Z'))]
      }
    })

    const snapshots = await collect(home)

    expect(snapshots.map((item) => item.usageDate)).toEqual(['2026-08-14', '2026-08-15'])
    expect(snapshots.every((item) => item.sessionCount === 1)).toBe(true)
  })

  test('falls back to a placeholder model when provenance is absent', async () => {
    const home = await dshHome({
      'project/session-a/session.jsonl': {
        lines: [
          JSON.stringify({
            type: 'assistant/message',
            seq: 1,
            time: eventMs,
            data: { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 2 } }
          })
        ]
      }
    })

    const [snapshot] = await collect(home)

    expect(snapshot.model).toBe('unknown')
  })

  test('keeps other sessions when one log cannot be read', async () => {
    const home = await dshHome({
      'project-a/broken/session.jsonl.zstd': { lines: ['not zstd at all'] },
      'project-b/session-b/session.jsonl': { lines: [assistantMessage()] }
    })
    const warnings: string[] = []

    const snapshots = await collect(home, { stderr: (line: string) => warnings.push(line) })

    expect(snapshots).toHaveLength(1)
    expect(warnings.join('\n')).toContain('Skipping unreadable DeepSeek Harness session log')
  })

  test('applies the since window and rejects an invalid value', async () => {
    const home = await dshHome({
      'project/session-a/session.jsonl': {
        lines: [
          assistantMessage({}, Date.parse('2026-08-10T02:00:00.000Z')),
          assistantMessage({}, Date.parse('2026-08-20T02:00:00.000Z'))
        ]
      }
    })

    expect(await collect(home, { since: '2026-08-15' })).toHaveLength(1)
    expect(await collect(home, { since: '20260815' })).toHaveLength(1)
    expect(await collect(home, { since: 'all' })).toHaveLength(2)
    await expect(collect(home, { since: 'week' })).rejects.toThrow('Invalid DeepSeek Harness since value')
  })

  test('reports no sessions instead of empty usage when nothing is scanned', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tokenboard-dsh-empty-'))

    await expect(collect(home)).rejects.toThrow('No DeepSeek Harness sessions found')
  })

  test('reads a session root configured independently of the home directory', async () => {
    const home = await dshHome({ 'project/session-a/session.jsonl': { lines: [assistantMessage()] } })

    const snapshots = await collectDeepSeekHarnessUsage({
      sessionRoot: join(home, 'sessions'),
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-08-14T12:00:00.000Z',
      since: 'all'
    })

    expect(snapshots).toHaveLength(1)
  })

  test('tolerates an empty log and malformed lines', async () => {
    const home = await dshHome({
      'project/empty/session.jsonl': { lines: [] },
      'project/messy/session.jsonl': { lines: ['not-json', '[]', '', assistantMessage()] }
    })

    expect(await collect(home)).toHaveLength(1)
  })
  test('matches the shape a real DSH session writes', async () => {
    // Taken from a real ~/.dsh/sessions/**/session.jsonl.zstd: one turn wrote
    // 51 frames, of which only two lines are assistant/message with usage. The
    // log carries no cost field of any kind, and cacheWriteTokens is absent
    // rather than zero when nothing was written to cache.
    const home = await dshHome({
      'proj/session-real/session.jsonl.zstd': {
        compress: true,
        lines: [
          JSON.stringify({ type: 'turn/start', seq: 1, time: eventMs, data: { turn: 1 } }),
          JSON.stringify({
            type: 'user/message',
            seq: 2,
            time: eventMs,
            data: { content: [{ type: 'text', text: 'a real prompt' }] }
          }),
          // Packed chunk rows hold the model's raw output and must be ignored.
          JSON.stringify({
            type: 'reasoning-chunks',
            seq: 3,
            time: eventMs,
            data: { turn: 1, step: 0, texts: ['private reasoning'] }
          }),
          JSON.stringify({
            type: 'text-chunks',
            seq: 4,
            time: eventMs,
            data: { turn: 1, step: 0, texts: ['streamed reply'] }
          }),
          JSON.stringify({
            type: 'assistant/chunk',
            seq: 5,
            time: eventMs,
            data: { turn: 1, step: 0, chunk: { text: 'delta' } }
          }),
          JSON.stringify({
            type: 'assistant/message',
            seq: 6,
            time: eventMs,
            data: {
              turn: 1,
              step: 0,
              message: {
                id: 'msg-1',
                role: 'assistant',
                content: [{ type: 'text', text: 'assembled reply' }],
                source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' }
              },
              usage: { inputTokens: 4557, outputTokens: 434, cacheReadTokens: 4224, reasoningTokens: 220 }
            }
          }),
          JSON.stringify({
            type: 'assistant/message',
            seq: 7,
            time: eventMs + 5000,
            data: {
              turn: 2,
              step: 0,
              message: {
                id: 'msg-2',
                role: 'assistant',
                content: [{ type: 'text', text: 'second reply' }],
                source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' }
              },
              usage: { inputTokens: 4638, outputTokens: 476, cacheReadTokens: 5632, reasoningTokens: 256 }
            }
          }),
          JSON.stringify({ type: 'session/title', seq: 8, time: eventMs, data: { title: 'a session title' } }),
          JSON.stringify({ type: 'turn/end', seq: 9, time: eventMs, data: { turn: 1, reason: 'completed' } })
        ]
      }
    })

    const snapshots = await collect(home)

    expect(snapshots).toEqual([
      {
        source: 'deepseek-harness',
        usageDate: '2026-08-14',
        timezone: 'Asia/Shanghai',
        model: 'deepseek-v4-flash-vision-exp',
        inputTokens: 9195,
        outputTokens: 910,
        cacheCreationTokens: 0,
        cacheReadTokens: 9856,
        totalTokens: 19_961,
        costUsd: 0,
        sessionCount: 1,
        collectedAt: '2026-08-14T12:00:00.000Z'
      }
    ])
  })

  test('keeps session content out of the snapshot', async () => {
    const secrets = ['a real prompt', 'private reasoning', 'streamed reply', 'assembled reply']
    const home = await dshHome({
      'proj/session-a/session.jsonl.zstd': {
        compress: true,
        lines: [
          JSON.stringify({
            type: 'user/message',
            seq: 1,
            time: eventMs,
            data: { content: [{ type: 'text', text: secrets[0] }] }
          }),
          JSON.stringify({ type: 'reasoning-chunks', seq: 2, time: eventMs, data: { texts: [secrets[1]] } }),
          JSON.stringify({ type: 'text-chunks', seq: 3, time: eventMs, data: { texts: [secrets[2]] } }),
          JSON.stringify({
            type: 'assistant/message',
            seq: 4,
            time: eventMs,
            data: {
              turn: 1,
              step: 0,
              message: {
                id: 'm',
                role: 'assistant',
                content: [{ type: 'text', text: secrets[3] }],
                source: { kind: 'model', provider: 'p', model: 'm', replayState: { opaque: 'provider state' } }
              },
              usage: { inputTokens: 10, outputTokens: 2 }
            }
          })
        ]
      }
    })

    const emitted = JSON.stringify(await collect(home))

    for (const secret of secrets) {
      expect(emitted).not.toContain(secret)
    }
    expect(emitted).not.toContain('provider state')
  })
})
