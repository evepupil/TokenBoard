import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from '../../test/sqlite-d1'
import { listLeaderboard, type LeaderboardQuery } from './queries'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')

// Everything else in this feature asserts the SQL text. These tests run the statement against a
// real SQLite database built from the real migrations, so the parts a string check cannot reach
// are exercised for real: the privacy predicate against actual rows, the ranking of each metric,
// the fallback path that unions `daily_usage`, and the JSON detail the panel renders.
describe('listLeaderboard against SQLite', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('only returns public, leaderboard-participating profiles for every metric', async () => {
    const { db } = createDb(tempDirs, {
      profiles: [
        profile('u_alice', 'alice', { isPublic: 1, participates: 1 }),
        profile('u_bob', 'bob', { isPublic: 1, participates: 1 }),
        // Public, but the user never opted into the board.
        profile('u_carol', 'carol', { isPublic: 1, participates: 0 }),
        // Participating flag set, but the profile is not public.
        profile('u_dave', 'dave', { isPublic: 0, participates: 1 }),
        profile('u_erin', 'erin', { isPublic: 0, participates: 0 })
      ],
      summaries: [
        summary({ user: 'u_alice', source: 'claude-code', model: 'claude-opus-4', total: 1000 }),
        summary({ user: 'u_bob', source: 'codex', model: 'gpt-5-codex', total: 900 }),
        summary({ user: 'u_carol', source: 'codex', model: 'gpt-5-codex', total: 5000 }),
        summary({ user: 'u_dave', source: 'codex', model: 'gpt-5-codex', total: 6000 }),
        summary({ user: 'u_erin', source: 'codex', model: 'gpt-5-codex', total: 7000 })
      ]
    })

    for (const metric of ['tokens', 'tokens-without-cache-read', 'cost'] as const) {
      const entries = await listLeaderboard(db, monthly({ metric }))

      expect(entries.map((entry) => entry.slug)).toEqual(['alice', 'bob'])
      expect(entries[0]?.totalTokens).toBe(1000)
      expect(entries[1]?.totalTokens).toBe(900)
    }
  })

  test('ranks each metric by its own total, not by the shared one', async () => {
    const { db } = createDb(tempDirs, {
      profiles: [
        profile('u_alice', 'alice', { isPublic: 1, participates: 1 }),
        profile('u_bob', 'bob', { isPublic: 1, participates: 1 })
      ],
      summaries: [
        // Alice leads on raw tokens because most of hers are cache reads, and her billable cost
        // is smaller; Bob leads once cache reads are subtracted and on cost.
        summary({
          user: 'u_alice',
          source: 'claude-code',
          model: 'claude-opus-4',
          total: 5000,
          cacheRead: 4800,
          cost: 3
        }),
        summary({ user: 'u_bob', source: 'codex', model: 'gpt-5-codex', total: 1000, cacheRead: 0, cost: 9 })
      ]
    })

    const byTokens = await listLeaderboard(db, monthly({ metric: 'tokens' }))
    expect(byTokens.map((entry) => entry.slug)).toEqual(['alice', 'bob'])
    expect(byTokens[0]?.totalTokensWithoutCacheRead).toBe(200)
    expect(byTokens[0]?.cacheReadRate).toBeCloseTo(4800 / 5000)

    const byFreshTokens = await listLeaderboard(db, monthly({ metric: 'tokens-without-cache-read' }))
    expect(byFreshTokens.map((entry) => entry.slug)).toEqual(['bob', 'alice'])
    expect(byFreshTokens[0]?.totalTokensWithoutCacheRead).toBe(1000)

    const byCost = await listLeaderboard(db, monthly({ metric: 'cost' }))
    expect(byCost.map((entry) => entry.slug)).toEqual(['bob', 'alice'])
    expect(byCost.map((entry) => entry.costUsd)).toEqual([9, 3])
  })

  test('breaks an exact tie by slug so the order cannot change between requests', async () => {
    const { db } = createDb(tempDirs, {
      profiles: [
        profile('u_zeta', 'zeta', { isPublic: 1, participates: 1 }),
        profile('u_alpha', 'alpha', { isPublic: 1, participates: 1 })
      ],
      summaries: [
        summary({ user: 'u_zeta', source: 'codex', model: 'gpt-5-codex', total: 700, cacheRead: 0, cost: 2 }),
        summary({ user: 'u_alpha', source: 'codex', model: 'gpt-5-codex', total: 700, cacheRead: 0, cost: 2 })
      ]
    })

    for (const metric of ['tokens', 'tokens-without-cache-read', 'cost'] as const) {
      const entries = await listLeaderboard(db, monthly({ metric }))
      expect(entries.map((entry) => entry.slug)).toEqual(['alpha', 'zeta'])
      expect(entries.map((entry) => entry.rank)).toEqual([1, 2])
    }
  })

  test('counts only usage inside the window, on both edges', async () => {
    const { db } = createDb(tempDirs, {
      profiles: [profile('u_alice', 'alice', { isPublic: 1, participates: 1 })],
      summaries: [
        summary({ user: 'u_alice', source: 'codex', model: 'gpt-5-codex', total: 100, date: '2026-04-30' }),
        summary({ user: 'u_alice', source: 'codex', model: 'gpt-5-codex', total: 200, date: '2026-05-01' }),
        summary({ user: 'u_alice', source: 'claude-code', model: 'claude-opus-4', total: 300, date: '2026-05-31' }),
        summary({ user: 'u_alice', source: 'codex', model: 'gpt-5-codex', total: 400, date: '2026-06-01' })
      ]
    })

    const entries = await listLeaderboard(db, {
      period: 'monthly',
      metric: 'tokens',
      startDate: '2026-05-01',
      endDateExclusive: '2026-06-01'
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.totalTokens).toBe(500)
    expect(entries[0]?.sourceBreakdown.map((item) => item.source)).toEqual(['claude-code', 'codex'])
  })

  test('reads usage that only exists in daily_usage, and prefers the summary when both do', async () => {
    const { db } = createDb(tempDirs, {
      profiles: [profile('u_alice', 'alice', { isPublic: 1, participates: 1 })],
      summaries: [summary({ user: 'u_alice', source: 'codex', model: 'gpt-5-codex', total: 200, cost: 2 })],
      usage: [
        // The summary already covers this key, so the fallback must not add this row on top.
        usage({ user: 'u_alice', source: 'codex', model: 'gpt-5-codex', total: 200, cost: 2 }),
        // No summary row for this one, so the raw table is the only place it exists.
        usage({ user: 'u_alice', source: 'claude-code', model: 'claude-opus-4', total: 300, cacheRead: 100, cost: 3 })
      ]
    })

    const entries = await listLeaderboard(db, monthly({ metric: 'tokens' }))

    expect(entries).toHaveLength(1)
    expect(entries[0]?.totalTokens).toBe(500)
    expect(entries[0]?.costUsd).toBe(5)
    expect(entries[0]?.sourceBreakdown).toEqual([
      { source: 'claude-code', share: 300 / 500 },
      { source: 'codex', share: 200 / 500 }
    ])
  })

  test('ignores a legacy device row that a current device row replaced', async () => {
    const { db } = createDb(tempDirs, {
      profiles: [profile('u_alice', 'alice', { isPublic: 1, participates: 1 })],
      usage: [
        usage({ user: 'u_alice', source: 'codex', model: 'gpt-5-codex', total: 900, device: 'legacy' }),
        usage({ user: 'u_alice', source: 'codex', model: 'gpt-5-codex', total: 100 })
      ]
    })

    const entries = await listLeaderboard(db, monthly({ metric: 'tokens' }))

    expect(entries[0]?.totalTokens).toBe(100)
  })

  test('reads only the summary table in strict mode', async () => {
    const { db } = createDb(tempDirs, {
      profiles: [profile('u_alice', 'alice', { isPublic: 1, participates: 1 })],
      summaries: [summary({ user: 'u_alice', source: 'codex', model: 'gpt-5-codex', total: 200 })],
      usage: [usage({ user: 'u_alice', source: 'codex', model: 'gpt-5-codex', total: 900 })]
    })

    const entries = await listLeaderboard(db, monthly({ metric: 'tokens', summaryStrict: true }))

    expect(entries[0]?.totalTokens).toBe(200)
  })

  test('names the model with the most tokens, breaking ties by model id', async () => {
    const { db } = createDb(tempDirs, {
      profiles: [
        profile('u_alice', 'alice', { isPublic: 1, participates: 1 }),
        profile('u_bob', 'bob', { isPublic: 1, participates: 1 })
      ],
      summaries: [
        // Alice's leading model is split across two sources but still leads once combined.
        summary({ user: 'u_alice', source: 'claude-code', model: 'claude-opus-4', total: 600 }),
        summary({ user: 'u_alice', source: 'codex', model: 'gpt-5-codex', total: 500 }),
        summary({ user: 'u_alice', source: 'opencode', model: 'claude-opus-4', total: 100 }),
        // Bob's two models tie exactly, so the id decides.
        summary({ user: 'u_bob', source: 'codex', model: 'gpt-5-codex', total: 400 }),
        summary({ user: 'u_bob', source: 'codex', model: 'claude-opus-4', total: 400 })
      ]
    })

    const entries = await listLeaderboard(db, monthly({ metric: 'tokens' }))

    expect(entries.map((entry) => [entry.slug, entry.primaryModel])).toEqual([
      ['alice', 'claude-opus-4'],
      ['bob', 'claude-opus-4']
    ])
  })

  test('reports every source as a share of the user total, largest first', async () => {
    const { db } = createDb(tempDirs, {
      profiles: [profile('u_alice', 'alice', { isPublic: 1, participates: 1 })],
      summaries: [
        // Two sources with identical totals sit in alphabetical order, and a third trails them.
        summary({ user: 'u_alice', source: 'pi', model: 'sonnet', total: 250 }),
        summary({ user: 'u_alice', source: 'codex', model: 'gpt-5-codex', total: 250 }),
        summary({ user: 'u_alice', source: 'claude-code', model: 'claude-opus-4', total: 500 })
      ]
    })

    const entries = await listLeaderboard(db, monthly({ metric: 'tokens' }))

    expect(entries[0]?.totalTokens).toBe(1000)
    expect(entries[0]?.sourceBreakdown).toEqual([
      { source: 'claude-code', share: 0.5 },
      { source: 'codex', share: 0.25 },
      { source: 'pi', share: 0.25 }
    ])
    expect(entries[0]?.sourceBreakdown.reduce((total, item) => total + item.share, 0)).toBeCloseTo(1)
  })

  test('flags the viewer row only, and flags nobody without a viewer', async () => {
    const { db } = createDb(tempDirs, {
      profiles: [
        profile('u_alice', 'alice', { isPublic: 1, participates: 1 }),
        profile('u_bob', 'bob', { isPublic: 1, participates: 1 })
      ],
      summaries: [
        summary({ user: 'u_alice', source: 'codex', model: 'gpt-5-codex', total: 200 }),
        summary({ user: 'u_bob', source: 'codex', model: 'gpt-5-codex', total: 100 })
      ]
    })

    const withViewer = await listLeaderboard(db, monthly({ metric: 'tokens', viewerUserId: 'u_bob' }))
    expect(withViewer.map((entry) => [entry.slug, entry.isCurrentViewer])).toEqual([
      ['alice', false],
      ['bob', true]
    ])
    // The viewer's id is resolved to a boolean inside SQL; nothing in the response carries it.
    expect(JSON.stringify(withViewer)).not.toContain('u_bob')
    expect(JSON.stringify(withViewer)).not.toContain('u_alice')

    const anonymous = await listLeaderboard(db, monthly({ metric: 'tokens' }))
    expect(anonymous.map((entry) => entry.isCurrentViewer)).toEqual([false, false])

    // A signed-in viewer who is not on the board (private, or no usage) flags nobody rather
    // than failing.
    const absentViewer = await listLeaderboard(db, monthly({ metric: 'tokens', viewerUserId: 'u_private' }))
    expect(absentViewer.map((entry) => entry.isCurrentViewer)).toEqual([false, false])
  })

  test('returns at most the requested number of rows', async () => {
    const { db } = createDb(tempDirs, {
      profiles: [
        profile('u_alice', 'alice', { isPublic: 1, participates: 1 }),
        profile('u_bob', 'bob', { isPublic: 1, participates: 1 }),
        profile('u_carol', 'carol', { isPublic: 1, participates: 1 })
      ],
      summaries: [
        summary({ user: 'u_alice', source: 'codex', model: 'gpt-5-codex', total: 300 }),
        summary({ user: 'u_bob', source: 'codex', model: 'gpt-5-codex', total: 200 }),
        summary({ user: 'u_carol', source: 'codex', model: 'gpt-5-codex', total: 100 })
      ]
    })

    const entries = await listLeaderboard(db, monthly({ metric: 'tokens', limit: 2 }))

    expect(entries.map((entry) => entry.slug)).toEqual(['alice', 'bob'])
    expect(entries.map((entry) => entry.rank)).toEqual([1, 2])
  })

  test('marks Antigravity-only usage cost unavailable, and leaves the totals intact', async () => {
    const { db } = createDb(tempDirs, {
      profiles: [profile('u_alice', 'alice', { isPublic: 1, participates: 1 })],
      summaries: [
        summary({ user: 'u_alice', source: 'antigravity-cli', model: 'gemini-3-pro', total: 400, cost: 12 }),
        summary({ user: 'u_alice', source: 'codex', model: 'gpt-5-codex', total: 100, cost: 2 })
      ]
    })

    const entries = await listLeaderboard(db, monthly({ metric: 'cost' }))

    expect(entries[0]?.totalTokens).toBe(500)
    expect(entries[0]?.costUsd).toBe(2)
    expect(entries[0]?.costAvailable).toBe(false)
  })

  // A public account can create rows on purpose (one per date/source/model, each capped at 1e12
  // tokens), so an integer SUM over a window is an overflow an uploader can trigger deliberately —
  // and it would blank the board for every viewer, not just them. `SUM()` throws "integer
  // overflow" past int64; `total()` accumulates in floating point and cannot. Two rows at int64
  // max stand in for the ~9.2M capped rows that would reach the same sum, and the plain SUM
  // check first proves the failure mode is real.
  test('a window whose token sum overflows int64 still returns a row', async () => {
    const { path, db } = createDb(tempDirs, {
      profiles: [profile('u_alice', 'alice', { isPublic: 1, participates: 1 })]
    })
    runSql(
      path,
      `
      INSERT INTO daily_usage (
        user_id, device_id, source, usage_date, timezone, model,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        total_tokens, cost_usd, session_count, snapshot_hash, synced_at
      ) VALUES
        ('u_alice', 'device-1', 'claude-code', '2026-05-10', 'UTC', 'model-a', 0, 0, 0, 0, 9223372036854775807, 0, 1, 'hash-a', '2026-05-10T00:00:00Z'),
        ('u_alice', 'device-2', 'claude-code', '2026-05-11', 'UTC', 'model-b', 0, 0, 0, 0, 9223372036854775807, 0, 1, 'hash-b', '2026-05-11T00:00:00Z');
    `
    )

    expect(() => runSql(path, 'SELECT SUM(total_tokens) FROM daily_usage')).toThrow(/integer overflow/)

    const entries = await listLeaderboard(db, monthly({ metric: 'tokens' }))

    expect(entries).toHaveLength(1)
    expect(entries[0]?.totalTokens).toBeGreaterThan(9e18)
    expect(Number.isFinite(entries[0]?.totalTokens ?? Number.NaN)).toBe(true)
    // The per-source CTE sums the same rows and must survive the same overflow.
    expect(entries[0]?.sourceBreakdown.map((item) => item.source)).toEqual(['claude-code'])
  })
})

