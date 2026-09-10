import { randomId } from '../../lib/crypto'
import type { Bindings } from '../../lib/db'
import { ApiError } from '../../lib/errors'
import {
  claimModelPricingSync,
  isModelPricingSyncLocked,
  listModelPricing,
  markModelPricingSyncFailure,
  markModelPricingSyncSuccess,
  readModelPricingSyncState,
  replaceModelPricing,
  type ModelPricingSyncState
} from './repository'
import {
  defaultModelPricingPageSize,
  maxModelPricingPageSize,
  normalizeModelPricingLimit,
  parseModelPricingLimit
} from './validation'
import { defaultModelPricingSourceUrl, fetchModelPricingSource, type PricingFetcher } from './source'

export const defaultModelPricingSyncIntervalHours = 24
export const maxModelPricingSyncIntervalHours = 168

export type ModelPricingEnv = Pick<
  Bindings,
  | 'DB'
  | 'TOKENBOARD_MODEL_PRICING_SYNC_ENABLED'
  | 'TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS'
  | 'TOKENBOARD_MODEL_PRICING_SOURCE_URL'
  | 'TOKENBOARD_MODEL_PRICING_SYNC_TOKEN'
>

export type ModelPricingSyncResult = {
  status: 'success' | 'skipped'
  reason?: 'disabled' | 'not-due' | 'locked'
  modelCount?: number
  sourceUpdatedAt?: string | null
  completedAt?: string
}

export async function runModelPricingSync(input: {
  env: Pick<
    ModelPricingEnv,
    'DB' | 'TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS' | 'TOKENBOARD_MODEL_PRICING_SOURCE_URL'
  >
  now?: Date
  force?: boolean
  fetcher?: PricingFetcher
}): Promise<ModelPricingSyncResult> {
  const now = input.now ?? new Date()
  const syncStartedAt = Date.now()
  const logicalNow = () => new Date(now.getTime() + Math.max(0, Date.now() - syncStartedAt))
  const sourceUrl = input.env.TOKENBOARD_MODEL_PRICING_SOURCE_URL?.trim() || defaultModelPricingSourceUrl
  const lockToken = randomId('pricing-sync')
  const claimed = await claimModelPricingSync({
    db: input.env.DB,
    sourceUrl,
    now,
    intervalHours: modelPricingSyncIntervalHours(input.env),
    force: input.force,
    lockToken
  })
  if (!claimed) {
    const locked = await isModelPricingSyncLocked(input.env.DB, now)
    return { status: 'skipped', reason: locked ? 'locked' : 'not-due' }
  }

  let syncGeneration: string | null = null
  try {
    const snapshot = await fetchModelPricingSource({
      sourceUrl,
      now,
      fetcher: input.fetcher
    })
    syncGeneration = randomId('pricing-generation')
    await replaceModelPricing({
      db: input.env.DB,
      models: snapshot.models,
      sourceUrl: snapshot.sourceUrl,
      fetchedAt: snapshot.fetchedAt,
      syncGeneration,
      lockToken,
      now: logicalNow()
    })
    const completedAt = logicalNow()
    await markModelPricingSyncSuccess({
      db: input.env.DB,
      lockToken,
      sourceUrl: snapshot.sourceUrl,
      now: completedAt,
      leaseNow: completedAt,
      sourceUpdatedAt: snapshot.latestSourceUpdatedAt,
      modelCount: snapshot.models.length,
      syncGeneration
    })
    return {
      status: 'success',
      modelCount: snapshot.models.length,
      sourceUpdatedAt: snapshot.latestSourceUpdatedAt,
      completedAt: completedAt.toISOString()
    }
  } catch (error) {
    const message = errorMessage(error)
    try {
      await markModelPricingSyncFailure({
        db: input.env.DB,
        lockToken,
        sourceUrl,
        now: logicalNow(),
        error: message,
        syncGeneration
      })
    } catch (stateError) {
      throw new Error(`${message}; additionally failed to persist pricing sync failure: ${errorMessage(stateError)}`)
    }
    throw new Error(`Model pricing sync failed: ${message}`)
  }
}

