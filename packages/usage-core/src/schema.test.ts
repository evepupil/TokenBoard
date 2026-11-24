import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  costUnavailableSources,
  isAntigravityUsageSource,
  isCostUnavailableSource,
  isValidIsoDate,
  isValidTimezone,
  roundUsd,
  snapshotHashPayload,
  snapshotKey,
  uploadIsoDateIssue,
  usageSnapshotSchema,
  usageSources,
  type UsageSnapshot
} from './index'

test('usageSources contains all 21 canonical sources', () => {
  assert.equal(usageSources.length, 21)
  assert.equal(isAntigravityUsageSource('antigravity-cli'), true)
  assert.equal(isAntigravityUsageSource('codex'), false)
  assert.equal(isCostUnavailableSource('grok-build'), true)
  assert.equal(isCostUnavailableSource('claude-code'), false)
  assert.equal(costUnavailableSources.length, 5)
})

test('snapshotHashPayload matches Go contract golden file byte-for-byte', () => {
  const goldensPath = resolve(process.cwd(), 'clients/go/internal/contract/goldens/snapshot-hash.json')
  const goldens = JSON.parse(readFileSync(goldensPath, 'utf8')) as Array<{
    name: string
    key: string
    hashPayload: string
  }>

  for (const entry of goldens) {
    const parsed = JSON.parse(entry.hashPayload) as UsageSnapshot
    const snapshot: UsageSnapshot = {
      ...parsed,
      collectedAt: '2026-05-09T10:00:00.000Z'
    }
    assert.equal(snapshotKey(snapshot), entry.key, `key mismatch for ${entry.name}`)
    assert.equal(snapshotHashPayload(snapshot), entry.hashPayload, `hashPayload mismatch for ${entry.name}`)
  }
})

test('date, timezone, cost, and schema validation enforce fail-closed contract', () => {
  assert.equal(isValidIsoDate('2026-02-28'), true)
  assert.equal(isValidIsoDate('2026-02-30'), false)
  assert.equal(isValidTimezone('Asia/Shanghai'), true)
  assert.equal(isValidTimezone('Invalid/Zone'), false)
  assert.equal(uploadIsoDateIssue('2022-12-31', new Date('2026-05-09T00:00:00.000Z')), 'before-history-window')
  assert.equal(uploadIsoDateIssue('2099-01-01', new Date('2026-05-09T00:00:00.000Z')), 'too-far-future')
  assert.equal(uploadIsoDateIssue('2026-05-09', new Date('2026-05-09T00:00:00.000Z')), null)
  assert.equal(roundUsd(0.123456), 0.1235)

  assert.throws(() =>
    usageSnapshotSchema.parse({
      source: 'antigravity',
      usageDate: '2026-05-09',
      timezone: 'UTC',
      model: 'gemini-3',
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 15,
      costUsd: 0.01,
      sessionCount: 1,
      collectedAt: '2026-05-09T10:00:00.000Z'
    })
  )
})
