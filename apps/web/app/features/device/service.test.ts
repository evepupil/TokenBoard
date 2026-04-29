import { describe, expect, test } from 'vitest'
import { ApiError } from '../../lib/errors'
import {
  createPairingCode,
  listUserDevices,
  parseDeviceNameForm,
  pairDevice,
  revokeDevice,
  renameDevice,
  type DevicePairingRepository
} from './service'

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

describe('device management', () => {
  test('lists devices with active token state for one user', async () => {
    const sqlStatements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async all() {
                return {
                  results: [
                    {
                      id: 'dev_1',
                      name: 'Office PC',
                      platform: 'windows',
                      lastSyncedAt: '2026-04-29T08:00:00.000Z',
                      createdAt: '2026-04-28T08:00:00.000Z',
                      activeTokenCount: 1
                    }
                  ]
                }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await expect(listUserDevices(db, 'user_1')).resolves.toEqual([
      {
        id: 'dev_1',
        name: 'Office PC',
        platform: 'windows',
        lastSyncedAt: '2026-04-29T08:00:00.000Z',
        createdAt: '2026-04-28T08:00:00.000Z',
        activeTokenCount: 1
      }
    ])
    expect(sqlStatements[0]).toContain('LEFT JOIN upload_tokens')
    expect(sqlStatements[0]).toContain('revoked_at IS NULL')
    expect(bindings[0]).toEqual(['user_1'])
  })

  test('renames a device owned by the current user', async () => {
    const sqlStatements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await renameDevice(db, {
      userId: 'user_1',
      deviceId: 'dev_1',
      name: 'Laptop',
      now: '2026-04-29T09:00:00.000Z'
    })

    expect(sqlStatements[0]).toContain('UPDATE devices')
    expect(bindings[0]).toEqual(['Laptop', '2026-04-29T09:00:00.000Z', 'dev_1', 'user_1'])
  })

  test('revokes active upload tokens for a device owned by the current user', async () => {
    const sqlStatements: string[] = []
    const bindings: unknown[][] = []
    const db = {
      prepare(sql: string) {
        sqlStatements.push(sql)
        return {
          bind(...values: unknown[]) {
            bindings.push(values)
            return {
              async run() {
                return { meta: { changes: 1 } }
              }
            }
          }
        }
      }
    } as unknown as D1Database

    await revokeDevice(db, {
      userId: 'user_1',
      deviceId: 'dev_1',
      now: '2026-04-29T09:00:00.000Z'
    })

    expect(sqlStatements[0]).toContain('UPDATE upload_tokens')
    expect(sqlStatements[0]).toContain('revoked_at IS NULL')
    expect(sqlStatements[1]).toContain('UPDATE devices')
    expect(bindings[0]).toEqual(['2026-04-29T09:00:00.000Z', 'user_1', 'dev_1'])
    expect(bindings[1]).toEqual(['2026-04-29T09:00:00.000Z', 'dev_1', 'user_1'])
  })

  test('rejects blank device names from forms', () => {
    expect(() => parseDeviceNameForm({ name: '   ' })).toThrow()
    expect(parseDeviceNameForm({ name: '  Laptop  ' })).toBe('Laptop')
  })
})
