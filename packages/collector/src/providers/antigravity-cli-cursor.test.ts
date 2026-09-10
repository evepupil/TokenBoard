import { describe, expect, test } from 'vitest'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import {
  assertCliHistoryEventsCanApplyIncrementally,
  cliHistoryAggregateKey,
  cliHistoryEventKey,
  cliHistorySessionKey,
  cliHistorySnapshotGroupFromEvent,
  pushCliHistoryUsageEvent,
  pushCompleteCliCursorSnapshots
} from './antigravity-cli-cursor'
import { mergeSnapshots } from './session-cursor'
import type { CursorState } from './session-cursor-store'

const cascadeHash = 'a'.repeat(64)
const firstEventHash = 'b'.repeat(64)
const secondEventHash = 'c'.repeat(64)
const timezone = 'UTC'
const collectedAt = '2026-07-20T10:00:00.000Z'

describe('Antigravity CLI history cursor', () => {
  test('keeps distinct history events with identical token counts and counts one session', () => {
    const cursor = emptyCursor()
    const snapshots: UsageSnapshot[] = []
    const emittedKeys = new Set<string>()
    const first = historyEvent(firstEventHash)
    const second = historyEvent(secondEventHash)

    pushCliHistoryUsageEvent({ event: first, cursor, snapshots, emittedKeys, timezone, collectedAt })
    pushCliHistoryUsageEvent({ event: second, cursor, snapshots, emittedKeys, timezone, collectedAt })

    expect(mergeSnapshots(snapshots)).toEqual([
      expect.objectContaining({ inputTokens: 20, totalTokens: 20, sessionCount: 1 })
    ])
    expect(cursor.files[cliHistoryEventKey(first)]).toBeDefined()
    expect(cursor.files[cliHistoryEventKey(second)]).toBeDefined()
    expect(
      cursor.files[
        cliHistorySessionKey({
          cascadeHash,
          usageDate: '2026-07-20',
          model: 'gemini-3-flash-a'
        })
      ]
    ).toBeDefined()
  })

  test('re-emits a pending event without creating another history identity', () => {
    const cursor = emptyCursor()
    const firstSnapshots: UsageSnapshot[] = []
    const event = historyEvent(firstEventHash)

    pushCliHistoryUsageEvent({
      event,
      cursor,
      snapshots: firstSnapshots,
      emittedKeys: new Set(),
      timezone,
      collectedAt
    })
    const retrySnapshots: UsageSnapshot[] = []
    pushCliHistoryUsageEvent({
      event,
      cursor,
      snapshots: retrySnapshots,
      emittedKeys: new Set(),
      timezone,
      collectedAt: '2026-07-20T10:01:00.000Z'
    })

    expect(retrySnapshots).toEqual([expect.objectContaining({ inputTokens: 10, totalTokens: 10, sessionCount: 1 })])
    expect(Object.keys(cursor.files).filter((key) => key.startsWith('history-event\0'))).toHaveLength(1)
  })

  test('merges all pending entries for a dirty daily model snapshot group', () => {
    const cursor = emptyCursor()
    const snapshots: UsageSnapshot[] = []
    const emittedKeys = new Set<string>()
    const first = historyEvent(firstEventHash)
    const second = historyEvent(secondEventHash)
    pushCliHistoryUsageEvent({ event: first, cursor, snapshots, emittedKeys, timezone, collectedAt })
    pushCliHistoryUsageEvent({ event: second, cursor, snapshots, emittedKeys, timezone, collectedAt })

    const complete: UsageSnapshot[] = []
    pushCompleteCliCursorSnapshots(complete, cursor, collectedAt, new Set())

    expect(mergeSnapshots(complete)).toEqual([
      expect.objectContaining({ inputTokens: 20, totalTokens: 20, sessionCount: 1 })
    ])
  })

  test('requires a full rebuild for an expired unknown session in a compacted daily model', () => {
    const cursor = emptyCursor()
    const event = historyEvent(firstEventHash, '2025-01-01T10:00:00.000Z')
    const group = cliHistorySnapshotGroupFromEvent(event, timezone)
    cursor.files[cliHistoryAggregateKey(group)] = aggregateEntry()
    cursor.antigravityCliHistoryCompactedThroughDate = '2026-04-21'

    expect(() => assertCliHistoryEventsCanApplyIncrementally({ cursor, events: [event], timezone })).toThrow(
      'rerun with --since all'
    )
  })

  test('uses the persisted compacted frontier instead of the current clock for unknown events', () => {
    const cursor = emptyCursor()
    const createdAt = new Date().toISOString()
    const event = historyEvent(firstEventHash, createdAt)
    cursor.antigravityCliHistoryCompactedThroughDate = createdAt.slice(0, 10)

    expect(() => assertCliHistoryEventsCanApplyIncrementally({ cursor, events: [event], timezone })).toThrow(
      'rerun with --since all'
    )
  })

  test('requires a full rebuild when an old unknown event shares a retained session marker', () => {
    const cursor = emptyCursor()
    const event = historyEvent(firstEventHash, '2025-01-01T10:00:00.000Z')
    cursor.antigravityCliHistoryCompactedThroughDate = '2026-04-21'
    cursor.files[
      cliHistorySessionKey({
        cascadeHash,
        usageDate: '2025-01-01',
        model: 'gemini-3-flash-a'
      })
    ] = aggregateEntry()

    expect(() => assertCliHistoryEventsCanApplyIncrementally({ cursor, events: [event], timezone })).toThrow(
      'rerun with --since all'
    )
  })

  test('allows a recent new session to extend an existing compacted daily model', () => {
    const cursor = emptyCursor()
    const event = historyEvent(firstEventHash, new Date().toISOString())
    const group = cliHistorySnapshotGroupFromEvent(event, timezone)
    cursor.files[cliHistoryAggregateKey(group)] = aggregateEntry()

    expect(() => assertCliHistoryEventsCanApplyIncrementally({ cursor, events: [event], timezone })).not.toThrow()
  })
})

function emptyCursor(): CursorState {
  return { version: 1, source: 'antigravity-cli', antigravityCliMeteringVersion: 3, files: {} }
}

function historyEvent(eventHash: string, createdAt = '2026-07-20T10:00:00.000Z') {
  return {
    cascadeHash,
    eventHash,
    createdAt,
    model: 'gemini-3-flash-a',
    inputTokens: 10,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0
  }
}

function aggregateEntry() {
  return {
    size: 0,
    mtimeMs: Date.now(),
    sha256: 'd'.repeat(64),
    snapshots: [],
    missingCost: true,
    pendingUpload: false,
    updatedAt: collectedAt
  }
}
