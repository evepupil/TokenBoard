import { ApiError } from '../../lib/errors'
import { randomId, randomToken, sha256Hex } from '../../lib/crypto'
import { defaultTimezone, parseTimezone } from '../../lib/timezone'
import type { DevicePairRequest } from './schema'

export type PairingType = 'new_device' | 'reconnect_device'

const DEFAULT_DEVICE_AUDIT_LOG_LIMIT = 20
const MAX_DEVICE_AUDIT_LOG_LIMIT = 100

export type PairingCodeRecord = {
  id: string
  userId: string
  pairingType: PairingType
  targetDeviceId: string | null
  metadata: string | null
  expiresAt: string
  consumedAt: string | null
}

export type DevicePairingRepository = {
  findUsablePairingCode(codeHash: string, now: string): Promise<PairingCodeRecord | null>
  createPairingCode(input: {
    pairingCodeId: string
    userId: string
    codeHash: string
    pairingType: PairingType
    targetDeviceId?: string | null
    metadata?: string | null
    expiresAt: string
    createdAt: string
  }): Promise<void>
  createReconnectPairingCodeExchange(input: {
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
  }): Promise<void>
  ensureDeviceOwnedByUser(userId: string, deviceId: string): Promise<boolean>
  hasActiveInstallationForDevice(userId: string, deviceId: string): Promise<boolean>
  findInstallationByClaim(input: {
    deviceId: string
    installationId: string
    installClaimHash: string
  }): Promise<DeviceInstallationClaimRecord | null>
  createUploadTokenAndDevice(input: {
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
  }): Promise<void>
  createUploadTokenAndInstallation(input: {
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
    sourceInstallationId?: string | null
    sourceInstallClaimHash?: string | null
    consumedInstallClaimHash?: string | null
  }): Promise<void>
  createAuditLog(input: {
    auditLogId: string
    userId: string
    actorType: string
    action: string
    targetType: string
    targetId: string | null
    metadata?: string | null
    createdAt: string
  }): Promise<void>
}

export type DeviceInstallationClaimRecord = {
  id: string
  userId: string
  deviceId: string
  revokedAt: string | null
}

export type PairDeviceDeps = {
  now: () => string
  endpoint: string
  randomId: () => string
  randomToken: () => string
  randomInstallClaim: () => string
  hash: (value: string) => Promise<string>
}

export type CreatePairingCodeDeps = {
  now: () => Date
  randomId: () => string
  randomToken: () => string
  hash: (value: string) => Promise<string>
}

export type RotateUploadTokenDeps = {
  now: () => string
  randomTokenId: () => string
  randomAuditId: () => string
  randomToken: () => string
  randomInstallClaim: () => string
  hash: (value: string) => Promise<string>
}

export type UserDevice = {
  id: string
  name: string
  platform: string
  lastSyncedAt: string | null
  createdAt: string
  activeTokenCount: number
  installations: UserDeviceInstallation[]
  uploadTokens: UserDeviceUploadToken[]
}

export type UserDeviceInstallation = {
  id: string
  deviceId: string
  platform: string
  hostname: string | null
  clientVersion: string | null
  firstSeenAt: string
  lastSeenAt: string | null
  revokedAt: string | null
  activeTokenCount: number
}

export type UserDeviceUploadToken = {
  id: string
  deviceId: string | null
  installationId: string | null
  name: string
  lastUsedAt: string | null
  createdAt: string
  revokedAt: string | null
}

export type UserDeviceAuditLog = {
  id: string
  action: string
  targetType: string
  targetId: string | null
  metadata: string | null
  createdAt: string
}

type DeviceRow = Omit<UserDevice, 'activeTokenCount' | 'installations' | 'uploadTokens'> & {
  activeTokenCount: number | null
}

type InstallationRow = Omit<UserDeviceInstallation, 'activeTokenCount'> & {
  activeTokenCount: number | null
}

type UploadTokenRow = UserDeviceUploadToken
type LatestDeviceAuditLogRow = UserDeviceAuditLog & { deviceId: string }

const maxD1BindParameters = 100
const maxLatestAuditLogDeviceIdsPerQuery = maxD1BindParameters - 1

export function createPairDeviceDeps(endpoint: string): PairDeviceDeps {
  return {
    now: () => new Date().toISOString(),
    endpoint,
    randomId: () => randomId('id'),
    randomToken: () => randomToken('tb_upload'),
    randomInstallClaim: () => randomToken('tb_install'),
    hash: sha256Hex
  }
}

export function createPairingCodeDeps(): CreatePairingCodeDeps {
  return {
    now: () => new Date(),
    randomId: () => randomId('pair'),
    randomToken: () => randomToken('tb_pair'),
    hash: sha256Hex
  }
}

export function createRotateUploadTokenDeps(): RotateUploadTokenDeps {
  return {
    now: () => new Date().toISOString(),
    randomTokenId: () => randomId('ut'),
    randomAuditId: () => randomId('audit'),
    randomToken: () => randomToken('tb_upload'),
    randomInstallClaim: () => randomToken('tb_install'),
    hash: sha256Hex
  }
}

