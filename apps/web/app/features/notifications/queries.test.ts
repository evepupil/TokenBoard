import { describe, expect, test } from 'vitest'
import {
  claimWebhookSubscription,
  hasSuccessfulDailyDelivery,
  insertDeliveryLog,
  listDueWebhookSubscriptions,
  pruneWebhookDeliveryLogs
} from './queries'

describe('notification queries', () => {
  test('filters out active delivery locks when listing due subscriptions', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async all() {
                return { results: [] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await listDueWebhookSubscriptions(db, '2026-04-29T01:31:00.000Z', 50)

    expect(statements[0]).toContain('webhook_subscriptions.locked_until IS NULL')
    expect(statements[0]).toContain('webhook_subscriptions.locked_until <= ?')
    expect(bindings[0]).toEqual(['2026-04-29T01:31:00.000Z', '2026-04-29T01:31:00.000Z', 50])
  })

  test('claims only due enabled subscriptions with an expired lock', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const claimed = await claimWebhookSubscription({
      db,
      subscriptionId: 'sub_1',
      nowIso: '2026-04-29T01:31:00.000Z',
      lockedUntilIso: '2026-04-29T01:41:00.000Z'
    })

    expect(claimed).toBe(true)
    expect(statements[0]).toContain('enabled = 1')
    expect(statements[0]).toContain('next_run_at <= ?')
    expect(statements[0]).toContain('locked_until <= ?')
    expect(bindings[0]).toEqual([
      '2026-04-29T01:41:00.000Z',
      '2026-04-29T01:31:00.000Z',
      '2026-04-29T01:31:00.000Z',
      'sub_1',
      '2026-04-29T01:31:00.000Z',
      '2026-04-29T01:31:00.000Z'
    ])
  })

  test('checks daily success by schedule slot', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async first() {
                return { id: 'whl_1' }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const delivered = await hasSuccessfulDailyDelivery({
      db,
      subscriptionId: 'sub_1',
      reportDate: '2026-04-29',
      scheduleSlot: '2026-04-29T09:30'
    })

    expect(delivered).toBe(true)
    expect(statements[0]).toContain('schedule_slot = ?')
    expect(bindings[0]).toEqual(['sub_1', '2026-04-29', '2026-04-29T09:30'])
  })

  test('writes delivery logs with schedule slot in the daily success idempotency key', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async run() {
                return {}
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await insertDeliveryLog({
      db,
      id: 'whl_1',
      subscriptionId: 'sub_1',
      userId: 'user_1',
      reportDate: '2026-04-29',
      scheduleSlot: '2026-04-29T18:00',
      kind: 'daily',
      status: 'success',
      httpStatus: 200,
      attempt: 1,
      durationMs: 123,
      createdAt: '2026-04-29T10:00:00.000Z',
      ignoreDuplicateDailySuccess: true
    })

    expect(statements[0]).toContain('schedule_slot')
    expect(statements[0]).toContain('ON CONFLICT(subscription_id, report_date, kind, schedule_slot)')
    expect(statements[0]).toContain('schedule_slot IS NOT NULL')
    expect(bindings[0]).toEqual([
      'whl_1',
      'sub_1',
      'user_1',
      '2026-04-29',
      '2026-04-29T18:00',
      'daily',
      'success',
      200,
      1,
      null,
      123,
      '2026-04-29T10:00:00.000Z'
    ])
  })

  test('prunes webhook delivery logs older than a cutoff timestamp', async () => {
    const statements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async run() {
                return {}
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await pruneWebhookDeliveryLogs({
      db,
      cutoffIso: '2026-01-30T00:00:00.000Z'
    })

    expect(statements[0]).toBe('DELETE FROM webhook_delivery_logs WHERE created_at < ?')
    expect(bindings[0]).toEqual(['2026-01-30T00:00:00.000Z'])
  })
})
