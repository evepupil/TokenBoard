import { appendFile, lstat, mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'
import {
  codexChildSessionReadLimits,
  formatCodexUsageDate,
  maxCodexChildSessionBytes,
  maxCodexChildSessionLineBytes,
  maxCodexChildUsageEvents,
  maxMergedCodexChildUsageEvents,
  mergeChildUsageEventsByDate,
  readChildLastUsageByDate,
  readChildLastUsageEvents
} from './codex-subagent-usage-child'
import {
  normalizeDate,
  readJsonlRecords,
  readJsonlRecordsFromStream,
  readNumber,
  readTotalTokens
} from './codex-subagent-usage-json'

const childUsageEventLimitTestTimeoutMs = 60_000

describe('Codex JSONL reader', () => {
  test('normalizes inconsistent Codex child totals', () => {
    expect(
      readTotalTokens({
        input_tokens: 10,
        output_tokens: 4,
        cache_write_input_tokens: 3,
        cached_input_tokens: 20,
        total_tokens: 15
      })
    ).toBe(37)
  })

  test('ignores negative and fractional token fields', () => {
    expect(readNumber({ input_tokens: -10 }, ['input_tokens'])).toBe(0)
    expect(readNumber({ input_tokens: 1.5 }, ['input_tokens'])).toBe(0)
    expect(readNumber({ input_tokens: Number.MAX_SAFE_INTEGER + 1 }, ['input_tokens'])).toBe(0)
    expect(readNumber({ input_tokens: 12 }, ['input_tokens'])).toBe(12)
  })

  test('reuses one date formatter for repeated Codex usage dates in the same timezone', () => {
    const OriginalDateTimeFormat = Intl.DateTimeFormat
    let formatterCount = 0
    Object.defineProperty(Intl, 'DateTimeFormat', {
      configurable: true,
      value: function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
        formatterCount += 1
        return new OriginalDateTimeFormat(...args)
      }
    })

    try {
      for (let index = 0; index < 1_000; index += 1) {
        expect(formatCodexUsageDate('2026-05-25T01:10:00.000Z', 'Asia/Shanghai')).toBe('2026-05-25')
      }
      expect(formatterCount).toBe(1)
    } finally {
      Object.defineProperty(Intl, 'DateTimeFormat', {
        configurable: true,
        value: OriginalDateTimeFormat
      })
    }
  })

  test('caches a repeated Codex usage timestamp after formatting it once', () => {
    const formatToParts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')

    try {
      for (let index = 0; index < 1_000; index += 1) {
        expect(formatCodexUsageDate('2026-05-25T01:10:00.000Z', 'Pacific/Kiritimati')).toBe('2026-05-25')
      }
      expect(formatToParts).toHaveBeenCalledTimes(1)
    } finally {
      formatToParts.mockRestore()
    }
  })

  test('destroys the input stream when the consumer stops early', async () => {
    let emitted = false
    const stream = new Readable({
      read() {
        if (emitted) return
        emitted = true
        this.push('{"type":"session_meta"}\n')
      }
    })
    const iterator = readJsonlRecordsFromStream(stream)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'session_meta' }
    })
    await iterator.return?.()

    expect(stream.destroyed).toBe(true)
  })

  test('rejects an early child-session reader exit after a same-size source replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-child-early-replace-'))
    const filePath = join(root, 'child.jsonl')
    const original = '{"type":"session_meta","id":"a"}\n{"type":"event_msg"}\n'
    const replacement = '{"type":"session_meta","id":"b"}\n{"type":"event_msg"}\n'

    try {
      expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original))
      await writeFile(filePath, original)
      const iterator = readJsonlRecords(filePath, undefined, {
        maxBytes: 1024,
        maxLineBytes: 128,
        label: 'Codex child session'
      })[Symbol.asyncIterator]()

      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: 'session_meta', id: 'a' }
      })
      await writeFile(filePath, replacement)

      const stop = iterator.return
      if (!stop) throw new Error('Codex JSONL iterator does not support early return')
      await expect(stop.call(iterator)).rejects.toThrow('Codex child session changed while reading; retry the sync')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')(
    'rejects an early child-session reader exit after an atomic replacement',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-child-atomic-replace-'))
      const filePath = join(root, 'child.jsonl')
      const replacementPath = join(root, 'replacement.jsonl')
      const original = '{"type":"session_meta","id":"a"}\n{"type":"event_msg"}\n'
      const replacement = '{"type":"session_meta","id":"b"}\n{"type":"event_msg"}\n'

      try {
        await writeFile(filePath, original)
        const originalStat = await lstat(filePath)
        const iterator = readJsonlRecords(filePath, undefined, {
          maxBytes: 1024,
          maxLineBytes: 128,
          label: 'Codex child session'
        })[Symbol.asyncIterator]()

        await expect(iterator.next()).resolves.toMatchObject({
          done: false,
          value: { type: 'session_meta', id: 'a' }
        })
        await writeFile(replacementPath, replacement)
        await rename(replacementPath, filePath)
        const replacementStat = await lstat(filePath)
        expect(replacementStat.ino).not.toBe(originalStat.ino)

        const stop = iterator.return
        if (!stop) throw new Error('Codex JSONL iterator does not support early return')
        await expect(stop.call(iterator)).rejects.toThrow('Codex child session changed while reading; retry the sync')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  test('reads CRLF-delimited records split across chunks', async () => {
    const stream = Readable.from([Buffer.from('{"type":"session_meta"}\r'), Buffer.from('\n{"type":"event_msg"}\r\n')])
    const records: unknown[] = []

    for await (const record of readJsonlRecordsFromStream(stream, undefined, { maxLineBytes: 64 })) {
      records.push(record)
    }

    expect(records).toEqual([{ type: 'session_meta' }, { type: 'event_msg' }])
  })

  test('does not turn a delayed CRLF continuation into a blank row', async () => {
    const stream = new Readable({
      read() {
        this.push(Buffer.from('{"type":"session_meta"}\r'))
        this.push(Buffer.alloc(0))
        this.push(Buffer.from('\n{"type":"event_msg"}\n'))
        this.push(null)
      }
    })
    const warnings: string[] = []

    for await (const _record of readJsonlRecordsFromStream(stream, (line) => warnings.push(line), {
      maxLineBytes: 64
    })) {
    }

    expect(warnings).toEqual([])
  })

  test('emits a line when its LF terminator starts the next chunk', async () => {
    const stream = Readable.from([Buffer.from('{"type":"session_meta"}'), Buffer.from('\n{"type":"event_msg"}\n')])
    const records: unknown[] = []

    for await (const record of readJsonlRecordsFromStream(stream, undefined, { maxLineBytes: 64 })) {
      records.push(record)
    }

    expect(records).toEqual([{ type: 'session_meta' }, { type: 'event_msg' }])
  })

  test('preserves standalone CR line delimiters', async () => {
    const stream = Readable.from([Buffer.from('{"type":"session_meta"}\r{"type":"event_msg"}\r')])
    const records: unknown[] = []

    for await (const record of readJsonlRecordsFromStream(stream, undefined, { maxLineBytes: 64 })) {
      records.push(record)
    }

    expect(records).toEqual([{ type: 'session_meta' }, { type: 'event_msg' }])
  })

  test('rejects invalid UTF-8 before a short child row can be decoded with replacement characters', async () => {
    const malformed = Buffer.concat([
      Buffer.from('{"type":"event_msg","payload":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}\n')
    ])

    await expect(async () => {
      for await (const _record of readJsonlRecordsFromStream(Readable.from([malformed]), undefined, {
        ...codexChildSessionReadLimits,
        maxLineBytes: 1024
      })) {
      }
    }).rejects.toThrow('Codex child session contains invalid UTF-8')
  })

  test('does not skip a malformed oversized child row', async () => {
    const malformed = `{"type":"compacted","payload":"${'x'.repeat(128)}`

    await expect(async () => {
      for await (const _record of readJsonlRecordsFromStream(Readable.from([Buffer.from(malformed)]), undefined, {
        ...codexChildSessionReadLimits,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 512
      })) {
      }
    }).rejects.toThrow('Codex child session contains a malformed oversized line')
  })

  test('does not skip an oversized child row with invalid UTF-8 content', async () => {
    const malformed = Buffer.concat([
      Buffer.from('{"type":"compacted","payload":"'),
      Buffer.from('x'.repeat(128)),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}')
    ])

    await expect(async () => {
      for await (const _record of readJsonlRecordsFromStream(Readable.from([malformed]), undefined, {
        ...codexChildSessionReadLimits,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 512
      })) {
      }
    }).rejects.toThrow('Codex child session contains a malformed oversized line')
  })

  test('does not skip invalid UTF-8 split across oversized child row chunks', async () => {
    const firstChunk = Buffer.concat([
      Buffer.from('{"type":"compacted","payload":"'),
      Buffer.from('x'.repeat(128)),
      Buffer.from([0xc3])
    ])
    const secondChunk = Buffer.concat([Buffer.from([0x28]), Buffer.from('"}')])

    await expect(async () => {
      for await (const _record of readJsonlRecordsFromStream(Readable.from([firstChunk, secondChunk]), undefined, {
        ...codexChildSessionReadLimits,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 512
      })) {
      }
    }).rejects.toThrow('Codex child session contains a malformed oversized line')
  })

  test('does not skip an oversized child row with an escaped usage key', async () => {
    const oversized = `{"type":"event_msg","payload":{"info":{"\\u0074otal_token_usage":{"input_tokens":1}}},"padding":"${'x'.repeat(128)}"}`

    await expect(async () => {
      for await (const _record of readJsonlRecordsFromStream(Readable.from([Buffer.from(oversized)]), undefined, {
        ...codexChildSessionReadLimits,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 512
      })) {
      }
    }).rejects.toThrow('Codex child session contains an oversized line with usage or subagent metadata')
  })

  test('rejects an oversized line across chunks before buffering the full line', async () => {
    const stream = Readable.from([
      Buffer.from('a'.repeat(16)),
      Buffer.from('b'.repeat(17)),
      Buffer.from('c'.repeat(64))
    ])

    await expect(async () => {
      for await (const _record of readJsonlRecordsFromStream(stream, undefined, {
        maxLineBytes: 32,
        label: 'Codex child session'
      })) {
      }
    }).rejects.toThrow('Codex child session contains a line exceeding the 32-byte limit')

    expect(stream.destroyed).toBe(true)
  })

  test('enforces the total byte limit for direct JSONL streams', async () => {
    const stream = Readable.from([Buffer.from('{"type":"session_meta"}\n'), Buffer.from('{"type":"event_msg"}\n')])

    await expect(async () => {
      for await (const _record of readJsonlRecordsFromStream(stream, undefined, {
        maxBytes: 32,
        maxLineBytes: 64,
        label: 'Codex child session'
      })) {
      }
    }).rejects.toThrow('Codex child session exceeds the 32-byte limit')

    expect(stream.destroyed).toBe(true)
  })

  test('bounds discarded oversized lines when an explicit streaming policy is enabled', async () => {
    const stream = Readable.from([Buffer.from('{"type":"compacted","payload":"'), Buffer.from('x'.repeat(65))])

    await expect(async () => {
      for await (const _record of readJsonlRecordsFromStream(stream, undefined, {
        maxLineBytes: 32,
        maxDiscardedLineBytes: 64,
        relevantMetadataKeys: ['total_token_usage'],
        discardableLineTypes: ['compacted'],
        label: 'Codex child session'
      })) {
      }
    }).rejects.toThrow('Codex child session contains a line exceeding the 64-byte discarded-line limit')

    expect(stream.destroyed).toBe(true)
  })

  test('rejects impossible ISO calendar dates instead of normalizing them', () => {
    expect(() => normalizeDate('2026-02-30T00:00:00.000Z')).toThrow('Invalid Codex date')
    expect(() => normalizeDate('2026-02-30')).toThrow('Invalid Codex date')
    expect(() => normalizeDate('2026-02-30 00:00:00')).toThrow('Invalid Codex date')
    expect(() => normalizeDate('2026-02-30Z')).toThrow('Invalid Codex date')
    expect(normalizeDate('2024-02-29T00:00:00.000Z')).toBe('2024-02-29')
  })

  test('rejects an impossible child usage timestamp before assigning a usage date', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-date-'))
    const filePath = join(root, 'child.jsonl')

    try {
      await writeFile(
        filePath,
        `${JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-02-30T00:00:00.000Z',
          payload: {
            info: {
              total_token_usage: { input_tokens: 1, total_tokens: 1 },
              last_token_usage: { input_tokens: 1, total_tokens: 1 }
            }
          }
        })}\n`
      )

      await expect(readChildLastUsageByDate(filePath, '2026-02-01T00:00:00.000Z', 'UTC')).rejects.toThrow(
        'Invalid Codex date'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('streams a child JSONL larger than the former 8 MiB limit when its rows remain bounded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-child-streaming-'))
    const filePath = join(root, 'child.jsonl')
    const padding = `${' '.repeat(256 * 1024 - 1)}\n`

    try {
      for (let index = 0; index < 33; index += 1) {
        await appendFile(filePath, padding)
      }
      await appendFile(filePath, `${JSON.stringify(childUsageEvent(1))}\n`)

      await expect(readChildLastUsageEvents(filePath, '2026-05-25T01:00:00.000Z', 'UTC')).resolves.toEqual([
        expect.objectContaining({
          usageDate: '2026-05-25',
          totalTokens: 1
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects a child JSONL over the bounded input size before parsing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-child-bytes-'))
    const filePath = join(root, 'child.jsonl')

    try {
      await writeFile(filePath, '')
      await truncate(filePath, maxCodexChildSessionBytes + 1)

      await expect(readChildLastUsageEvents(filePath, '2026-05-25T01:00:00.000Z', 'UTC')).rejects.toThrow(
        `Codex child session exceeds the ${maxCodexChildSessionBytes}-byte limit`
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')('rejects a symbolic link child JSONL before opening it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-child-symlink-'))
    const targetPath = join(root, 'target.jsonl')
    const linkedPath = join(root, 'linked.jsonl')

    try {
      await writeFile(targetPath, `${JSON.stringify(childUsageEvent(1))}\n`)
      await symlink(targetPath, linkedPath)

      await expect(readChildLastUsageEvents(linkedPath, '2026-05-25T01:00:00.000Z', 'UTC')).rejects.toThrow(
        'Unable to read Codex child session: symbolic links are not supported'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects an oversized child JSONL line before parsing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-child-line-'))
    const filePath = join(root, 'child.jsonl')

    try {
      await writeFile(filePath, `${' '.repeat(maxCodexChildSessionLineBytes + 1)}\n`)

      await expect(readChildLastUsageEvents(filePath, '2026-05-25T01:00:00.000Z', 'UTC')).rejects.toThrow(
        `Codex child session contains a line exceeding the ${maxCodexChildSessionLineBytes}-byte limit`
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips oversized child rows without usage or subagent metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-child-irrelevant-line-'))
    const filePath = join(root, 'child.jsonl')
    const warnings: string[] = []
    const oversized = JSON.stringify({
      type: 'compacted',
      payload: { summary: 'x'.repeat(maxCodexChildSessionLineBytes + 1) }
    })

    try {
      await writeFile(filePath, `${oversized}\n${JSON.stringify(childUsageEvent(1))}\n`)

      await expect(
        readChildLastUsageEvents(filePath, '2026-05-25T01:00:00.000Z', 'UTC', (line) => warnings.push(line))
      ).resolves.toEqual([
        expect.objectContaining({
          usageDate: '2026-05-25',
          totalTokens: 1
        })
      ])
      expect(warnings).toEqual([
        `Skipped 1 oversized Codex child session JSONL row without usage or subagent metadata (largest ${Buffer.byteLength(oversized)} bytes)`
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects an oversized child row containing token usage metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-child-usage-line-'))
    const filePath = join(root, 'child.jsonl')
    const usage = { input_tokens: 1, total_tokens: 1 }
    const oversized = JSON.stringify({
      type: 'event_msg',
      payload: {
        info: {
          total_token_usage: usage,
          last_token_usage: usage,
          padding: 'x'.repeat(maxCodexChildSessionLineBytes + 1)
        }
      }
    })

    try {
      await writeFile(filePath, `${oversized}\n`)

      await expect(readChildLastUsageEvents(filePath, '2026-05-25T01:00:00.000Z', 'UTC')).rejects.toThrow(
        'Codex child session contains an oversized line with usage or subagent metadata'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects an oversized child row containing subagent metadata', async () => {
    const oversized = JSON.stringify({
      type: 'session_meta',
      payload: {
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: 'parent'
            }
          }
        },
        padding: 'x'.repeat(maxCodexChildSessionLineBytes + 1)
      }
    })

    await expect(async () => {
      for await (const _record of readJsonlRecordsFromStream(
        Readable.from([Buffer.from(`${oversized}\n`)]),
        undefined,
        codexChildSessionReadLimits
      )) {
      }
    }).rejects.toThrow('Codex child session contains an oversized line with usage or subagent metadata')
  })

  test(
    'rejects excessive unique child usage events instead of retaining them unboundedly',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-child-events-'))
      const filePath = join(root, 'child.jsonl')

      try {
        const rows = Array.from({ length: maxCodexChildUsageEvents + 1 }, (_, index) =>
          JSON.stringify(childUsageEvent(index + 1))
        )
        await writeFile(filePath, `${rows.join('\n')}\n`)

        await expect(readChildLastUsageEvents(filePath, '2026-05-25T01:00:00.000Z', 'UTC')).rejects.toThrow(
          `Codex child session exceeds the ${maxCodexChildUsageEvents} unique usage-event limit`
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    childUsageEventLimitTestTimeoutMs
  )

  test('rejects excessive combined multi-profile child usage events', () => {
    const eventLists = [
      Array.from({ length: maxMergedCodexChildUsageEvents + 1 }, (_, index) => ({
        eventKey: `event-${index}`,
        usageDate: '2026-05-25',
        inputTokens: 1,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 1
      }))
    ]

    expect(() => mergeChildUsageEventsByDate(eventLists)).toThrow(
      `Codex child usage correction exceeds the ${maxMergedCodexChildUsageEvents} unique usage-event limit`
    )
  })

  test('preserves cache creation tokens from child usage records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-cache-creation-'))
    const filePath = join(root, 'child.jsonl')

    try {
      const usage = {
        input_tokens: 200,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cached_input_tokens: 150,
        total_tokens: 250
      }
      await writeFile(
        filePath,
        `${JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-05-25T01:10:00.000Z',
          payload: { info: { total_token_usage: usage, last_token_usage: usage } }
        })}\n`
      )

      await expect(readChildLastUsageByDate(filePath, '2026-05-25T01:00:00.000Z', 'UTC')).resolves.toEqual([
        {
          usageDate: '2026-05-25',
          inputTokens: 200,
          outputTokens: 20,
          cacheCreationTokens: 30,
          cacheReadTokens: 150,
          totalTokens: 250
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reports child records missing per-request usage without treating them as zero usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-child-missing-last-'))
    const filePath = join(root, 'child.jsonl')
    const warnings: string[] = []

    try {
      await writeFile(
        filePath,
        `${JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-05-25T01:10:00.000Z',
          payload: {
            info: {
              total_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
            }
          }
        })}\n`
      )

      await expect(
        readChildLastUsageEvents(filePath, '2026-05-25T01:00:00.000Z', 'UTC', (line) => warnings.push(line))
      ).resolves.toEqual([])
      expect(warnings).toEqual([
        'Skipped 1 Codex child usage record with total_token_usage but missing last_token_usage'
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps same-value events distinct while deduplicating the same child across profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-child-event-identity-'))
    const firstPath = join(root, 'profile-a', 'sessions', '2026', '05', '25', 'child-a.jsonl')
    const copiedPath = join(root, 'profile-b', 'sessions', '2026', '05', '25', 'child-a.jsonl')
    const otherPath = join(root, 'profile-c', 'sessions', '2026', '05', '25', 'child-b.jsonl')

    try {
      await Promise.all([
        mkdir(join(root, 'profile-a', 'sessions', '2026', '05', '25'), { recursive: true }),
        mkdir(join(root, 'profile-b', 'sessions', '2026', '05', '25'), { recursive: true }),
        mkdir(join(root, 'profile-c', 'sessions', '2026', '05', '25'), { recursive: true })
      ])
      await Promise.all([
        writeFile(
          firstPath,
          `${JSON.stringify(childUsageEventAt(1, '2026-05-25T01:10:00.000Z'))}\n${JSON.stringify(childUsageEventAt(1, '2026-05-25T01:20:00.000Z'))}\n`
        ),
        writeFile(copiedPath, `${JSON.stringify(childUsageEventAt(1, '2026-05-25T01:10:00.000Z'))}\n`),
        writeFile(otherPath, `${JSON.stringify(childUsageEventAt(1, '2026-05-25T01:10:00.000Z'))}\n`)
      ])

      const [firstEvents, copiedEvents, otherEvents] = await Promise.all([
        readChildLastUsageEvents(firstPath, '2026-05-25T01:00:00.000Z', 'UTC'),
        readChildLastUsageEvents(copiedPath, '2026-05-25T01:00:00.000Z', 'UTC'),
        readChildLastUsageEvents(otherPath, '2026-05-25T01:00:00.000Z', 'UTC')
      ])

      expect(firstEvents).toHaveLength(2)
      expect(firstEvents[0].eventKey).toBe(copiedEvents[0].eventKey)
      expect(firstEvents[0].eventKey).not.toBe(otherEvents[0].eventKey)
      expect(mergeChildUsageEventsByDate([firstEvents, copiedEvents, otherEvents])).toEqual([
        expect.objectContaining({
          usageDate: '2026-05-25',
          totalTokens: 3
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function childUsageEvent(index: number) {
  return childUsageEventAt(index, '2026-05-25T01:10:00.000Z')
}

function childUsageEventAt(index: number, timestamp: string) {
  const usage = { input_tokens: index, total_tokens: index }
  return {
    type: 'event_msg',
    timestamp,
    payload: { info: { total_token_usage: usage, last_token_usage: usage } }
  }
}