export async function listUserDevices(db: D1Database, userId: string): Promise<UserDevice[]> {
  const [deviceRows, installationRows, uploadTokenRows] = await Promise.all([
    db
      .prepare(
        `
          SELECT
            devices.id,
            devices.name,
            devices.platform,
            devices.last_synced_at as lastSyncedAt,
            devices.created_at as createdAt,
            COALESCE(SUM(CASE WHEN upload_tokens.id IS NOT NULL AND upload_tokens.revoked_at IS NULL THEN 1 ELSE 0 END), 0) as activeTokenCount
          FROM devices
          LEFT JOIN upload_tokens ON upload_tokens.device_id = devices.id
            AND upload_tokens.user_id = devices.user_id
          WHERE devices.user_id = ?
          GROUP BY devices.id
          ORDER BY devices.last_synced_at DESC, devices.created_at DESC
        `
      )
      .bind(userId)
      .all<DeviceRow>(),
    db
      .prepare(
        `
          SELECT
            device_installations.id,
            device_installations.device_id as deviceId,
            device_installations.platform,
            device_installations.hostname,
            device_installations.client_version as clientVersion,
            device_installations.first_seen_at as firstSeenAt,
            device_installations.last_seen_at as lastSeenAt,
            device_installations.revoked_at as revokedAt,
            COALESCE(SUM(CASE WHEN upload_tokens.id IS NOT NULL AND upload_tokens.revoked_at IS NULL THEN 1 ELSE 0 END), 0) as activeTokenCount
          FROM device_installations
          LEFT JOIN upload_tokens ON upload_tokens.installation_id = device_installations.id
            AND upload_tokens.user_id = device_installations.user_id
          WHERE device_installations.user_id = ?
          GROUP BY device_installations.id
          ORDER BY device_installations.last_seen_at DESC, device_installations.created_at DESC
        `
      )
      .bind(userId)
      .all<InstallationRow>(),
    db
      .prepare(
        `
          SELECT
            id,
            device_id as deviceId,
            installation_id as installationId,
            name,
            last_used_at as lastUsedAt,
            created_at as createdAt,
            revoked_at as revokedAt
          FROM upload_tokens
          WHERE user_id = ?
          ORDER BY last_used_at DESC, created_at DESC
        `
      )
      .bind(userId)
      .all<UploadTokenRow>()
  ])

  const installationsByDevice = new Map<string, UserDeviceInstallation[]>()
  for (const row of installationRows.results ?? []) {
    const installation = {
      id: row.id,
      deviceId: row.deviceId,
      platform: row.platform,
      hostname: row.hostname ?? null,
      clientVersion: row.clientVersion ?? null,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt ?? null,
      revokedAt: row.revokedAt ?? null,
      activeTokenCount: Number(row.activeTokenCount ?? 0)
    }
    installationsByDevice.set(row.deviceId, [...(installationsByDevice.get(row.deviceId) ?? []), installation])
  }

  const uploadTokensByDevice = new Map<string, UserDeviceUploadToken[]>()
  for (const row of uploadTokenRows.results ?? []) {
    if (!row.deviceId) continue
    const token = {
      id: row.id,
      deviceId: row.deviceId,
      installationId: row.installationId ?? null,
      name: row.name,
      lastUsedAt: row.lastUsedAt ?? null,
      createdAt: row.createdAt,
      revokedAt: row.revokedAt ?? null
    }
    uploadTokensByDevice.set(row.deviceId, [...(uploadTokensByDevice.get(row.deviceId) ?? []), token])
  }

  return (deviceRows.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    platform: row.platform,
    lastSyncedAt: row.lastSyncedAt ?? null,
    createdAt: row.createdAt,
    activeTokenCount: Number(row.activeTokenCount ?? 0),
    installations: installationsByDevice.get(row.id) ?? [],
    uploadTokens: uploadTokensByDevice.get(row.id) ?? []
  }))
}

export async function listDeviceAuditLogs(
  db: D1Database,
  input: {
    userId: string
    deviceId: string
    limit?: number
  }
) {
  const rows = await db
    .prepare(
      `
        SELECT
          id,
          action,
          target_type as targetType,
          target_id as targetId,
          metadata,
          created_at as createdAt
        FROM audit_logs
        WHERE user_id = ?
          AND (
            target_id = ?
            OR CASE
              WHEN json_valid(metadata) THEN json_extract(metadata, '$.deviceId')
              ELSE NULL
            END = ?
          )
        ORDER BY created_at DESC
        LIMIT ?
      `
    )
    .bind(input.userId, input.deviceId, input.deviceId, normalizeDeviceAuditLogLimit(input.limit))
    .all<UserDeviceAuditLog>()

  return rows.results ?? []
}

function normalizeDeviceAuditLogLimit(limit: number | undefined) {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_DEVICE_AUDIT_LOG_LIMIT
  const normalized = Math.trunc(limit)
  return Math.min(Math.max(normalized, 1), MAX_DEVICE_AUDIT_LOG_LIMIT)
}

export async function listLatestDeviceAuditLogs(
  db: D1Database,
  input: {
    userId: string
    deviceIds: string[]
  }
) {
  const deviceIds = [...new Set(input.deviceIds)].filter(Boolean)
  if (deviceIds.length === 0) return new Map<string, UserDeviceAuditLog[]>()

  const logsByDevice = new Map<string, UserDeviceAuditLog[]>()
  for (let index = 0; index < deviceIds.length; index += maxLatestAuditLogDeviceIdsPerQuery) {
    const chunk = deviceIds.slice(index, index + maxLatestAuditLogDeviceIdsPerQuery)
    const rows = await queryLatestDeviceAuditLogs(db, input.userId, chunk)
    for (const row of rows) {
      logsByDevice.set(row.deviceId, [
        {
          id: row.id,
          action: row.action,
          targetType: row.targetType,
          targetId: row.targetId,
          metadata: row.metadata,
          createdAt: row.createdAt
        }
      ])
    }
  }
  return logsByDevice
}

