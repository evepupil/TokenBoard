import { zstdDecompressSync } from 'node:zlib'

const zstdMagic = 0xfd2fb528
const skippableMagicMin = 0x184d2a50
const skippableMagicMax = 0x184d2a5f

/**
 * Decompress a Zstandard stream that may hold several concatenated frames.
 *
 * Node's `zstdDecompress` — the sync and stream forms alike — stops after the
 * first frame and silently drops the rest, so a log appended to in batches
 * would report only its first batch. Frames are therefore delimited by walking
 * the frame headers (per RFC 8878) and decompressed one at a time.
 *
 * A torn final frame is expected rather than exceptional: the tool may be
 * mid-append while a scan runs. Its bytes are dropped and the frames before it
 * are still returned.
 */
export function decompressZstdFrames(buffer: Buffer): Buffer {
  const decoded: Buffer[] = []
  for (const frame of scanZstdFrames(buffer)) {
    decoded.push(decompressZstdFrame(buffer, frame))
  }
  return Buffer.concat(decoded)
}

export function decompressZstdFrame(
  buffer: Buffer,
  frame: ZstdFrameRange,
  options?: { maxOutputLength?: number }
): Buffer {
  return zstdDecompressSync(buffer.subarray(frame.start, frame.end), options)
}

export type ZstdFrameRange = { start: number; end: number }

/**
 * Byte ranges of every structurally complete frame, in file order.
 *
 * Reading the headers rather than decompressing is what makes a partially
 * written trailing frame recoverable instead of fatal.
 */
export function scanZstdFrames(buffer: Buffer): ZstdFrameRange[] {
  const frames: ZstdFrameRange[] = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    const magic = buffer.readUInt32LE(offset)

    if (magic >= skippableMagicMin && magic <= skippableMagicMax) {
      // A skippable frame carries no compressed data; step over its payload.
      if (buffer.length - offset < 8) return frames
      const size = buffer.readUInt32LE(offset + 4)
      const end = offset + 8 + size
      if (end > buffer.length) return frames
      offset = end
      continue
    }

    if (magic !== zstdMagic) {
      throw new Error(`Corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4

    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    // Bit 3 is reserved and must be zero. Bit 4 is currently unused, but
    // valid producers may leave it set, so do not reject that forward-
    // compatible header bit.
    if ((descriptor & 0x08) !== 0) {
      throw new Error(`Corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const hasChecksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return frames
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`Corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      // An RLE block stores one byte that expands to `blockSize` bytes.
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }

    if (hasChecksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }

  return frames
}

export function isZstdBuffer(buffer: Buffer) {
  if (buffer.length < 4) return false
  const magic = buffer.readUInt32LE(0)
  return magic === zstdMagic || (magic >= skippableMagicMin && magic <= skippableMagicMax)
}
