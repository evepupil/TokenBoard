import { describe, expect, test } from 'vitest'
import {
  parseAntigravityGeneratorMetadataBlob,
  parseAntigravityGeneratorMetadataBlobEvents
} from './antigravity-history-protobuf'

describe('parseAntigravityGeneratorMetadataBlob', () => {
  test('extracts token metadata from Antigravity SQLite generator blobs', () => {
    const blob = message([
      fieldMessage(
        1,
        message([
          fieldVarint(3, 1132),
          fieldMessage(
            4,
            usageMessage({
              inputTokens: 25_908,
              outputTokens: 551,
              cacheReadTokens: 24_454,
              thinkingOutputTokens: 502,
              responseOutputTokens: 49,
              responseId: 'response-a'
            })
          ),
          fieldMessage(
            9,
            message([fieldMessage(4, message([fieldVarint(1, 1_782_229_139), fieldVarint(2, 863_115_000)]))])
          ),
          fieldMessage(
            17,
            message([
              fieldMessage(
                2,
                usageMessage({
                  inputTokens: 25_908,
                  outputTokens: 551,
                  cacheReadTokens: 24_454,
                  thinkingOutputTokens: 502,
                  responseOutputTokens: 49,
                  responseId: 'response-a'
                })
              )
            ])
          ),
          fieldString(19, 'gemini-3-flash-a'),
          fieldString(21, 'Gemini 3.5 Flash (High)')
        ])
      ),
      fieldString(4, 'execution-a')
    ])

    expect(
      parseAntigravityGeneratorMetadataBlob(blob, {
        cascadeId: 'conversation-a',
        rowIndex: 0
      })
    ).toEqual({
      cascadeHash: expect.any(String),
      eventHash: expect.any(String),
      createdAt: '2026-06-23T15:38:59.863Z',
      model: 'gemini-3-flash-a',
      modelAliases: ['Gemini 3.5 Flash (High)'],
      inputTokens: 25_908,
      outputTokens: 551,
      cacheCreationTokens: 0,
      cacheReadTokens: 24_454
    })
  })

  test('rejects an oversized display model alias', () => {
    const blob = message([
      fieldMessage(
        1,
        message([
          fieldMessage(4, usageMessage({ inputTokens: 10, outputTokens: 2 })),
          fieldMessage(9, message([fieldMessage(4, message([fieldVarint(1, 1_782_229_139)]))])),
          fieldString(19, 'gemini-3-flash-a'),
          fieldString(21, 'x'.repeat(161))
        ])
      )
    ])

    expect(() =>
      parseAntigravityGeneratorMetadataBlob(blob, {
        cascadeId: 'conversation-a',
        rowIndex: 0
      })
    ).toThrow('model is invalid')
  })

  test('emits distinct usage blocks from the same SQLite row', () => {
    const blob = message([
      fieldMessage(
        1,
        message([
          fieldMessage(
            4,
            usageMessage({
              inputTokens: 10,
              outputTokens: 2,
              responseId: 'response-a'
            })
          ),
          fieldMessage(
            17,
            message([
              fieldMessage(
                2,
                usageMessage({
                  inputTokens: 11,
                  cacheReadTokens: 5,
                  responseId: 'response-b'
                })
              )
            ])
          ),
          fieldMessage(9, message([fieldMessage(4, message([fieldVarint(1, 1_782_229_139)]))])),
          fieldString(19, 'gemini-3-flash-a')
        ])
      ),
      fieldString(4, 'execution-a')
    ])

    expect(
      parseAntigravityGeneratorMetadataBlobEvents(blob, {
        cascadeId: 'conversation-a',
        rowIndex: 0
      })
    ).toMatchObject([
      {
        model: 'gemini-3-flash-a',
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0
      },
      {
        model: 'gemini-3-flash-a',
        inputTokens: 11,
        outputTokens: 0,
        cacheReadTokens: 5
      }
    ])
  })

  test('keeps primary usage when an optional nested usage block is truncated', () => {
    const blob = message([
      fieldMessage(
        1,
        message([
          fieldMessage(
            4,
            usageMessage({
              inputTokens: 10,
              outputTokens: 2,
              responseId: 'response-primary'
            })
          ),
          fieldMessage(17, message([fieldMessage(2, Buffer.from([0x08, 0x80]))])),
          fieldString(19, 'gemini-3-flash-a')
        ])
      ),
      fieldString(4, 'execution-a')
    ])

    expect(
      parseAntigravityGeneratorMetadataBlobEvents(blob, {
        cascadeId: 'conversation-a',
        rowIndex: 0,
        fallbackCreatedAt: '2026-06-24T00:00:00.000Z'
      })
    ).toMatchObject([
      {
        model: 'gemini-3-flash-a',
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0
      }
    ])
  })

  test('rejects an oversized token in an optional nested usage block', () => {
    const blob = message([
      fieldMessage(
        1,
        message([
          fieldMessage(
            4,
            usageMessage({
              inputTokens: 10,
              outputTokens: 2,
              responseId: 'response-primary'
            })
          ),
          fieldMessage(
            17,
            message([
              fieldMessage(
                2,
                usageMessage({
                  inputTokens: 1_000_000_001,
                  responseId: 'response-nested'
                })
              )
            ])
          ),
          fieldString(19, 'gemini-3-flash-a')
        ])
      ),
      fieldString(4, 'execution-a')
    ])

    expect(() =>
      parseAntigravityGeneratorMetadataBlobEvents(blob, {
        cascadeId: 'conversation-a',
        rowIndex: 0,
        fallbackCreatedAt: '2026-06-24T00:00:00.000Z'
      })
    ).toThrow('token field 2 is invalid')
  })

  test('does not suppress unexpected optional usage parsing failures', () => {
    const blob = message([
      fieldMessage(
        1,
        message([
          fieldMessage(
            4,
            usageMessage({
              inputTokens: 10,
              outputTokens: 2,
              responseId: 'response-primary'
            })
          ),
          fieldString(19, 'gemini-3-flash-a')
        ])
      ),
      fieldString(4, 'execution-a')
    ])
    const originalGet = Map.prototype.get
    Map.prototype.get = function (key) {
      if (key === 17) throw new Error('Unexpected optional usage parser failure')
      return originalGet.call(this, key)
    }

    try {
      expect(() =>
        parseAntigravityGeneratorMetadataBlobEvents(blob, {
          cascadeId: 'conversation-a',
          rowIndex: 0,
          fallbackCreatedAt: '2026-06-24T00:00:00.000Z'
        })
      ).toThrow('Unexpected optional usage parser failure')
    } finally {
      Map.prototype.get = originalGet
    }
  })

  test('keeps placeholder model ids when SQLite blobs have no resolved model', () => {
    const blob = message([
      fieldMessage(
        1,
        message([
          fieldMessage(
            4,
            usageMessage({
              inputTokens: 10,
              outputTokens: 2,
              responseId: 'response-a'
            })
          ),
          fieldString(19, 'MODEL_PLACEHOLDER_M12')
        ])
      ),
      fieldString(4, 'execution-a')
    ])

    expect(
      parseAntigravityGeneratorMetadataBlob(blob, {
        cascadeId: 'conversation-a',
        rowIndex: 0,
        fallbackCreatedAt: '2026-06-24T00:00:00.000Z'
      })
    ).toMatchObject({
      model: 'MODEL_PLACEHOLDER_M12',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0
    })
  })

  test('keeps sparse SQLite usage blocks without output tokens', () => {
    const blob = message([
      fieldMessage(
        1,
        message([
          fieldMessage(
            4,
            usageMessage({
              inputTokens: 8901,
              cacheReadTokens: 89389,
              responseId: 'response-a'
            })
          ),
          fieldString(19, 'gemini-3-flash-c')
        ])
      ),
      fieldString(4, 'execution-a')
    ])

    expect(
      parseAntigravityGeneratorMetadataBlob(blob, {
        cascadeId: 'conversation-a',
        rowIndex: 0,
        fallbackCreatedAt: '2026-06-24T00:00:00.000Z'
      })
    ).toMatchObject({
      model: 'gemini-3-flash-c',
      inputTokens: 8901,
      outputTokens: 0,
      cacheReadTokens: 89389
    })
  })

  test('rejects oversized token varints when the field is present', () => {
    const blob = message([
      fieldMessage(
        1,
        message([
          fieldMessage(
            4,
            usageMessage({
              inputTokens: 1_000_000_001,
              outputTokens: 2,
              responseId: 'response-a'
            })
          ),
          fieldString(19, 'gemini-3-flash-c')
        ])
      ),
      fieldString(4, 'execution-a')
    ])

    expect(() =>
      parseAntigravityGeneratorMetadataBlob(blob, {
        cascadeId: 'conversation-a',
        rowIndex: 0,
        fallbackCreatedAt: '2026-06-24T00:00:00.000Z'
      })
    ).toThrow('token field 2 is invalid')
  })

  test('rejects invalid timestamp fields instead of falling back to file mtime', () => {
    const blob = message([
      fieldMessage(
        1,
        message([
          fieldMessage(
            4,
            usageMessage({
              inputTokens: 10,
              outputTokens: 2,
              responseId: 'response-a'
            })
          ),
          fieldMessage(9, message([fieldMessage(4, message([fieldVarint(1, Number.MAX_SAFE_INTEGER + 1_000)]))])),
          fieldString(19, 'gemini-3-flash-c')
        ])
      ),
      fieldString(4, 'execution-a')
    ])

    expect(() =>
      parseAntigravityGeneratorMetadataBlob(blob, {
        cascadeId: 'conversation-a',
        rowIndex: 0,
        fallbackCreatedAt: '2026-06-24T00:00:00.000Z'
      })
    ).toThrow('createdAt is invalid')
  })

  test('rejects truncated nested timestamps instead of falling back to file mtime', () => {
    const blob = message([
      fieldMessage(
        1,
        message([
          fieldMessage(
            4,
            usageMessage({
              inputTokens: 10,
              outputTokens: 2,
              responseId: 'response-a'
            })
          ),
          fieldMessage(9, message([fieldMessage(4, Buffer.from([0x08, 0x80]))])),
          fieldString(19, 'gemini-3-flash-c')
        ])
      ),
      fieldString(4, 'execution-a')
    ])

    expect(() =>
      parseAntigravityGeneratorMetadataBlob(blob, {
        cascadeId: 'conversation-a',
        rowIndex: 0,
        fallbackCreatedAt: '2026-06-24T00:00:00.000Z'
      })
    ).toThrow('Truncated protobuf varint')
  })

  test.each([
    ['an empty timestamp', fieldMessage(4, Buffer.alloc(0))],
    ['a timestamp with the wrong wire type', fieldVarint(4, 1)],
    ['timestamp seconds with the wrong wire type', fieldMessage(4, message([fieldString(1, 'invalid')]))],
    ['a timestamp with nanos but no seconds', fieldMessage(4, message([fieldVarint(2, 1)]))]
  ])('rejects %s instead of falling back to file mtime', (_name, timestampField) => {
    const blob = metadataBlobWithTimestampField(timestampField)

    expect(() =>
      parseAntigravityGeneratorMetadataBlob(blob, {
        cascadeId: 'conversation-a',
        rowIndex: 0,
        fallbackCreatedAt: '2026-06-24T00:00:00.000Z'
      })
    ).toThrow()
  })

  test('rejects invalid timestamp nanos', () => {
    const blob = message([
      fieldMessage(
        1,
        message([
          fieldMessage(
            4,
            usageMessage({
              inputTokens: 10,
              outputTokens: 2,
              responseId: 'response-a'
            })
          ),
          fieldMessage(
            9,
            message([fieldMessage(4, message([fieldVarint(1, 1_782_229_139), fieldVarint(2, 1_000_000_000)]))])
          ),
          fieldString(19, 'gemini-3-flash-c')
        ])
      ),
      fieldString(4, 'execution-a')
    ])

    expect(() =>
      parseAntigravityGeneratorMetadataBlob(blob, {
        cascadeId: 'conversation-a',
        rowIndex: 0,
        fallbackCreatedAt: '2026-06-24T00:00:00.000Z'
      })
    ).toThrow('createdAt is invalid')
  })
})