async function queryLatestDeviceAuditLogs(
  db: D1Database,
  userId: string,
  deviceIds: string[]
): Promise<LatestDeviceAuditLogRow[]> {
  const requestedDeviceRows = deviceIds.map(() => '(?)').join(', ')
  const rows = await db
    .prepare(
      `
        WITH requested(device_id) AS (
          VALUES ${requestedDeviceRows}
        )
        SELECT
          deviceId,
          id,
          action,
          targetType,
          targetId,
          metadata,
          createdAt
        FROM (
          SELECT
            requested.device_id as deviceId,
            id,
            action,
            target_type as targetType,
            target_id as targetId,
            metadata,
            created_at as createdAt,
            ROW_NUMBER() OVER (
              PARTITION BY requested.device_id
              ORDER BY created_at DESC
            ) as rowNumber
          FROM audit_logs
          JOIN requested
            ON target_id = requested.device_id
            OR CASE
              WHEN json_valid(metadata) THEN json_extract(metadata, '$.deviceId')
              ELSE NULL
            END = requested.device_id
          WHERE user_id = ?
        )
        WHERE rowNumber = 1
      `
    )
    .bind(...deviceIds, userId)
    .all<LatestDeviceAuditLogRow>()

  return rows.results ?? []
}

export function parseDeviceNameForm(form: Record<string, unknown>) {
  const name = String(form.name ?? '').trim()
  if (name.length < 1 || name.length > 80) {
    throw new ApiError('BAD_REQUEST', 'Device name must be 1-80 characters', 400)
  }
  return name
}

