import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import { decompressZstdFrame, decompressZstdFrames, isZstdBuffer, scanZstdFrames } from './zstd-frames'

// DSH writes frames with a content checksum.
const checksumOptions = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

function frame(text: string, options = {}) {
  return zstdCompressSync(Buffer.from(text), options)
}

describe('zstd frames', () => {
  test('decodes every frame of a concatenated stream', () => {
    // Node's own zstdDecompressSync stops after the first frame, which is why
    // frames are delimited here instead of decompressed in one call.
    const stream = Buffer.concat([frame('one\n'), frame('two\n'), frame('three\n')])

    expect(zstdDecompressSync(stream).toString()).toBe('one\n')
    expect(scanZstdFrames(stream)).toHaveLength(3)
    expect(decompressZstdFrames(stream).toString()).toBe('one\ntwo\nthree\n')
  })

  test('decodes frames written with a content checksum', () => {
    const stream = Buffer.concat([frame('a\n', checksumOptions), frame('b\n', checksumOptions)])

    expect(scanZstdFrames(stream)).toHaveLength(2)
    expect(decompressZstdFrames(stream).toString()).toBe('a\nb\n')
  })

  test('enforces a per-frame decompressed output limit', () => {
    const stream = frame('0123456789')
    const [range] = scanZstdFrames(stream)

    expect(() => decompressZstdFrame(stream, range, { maxOutputLength: 5 })).toThrow(/larger than 5 bytes/)
  })

  test('accepts the currently unused frame-header bit', () => {
    const stream = frame('unused-bit\n')
    stream[4] |= 0x10

    expect(decompressZstdFrames(stream).toString()).toBe('unused-bit\n')
  })

  test('rejects the reserved frame-header bit', () => {
    const stream = frame('reserved-bit\n')
    stream[4] |= 0x08

    expect(() => scanZstdFrames(stream)).toThrow('reserved frame-header bit')
  })

  test('keeps complete frames when the last one is torn mid-append', () => {
    const complete = Buffer.concat([frame('a\n'), frame('b\n')])
    const tail = frame('c\n')
    const torn = Buffer.concat([complete, tail.subarray(0, tail.length - 4)])

    expect(scanZstdFrames(torn)).toHaveLength(2)
    expect(decompressZstdFrames(torn).toString()).toBe('a\nb\n')
  })

  test('round-trips a payload large enough to span several blocks', () => {
    const text = `${Array.from({ length: 20_000 }, (_, index) => `{"n":${index}}`).join('\n')}\n`
    const stream = Buffer.concat([frame(text, checksumOptions), frame('tail\n')])

    expect(scanZstdFrames(stream)).toHaveLength(2)
    expect(decompressZstdFrames(stream).toString()).toBe(`${text}tail\n`)
  })

  test('steps over a skippable frame', () => {
    const skippable = Buffer.alloc(12)
    skippable.writeUInt32LE(0x184d2a50, 0)
    skippable.writeUInt32LE(4, 4)
    const stream = Buffer.concat([skippable, frame('after\n')])

    expect(scanZstdFrames(stream)).toHaveLength(1)
    expect(decompressZstdFrames(stream).toString()).toBe('after\n')
  })

  test('rejects a stream whose frame magic is wrong', () => {
    const corrupt = Buffer.concat([frame('a\n'), Buffer.from('plain text tail!!')])

    expect(() => scanZstdFrames(corrupt)).toThrow('invalid frame magic')
  })

  test('treats an empty or truncated header as no frames', () => {
    expect(scanZstdFrames(Buffer.alloc(0))).toEqual([])
    expect(scanZstdFrames(frame('a\n').subarray(0, 3))).toEqual([])
    expect(decompressZstdFrames(Buffer.alloc(0)).toString()).toBe('')
  })

  test('recognizes a Zstandard buffer', () => {
    expect(isZstdBuffer(frame('a\n'))).toBe(true)
    expect(isZstdBuffer(Buffer.from('{"type":"session"}'))).toBe(false)
    expect(isZstdBuffer(Buffer.alloc(2))).toBe(false)
  })
})