function monthly(input: Partial<LeaderboardQuery> = {}): LeaderboardQuery {
  return {
    period: 'monthly',
    metric: 'tokens',
    startDate: '2026-05-01',
    endDateExclusive: '2026-06-01',
    ...input
  }
}

type ProfileFixture = {
  userId: string
  slug: string
  isPublic: number
  participates: number
  timezone?: string
}

function profile(userId: string, slug: string, input: { isPublic: number; participates: number }): ProfileFixture {
  return { userId, slug, isPublic: input.isPublic, participates: input.participates, timezone: 'UTC' }
}

type SummaryFixture = {
  user: string
  source: string
  model: string
  total: number
  cacheRead?: number
  cost?: number
  date?: string
}

function summary(input: SummaryFixture) {
  return { ...input, date: input.date ?? '2026-05-15' }
}

type UsageFixture = {
  user: string
  source: string
  model: string
  total: number
  cacheRead?: number
  cost?: number
  date?: string
  device?: string
}

function usage(input: UsageFixture) {
  return { ...input, date: input.date ?? '2026-05-15', device: input.device ?? 'device-1' }
}

function createDb(
  tempDirs: string[],
  fixtures: {
    profiles: ProfileFixture[]
    summaries?: SummaryFixture[]
    usage?: UsageFixture[]
  }
) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-leaderboard-'))
  tempDirs.push(dir)
  const path = join(dir, 'test.sqlite')
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
  runSql(path, files.map((file) => `.read ${join(migrationsDir, file)}`).join('\n'))

  for (const fixture of fixtures.profiles) {
    runSql(
      path,
      `
      INSERT INTO users (id, email, name, image, created_at, updated_at)
      VALUES ('${fixture.userId}', NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO profiles (user_id, slug, display_name, timezone, timezone_source, is_public, participates_in_leaderboards, created_at, updated_at)
      VALUES ('${fixture.userId}', '${fixture.slug}', '${fixture.slug}', '${fixture.timezone ?? 'UTC'}', 'user', ${fixture.isPublic}, ${fixture.participates}, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    `
    )
  }

  for (const fixture of fixtures.summaries ?? []) {
    const cacheRead = fixture.cacheRead ?? 0
    runSql(
      path,
      `
      INSERT INTO daily_usage_summary (
        user_id, usage_date, source, model, timezone,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        total_tokens, total_tokens_without_cache_read, cost_usd, session_count, updated_at
      ) VALUES (
        '${fixture.user}', '${fixture.date}', '${fixture.source}', '${fixture.model}', 'UTC',
        ${fixture.total}, 0, 0, ${cacheRead},
        ${fixture.total}, ${fixture.total - cacheRead}, ${fixture.cost ?? 0}, 1, '2026-05-15T00:00:00Z'
      );
    `
    )
  }

  for (const fixture of fixtures.usage ?? []) {
    const cacheRead = fixture.cacheRead ?? 0
    runSql(
      path,
      `
      INSERT INTO daily_usage (
        user_id, device_id, source, usage_date, timezone, model,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        total_tokens, cost_usd, session_count, snapshot_hash, synced_at
      ) VALUES (
        '${fixture.user}', '${fixture.device}', '${fixture.source}', '${fixture.date}', 'UTC', '${fixture.model}',
        ${fixture.total}, 0, 0, ${cacheRead},
        ${fixture.total}, ${fixture.cost ?? 0}, 1, 'hash', '2026-05-15T00:00:00Z'
      );
    `
    )
  }

  return { path, db: createSqliteD1(path) }
}