export async function renameDevice(
  db: D1Database,
  input: {
    userId: string
    deviceId: string
    name: string
    now?: string
  }
) {
  const now = input.now ?? new Date().toISOString()
  const name = parseDeviceNameForm({ name: input.name })
  const results = await db.batch([
    db
      .prepare('UPDATE devices SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .bind(name, now, input.deviceId, input.userId),
    createDeviceRenameAuditStatement(db, {
      userId: input.userId,
      deviceId: input.deviceId,
      name,
      now
    })
  ])
  assertDeviceBatchSucceeded(results)
  assertChangedResult(results[0], 'Device not found')
  assertChangedResult(results[1], 'Device rename was not recorded')
}

function createDeviceRenameAuditStatement(
  db: D1Database,
  input: { userId: string; deviceId: string; name: string; now: string }
) {
  return db
    .prepare(
      `
    INSERT INTO audit_logs (
      id, user_id, actor_type, action, target_type, target_id, metadata, created_at
    )
    SELECT ?, ?, 'user', 'device.rename', 'device', id, ?, ?
    FROM devices
    WHERE id = ? AND user_id = ? AND name = ? AND updated_at = ?
  `
    )
    .bind(
      randomId('audit'),
      input.userId,
      JSON.stringify({ name: input.name }),
      input.now,
      input.deviceId,
      input.userId,
      input.name,
      input.now
    )
}

export async function revokeDevice(
  db: D1Database,
  input: {
    userId: string
    deviceId: string
    now?: string
  }
) {
  const now = input.now ?? new Date().toISOString()
  const results = await db.batch([
    createDeviceTokenRevokeStatement(db, { ...input, now }),
    createDeviceInstallationRevokeStatement(db, { ...input, now }),
    createDeviceTouchStatement(db, { ...input, now }),
    createDeviceRevokeAuditStatement(db, { ...input, now })
  ])
  assertDeviceBatchSucceeded(results)
  assertChangedResult(results[2], 'Device not found')
  assertChangedResult(results[3], 'Device revocation was not recorded')
}

export async function revokeInstallation(
  db: D1Database,
  input: {
    userId: string
    installationId: string
    now?: string
  }
) {
  const now = input.now ?? new Date().toISOString()
  const results = await db.batch([
    createInstallationRevokeAuditStatement(db, { ...input, now }),
    createInstallationTokenRevokeStatement(db, { ...input, now }),
    createInstallationRevokeStatement(db, { ...input, now })
  ])
  assertDeviceBatchSucceeded(results)
  assertChangedResult(results[2], 'Installation not found')
  assertChangedResult(results[0], 'Installation revocation was not recorded')
}

function createDeviceTokenRevokeStatement(db: D1Database, input: { userId: string; deviceId: string; now: string }) {
  return db
    .prepare(
      `
    UPDATE upload_tokens SET revoked_at = ?
    WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL
  `
    )
    .bind(input.now, input.userId, input.deviceId)
}

function createDeviceInstallationRevokeStatement(
  db: D1Database,
  input: { userId: string; deviceId: string; now: string }
) {
  return db
    .prepare(
      `
    UPDATE device_installations SET revoked_at = ?, updated_at = ?
    WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL
  `
    )
    .bind(input.now, input.now, input.userId, input.deviceId)
}

function createDeviceTouchStatement(db: D1Database, input: { userId: string; deviceId: string; now: string }) {
  return db
    .prepare('UPDATE devices SET updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(input.now, input.deviceId, input.userId)
}

function createDeviceRevokeAuditStatement(db: D1Database, input: { userId: string; deviceId: string; now: string }) {
  return db
    .prepare(
      `
    INSERT INTO audit_logs (
      id, user_id, actor_type, action, target_type, target_id, metadata, created_at
    )
    SELECT ?, ?, 'user', 'device.revoke', 'device', ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM devices WHERE id = ? AND user_id = ? AND updated_at = ?
    )
  `
    )
    .bind(
      randomId('audit'),
      input.userId,
      input.deviceId,
      JSON.stringify({ deviceId: input.deviceId }),
      input.now,
      input.deviceId,
      input.userId,
      input.now
    )
}

function createInstallationTokenRevokeStatement(
  db: D1Database,
  input: { userId: string; installationId: string; now: string }
) {
  return db
    .prepare(
      `
    UPDATE upload_tokens SET revoked_at = ?
    WHERE user_id = ? AND installation_id = ? AND revoked_at IS NULL
  `
    )
    .bind(input.now, input.userId, input.installationId)
}

function createInstallationRevokeStatement(
  db: D1Database,
  input: { userId: string; installationId: string; now: string }
) {
  return db
    .prepare(
      `
    UPDATE device_installations SET revoked_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL
  `
    )
    .bind(input.now, input.now, input.installationId, input.userId)
}

function createInstallationRevokeAuditStatement(
  db: D1Database,
  input: { userId: string; installationId: string; now: string }
) {
  return db
    .prepare(
      `
    INSERT INTO audit_logs (
      id, user_id, actor_type, action, target_type, target_id, metadata, created_at
    )
    SELECT ?, ?, 'user', 'installation.revoke', 'device_installation', id,
      json_object('deviceId', device_id), ?
    FROM device_installations
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL
  `
    )
    .bind(randomId('audit'), input.userId, input.now, input.installationId, input.userId)
}

export async function revokeUploadToken(
  db: D1Database,
  input: {
    userId: string
    uploadTokenId: string
    now?: string
  }
) {
  const now = input.now ?? new Date().toISOString()
  const token = await findUploadTokenForUser(db, input.userId, input.uploadTokenId)
  if (!token) {
    throw new ApiError('NOT_FOUND', 'Upload token not found', 404)
  }

  const statements = [
    createUploadTokenRevokeAuditStatement(db, {
      userId: input.userId,
      uploadTokenId: input.uploadTokenId,
      metadata: {
        deviceId: token.deviceId,
        installationId: token.installationId
      },
      now
    }),
    createUploadTokenRevokeOnlyStatement(db, {
      userId: input.userId,
      uploadTokenId: input.uploadTokenId,
      now
    })
  ]
  if (token.installationId) {
    statements.push(
      createInstallationClaimClearForRevokedTokenStatement(db, {
        userId: input.userId,
        installationId: token.installationId,
        uploadTokenId: input.uploadTokenId,
        now
      })
    )
  }
  const results = await db.batch(statements)
  assertDeviceBatchSucceeded(results)
  assertChangedResult(results[1], 'Upload token not found')
  assertChangedResult(results[0], 'Upload token revocation was not recorded')
}

function createUploadTokenRevokeOnlyStatement(
  db: D1Database,
  input: {
    userId: string
    uploadTokenId: string
    now: string
  }
) {
  return db
    .prepare(
      `
        UPDATE upload_tokens
        SET revoked_at = ?
        WHERE user_id = ?
          AND id = ?
          AND revoked_at IS NULL
      `
    )
    .bind(input.now, input.userId, input.uploadTokenId)
}

function createInstallationClaimClearForRevokedTokenStatement(
  db: D1Database,
  input: {
    userId: string
    installationId: string
    uploadTokenId: string
    now: string
  }
) {
  return db
    .prepare(
      `
        UPDATE device_installations
        SET install_claim_hash = NULL, updated_at = ?
        WHERE user_id = ?
          AND id = ?
          AND install_claim_hash IS NOT NULL
          AND revoked_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM upload_tokens
            WHERE upload_tokens.user_id = device_installations.user_id
              AND upload_tokens.id = ?
              AND upload_tokens.installation_id = device_installations.id
              AND upload_tokens.revoked_at = ?
          )
      `
    )
    .bind(input.now, input.userId, input.installationId, input.uploadTokenId, input.now)
}

function createUploadTokenRevokeAuditStatement(
  db: D1Database,
  input: {
    userId: string
    uploadTokenId: string
    metadata: Record<string, unknown>
    now: string
  }
) {
  return db
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
          FROM upload_tokens
          WHERE user_id = ?
            AND id = ?
            AND revoked_at IS NULL
        )
      `
    )
    .bind(
      randomId('audit'),
      input.userId,
      'user',
      'token.revoke',
      'upload_token',
      input.uploadTokenId,
      JSON.stringify(input.metadata),
      input.now,
      input.userId,
      input.uploadTokenId
    )
}

export async function rotateUploadToken(
  db: D1Database,
  input: {
    userId: string
    uploadTokenId: string
  },
  deps: RotateUploadTokenDeps = createRotateUploadTokenDeps()
) {
  const existing = await findUploadTokenForUser(db, input.userId, input.uploadTokenId)
  if (!existing) {
    throw new ApiError('NOT_FOUND', 'Upload token not found', 404)
  }
  if (existing.revokedAt) {
    throw new ApiError('NOT_FOUND', 'Upload token not found', 404)
  }

  const now = deps.now()
  const uploadTokenId = deps.randomTokenId()
  const uploadToken = deps.randomToken()
  const installationId = existing.installationId
  const installClaim = installationId ? deps.randomInstallClaim() : null
  const uploadTokenHash = await deps.hash(uploadToken)
  const installClaimHash = installClaim ? await deps.hash(installClaim) : null
  const auditId = deps.randomAuditId()
  const statements = [
    createRotatedUploadTokenInsert(db, {
      userId: input.userId,
      previousTokenId: input.uploadTokenId,
      uploadTokenId,
      uploadTokenHash,
      now
    }),
    createUploadTokenRevokeStatement(db, input.userId, input.uploadTokenId, uploadTokenId, now)
  ]
  if (installationId && installClaimHash) {
    statements.push(
      createInstallClaimRotateStatement(db, {
        userId: input.userId,
        installationId,
        previousInstallClaimHash: existing.installClaimHash,
        previousTokenId: input.uploadTokenId,
        uploadTokenId,
        installClaimHash,
        now
      })
    )
  }
  statements.push(
    createTokenRotateAuditStatement(db, {
      userId: input.userId,
      previousTokenId: input.uploadTokenId,
      uploadTokenId,
      existing,
      installClaimHash,
      auditId,
      now
    })
  )
  let results: D1Result<unknown>[] | undefined
  try {
    results = await db.batch(statements)
    assertDeviceBatchSucceeded(results)
    assertRotatedTokenUpdates(results, Boolean(installationId))
  } catch (error) {
    if (!results || mayHaveChanged(results[0])) {
      await cleanupFailedRotationAfterError(
        db,
        {
          userId: input.userId,
          uploadTokenId,
          previousTokenId: input.uploadTokenId,
          installationId,
          previousInstallClaimHash: existing.installClaimHash,
          nextInstallClaimHash: installClaimHash,
          auditId,
          now
        },
        error
      )
    }
    throw error
  }

  return {
    uploadTokenId,
    uploadToken,
    deviceId: existing.deviceId,
    installationId: existing.installationId,
    installClaim
  }
}

async function cleanupFailedRotationAfterError(
  db: D1Database,
  input: Parameters<typeof cleanupFailedRotation>[1],
  rotationError: unknown
) {
  try {
    await cleanupFailedRotation(db, input)
  } catch (cleanupError) {
    throw new AggregateError([rotationError, cleanupError], 'Token rotation failed and cleanup also failed')
  }
}

type ExistingUploadToken = {
  name: string
  deviceId: string | null
  installationId: string | null
  installClaimHash: string | null
  revokedAt: string | null
}

function createRotatedUploadTokenInsert(
  db: D1Database,
  input: {
    userId: string
    previousTokenId: string
    uploadTokenId: string
    uploadTokenHash: string
    now: string
  }
) {
  return db
    .prepare(
      `
        INSERT OR IGNORE INTO upload_tokens (
          id,
          user_id,
          name,
          token_hash,
          device_id,
          installation_id,
          supersedes_token_id,
          created_at
        )
        SELECT
          ?,
          source.user_id,
          source.name,
          ?,
          source.device_id,
          source.installation_id,
          source.id,
          ?
        FROM upload_tokens source
        LEFT JOIN device_installations installation
          ON installation.id = source.installation_id
          AND installation.user_id = source.user_id
        WHERE source.user_id = ?
          AND source.id = ?
          AND source.revoked_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM upload_tokens successor
            WHERE successor.user_id = source.user_id
              AND successor.supersedes_token_id = source.id
              AND successor.revoked_at IS NULL
          )
          AND (
            source.installation_id IS NULL
            OR (
              installation.id IS NOT NULL
              AND installation.revoked_at IS NULL
            )
          )
      `
    )
    .bind(input.uploadTokenId, input.uploadTokenHash, input.now, input.userId, input.previousTokenId)
}

function createUploadTokenRevokeStatement(
  db: D1Database,
  userId: string,
  uploadTokenId: string,
  rotatedTokenId: string,
  now: string
) {
  return db
    .prepare(
      `
        UPDATE upload_tokens
        SET revoked_at = ?
        WHERE user_id = ?
          AND id = ?
          AND revoked_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM upload_tokens replacement
            WHERE replacement.user_id = upload_tokens.user_id
              AND replacement.id = ?
              AND replacement.supersedes_token_id = upload_tokens.id
              AND replacement.revoked_at IS NULL
          )
      `
    )
    .bind(now, userId, uploadTokenId, rotatedTokenId)
}

function createInstallClaimRotateStatement(
  db: D1Database,
  input: {
    userId: string
    installationId: string
    previousInstallClaimHash: string | null
    previousTokenId: string
    uploadTokenId: string
    installClaimHash: string
    now: string
  }
) {
  return db
    .prepare(
      `
        UPDATE device_installations
        SET install_claim_hash = ?, updated_at = ?
        WHERE user_id = ?
          AND id = ?
          AND revoked_at IS NULL
          AND ((? IS NULL AND install_claim_hash IS NULL) OR install_claim_hash = ?)
          AND EXISTS (
            SELECT 1
            FROM upload_tokens replacement
            JOIN upload_tokens previous
              ON previous.id = replacement.supersedes_token_id
              AND previous.user_id = replacement.user_id
            WHERE replacement.user_id = device_installations.user_id
              AND replacement.id = ?
              AND replacement.supersedes_token_id = ?
              AND replacement.installation_id = device_installations.id
              AND replacement.revoked_at IS NULL
              AND previous.revoked_at = ?
          )
      `
    )
    .bind(
      input.installClaimHash,
      input.now,
      input.userId,
      input.installationId,
      input.previousInstallClaimHash,
      input.previousInstallClaimHash,
      input.uploadTokenId,
      input.previousTokenId,
      input.now
    )
}

function createTokenRotateAuditStatement(
  db: D1Database,
  input: {
    userId: string
    previousTokenId: string
    uploadTokenId: string
    existing: ExistingUploadToken
    installClaimHash: string | null
    auditId: string
    now: string
  }
) {
  return db
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
          FROM upload_tokens replacement
          JOIN upload_tokens previous
            ON previous.id = replacement.supersedes_token_id
            AND previous.user_id = replacement.user_id
          WHERE replacement.user_id = ?
            AND replacement.id = ?
            AND replacement.supersedes_token_id = ?
            AND replacement.revoked_at IS NULL
            AND previous.revoked_at = ?
            AND (
              ? IS NULL
              OR EXISTS (
                SELECT 1
                FROM device_installations installation
                WHERE installation.user_id = replacement.user_id
                  AND installation.id = replacement.installation_id
                  AND installation.install_claim_hash = ?
                  AND installation.revoked_at IS NULL
              )
            )
        )
      `
    )
    .bind(
      input.auditId,
      input.userId,
      'user',
      'token.rotate',
      'upload_token',
      input.uploadTokenId,
      JSON.stringify({
        previousTokenId: input.previousTokenId,
        deviceId: input.existing.deviceId,
        installationId: input.existing.installationId
      }),
      input.now,
      input.userId,
      input.uploadTokenId,
      input.previousTokenId,
      input.now,
      input.installClaimHash,
      input.installClaimHash
    )
}