export async function getModelPricing(input: {
  db: D1Database
  provider?: string
  includeInactive?: boolean
  limit?: number
  cursor?: string
}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await readModelPricingSyncState(input.db)
    const models = await listModelPricing(input.db, {
      provider: input.provider,
      activeOnly: !input.includeInactive,
      // The inactive catalogue is a historical view and is not scoped to the
      // currently active generation. Do not bind its pagination cursor to a
      // generation that can change while the caller walks the history.
      activeGeneration: input.includeInactive ? null : state?.activeGeneration,
      limit: input.limit,
      cursor: input.cursor
    })
    const currentState = await readModelPricingSyncState(input.db)
    if (samePricingState(state, currentState)) return { state, ...models }
    if (attempt < 2) await waitForPricingReadRetry(attempt)
  }
  throw new ApiError(
    'SERVICE_UNAVAILABLE',
    'Model pricing catalogue is temporarily unavailable; retry the request',
    503
  )
}

async function waitForPricingReadRetry(attempt: number) {
  const delayMs = 50 * 2 ** attempt
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

function samePricingState(left: ModelPricingSyncState | null, right: ModelPricingSyncState | null) {
  return left?.activeGeneration === right?.activeGeneration && left?.modelCount === right?.modelCount
}

export function modelPricingSyncEnabled(env: Pick<ModelPricingEnv, 'TOKENBOARD_MODEL_PRICING_SYNC_ENABLED'>) {
  const value = env.TOKENBOARD_MODEL_PRICING_SYNC_ENABLED
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  if (!['true', 'false', '1', '0'].includes(normalized)) {
    throw new Error('TOKENBOARD_MODEL_PRICING_SYNC_ENABLED must be true, false, 1, or 0')
  }
  return normalized === 'true' || normalized === '1'
}

export function modelPricingSyncIntervalHours(
  env: Pick<ModelPricingEnv, 'TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS'>
) {
  const value = env.TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS
  if (value === undefined) return defaultModelPricingSyncIntervalHours
  if (!/^\d+$/.test(value.trim())) throw invalidIntervalError()
  const parsed = Number(value.trim())
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maxModelPricingSyncIntervalHours) {
    throw invalidIntervalError()
  }
  return parsed
}

export function pricingSyncTokenConfigured(env: Pick<ModelPricingEnv, 'TOKENBOARD_MODEL_PRICING_SYNC_TOKEN'>) {
  return Boolean(env.TOKENBOARD_MODEL_PRICING_SYNC_TOKEN?.trim())
}

export async function verifyPricingSyncToken(
  env: Pick<ModelPricingEnv, 'TOKENBOARD_MODEL_PRICING_SYNC_TOKEN'>,
  authorization: string | null | undefined
) {
  const expected = env.TOKENBOARD_MODEL_PRICING_SYNC_TOKEN?.trim()
  const provided = parsePricingSyncToken(authorization)
  if (!expected || !provided) return false
  const [expectedHash, providedHash] = await Promise.all([sha256(expected), sha256(provided)])
  if (expectedHash.length !== providedHash.length) return false
  let difference = 0
  for (let index = 0; index < expectedHash.length; index += 1) {
    difference |= expectedHash.charCodeAt(index) ^ providedHash.charCodeAt(index)
  }
  return difference === 0
}

export function parsePricingSyncToken(value: string | null | undefined) {
  const match = /^Bearer\s+(\S+)$/.exec(value ?? '')
  return match?.[1] ?? null
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function invalidIntervalError() {
  return new Error(
    `TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS must be an integer from 1 to ${maxModelPricingSyncIntervalHours}`
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export type { ModelPricingSyncState }
export {
  defaultModelPricingPageSize,
  maxModelPricingPageSize,
  normalizeModelPricingLimit,
  parseModelPricingLimit,
  readModelPricingSyncState
}
