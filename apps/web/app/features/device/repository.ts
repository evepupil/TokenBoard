import type { DeviceInstallationClaimRecord, DevicePairingRepository, PairingCodeRecord } from './service'

type InstallationInput = {
  pairingCodeId: string
  consumedAt: string
  uploadTokenId: string
  uploadTokenHash: string
  deviceId: string
  installationId: string
  installClaimHash: string
  userId: string
  deviceName: string
  platform: string
  auditLogId: string
  auditAction: string
  auditMetadata?: string | null
  createdAt: string
}

type ReconnectInstallationInput = InstallationInput & {
  sourceInstallationId?: string | null
  sourceInstallClaimHash?: string | null
  consumedInstallClaimHash?: string | null
}

export class D1DevicePairingRepository implements DevicePairingRepository {
  constructor(private readonly db: D1Database) {}

  async createPairingCode(input: {
    pairingCodeId: string
    userId: string
    codeHash: string
    pairingType: string
    targetDeviceId?: string | null
    metadata?: string | null
    expiresAt: string
    createdAt: string
  }) {
    if (input.pairingType === 'reconnect_device') {
      const result = await this.reconnectPairingCodeCreateStatement(input).run()
      assertStatementChanged(result, 'Device has no active installation')
      return
    }

    await this.db
      .prepare(
        `
          INSERT INTO pairing_codes (
            id,
            user_id,
            code_hash,
            pairing_type,
            target_device_id,
            metadata,
            expires_at,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        input.pairingCodeId,
        input.userId,
        input.codeHash,
        input.pairingType,
        input.targetDeviceId ?? null,
        input.metadata ?? null,
        input.expiresAt,
        input.createdAt
      )
      .run()
  }

  private reconnectPairingCodeCreateStatement(input: {
    pairingCodeId: string
    userId: string
    codeHash: string
    pairingType: string
    targetDeviceId?: string | null
    metadata?: string | null
    expiresAt: string
    createdAt: string
  }) {
    return this.db
      .prepare(
        `
          INSERT INTO pairing_codes (
            id,
            user_id,
            code_hash,
            pairing_type,
            target_device_id,
            metadata,
            expires_at,
            created_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1
            FROM device_installations
            WHERE user_id = ?
              AND device_id = ?
              AND revoked_at IS NULL
          )
        `
      )
      .bind(
        input.pairingCodeId,
        input.userId,
        input.codeHash,
        input.pairingType,
        input.targetDeviceId ?? null,
        input.metadata ?? null,
        input.expiresAt,
        input.createdAt,
        input.userId,
        input.targetDeviceId ?? null
      )
  }

  async createReconnectPairingCodeExchange(input: {
    pairingCodeId: string
    userId: string
    codeHash: string
    deviceId: string
    installationId: string
    previousInstallClaimHash: string
    pairingMetadata?: string | null
    auditLogId: string
    auditMetadata?: string | null
    expiresAt: string
    createdAt: string
  }) {
    const results = await this.db.batch([
      this.reconnectPairingCodeInsertStatement(input),
      this.reconnectPriorPairingCodeInvalidateStatement(input),
      this.reconnectAuditLogInsertStatement(input)
    ])
    assertBatchSucceeded(results, 3)
    assertStatementChanged(results[0], 'Invalid device link claim')
    assertStatementChanged(results[2], 'Reconnect audit log was not created')
  }

  async findUsablePairingCode(codeHash: string, now: string): Promise<PairingCodeRecord | null> {
    const row = await this.db
      .prepare(
        `
          SELECT
            id,
            user_id as userId,
            pairing_type as pairingType,
            target_device_id as targetDeviceId,
            metadata,
            expires_at as expiresAt,
            consumed_at as consumedAt
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

  async ensureDeviceOwnedByUser(userId: string, deviceId: string) {
    const row = await this.db
      .prepare('SELECT id FROM devices WHERE id = ? AND user_id = ? LIMIT 1')
      .bind(deviceId, userId)
      .first<{ id: string }>()
    return Boolean(row)
  }

  async hasActiveInstallationForDevice(userId: string, deviceId: string) {
    const row = await this.db
      .prepare(
        `
          SELECT id
          FROM device_installations
          WHERE user_id = ?
            AND device_id = ?
            AND revoked_at IS NULL
          LIMIT 1
        `
      )
      .bind(userId, deviceId)
      .first<{ id: string }>()
    return Boolean(row)
  }

  async findInstallationByClaim(input: {
    deviceId: string
    installationId: string
    installClaimHash: string
  }): Promise<DeviceInstallationClaimRecord | null> {
    const row = await this.db
      .prepare(
        `
          SELECT
            id,
            user_id as userId,
            device_id as deviceId,
            revoked_at as revokedAt
          FROM device_installations
          WHERE id = ?
            AND device_id = ?
            AND install_claim_hash = ?
          LIMIT 1
        `
      )
      .bind(input.installationId, input.deviceId, input.installClaimHash)
      .first<DeviceInstallationClaimRecord>()

    return row ?? null
  }

  private reconnectPairingCodeInsertStatement(input: {
    pairingCodeId: string
    userId: string
    codeHash: string
    deviceId: string
    installationId: string
    previousInstallClaimHash: string
    pairingMetadata?: string | null
    expiresAt: string
    createdAt: string
  }) {
    return this.db
      .prepare(
        `
          INSERT INTO pairing_codes (
            id,
            user_id,
            code_hash,
            pairing_type,
            target_device_id,
            metadata,
            expires_at,
            created_at
          )
          SELECT ?, ?, ?, 'reconnect_device', ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1
            FROM device_installations
            WHERE id = ?
              AND user_id = ?
              AND device_id = ?
              AND install_claim_hash = ?
              AND revoked_at IS NULL
          )
        `
      )
      .bind(
        input.pairingCodeId,
        input.userId,
        input.codeHash,
        input.deviceId,
        input.pairingMetadata ?? null,
        input.expiresAt,
        input.createdAt,
        input.installationId,
        input.userId,
        input.deviceId,
        input.previousInstallClaimHash
      )
  }

  private reconnectAuditLogInsertStatement(input: {
    auditLogId: string
    userId: string
    deviceId: string
    pairingCodeId: string
    auditMetadata?: string | null
    createdAt: string
  }) {
    return this.db
      .prepare(
        `
          INSERT INTO audit_logs (
            id,
            user_id,
            actor_type,
            action,
            target_type,
            target_id,
            metadata,
            created_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1
            FROM pairing_codes
            WHERE id = ?
              AND user_id = ?
              AND pairing_type = 'reconnect_device'
              AND target_device_id = ?
          )
        `
      )
      .bind(
        input.auditLogId,
        input.userId,
        'user',
        'device.reconnect.claim',
        'device',
        input.deviceId,
        input.auditMetadata ?? null,
        input.createdAt,
        input.pairingCodeId,
        input.userId,
        input.deviceId
      )
  }

  private reconnectPriorPairingCodeInvalidateStatement(input: {
    userId: string
    deviceId: string
    pairingCodeId: string
    pairingMetadata?: string | null
    createdAt: string
  }) {
    return this.db
      .prepare(
        `
          UPDATE pairing_codes
          SET consumed_at = ?
          WHERE user_id = ?
            AND pairing_type = 'reconnect_device'
            AND target_device_id = ?
            AND id != ?
            AND consumed_at IS NULL
            AND expires_at > ?
            AND ((? IS NULL AND metadata IS NULL) OR metadata = ?)
            AND EXISTS (
              SELECT 1
              FROM pairing_codes current
              WHERE current.id = ?
                AND current.user_id = ?
                AND current.pairing_type = 'reconnect_device'
                AND current.target_device_id = ?
                AND current.consumed_at IS NULL
            )
        `
      )
      .bind(
        input.createdAt,
        input.userId,
        input.deviceId,
        input.pairingCodeId,
        input.createdAt,
        input.pairingMetadata ?? null,
        input.pairingMetadata ?? null,
        input.pairingCodeId,
        input.userId,
        input.deviceId
      )
  }

  async createUploadTokenAndDevice(input: {
    pairingCodeId: string
    consumedAt: string
    uploadTokenId: string
    uploadTokenHash: string
    deviceId: string
    installationId: string
    installClaimHash: string
    userId: string
    deviceName: string
    platform: string
    auditLogId: string
    auditAction: string
    auditMetadata?: string | null
    createdAt: string
  }) {
    const results = await this.db.batch([
      this.deviceInsertStatement(input),
      this.installationInsertStatement(input),
      this.uploadTokenInsertStatement(input),
      this.devicePairAuditLogInsertStatement(input),
      this.pairingCodeConsumeStatement(input)
    ])
    assertBatchSucceeded(results, 5)
    assertStatementChanged(results[0], 'Pairing code is no longer current')
    assertStatementChanged(results[1], 'Installation was not created')
    assertStatementChanged(results[2], 'Upload token was not created')
    assertStatementChanged(results[3], 'Device pairing was not recorded')
    assertStatementChanged(results[4], 'Pairing code is no longer current')
  }

  async createUploadTokenAndInstallation(input: ReconnectInstallationInput) {
    const hasSourceClaimMetadata = Boolean(
      input.sourceInstallationId || input.sourceInstallClaimHash || input.consumedInstallClaimHash
    )
    const shouldConsumeSourceClaim = Boolean(
      input.sourceInstallationId && input.sourceInstallClaimHash && input.consumedInstallClaimHash
    )
    if (hasSourceClaimMetadata && !shouldConsumeSourceClaim) {
      throw new Error('Reconnect source metadata is incomplete')
    }
    const statements = [this.reconnectPairingCodeCurrentStatement(input)]
    if (shouldConsumeSourceClaim) {
      statements.push(this.reconnectSourceClaimConsumeStatement(input))
    }
    statements.push(
      this.reconnectInstallationInsertStatement(input),
      this.reconnectUploadTokenInsertStatement(input),
      this.reconnectDevicePairAuditLogInsertStatement(input),
      this.pairingCodeConsumeStatement(input, 'reconnect_device')
    )

    const results = await this.db.batch(statements)
    assertBatchSucceeded(results, statements.length)
    let offset = 0
    assertStatementChanged(results[offset], 'Reconnect pairing code is no longer current')
    offset += 1
    if (shouldConsumeSourceClaim) {
      assertStatementChanged(results[offset], 'Reconnect source installation is no longer current')
      offset += 1
    }
    assertStatementChanged(results[offset], 'Reconnect target is no longer active')
    assertStatementChanged(results[offset + 1], 'Upload token was not created')
    assertStatementChanged(results[offset + 2], 'Device pairing was not recorded')
    assertStatementChanged(results[offset + 3], 'Pairing code is no longer current')
  }

  private reconnectPairingCodeCurrentStatement(input: ReconnectInstallationInput) {
    return this.db
      .prepare(
        `
          UPDATE pairing_codes
          SET consumed_at = consumed_at
          WHERE id = ?
            AND user_id = ?
            AND pairing_type = 'reconnect_device'
            AND target_device_id = ?
            AND consumed_at IS NULL
            AND expires_at > ?
        `
      )
      .bind(input.pairingCodeId, input.userId, input.deviceId, input.consumedAt)
  }

  private reconnectSourceClaimConsumeStatement(input: ReconnectInstallationInput) {
    return this.db
      .prepare(
        `
          UPDATE device_installations
          SET install_claim_hash = ?, updated_at = ?
          WHERE id = ?
            AND user_id = ?
            AND device_id = ?
            AND install_claim_hash = ?
            AND revoked_at IS NULL
            AND EXISTS (
              SELECT 1
              FROM pairing_codes pairing
              WHERE pairing.id = ?
                AND pairing.user_id = device_installations.user_id
                AND pairing.pairing_type = 'reconnect_device'
                AND pairing.target_device_id = device_installations.device_id
                AND pairing.consumed_at IS NULL
                AND pairing.expires_at > ?
            )
        `
      )
      .bind(
        input.consumedInstallClaimHash,
        input.createdAt,
        input.sourceInstallationId,
        input.userId,
        input.deviceId,
        input.sourceInstallClaimHash,
        input.pairingCodeId,
        input.consumedAt
      )
  }

  private reconnectInstallationInsertStatement(input: ReconnectInstallationInput) {
    return this.db
      .prepare(
        `
          INSERT INTO device_installations (
            id,
            user_id,
            device_id,
            platform,
            hostname,
            install_claim_hash,
            first_seen_at,
            last_seen_at,
            created_at,
            updated_at
          )
          SELECT
            ?, source.user_id, ?, ?, ?, ?, ?, ?, ?, ?
          FROM device_installations source
          JOIN pairing_codes pairing
            ON pairing.id = ?
            AND pairing.user_id = source.user_id
            AND pairing.pairing_type = 'reconnect_device'
            AND pairing.target_device_id = source.device_id
            AND pairing.consumed_at IS NULL
            AND pairing.expires_at > ?
          WHERE source.user_id = ?
            AND source.device_id = ?
            AND source.revoked_at IS NULL
            AND (? IS NULL OR source.id = ?)
            AND (? IS NULL OR source.install_claim_hash = ?)
          LIMIT 1
        `
      )
      .bind(
        input.installationId,
        input.deviceId,
        input.platform,
        input.deviceName,
        input.installClaimHash,
        input.createdAt,
        input.createdAt,
        input.createdAt,
        input.createdAt,
        input.pairingCodeId,
        input.consumedAt,
        input.userId,
        input.deviceId,
        input.sourceInstallationId ?? null,
        input.sourceInstallationId ?? null,
        input.consumedInstallClaimHash ?? null,
        input.consumedInstallClaimHash ?? null
      )
  }

  private reconnectUploadTokenInsertStatement(input: ReconnectInstallationInput) {
    return this.db
      .prepare(
        `
          INSERT INTO upload_tokens (
            id,
            user_id,
            name,
            token_hash,
            device_id,
            installation_id,
            created_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1
            FROM device_installations
            WHERE id = ?
              AND user_id = ?
              AND device_id = ?
              AND revoked_at IS NULL
          )
        `
      )
      .bind(
        input.uploadTokenId,
        input.userId,
        input.deviceName,
        input.uploadTokenHash,
        input.deviceId,
        input.installationId,
        input.createdAt,
        input.installationId,
        input.userId,
        input.deviceId
      )
  }

  private reconnectDevicePairAuditLogInsertStatement(input: ReconnectInstallationInput) {
    return this.db
      .prepare(
        `
          INSERT INTO audit_logs (
            id,
            user_id,
            actor_type,
            action,
            target_type,
            target_id,
            metadata,
            created_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1
            FROM device_installations
            WHERE id = ?
              AND user_id = ?
              AND device_id = ?
              AND revoked_at IS NULL
          )
        `
      )
      .bind(
        input.auditLogId,
        input.userId,
        'user',
        input.auditAction,
        'device',
        input.deviceId,
        input.auditMetadata ?? null,
        input.createdAt,
        input.installationId,
        input.userId,
        input.deviceId
      )
  }

  private deviceInsertStatement(input: InstallationInput) {
    return this.db
      .prepare(
        `
          INSERT INTO devices (id, user_id, name, platform, created_at, updated_at)
          SELECT ?, pairing.user_id, ?, ?, ?, ?
          FROM pairing_codes pairing
          WHERE pairing.id = ?
            AND pairing.user_id = ?
            AND pairing.pairing_type = 'new_device'
            AND pairing.consumed_at IS NULL
            AND pairing.expires_at > ?
        `
      )
      .bind(
        input.deviceId,
        input.deviceName,
        input.platform,
        input.createdAt,
        input.createdAt,
        input.pairingCodeId,
        input.userId,
        input.consumedAt
      )
  }

  private installationInsertStatement(input: InstallationInput) {
    return this.db
      .prepare(
        `
          INSERT INTO device_installations (
            id,
            user_id,
            device_id,
            platform,
            hostname,
            install_claim_hash,
            first_seen_at,
            last_seen_at,
            created_at,
            updated_at
          )
          SELECT ?, device.user_id, device.id, ?, ?, ?, ?, ?, ?, ?
          FROM devices device
          JOIN pairing_codes pairing
            ON pairing.id = ?
            AND pairing.user_id = device.user_id
            AND pairing.pairing_type = 'new_device'
            AND pairing.consumed_at IS NULL
            AND pairing.expires_at > ?
          WHERE device.id = ?
            AND device.user_id = ?
        `
      )
      .bind(
        input.installationId,
        input.platform,
        input.deviceName,
        input.installClaimHash,
        input.createdAt,
        input.createdAt,
        input.createdAt,
        input.createdAt,
        input.pairingCodeId,
        input.consumedAt,
        input.deviceId,
        input.userId
      )
  }

  private uploadTokenInsertStatement(input: InstallationInput) {
    return this.db
      .prepare(
        `
          INSERT INTO upload_tokens (
            id,
            user_id,
            name,
            token_hash,
            device_id,
            installation_id,
            created_at
          )
          SELECT ?, installation.user_id, ?, ?, installation.device_id, installation.id, ?
          FROM device_installations installation
          JOIN pairing_codes pairing
            ON pairing.id = ?
            AND pairing.user_id = installation.user_id
            AND pairing.pairing_type = 'new_device'
            AND pairing.consumed_at IS NULL
            AND pairing.expires_at > ?
          WHERE installation.id = ?
            AND installation.user_id = ?
            AND installation.device_id = ?
        `
      )
      .bind(
        input.uploadTokenId,
        input.deviceName,
        input.uploadTokenHash,
        input.createdAt,
        input.pairingCodeId,
        input.consumedAt,
        input.installationId,
        input.userId,
        input.deviceId
      )
  }

  private devicePairAuditLogInsertStatement(input: InstallationInput) {
    return this.db
      .prepare(
        `
          INSERT INTO audit_logs (
            id,
            user_id,
            actor_type,
            action,
            target_type,
            target_id,
            metadata,
            created_at
          )
          SELECT ?, installation.user_id, 'user', ?, 'device', installation.device_id, ?, ?
          FROM device_installations installation
          JOIN pairing_codes pairing
            ON pairing.id = ?
            AND pairing.user_id = installation.user_id
            AND pairing.pairing_type = 'new_device'
            AND pairing.consumed_at IS NULL
            AND pairing.expires_at > ?
          WHERE installation.id = ?
            AND installation.user_id = ?
            AND installation.device_id = ?
        `
      )
      .bind(
        input.auditLogId,
        input.auditAction,
        input.auditMetadata ?? null,
        input.createdAt,
        input.pairingCodeId,
        input.consumedAt,
        input.installationId,
        input.userId,
        input.deviceId
      )
  }

  private pairingCodeConsumeStatement(
    input: InstallationInput,
    pairingType: 'new_device' | 'reconnect_device' = 'new_device'
  ) {
    return this.db
      .prepare(
        `
          UPDATE pairing_codes
          SET consumed_at = ?
          WHERE id = ?
            AND user_id = ?
            AND pairing_type = ?
            AND consumed_at IS NULL
            AND expires_at > ?
            AND EXISTS (
              SELECT 1
              FROM upload_tokens
              WHERE id = ?
                AND user_id = ?
                AND device_id = ?
                AND installation_id = ?
                AND revoked_at IS NULL
            )
            AND EXISTS (
              SELECT 1
              FROM audit_logs
              WHERE id = ?
                AND user_id = ?
            )
        `
      )
      .bind(
        input.consumedAt,
        input.pairingCodeId,
        input.userId,
        pairingType,
        input.consumedAt,
        input.uploadTokenId,
        input.userId,
        input.deviceId,
        input.installationId,
        input.auditLogId,
        input.userId
      )
  }

  async createAuditLog(input: {
    auditLogId: string
    userId: string
    actorType: string
    action: string
    targetType: string
    targetId: string | null
    metadata?: string | null
    createdAt: string
  }) {
    await this.createAuditLogStatement(input).run()
  }

  private createAuditLogStatement(input: {
    auditLogId: string
    userId: string
    actorType: string
    action: string
    targetType: string
    targetId: string | null
    metadata?: string | null
    createdAt: string
  }) {
    return this.db
      .prepare(
        `
          INSERT INTO audit_logs (
            id,
            user_id,
            actor_type,
            action,
            target_type,
            target_id,
            metadata,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        input.auditLogId,
        input.userId,
        input.actorType,
        input.action,
        input.targetType,
        input.targetId,
        input.metadata ?? null,
        input.createdAt
      )
  }
}

function assertBatchSucceeded(results: D1Result<unknown>[], expectedStatements: number) {
  const batchResults = results as Array<{ success?: boolean; error?: string }>
  const failedIndex = batchResults.findIndex((result) => result.success === false)
  if (failedIndex < 0 && batchResults.length === expectedStatements) return

  const error =
    failedIndex >= 0
      ? batchResults[failedIndex]?.error
      : `expected ${expectedStatements} results, received ${batchResults.length}`
  const statementNumber = failedIndex >= 0 ? failedIndex + 1 : batchResults.length + 1
  throw new Error(`D1 batch statement ${statementNumber} failed${error ? `: ${error}` : ''}`)
}

function assertStatementChanged(result: D1Result<unknown> | undefined, message: string) {
  if (Number(result?.meta?.changes ?? 0) > 0) return
  throw new Error(message)
}