function assertDeviceBatchSucceeded(results: D1Result<unknown>[]) {
  const batchResults = results as Array<{ success?: boolean; error?: string }>
  const failedIndex = batchResults.findIndex((result) => result.success === false)
  if (failedIndex < 0) return

  const error = batchResults[failedIndex]?.error
  throw new Error(`D1 batch statement ${failedIndex + 1} failed${error ? `: ${error}` : ''}`)
}

function assertRotatedTokenUpdates(results: D1Result<unknown>[], rotatedInstallClaim: boolean) {
  assertChangedResult(results[0], 'Upload token already has an active successor')
  assertChangedResult(results[1], 'Previous upload token is no longer current')
  if (rotatedInstallClaim) {
    assertChangedResult(results[2], 'Installation is no longer current')
  }
  const auditResultIndex = rotatedInstallClaim ? 3 : 2
  assertChangedResult(results[auditResultIndex], 'Upload token rotation was not recorded')
}

function assertChangedResult(result: D1Result<unknown> | undefined, message: string) {
  if (result?.meta?.changes === undefined) {
    throw new Error(`D1 batch statement did not report changes: ${message}`)
  }
  const changes = Number(result.meta.changes)
  if (!Number.isFinite(changes) || changes > 0) return
  throw new ApiError('NOT_FOUND', message, 404)
}

