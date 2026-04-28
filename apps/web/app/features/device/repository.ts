import type { DevicePairingRepository, PairingCodeRecord } from './service'

export class D1DevicePairingRepository implements DevicePairingRepository {
  constructor(private readonly db: D1Database) {}

  async createPairingCode(input: {
    pairingCodeId: string
    userId: string
    codeHash: string
    expiresAt: string
    createdAt: string
  }) {
    await this.db
      .prepare(
        `
          INSERT INTO pairing_codes (id, user_id, code_hash, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?)
        `
      )
      .bind(
        input.pairingCodeId,
        input.userId,
        input.codeHash,
        input.expiresAt,
        input.createdAt
      )
      .run()
  }

  async findUsablePairingCode(codeHash: string, now: string): Promise<PairingCodeRecord | null> {
    const row = await this.db
      .prepare(
        `
          SELECT id, user_id as userId, expires_at as expiresAt, consumed_at as consumedAt
          FROM pairing_codes
          WHERE code_hash = ?
            AND consumed_at IS NULL
            AND expires_at > ?
          LIMIT 1
        `
      )
      .bind(codeHash, now)
      .first<PairingCodeRecord>()

    return row ?? null
  }

  async createUploadTokenAndDevice(input: {
    uploadTokenId: string
    uploadTokenHash: string
    deviceId: string
    userId: string
    deviceName: string
    platform: string
    createdAt: string
  }) {
    await this.db
      .prepare(
        `
          INSERT INTO upload_tokens (id, user_id, name, token_hash, created_at)
          VALUES (?, ?, ?, ?, ?)
        `
      )
      .bind(
        input.uploadTokenId,
        input.userId,
        input.deviceName,
        input.uploadTokenHash,
        input.createdAt
      )
      .run()

    await this.db
      .prepare(
        `
          INSERT INTO devices (id, user_id, name, platform, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        input.deviceId,
        input.userId,
        input.deviceName,
        input.platform,
        input.createdAt,
        input.createdAt
      )
      .run()
  }

  async consumePairingCode(pairingCodeId: string, consumedAt: string) {
    const result = await this.db
      .prepare('UPDATE pairing_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
      .bind(consumedAt, pairingCodeId)
      .run()
    return (result.meta.changes ?? 0) > 0
  }
}
