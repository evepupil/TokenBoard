import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

const correction = vi.hoisted(() => vi.fn())

vi.mock('./codex-subagent-usage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codex-subagent-usage')>()
  return { ...actual, applyCodexSubagentUsageCorrections: correction }
})

import { collectCodexUsage } from './codex'

describe('Codex hook reusable pending snapshots', () => {
  afterEach(() => {
    correction.mockReset()
    vi.unstubAllEnvs()
  })

  // A pending file is reused so its usage survives a sync that could not upload it. That is
  // only safe while ccusage has nothing for the key: ccusage scans the same tree independently
  // and reports the whole day, so once it does report the key, the cursor's cached copy is a
  // second, partial view of a figure already included. `mergeSnapshots` sums on key collision
  // rather than replacing, so the two are added together and the upload carries a total that
  // is too high — silently, with no diagnostic and no error.
  test('does not add a reused pending snapshot on top of the same day from ccusage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-pending-merge-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const fileA = join(codexHome, 'sessions', '2026', '05', '22', 'a.jsonl')
    const fileB = join(codexHome, 'sessions', '2026', '05', '22', 'b.jsonl')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    correction.mockImplementation(async (input: { snapshots: unknown[] }) => input.snapshots)

    // The first sync finds usage in the file but ccusage reports nothing for the day, so the
    // run fails closed and the cursor keeps file A pending.
    let daily: unknown = { data: [] }
    const runner = vi.fn(async (_command: string, args: string[]) => (args.includes('session') ? { data: [] } : daily))

    try {
      await writeJsonl(fileA, [tokenCountEvent()])
      await expect(
        collectCodexUsage({
          codexHome,
          stateDir,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:00:00.000Z',
          runner
        })
      ).rejects.toThrow('Codex hook reconciliation returned no snapshots for parsed usage keys')

      // A second file appears for the same day, and ccusage now reports the whole day: A's 15
      // plus B's 15.
      await writeJsonl(fileB, [tokenCountEvent('2026-05-22T02:00:00.000Z', 10, 5, 0.03)])
      daily = {
        data: [
          { date: '2026-05-22', model: 'gpt-5', inputTokens: 20, outputTokens: 10, totalTokens: 30, costUSD: 0.06 }
        ]
      }

      const snapshots = await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T11:00:00.000Z',
        runner
      })

      expect(snapshots).toEqual([
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-22',
          model: 'gpt-5',
          inputTokens: 20,
          outputTokens: 10,
          totalTokens: 30
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  // Real Codex `token_count` events carry no `info.model`, so the session parser labels the
  // turn `all`. ccusage reports the day under concrete model ids, and an exact group-key match
  // would never fire for `all` — the cached copy would then be summed on top of a day that
  // already contains it. Every codex hook sync would over-count by the pending file's share.
  test('does not add a reused pending snapshot labelled "all" on top of the same day', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-pending-all-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const fileA = join(codexHome, 'sessions', '2026', '05', '22', 'a.jsonl')
    const fileB = join(codexHome, 'sessions', '2026', '05', '22', 'b.jsonl')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    correction.mockImplementation(async (input: { snapshots: unknown[] }) => input.snapshots)

    let daily: unknown = { data: [] }
    const runner = vi.fn(async (_command: string, args: string[]) => (args.includes('session') ? { data: [] } : daily))

    try {
      // A token_count event with no model, so the parser falls back to `all` and the pending
      // snapshot carries that label.
      await writeJsonl(fileA, [tokenCountEventWithoutModel()])
      await expect(
        collectCodexUsage({
          codexHome,
          stateDir,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:00:00.000Z',
          runner
        })
      ).rejects.toThrow('Codex hook reconciliation returned no snapshots for parsed usage keys')

      await writeJsonl(fileB, [tokenCountEventWithoutModel('2026-05-22T02:00:00.000Z', 10, 5, 0.03)])
      daily = {
        data: [
          { date: '2026-05-22', model: 'gpt-5', inputTokens: 20, outputTokens: 10, totalTokens: 30, costUSD: 0.06 }
        ]
      }

      const snapshots = await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T11:00:00.000Z',
        runner
      })

      // Only ccusage's figure, not the cached `all` copy summed on top of it.
      expect(snapshots).toEqual([
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-22',
          model: 'gpt-5',
          totalTokens: 30
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  // The reuse exists for the opposite case and must keep working: when ccusage has nothing for
  // the key, the cached snapshot is the only record of that usage.
  test('still reports a reused pending snapshot when ccusage has nothing for the day', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-pending-merge-keep-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const fileA = join(codexHome, 'sessions', '2026', '05', '22', 'a.jsonl')
    const fileB = join(codexHome, 'sessions', '2026', '05', '23', 'b.jsonl')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    correction.mockImplementation(async (input: { snapshots: unknown[] }) => input.snapshots)

    let daily: unknown = { data: [] }
    const runner = vi.fn(async (_command: string, args: string[]) => (args.includes('session') ? { data: [] } : daily))

    try {
      await writeJsonl(fileA, [tokenCountEvent()])
      await expect(
        collectCodexUsage({
          codexHome,
          stateDir,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:00:00.000Z',
          runner
        })
      ).rejects.toThrow('Codex hook reconciliation returned no snapshots')

      // A new file lands on a different day, so ccusage reports that day only. File A's cached
      // snapshot must still reach the upload.
      await writeJsonl(fileB, [tokenCountEvent('2026-05-23T02:00:00.000Z', 20, 10, 0.06)])
      daily = {
        data: [
          { date: '2026-05-23', model: 'gpt-5', inputTokens: 20, outputTokens: 10, totalTokens: 30, costUSD: 0.06 }
        ]
      }

      const snapshots = await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-23T11:00:00.000Z',
        runner
      })

      expect(snapshots).toEqual([
        expect.objectContaining({ usageDate: '2026-05-22', totalTokens: 15 }),
        expect.objectContaining({ usageDate: '2026-05-23', totalTokens: 30 })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

async function writeJsonl(file: string, rows: unknown[]) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, { encoding: 'utf8', flag: 'w' })
}

function tokenCountEvent(timestamp = '2026-05-22T01:00:00.000Z', inputTokens = 10, outputTokens = 5, costUsd = 0.03) {
  return {
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5',
        last_token_usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          cost_usd: costUsd
        }
      }
    }
  }
}

// The shape real Codex writes: a `token_count` event whose info carries only the usage, no
// model. The session parser then records the turn under the `all` sentinel.
function tokenCountEventWithoutModel(
  timestamp = '2026-05-22T01:00:00.000Z',
  inputTokens = 10,
  outputTokens = 5,
  costUsd = 0.03
) {
  return {
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          cost_usd: costUsd
        }
      }
    }
  }
}