function mayHaveChanged(result: D1Result<unknown> | undefined) {
  if (result?.meta?.changes === undefined) return true
  const changes = Number(result.meta.changes)
  return !Number.isFinite(changes) || changes > 0
}

async function findUploadTokenForUser(db: D1Database, userId: string, uploadTokenId: string) {
  return await db
    .prepare(
      `
        SELECT
          name,
          upload_tokens.device_id as deviceId,
          upload_tokens.installation_id as installationId,
          device_installations.install_claim_hash as installClaimHash,
          upload_tokens.revoked_at as revokedAt
        FROM upload_tokens
        LEFT JOIN device_installations
          ON device_installations.id = upload_tokens.installation_id
          AND device_installations.user_id = upload_tokens.user_id
        WHERE upload_tokens.id = ?
          AND upload_tokens.user_id = ?
        LIMIT 1
      `
    )
    .bind(uploadTokenId, userId)
    .first<ExistingUploadToken>()
}

async function cleanupFailedRotation(
  db: D1Database,
  input: {
    userId: string
    uploadTokenId: string
    previousTokenId: string
    installationId: string | null
    previousInstallClaimHash: string | null
    nextInstallClaimHash: string | null
    auditId: string
    now: string
  }
) {
  const statements = [createRevokeFailedRotatedUploadTokenStatement(db, input)]
  if (input.installationId && input.nextInstallClaimHash) {
    statements.push(createRestoreFailedInstallClaimStatement(db, input))
  }
  statements.push(
    createRestoreFailedPreviousUploadTokenStatement(db, input),
    createDeleteFailedRotationAuditStatement(db, input)
  )

  const results = await db.batch(statements)
  assertDeviceBatchSucceeded(results)
}

function createRestoreFailedInstallClaimStatement(
  db: D1Database,
  input: {
    userId: string
    uploadTokenId: string
    previousTokenId: string
    installationId: string | null
    previousInstallClaimHash: string | null
    nextInstallClaimHash: string | null
    now: string
  }
) {
  return db
    .prepare(
      `
        UPDATE device_installations
        SET install_claim_hash = ?, updated_at = ?
        WHERE user_id = ?
          AND id = ?
          AND install_claim_hash = ?
          AND revoked_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM upload_tokens replacement
            WHERE replacement.user_id = device_installations.user_id
              AND replacement.id = ?
              AND replacement.supersedes_token_id = ?
          )
      `
    )
    .bind(
      input.previousInstallClaimHash,
      input.now,
      input.userId,
      input.installationId,
      input.nextInstallClaimHash,
      input.uploadTokenId,
      input.previousTokenId
    )
}

function createRevokeFailedRotatedUploadTokenStatement(
  db: D1Database,
  input: {
    userId: string
    uploadTokenId: string
    previousTokenId: string
    now: string
  }
) {
  return db
    .prepare(
      `
        UPDATE upload_tokens
        SET revoked_at = ?
        WHERE user_id = ?
          AND id = ?
          AND supersedes_token_id = ?
          AND revoked_at IS NULL
      `
    )
    .bind(input.now, input.userId, input.uploadTokenId, input.previousTokenId)
}