function usageMessage(input: {
  inputTokens: number
  outputTokens?: number
  cacheReadTokens?: number
  thinkingOutputTokens?: number
  responseOutputTokens?: number
  responseId?: string
}): Buffer {
  return message([
    fieldVarint(2, input.inputTokens),
    ...(input.outputTokens !== undefined ? [fieldVarint(3, input.outputTokens)] : []),
    ...(input.cacheReadTokens ? [fieldVarint(5, input.cacheReadTokens)] : []),
    ...(input.thinkingOutputTokens ? [fieldVarint(9, input.thinkingOutputTokens)] : []),
    ...(input.responseOutputTokens ? [fieldVarint(10, input.responseOutputTokens)] : []),
    ...(input.responseId ? [fieldString(11, input.responseId)] : [])
  ])
}

function metadataBlobWithTimestampField(timestampField: Buffer) {
  return message([
    fieldMessage(
      1,
      message([
        fieldMessage(
          4,
          usageMessage({
            inputTokens: 10,
            outputTokens: 2,
            responseId: 'response-a'
          })
        ),
        fieldMessage(9, message([timestampField])),
        fieldString(19, 'gemini-3-flash-c')
      ])
    ),
    fieldString(4, 'execution-a')
  ])
}

function message(fields: Buffer[]) {
  return Buffer.concat(fields)
}

function fieldVarint(field: number, value: number) {
  return Buffer.concat([tag(field, 0), varint(value)])
}

function fieldString(field: number, value: string) {
  const bytes = Buffer.from(value)
  return Buffer.concat([tag(field, 2), varint(bytes.length), bytes])
}

function fieldMessage(field: number, value: Buffer) {
  return Buffer.concat([tag(field, 2), varint(value.length), value])
}

function tag(field: number, wireType: number) {
  return varint(field * 8 + wireType)
}

function varint(value: number) {
  const bytes: number[] = []
  let current = BigInt(value)
  while (current >= 128n) {
    bytes.push(Number((current & 127n) | 128n))
    current >>= 7n
  }
  bytes.push(Number(current))
  return Buffer.from(bytes)
}
