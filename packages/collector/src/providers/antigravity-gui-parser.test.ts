import { describe, expect, test } from 'vitest'
import { maxAntigravityGeneratorMetadataItems, parseGeneratorMetadata } from './antigravity-gui-parser'

describe('parseGeneratorMetadata', () => {
  test.each(['2025-02-29T00:00:00Z', '2026-02-30T00:00:00Z', '2026-04-31T00:00:00Z'])(
    'rejects nonexistent calendar date %s',
    (createdAt) => {
      expect(() => parseGeneratorMetadata(metadataResponse(createdAt), 'conversation-a')).toThrow(
        'createdAt must be an ISO datetime'
      )
    }
  )

  test('accepts a valid leap day with fractional seconds and an offset', () => {
    const createdAt = '2024-02-29T23:59:59.123456789+14:00'

    expect(parseGeneratorMetadata(metadataResponse(createdAt), 'conversation-a')[0]?.createdAt).toBe(createdAt)
  })

  test('rejects metadata arrays that exceed the bounded projection limit', () => {
    expect(() =>
      parseGeneratorMetadata(
        {
          generatorMetadata: Array.from({ length: maxAntigravityGeneratorMetadataItems + 1 }, () => null)
        },
        'conversation-a'
      )
    ).toThrow(`Antigravity generator metadata response exceeded the ${maxAntigravityGeneratorMetadataItems}-item limit`)
  })

  test('rejects oversized event identity fields before hashing them', () => {
    const response = metadataResponse('2024-02-29T23:59:59Z')
    response.generatorMetadata[0].chatModel.usage.responseId = 'x'.repeat(16 * 1024)

    expect(() => parseGeneratorMetadata(response, 'conversation-a')).toThrow('responseId must be a bounded identifier')
  })

  test('rejects oversized step-index arrays before hashing them', () => {
    const response = metadataResponse('2024-02-29T23:59:59Z')
    response.generatorMetadata[0].stepIndices = Array.from({ length: 513 }, (_, index) => index)

    expect(() => parseGeneratorMetadata(response, 'conversation-a')).toThrow(
      'stepIndices must be a bounded integer array'
    )
  })
})

function metadataResponse(createdAt: string) {
  return {
    generatorMetadata: [
      {
        executionId: 'execution-a',
        stepIndices: [3],
        chatModel: {
          model: 'Gemini 3.5 Flash (Medium)',
          chatStartMetadata: { createdAt },
          usage: {
            inputTokens: '10',
            outputTokens: '2',
            responseId: 'response-a'
          }
        }
      }
    ]
  }
}