function createRestoreFailedPreviousUploadTokenStatement(
  db: D1Database,
  input: {
    userId: string
    uploadTokenId: string
    previousTokenId: string
    now: string
  }
) {
  return db
    .prepare(
      `
        UPDATE upload_tokens
        SET revoked_at = NULL
        WHERE user_id = ?
          AND id = ?
          AND revoked_at = ?
          AND EXISTS (
            SELECT 1
            FROM upload_tokens replacement
            WHERE replacement.user_id = upload_tokens.user_id
              AND replacement.id = ?
              AND replacement.supersedes_token_id = upload_tokens.id
              AND replacement.revoked_at = ?
          )
      `
    )
    .bind(input.userId, input.previousTokenId, input.now, input.uploadTokenId, input.now)
}

function createDeleteFailedRotationAuditStatement(
  db: D1Database,
  input: {
    userId: string
    uploadTokenId: string
    auditId: string
    now: string
  }
) {
  return db
    .prepare(
      `
        DELETE FROM audit_logs
        WHERE id = ?
          AND user_id = ?
          AND action = ?
          AND target_type = ?
          AND target_id = ?
          AND created_at = ?
      `
    )
    .bind(input.auditId, input.userId, 'token.rotate', 'upload_token', input.uploadTokenId, input.now)
}

export async function createPairingCode(
  repository: DevicePairingRepository,
  userId: string,
  deps: CreatePairingCodeDeps,
  ttlMinutes = 30,
  options: {
    pairingType?: PairingType
    targetDeviceId?: string | null
    metadata?: string | null
  } = {}
) {
  const now = deps.now()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString()
  const pairingCode = deps.randomToken()
  const codeHash = await deps.hash(pairingCode)
  const pairingType = options.pairingType ?? 'new_device'
  const targetDeviceId = options.targetDeviceId ?? null

  if (pairingType === 'reconnect_device') {
    if (!targetDeviceId) {
      throw new ApiError('BAD_REQUEST', 'Reconnect pairing requires target device', 400)
    }
    const ownsTarget = await repository.ensureDeviceOwnedByUser(userId, targetDeviceId)
    if (!ownsTarget) {
      throw new ApiError('NOT_FOUND', 'Device not found', 404)
    }
    const hasActiveInstallation = await repository.hasActiveInstallationForDevice(userId, targetDeviceId)
    if (!hasActiveInstallation) {
      throw new ApiError('NOT_FOUND', 'Device has no active installation', 404)
    }
  }

  try {
    await repository.createPairingCode({
      pairingCodeId: deps.randomId(),
      userId,
      codeHash,
      pairingType,
      targetDeviceId,
      metadata: options.metadata ?? null,
      expiresAt,
      createdAt
    })
  } catch (error) {
    if (isNoActiveInstallationError(error)) {
      throw new ApiError('NOT_FOUND', 'Device has no active installation', 404)
    }
    throw error
  }

  return {
    pairingCode,
    expiresAt
  }
}

export async function createReconnectPairingCodeFromClaim(
  repository: DevicePairingRepository,
  input: {
    deviceId: string
    installationId: string
    installClaim: string
  },
  deps: CreatePairingCodeDeps,
  ttlMinutes = 30
) {
  const normalized = normalizeInstallClaimInput(input)
  const installClaimHash = await deps.hash(normalized.installClaim)
  const installation = await repository.findInstallationByClaim({
    deviceId: normalized.deviceId,
    installationId: normalized.installationId,
    installClaimHash
  })
  if (!installation || installation.revokedAt) {
    throw new ApiError('UNAUTHORIZED', 'Invalid device link claim', 401)
  }

  const createdAt = deps.now().toISOString()
  const expiresAt = new Date(new Date(createdAt).getTime() + ttlMinutes * 60 * 1000).toISOString()
  const pairingCode = deps.randomToken()
  const codeHash = await deps.hash(pairingCode)

  try {
    await repository.createReconnectPairingCodeExchange({
      pairingCodeId: deps.randomId(),
      userId: installation.userId,
      codeHash,
      deviceId: normalized.deviceId,
      installationId: normalized.installationId,
      previousInstallClaimHash: installClaimHash,
      pairingMetadata: JSON.stringify({
        method: 'device-link',
        installationId: normalized.installationId,
        installClaimHash
      }),
      auditLogId: deps.randomId(),
      auditMetadata: JSON.stringify({ installationId: normalized.installationId }),
      expiresAt,
      createdAt
    })
  } catch (error) {
    if (isInvalidDeviceLinkClaimError(error)) {
      throw new ApiError('UNAUTHORIZED', 'Invalid device link claim', 401)
    }
    throw error
  }

  return {
    pairingCode,
    expiresAt
  }
}

function normalizeInstallClaimInput(input: { deviceId: string; installationId: string; installClaim: string }) {
  const deviceId = requiredTrimmedString(input.deviceId, 'deviceId')
  const installationId = requiredTrimmedString(input.installationId, 'installationId')
  const installClaim = requiredTrimmedString(input.installClaim, 'installClaim')
  return { deviceId, installationId, installClaim }
}

function requiredTrimmedString(value: unknown, name: string) {
  if (typeof value !== 'string') {
    throw new ApiError('BAD_REQUEST', `Missing ${name}`, 400)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new ApiError('BAD_REQUEST', `Missing ${name}`, 400)
  }
  return trimmed
}

function isInvalidDeviceLinkClaimError(error: unknown) {
  return error instanceof Error && error.message === 'Invalid device link claim'
}

function isNoActiveInstallationError(error: unknown) {
  return error instanceof Error && error.message === 'Device has no active installation'
}

