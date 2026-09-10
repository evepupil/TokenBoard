import { describe, expect, test } from 'vitest'
import { devicePairRequestSchema } from './schema'

describe('devicePairRequestSchema', () => {
  test('trims device identity fields at the request boundary', () => {
    expect(
      devicePairRequestSchema.parse({
        pairingCode: 'pair_123',
        deviceName: '  Workstation  ',
        platform: '  linux  '
      })
    ).toMatchObject({
      deviceName: 'Workstation',
      platform: 'linux'
    })
  })

  test.each(['deviceName', 'platform'] as const)('rejects a whitespace-only %s', (field) => {
    expect(() =>
      devicePairRequestSchema.parse({
        pairingCode: 'pair_123',
        [field]: '   '
      })
    ).toThrow()
  })
})