// The reuse must also not double-count when the pending file's own day falls *between* two days
// that changed. ccusage is asked for a contiguous `--since/--until` window, so a day inside it
// is reported even though that day's file did not change — the same overlap as the adjacent
// case, reached through the range rather than through the day.
test('does not double-count a pending day that only falls inside the ccusage window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-pending-window-'))
  const codexHome = join(root, 'codex')
  const stateDir = join(root, 'state')
  const pendingFile = join(codexHome, 'sessions', '2026', '05', '23', 'pending.jsonl')
  const beforeFile = join(codexHome, 'sessions', '2026', '05', '22', 'before.jsonl')
  const afterFile = join(codexHome, 'sessions', '2026', '05', '24', 'after.jsonl')

  vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
  vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
  correction.mockImplementation(async (input: { snapshots: unknown[] }) => input.snapshots)

  // The 23rd parses to 15 but ccusage reports nothing, so it stays pending.
  let daily: unknown = { data: [] }
  const runner = vi.fn(async (_command: string, args: string[]) => (args.includes('session') ? { data: [] } : daily))

  try {
    await writeJsonl(pendingFile, [tokenCountEvent('2026-05-23T01:00:00.000Z', 10, 5, 0.03)])
    await expect(
      collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-23T10:00:00.000Z',
        runner
      })
    ).rejects.toThrow('Codex hook reconciliation returned no snapshots')

    // Files land on the 22nd and the 24th, so ccusage is asked for a window that spans the
    // pending 23rd and reports it along with the two days that actually changed.
    await writeJsonl(beforeFile, [tokenCountEvent('2026-05-22T01:00:00.000Z', 10, 0, 0.01)])
    await writeJsonl(afterFile, [tokenCountEvent('2026-05-24T01:00:00.000Z', 30, 10, 0.06)])
    daily = {
      data: [
        { date: '2026-05-22', model: 'gpt-5', inputTokens: 10, outputTokens: 0, totalTokens: 10, costUSD: 0.01 },
        { date: '2026-05-23', model: 'gpt-5', inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0.03 },
        { date: '2026-05-24', model: 'gpt-5', inputTokens: 30, outputTokens: 10, totalTokens: 40, costUSD: 0.06 }
      ]
    }

    const snapshots = await collectCodexUsage({
      codexHome,
      stateDir,
      timezone: 'Asia/Shanghai',
      collectedAt: '2026-05-24T10:00:00.000Z',
      runner
    })

    expect(snapshots).toEqual([
      expect.objectContaining({ usageDate: '2026-05-22', totalTokens: 10 }),
      expect.objectContaining({ usageDate: '2026-05-23', totalTokens: 15 }),
      expect.objectContaining({ usageDate: '2026-05-24', totalTokens: 40 })
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
