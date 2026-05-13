import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildDefaultSince, readSince } from './sync-options.mjs'

test('buildDefaultSince returns compact local date for the lookback window', () => {
  assert.equal(
    buildDefaultSince({
      now: new Date('2026-05-09T08:00:00.000Z'),
      timezone: 'Asia/Shanghai',
      lookbackDays: 7
    }),
    '20260502'
  )
})

test('buildDefaultSince handles timezone calendar dates without locale string parsing', () => {
  const RealDate = globalThis.Date
  class ThrowOnStringDate extends RealDate {
    constructor(...args) {
      if (typeof args[0] === 'string') {
        throw new Error('string date parsing is not allowed')
      }
      super(...args)
    }
  }

  globalThis.Date = ThrowOnStringDate
  try {
    assert.equal(
      buildDefaultSince({
        now: new RealDate('2026-01-01T00:30:00.000Z'),
        timezone: 'America/Los_Angeles',
        lookbackDays: 1
      }),
      '20251230'
    )

    assert.equal(
      buildDefaultSince({
        now: new RealDate('2026-01-01T00:30:00.000Z'),
        timezone: 'Pacific/Kiritimati',
        lookbackDays: 1
      }),
      '20251231'
    )
  } finally {
    globalThis.Date = RealDate
  }
})

test('readSince prefers CLI flag then environment then config then default', () => {
  assert.equal(
    readSince({
      flags: { since: '20260509' },
      env: { TOKENBOARD_SINCE: '20260508' },
      config: { since: '20260507', timezone: 'Asia/Shanghai' },
      now: new Date('2026-05-09T08:00:00.000Z')
    }),
    '20260509'
  )

  assert.equal(
    readSince({
      flags: {},
      env: { TOKENBOARD_SINCE: '20260508' },
      config: { since: '20260507', timezone: 'Asia/Shanghai' },
      now: new Date('2026-05-09T08:00:00.000Z')
    }),
    '20260508'
  )

  assert.equal(
    readSince({
      flags: {},
      env: {},
      config: { since: '20260507', timezone: 'Asia/Shanghai' },
      now: new Date('2026-05-09T08:00:00.000Z')
    }),
    '20260507'
  )

  assert.equal(
    readSince({
      flags: {},
      env: {},
      config: { timezone: 'Asia/Shanghai' },
      now: new Date('2026-05-09T08:00:00.000Z')
    }),
    '20260502'
  )
})

test('readSince keeps explicit all sentinel', () => {
  assert.equal(
    readSince({
      flags: { since: 'all' },
      env: {},
      config: { timezone: 'Asia/Shanghai' },
      now: new Date('2026-05-09T08:00:00.000Z')
    }),
    'all'
  )
})

test('sync script forwards resolved since to all collectors', () => {
  const source = readFileSync(new URL('./sync.mjs', import.meta.url), 'utf8')

  assert.match(source, /TOKENBOARD_SINCE:\s*since/)
  assert.match(source, /TOKENBOARD_DEFAULT_SINCE:\s*since/)
})
