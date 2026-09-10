import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { isSkippedOversizedSessionJsonlLine, readSessionJsonlLines } from './session-jsonl-line-reader'

describe('readSessionJsonlLines', () => {
  test('preserves LF, CRLF, and CR JSONL separators', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'separators.jsonl')

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, '{"type":"session_meta"}\n{"type":"summary"}\r\n{"type":"progress"}\r')

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toEqual(['{"type":"session_meta"}', '{"type":"summary"}', '{"type":"progress"}'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects invalid UTF-8 before a short JSONL row can be decoded with replacement characters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'invalid-short-utf8.jsonl')
    const malformed = Buffer.concat([
      Buffer.from('{"type":"response_item","payload":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}\n')
    ])

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, malformed)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains invalid UTF-8')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('yields a bounded skip marker for a non-usage line and continues with later records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'oversized.jsonl')
    const oversized = JSON.stringify({
      type: 'response_item',
      payload: { text: 'x'.repeat(512) }
    })
    const later = JSON.stringify({ type: 'session_meta' })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n${later}\n`)

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(2)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
      expect(isSkippedOversizedSessionJsonlLine(lines[0]) && lines[0].byteLength).toBe(Buffer.byteLength(oversized))
      expect(lines[1]).toBe(later)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('recognizes a known non-usage record type after an oversized content field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'late-type.jsonl')
    const oversized = `{"payload":{"text":"${'x'.repeat(512)}"},"type":"response_item"}`

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(1)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips a known non-usage record with a valid oversized irrelevant key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'oversized-key.jsonl')
    const oversized = JSON.stringify({
      ['x'.repeat(512)]: 'irrelevant',
      type: 'response_item'
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(1)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('still detects usage metadata after a valid oversized irrelevant key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'oversized-key-with-usage.jsonl')
    const oversized = JSON.stringify({
      ['x'.repeat(512)]: 'irrelevant',
      type: 'event_msg',
      payload: { info: { last_token_usage: { input_tokens: 1 } } }
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 1024,
          source: 'codex'
        })) {
        }
      }).rejects.toThrow('Session JSONL contains an oversized line with token or usage metadata')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails when usage metadata appears after the in-memory line limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'usage-after-limit.jsonl')
    const oversized = JSON.stringify({
      type: 'event_msg',
      padding: 'x'.repeat(128 * 1024),
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 1 } }
      }
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 256 * 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains an oversized line with token or usage metadata')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips a non-metric usage string without treating it as an upload usage object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'usage-string.jsonl')
    const oversized = JSON.stringify({
      type: 'response_item',
      payload: {
        usage: 'render diagnostics only',
        text: 'x'.repeat(512)
      }
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(1)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not treat token-shaped text inside a large content string as metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'token-text.jsonl')
    const oversized = JSON.stringify({
      type: 'response_item',
      payload: {
        text: `${'x'.repeat(256)} {"usage":{"input_tokens":1}} ${'y'.repeat(256)}`
      }
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(1)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails when an oversized usage object is split across stream chunks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'usage-object.jsonl')
    const oversized = `{"type":"assistant","padding":"${'x'.repeat(128 * 1024)}","usage" : {"input_tokens":1}}`

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 256 * 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains an oversized line with token or usage metadata')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails for an oversized empty usage object because the parser treats it as a metric row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'empty-usage.jsonl')
    const oversized = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-22T02:00:00.000Z',
      padding: 'x'.repeat(128 * 1024),
      usage: {}
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 256 * 1024,
          source: 'claude-code'
        })) {
        }
      }).rejects.toThrow('Session JSONL contains an oversized line with token or usage metadata')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails for an oversized Codex row with token fields outside the usage object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'unparsed-token.jsonl')
    const oversized = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        padding: 'x'.repeat(128 * 1024),
        unrelated: { input_tokens: 1 }
      }
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 256 * 1024,
          source: 'codex'
        })) {
        }
      }).rejects.toThrow('Session JSONL contains an oversized line with token or usage metadata')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not silently skip a malformed oversized row after the line limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'malformed.jsonl')
    const malformed = `{"type":"response_item","payload":"${'x'.repeat(512)}`

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${malformed}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains a malformed oversized line')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not silently skip an oversized row with a trailing comma', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'trailing-comma.jsonl')
    const malformed = `{"type":"response_item","payload":{"text":"${'x'.repeat(512)}"},}`

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${malformed}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains a malformed oversized line')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not silently skip an oversized row with a trailing comma after a scalar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'scalar-trailing-comma.jsonl')
    const malformed = `{"type":"response_item","payload":"${'x'.repeat(512)}","count":1,}`

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${malformed}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains a malformed oversized line')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not silently skip an oversized row with a trailing comma in an array', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'array-trailing-comma.jsonl')
    const malformed = `{"type":"response_item","payload":["${'x'.repeat(512)}",]}`

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${malformed}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains a malformed oversized line')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips an oversized row with valid scalar fields after a comma', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'scalar-fields.jsonl')
    const oversized = `{"type":"response_item","payload":"${'x'.repeat(512)}","count":1,"next":2}`

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(1)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('skips an oversized known record with valid multibyte UTF-8 content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'utf8.jsonl')
    const oversized = JSON.stringify({
      type: 'response_item',
      payload: `${'x'.repeat(512)}${String.fromCodePoint(0x4e2d)}`
    })

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${oversized}\n`)

      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(1)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not silently skip an oversized row with invalid UTF-8 content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'invalid-utf8.jsonl')
    const malformed = Buffer.concat([
      Buffer.from('{"type":"response_item","payload":"'),
      Buffer.from('x'.repeat(512)),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}\n')
    ])

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, malformed)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains a malformed oversized line')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses the final root type value when an oversized record repeats the type key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'repeated-type.jsonl')
    const unknownFinalType = `{"type":"response_item","payload":"${'x'.repeat(512)}","type":1}`
    const knownFinalType = `{"type":"unknown_record","payload":"${'x'.repeat(512)}","type":"response_item"}`

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, `${unknownFinalType}\n`)

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains an oversized line with an unknown record type')

      await writeFile(filePath, `${knownFinalType}\n`)
      const lines = []
      for await (const line of readSessionJsonlLines({
        filePath,
        startOffsetBytes: 0,
        maxLineBytes: 64,
        maxDiscardedLineBytes: 1024
      })) {
        lines.push(line)
      }

      expect(lines).toHaveLength(1)
      expect(isSkippedOversizedSessionJsonlLine(lines[0])).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('caps discarded non-usage line scanning without retaining the full row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'discard-limit.jsonl')

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(
        filePath,
        `${JSON.stringify({
          type: 'response_item',
          payload: { text: 'x'.repeat(65) }
        })}\n`
      )

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 32,
          maxDiscardedLineBytes: 64
        })) {
        }
      }).rejects.toThrow('Session JSONL contains a non-usage line exceeding the 64-byte discard limit')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not silently skip an oversized row with an unknown record type', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-session-jsonl-lines-'))
    const filePath = join(root, 'sessions', 'unknown-type.jsonl')

    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(
        filePath,
        `${JSON.stringify({
          type: 'unknown_record',
          payload: { text: 'x'.repeat(512) }
        })}\n`
      )

      await expect(async () => {
        for await (const _line of readSessionJsonlLines({
          filePath,
          startOffsetBytes: 0,
          maxLineBytes: 64,
          maxDiscardedLineBytes: 1024
        })) {
        }
      }).rejects.toThrow('Session JSONL contains an oversized line with an unknown record type')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
