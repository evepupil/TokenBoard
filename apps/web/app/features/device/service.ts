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
