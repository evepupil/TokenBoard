import { describe, expect, test } from 'vitest'
import { findMismatchedUsageTimezones, listActiveUsageTimezones } from './usage-timezone-scope'

describe('listActiveUsageTimezones', () => {
  test('reads the zones of the most recent usage date only', async () => {
    const statements: string[] = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        return {
          bind() {
            return {
              async all() {
                return { results: [{ timezone: 'Asia/Shanghai' }, { timezone: 'Asia/Shanghai' }] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    const zones = await listActiveUsageTimezones(db, 'u1')

    // A zone the user left years ago must not keep a warning alive, so the query is scoped to the
    // latest usage date rather than the whole history.
    expect(statements[0]).toContain('MAX(usage_date)')
    expect(zones).toEqual(['Asia/Shanghai'])
  })

  test('normalises an unusable stored zone instead of returning it raw', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                return { results: [{ timezone: 'Mars/Base' }] }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    expect(await listActiveUsageTimezones(db, 'u1')).toEqual(['UTC'])
  })
})

describe('findMismatchedUsageTimezones', () => {
  test('reports a collector still stamping the old zone', () => {
    expect(findMismatchedUsageTimezones('America/Los_Angeles', ['Asia/Shanghai'])).toEqual(['Asia/Shanghai'])
  })

  test('reports nothing when the collector and the profile agree', () => {
    expect(findMismatchedUsageTimezones('Asia/Shanghai', ['Asia/Shanghai'])).toEqual([])
  })

  test('reports nothing when there is no usage at all', () => {
    expect(findMismatchedUsageTimezones('Asia/Shanghai', [])).toEqual([])
  })

  // A user with machines in two zones has one of them disagreeing by construction; the point of
  // the check is to surface the disagreement, not to pick a winner.
  test('reports every disagreeing zone', () => {
    // Input order is preserved; the caller sorts for display.
    expect(findMismatchedUsageTimezones('UTC', ['Asia/Shanghai', 'America/Los_Angeles'])).toEqual([
      'Asia/Shanghai',
      'America/Los_Angeles'
    ])
  })

  test('treats an unusable profile zone as UTC rather than flagging every collector', () => {
    expect(findMismatchedUsageTimezones('Mars/Base', ['UTC'])).toEqual([])
  })

  // `normalizeTimezone` only checks the spelling; the same calendar under two names (the older
  // alias of a zone) is not a collector that needs reinstalling.
  test('treats an alias of the same zone as the same zone', () => {
    expect(findMismatchedUsageTimezones('UTC', ['Etc/UTC'])).toEqual([])
    expect(findMismatchedUsageTimezones('Asia/Kolkata', ['Asia/Calcutta'])).toEqual([])
    expect(findMismatchedUsageTimezones('Asia/Calcutta', ['Asia/Kolkata'])).toEqual([])
  })
})