type ReconnectPairingMetadata = {
  sourceInstallationId: string | null
  sourceInstallClaimHash: string | null
}

function parseReconnectPairingMetadata(metadata: string | null): ReconnectPairingMetadata {
  if (!metadata) {
    return { sourceInstallationId: null, sourceInstallClaimHash: null }
  }

  const parsed = parseReconnectMetadataJson(metadata)
  const sourceInstallationId = optionalTrimmedString(parsed.installationId)
  const sourceInstallClaimHash = optionalTrimmedString(parsed.installClaimHash)
  const method = optionalTrimmedString(parsed.method)
  const isDeviceLinkMetadata = method === 'device-link' || Boolean(sourceInstallationId || sourceInstallClaimHash)
  if (!isDeviceLinkMetadata) {
    return { sourceInstallationId: null, sourceInstallClaimHash: null }
  }
  if (!sourceInstallationId || !sourceInstallClaimHash) {
    throw new ApiError('UNAUTHORIZED', 'Invalid or expired pairing code', 401)
  }
  return {
    sourceInstallationId,
    sourceInstallClaimHash
  }
}

function parseReconnectMetadataJson(metadata: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(metadata)
  } catch {
    throw new ApiError('UNAUTHORIZED', 'Invalid or expired pairing code', 401)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError('UNAUTHORIZED', 'Invalid or expired pairing code', 401)
  }
  return parsed as {
    method?: unknown
    installationId?: unknown
    installClaimHash?: unknown
  }
}

function optionalTrimmedString(value: unknown) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function isInactiveReconnectTargetError(error: unknown) {
  return (
    error instanceof Error &&
    (error.message === 'Reconnect target is no longer active' ||
      error.message === 'Reconnect source installation is no longer current')
  )
}

function isStaleReconnectPairingError(error: unknown) {
  return error instanceof Error && error.message === 'Reconnect pairing code is no longer current'
}

function isStaleNewDevicePairingError(error: unknown) {
  return error instanceof Error && error.message === 'Pairing code is no longer current'
}

export async function pairDevice(
  repository: DevicePairingRepository,
  request: DevicePairRequest,
  deps: PairDeviceDeps
) {
  const timezone = request.timezone ? parseTimezone(request.timezone) : defaultTimezone
  if (!timezone) {
    throw new ApiError('BAD_REQUEST', 'Invalid timezone', 400)
  }

  const now = deps.now()
  const pairingCodeHash = await deps.hash(request.pairingCode)
  const pairingCode = await repository.findUsablePairingCode(pairingCodeHash, now)
  if (!pairingCode) {
    throw new ApiError('UNAUTHORIZED', 'Invalid or expired pairing code', 401)
  }

  const reconnectMetadata =
    pairingCode.pairingType === 'reconnect_device' ? parseReconnectPairingMetadata(pairingCode.metadata) : null
  const id = deps.randomId()
  const deviceId = pairingCode.pairingType === 'reconnect_device' ? pairingCode.targetDeviceId : `dev_${id}`
  if (!deviceId) {
    throw new ApiError('BAD_REQUEST', 'Reconnect pairing is missing target device', 400)
  }

  const uploadTokenId = `ut_${id}`
  const installationId = `inst_${id}`
  const uploadToken = deps.randomToken()
  const installClaim = deps.randomInstallClaim()
  const uploadTokenHash = await deps.hash(uploadToken)
  const installClaimHash = await deps.hash(installClaim)
  const shouldConsumeSourceClaim = Boolean(
    reconnectMetadata?.sourceInstallationId && reconnectMetadata.sourceInstallClaimHash
  )
  const consumedInstallClaimHash = shouldConsumeSourceClaim ? await deps.hash(deps.randomInstallClaim()) : null
  const deviceName = request.deviceName ?? 'TokenBoard device'
  const platform = request.platform ?? 'unknown'
  const input = {
    pairingCodeId: pairingCode.id,
    consumedAt: now,
    uploadTokenId,
    uploadTokenHash,
    deviceId,
    installationId,
    installClaimHash,
    userId: pairingCode.userId,
    deviceName,
    platform,
    auditLogId: `audit_${id}`,
    auditAction: pairingCode.pairingType === 'reconnect_device' ? 'device.reconnect' : 'device.pair',
    auditMetadata: JSON.stringify({ installationId, platform }),
    createdAt: now,
    sourceInstallationId: reconnectMetadata?.sourceInstallationId ?? null,
    sourceInstallClaimHash: reconnectMetadata?.sourceInstallClaimHash ?? null,
    consumedInstallClaimHash
  }

  try {
    if (pairingCode.pairingType === 'reconnect_device') {
      await repository.createUploadTokenAndInstallation(input)
    } else {
      await repository.createUploadTokenAndDevice(input)
    }
  } catch (error) {
    if (pairingCode.pairingType !== 'reconnect_device' && isStaleNewDevicePairingError(error)) {
      throw new ApiError('UNAUTHORIZED', 'Invalid or expired pairing code', 401)
    }
    if (pairingCode.pairingType === 'reconnect_device') {
      if (isStaleReconnectPairingError(error)) {
        throw new ApiError('UNAUTHORIZED', 'Invalid or expired pairing code', 401)
      }
      if (isInactiveReconnectTargetError(error)) {
        throw new ApiError('NOT_FOUND', 'Device has no active installation', 404)
      }
    }
    throw error
  }

  return {
    endpoint: deps.endpoint,
    uploadToken,
    deviceId,
    installationId,
    installClaim,
    timezone
  }
}
