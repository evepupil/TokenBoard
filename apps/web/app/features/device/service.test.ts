import { describe, expect, test } from 'vitest'
import { ApiError } from '../../lib/errors'
import { createPairingCode, pairDevice, type DevicePairingRepository } from './service'

function createRepository(overrides: Partial<DevicePairingRepository> = {}) {
  const calls: string[] = []
  const repository: DevicePairingRepository = {
    async findUsablePairingCode(codeHash, now) {
      calls.push(`find:${codeHash}:${now}`)
      return {
        id: 'pair_1',
        userId: 'seed-user',
        expiresAt: '2026-04-28T10:10:00.000Z',
        consumedAt: null
      }
    },
    async createPairingCode(input) {
      calls.push(`pair:${input.userId}:${input.codeHash}:${input.expiresAt}`)
    },
    async createUploadTokenAndDevice(input) {
      calls.push(`create:${input.userId}:${input.deviceName}:${input.uploadTokenHash}`)
    },
    async consumePairingCode(pairingCodeId, consumedAt) {
      calls.push(`consume:${pairingCodeId}:${consumedAt}`)
      return true
    },
    ...overrides
  }

  return { repository, calls }
}

describe('pairDevice', () => {
  test('creates a short-lived pairing code without storing the plaintext code', async () => {
    const { repository, calls } = createRepository()

    const result = await createPairingCode(repository, 'seed-user', {
      now: () => new Date('2026-04-28T10:00:00.000Z'),
      randomId: () => 'pair_123',
      randomToken: () => 'tb_pair_secret',
      hash: async (value) => `hash:${value}`
    })

    expect(result).toEqual({
      pairingCode: 'tb_pair_secret',
      expiresAt: '2026-04-28T10:30:00.000Z'
    })
    expect(calls).toEqual([
      'pair:seed-user:hash:tb_pair_secret:2026-04-28T10:30:00.000Z'
    ])
  })

  test('exchanges a pairing code for a one-time upload token and device config', async () => {
    const { repository, calls } = createRepository()

    const result = await pairDevice(
      repository,
      {
        pairingCode: 'dev-pairing-code',
        deviceName: 'Codex Desktop',
        platform: 'windows',
        timezone: 'Asia/Shanghai'
      },
      {
        now: () => '2026-04-28T10:00:00.000Z',
        endpoint: 'https://tokenboard.example.com/api/v1/ingest',
        randomId: () => 'id_123',
        randomToken: () => 'tb_upload_secret',
        hash: async (value) => `hash:${value}`
      }
    )

    expect(result).toEqual({
      endpoint: 'https://tokenboard.example.com/api/v1/ingest',
      uploadToken: 'tb_upload_secret',
      deviceId: 'dev_id_123',
      timezone: 'Asia/Shanghai'
    })
    expect(calls).toEqual([
      'find:hash:dev-pairing-code:2026-04-28T10:00:00.000Z',
      'consume:pair_1:2026-04-28T10:00:00.000Z',
      'create:seed-user:Codex Desktop:hash:tb_upload_secret'
    ])
  })

  test('rejects an invalid or expired pairing code', async () => {
    const { repository } = createRepository({
      async findUsablePairingCode() {
        return null
      }
    })

    await expect(
      pairDevice(
        repository,
        { pairingCode: 'bad-code' },
        {
          now: () => '2026-04-28T10:00:00.000Z',
          endpoint: 'https://tokenboard.example.com/api/v1/ingest',
          randomId: () => 'id_123',
          randomToken: () => 'tb_upload_secret',
          hash: async (value) => `hash:${value}`
        }
      )
    ).rejects.toBeInstanceOf(ApiError)
  })

  test('rejects a pairing code that was consumed by another request', async () => {
    const { repository } = createRepository({
      async consumePairingCode() {
        return false
      }
    })

    await expect(
      pairDevice(
        repository,
        { pairingCode: 'dev-pairing-code' },
        {
          now: () => '2026-04-28T10:00:00.000Z',
          endpoint: 'https://tokenboard.example.com/api/v1/ingest',
          randomId: () => 'id_123',
          randomToken: () => 'tb_upload_secret',
          hash: async (value) => `hash:${value}`
        }
      )
    ).rejects.toBeInstanceOf(ApiError)
  })
})
