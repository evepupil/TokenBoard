import { ApiError } from '../../lib/errors'
import { randomId, randomToken, sha256Hex } from '../../lib/crypto'
import type { DevicePairRequest } from './schema'

export type PairingCodeRecord = {
  id: string
  userId: string
  expiresAt: string
  consumedAt: string | null
}

export type DevicePairingRepository = {
  findUsablePairingCode(codeHash: string, now: string): Promise<PairingCodeRecord | null>
  createPairingCode(input: {
    pairingCodeId: string
    userId: string
    codeHash: string
    expiresAt: string
    createdAt: string
  }): Promise<void>
  createUploadTokenAndDevice(input: {
    uploadTokenId: string
    uploadTokenHash: string
    deviceId: string
    userId: string
    deviceName: string
    platform: string
    createdAt: string
  }): Promise<void>
  consumePairingCode(pairingCodeId: string, consumedAt: string): Promise<boolean>
}

export type PairDeviceDeps = {
  now: () => string
  endpoint: string
  randomId: () => string
  randomToken: () => string
  hash: (value: string) => Promise<string>
}

export type CreatePairingCodeDeps = {
  now: () => Date
  randomId: () => string
  randomToken: () => string
  hash: (value: string) => Promise<string>
}

export type UserDevice = {
  id: string
  name: string
  platform: string
  lastSyncedAt: string | null
  createdAt: string
  activeTokenCount: number
}

type DeviceRow = Omit<UserDevice, 'activeTokenCount'> & {
  activeTokenCount: number | null
}

export function createPairDeviceDeps(endpoint: string): PairDeviceDeps {
  return {
    now: () => new Date().toISOString(),
    endpoint,
    randomId: () => randomId('id'),
    randomToken: () => randomToken('tb_upload'),
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

export async function listUserDevices(db: D1Database, userId: string): Promise<UserDevice[]> {
  const rows = await db
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
    .all<DeviceRow>()

  return (rows.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    platform: row.platform,
    lastSyncedAt: row.lastSyncedAt ?? null,
    createdAt: row.createdAt,
    activeTokenCount: Number(row.activeTokenCount ?? 0)
  }))
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
  const result = await db
    .prepare('UPDATE devices SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(name, now, input.deviceId, input.userId)
    .run()

  if ((result.meta.changes ?? 0) === 0) {
    throw new ApiError('NOT_FOUND', 'Device not found', 404)
  }
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

  await db
    .prepare(
      `
        UPDATE upload_tokens
        SET revoked_at = ?
        WHERE user_id = ?
          AND device_id = ?
          AND revoked_at IS NULL
      `
    )
    .bind(now, input.userId, input.deviceId)
    .run()

  const result = await db
    .prepare('UPDATE devices SET updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(now, input.deviceId, input.userId)
    .run()

  if ((result.meta.changes ?? 0) === 0) {
    throw new ApiError('NOT_FOUND', 'Device not found', 404)
  }
}

export async function createPairingCode(
  repository: DevicePairingRepository,
  userId: string,
  deps: CreatePairingCodeDeps,
  ttlMinutes = 30
) {
  const now = deps.now()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString()
  const pairingCode = deps.randomToken()
  const codeHash = await deps.hash(pairingCode)

  await repository.createPairingCode({
    pairingCodeId: deps.randomId(),
    userId,
    codeHash,
    expiresAt,
    createdAt
  })

  return {
    pairingCode,
    expiresAt
  }
}

export async function pairDevice(
  repository: DevicePairingRepository,
  request: DevicePairRequest,
  deps: PairDeviceDeps
) {
  const now = deps.now()
  const pairingCodeHash = await deps.hash(request.pairingCode)
  const pairingCode = await repository.findUsablePairingCode(pairingCodeHash, now)
  if (!pairingCode) {
    throw new ApiError('UNAUTHORIZED', 'Invalid or expired pairing code', 401)
  }

  const id = deps.randomId()
  const deviceId = `dev_${id}`
  const uploadTokenId = `ut_${id}`
  const uploadToken = deps.randomToken()
  const uploadTokenHash = await deps.hash(uploadToken)
  const consumed = await repository.consumePairingCode(pairingCode.id, now)
  if (!consumed) {
    throw new ApiError('UNAUTHORIZED', 'Invalid or expired pairing code', 401)
  }

  await repository.createUploadTokenAndDevice({
    uploadTokenId,
    uploadTokenHash,
    deviceId,
    userId: pairingCode.userId,
    deviceName: request.deviceName ?? 'TokenBoard device',
    platform: request.platform ?? 'unknown',
    createdAt: now
  })

  return {
    endpoint: deps.endpoint,
    uploadToken,
    deviceId,
    timezone: request.timezone ?? 'UTC'
  }
}
