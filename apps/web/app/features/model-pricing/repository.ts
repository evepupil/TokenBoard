import type { NormalizedModelPricing } from './source'
import {
  defaultModelPricingPageSize,
  ModelPricingQueryError,
  normalizeModelPricingLimit,
  parseModelPricingProvider
} from './validation'

export type ModelPricingSyncState = {
  status: 'running' | 'success' | 'failed'
  sourceUrl: string
  lastStartedAt: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastSourceUpdatedAt: string | null
  modelCount: number
  activeGeneration: string | null
  lastError: string | null
  updatedAt: string | null
}

export type StoredModelPricing = NormalizedModelPricing & {
  sourceUrl: string
  pricing: Record<string, unknown>
  isActive: boolean
  fetchedAt: string
}

const STATE_ID = 'global'
const maxBatchStatements = 100
const modelPricingLeaseDurationMs = 10 * 60 * 1000
export const modelPricingFailureRetryDelayMs = 60 * 60 * 1000

export async function claimModelPricingSync(input: {
  db: D1Database
  sourceUrl: string
  now: Date
  intervalHours: number
  force?: boolean
  lockToken: string
}) {
  const nowIso = input.now.toISOString()
  const lockedUntil = new Date(input.now.getTime() + modelPricingLeaseDurationMs).toISOString()
  const dueAt = new Date(input.now.getTime() - input.intervalHours * 60 * 60 * 1000).toISOString()
  const failureRetryAt = new Date(input.now.getTime() - modelPricingFailureRetryDelayMs).toISOString()
  const result = await input.db
    .prepare(
      `
        INSERT INTO model_pricing_sync_state (
          id,
          source_url,
          status,
          lock_token,
          locked_until,
          last_started_at,
          last_success_at,
          last_failure_at,
          last_source_updated_at,
          model_count,
          active_generation,
          last_error,
          updated_at
        )
        VALUES (?, ?, 'running', ?, ?, ?, NULL, NULL, NULL, 0, NULL, NULL, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_url = excluded.source_url,
          status = 'running',
          lock_token = excluded.lock_token,
          locked_until = excluded.locked_until,
          last_started_at = excluded.last_started_at,
          last_error = NULL,
          updated_at = excluded.updated_at
        WHERE (model_pricing_sync_state.locked_until IS NULL OR model_pricing_sync_state.locked_until <= ?)
          AND (? = 1 OR model_pricing_sync_state.last_success_at IS NULL OR model_pricing_sync_state.last_success_at <= ?)
          AND (? = 1 OR model_pricing_sync_state.last_failure_at IS NULL OR model_pricing_sync_state.last_failure_at <= ?)
      `
    )
    .bind(
      STATE_ID,
      input.sourceUrl,
      input.lockToken,
      lockedUntil,
      nowIso,
      nowIso,
      nowIso,
      input.force ? 1 : 0,
      dueAt,
      input.force ? 1 : 0,
      failureRetryAt
    )
    .run()

  return Number(result.meta?.changes ?? 0) > 0
}

export async function replaceModelPricing(input: {
  db: D1Database
  models: NormalizedModelPricing[]
  sourceUrl: string
  fetchedAt: string
  syncGeneration: string
  lockToken: string
  now: Date
}) {
  if (input.models.length === 0) {
    throw new Error('Model pricing sync cannot activate an empty catalogue')
  }
  const startedAt = Date.now()
  const leaseNow = () => new Date(input.now.getTime() + Math.max(0, Date.now() - startedAt)).toISOString()
  const renewLease = async () => {
    const now = leaseNow()
    const lockedUntil = new Date(Date.parse(now) + modelPricingLeaseDurationMs).toISOString()
    const result = await input.db
      .prepare(
        `
          UPDATE model_pricing_sync_state
          SET locked_until = ?, updated_at = ?
          WHERE id = ?
            AND status = 'running'
            AND lock_token = ?
            AND locked_until > ?
        `
      )
      .bind(lockedUntil, now, STATE_ID, input.lockToken, now)
      .run()
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new Error('Model pricing sync lock ownership was lost before writing staging rows')
    }
    return now
  }
  await input.db
    .prepare(
      `
      DELETE FROM model_pricing_staging
      WHERE generation_id != ?
        AND generation_id != COALESCE(
          (SELECT active_generation FROM model_pricing_sync_state WHERE id = ? LIMIT 1),
          ''
        )
        AND EXISTS (
          SELECT 1
          FROM model_pricing_sync_state
          WHERE id = ? AND status = 'running' AND lock_token = ? AND locked_until > ?
        )
      `
    )
    .bind(input.syncGeneration, STATE_ID, STATE_ID, input.lockToken, leaseNow())
    .run()

  for (let offset = 0; offset < input.models.length; offset += maxBatchStatements) {
    const batchLeaseNow = await renewLease()
    const batch = input.models.slice(offset, offset + maxBatchStatements).map((model) =>
      input.db
        .prepare(
          `
          INSERT INTO model_pricing_staging (
            generation_id,
            provider,
            model_id,
            display_name,
            input_cost_per_million,
            output_cost_per_million,
            cache_read_cost_per_million,
            cache_write_cost_per_million,
            context_window,
            max_input_tokens,
            max_output_tokens,
            release_date,
            source_updated_at,
            official_docs_url,
            source_url,
            pricing_json,
            is_deprecated,
            fetched_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1
            FROM model_pricing_sync_state
            WHERE id = ? AND status = 'running' AND lock_token = ? AND locked_until > ?
          )
          ON CONFLICT(generation_id, provider, model_id) DO UPDATE SET
            display_name = excluded.display_name,
            input_cost_per_million = excluded.input_cost_per_million,
            output_cost_per_million = excluded.output_cost_per_million,
            cache_read_cost_per_million = excluded.cache_read_cost_per_million,
            cache_write_cost_per_million = excluded.cache_write_cost_per_million,
            context_window = excluded.context_window,
            max_input_tokens = excluded.max_input_tokens,
            max_output_tokens = excluded.max_output_tokens,
            release_date = excluded.release_date,
            source_updated_at = excluded.source_updated_at,
            official_docs_url = excluded.official_docs_url,
            source_url = excluded.source_url,
            pricing_json = excluded.pricing_json,
            is_deprecated = excluded.is_deprecated,
            fetched_at = excluded.fetched_at
        `
        )
        .bind(
          input.syncGeneration,
          model.provider,
          model.modelId,
          model.displayName,
          model.inputCostPerMillion,
          model.outputCostPerMillion,
          model.cacheReadCostPerMillion,
          model.cacheWriteCostPerMillion,
          model.contextWindow,
          model.maxInputTokens,
          model.maxOutputTokens,
          model.releaseDate,
          model.sourceUpdatedAt,
          model.officialDocsUrl,
          input.sourceUrl,
          model.pricingJson,
          model.isDeprecated ? 1 : 0,
          input.fetchedAt,
          STATE_ID,
          input.lockToken,
          batchLeaseNow
        )
    )
    const results = await runBatch(
      input.db,
      batch,
      `staging rows ${offset + 1}-${Math.min(offset + maxBatchStatements, input.models.length)}`
    )
    if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
      throw new Error('Model pricing sync lock ownership was lost while writing staging rows')
    }
  }
}

export async function markModelPricingSyncSuccess(input: {
  db: D1Database
  lockToken: string
  sourceUrl: string
  now: Date
  leaseNow?: Date
  sourceUpdatedAt: string | null
  modelCount: number
  syncGeneration: string
}) {
  const nowIso = input.now.toISOString()
  const leaseNowIso = (input.leaseNow ?? input.now).toISOString()
  const statements = [
    input.db
      .prepare(
        `
        UPDATE model_pricing_sync_state
        SET status = 'success',
            source_url = ?,
            lock_token = NULL,
            locked_until = NULL,
            last_success_at = ?,
            last_failure_at = NULL,
            last_source_updated_at = ?,
            model_count = ?,
            active_generation = ?,
            last_error = NULL,
            updated_at = ?
        WHERE id = ? AND lock_token = ?
          AND locked_until > ?
          AND (
            SELECT COUNT(*)
            FROM model_pricing_staging
            WHERE generation_id = ?
          ) = ?
      `
      )
      .bind(
        input.sourceUrl,
        nowIso,
        input.sourceUpdatedAt,
        input.modelCount,
        input.syncGeneration,
        nowIso,
        STATE_ID,
        input.lockToken,
        leaseNowIso,
        input.syncGeneration,
        input.modelCount
      ),
    input.db
      .prepare(
        `
        INSERT INTO model_pricing (
          provider, model_id, display_name, input_cost_per_million, output_cost_per_million,
          cache_read_cost_per_million, cache_write_cost_per_million, context_window,
          max_input_tokens, max_output_tokens, release_date, source_updated_at,
          official_docs_url, source_url, pricing_json, is_deprecated, is_active,
          sync_generation, fetched_at
        )
        SELECT provider, model_id, display_name, input_cost_per_million, output_cost_per_million,
          cache_read_cost_per_million, cache_write_cost_per_million, context_window,
          max_input_tokens, max_output_tokens, release_date, source_updated_at,
          official_docs_url, source_url, pricing_json, is_deprecated, 1,
          generation_id, fetched_at
        FROM model_pricing_staging
        WHERE generation_id = ?
          AND EXISTS (
            SELECT 1 FROM model_pricing_sync_state
            WHERE id = ? AND status = 'success' AND active_generation = ? AND lock_token IS NULL
          )
        ON CONFLICT(provider, model_id) DO UPDATE SET
          display_name = excluded.display_name,
          input_cost_per_million = excluded.input_cost_per_million,
          output_cost_per_million = excluded.output_cost_per_million,
          cache_read_cost_per_million = excluded.cache_read_cost_per_million,
          cache_write_cost_per_million = excluded.cache_write_cost_per_million,
          context_window = excluded.context_window,
          max_input_tokens = excluded.max_input_tokens,
          max_output_tokens = excluded.max_output_tokens,
          release_date = excluded.release_date,
          source_updated_at = excluded.source_updated_at,
          official_docs_url = excluded.official_docs_url,
          source_url = excluded.source_url,
          pricing_json = excluded.pricing_json,
          is_deprecated = excluded.is_deprecated,
          is_active = 1,
          sync_generation = excluded.sync_generation,
          fetched_at = excluded.fetched_at
      `
      )
      .bind(input.syncGeneration, STATE_ID, input.syncGeneration),
    input.db
      .prepare(
        `
        UPDATE model_pricing
        SET is_active = CASE WHEN sync_generation = ? THEN 1 ELSE 0 END
        WHERE (is_active = 1 OR sync_generation = ?)
          AND EXISTS (
            SELECT 1 FROM model_pricing_sync_state
            WHERE id = ? AND status = 'success' AND active_generation = ? AND lock_token IS NULL
          )
      `
      )
      .bind(input.syncGeneration, input.syncGeneration, STATE_ID, input.syncGeneration),
    input.db
      .prepare(
        `
        DELETE FROM model_pricing_staging
        WHERE generation_id = ?
          AND EXISTS (
            SELECT 1 FROM model_pricing_sync_state
            WHERE id = ? AND status = 'success' AND active_generation = ? AND lock_token IS NULL
          )
      `
      )
      .bind(input.syncGeneration, STATE_ID, input.syncGeneration)
  ]
  const results = await runBatch(input.db, statements, 'activate pricing generation')
  const stateResult = results[0]
  if (Number(stateResult?.meta?.changes ?? 0) !== 1) {
    const [state, stagingCount] = await Promise.all([
      input.db
        .prepare(
          `
            SELECT status, lock_token as lockToken, locked_until as lockedUntil
            FROM model_pricing_sync_state
            WHERE id = ?
            LIMIT 1
          `
        )
        .bind(STATE_ID)
        .first<Record<string, unknown>>(),
      input.db
        .prepare(
          `
            SELECT COUNT(*) as count
            FROM model_pricing_staging
            WHERE generation_id = ?
          `
        )
        .bind(input.syncGeneration)
        .first<Record<string, unknown>>()
    ])
    const ownsLiveLock =
      state?.status === 'running' &&
      state.lockToken === input.lockToken &&
      typeof state.lockedUntil === 'string' &&
      Date.parse(state.lockedUntil) > Date.parse(leaseNowIso)
    const actualStagingCount = Number(stagingCount?.count ?? 0)
    if (ownsLiveLock && actualStagingCount !== input.modelCount) {
      throw new Error(
        `Model pricing generation staging count ${actualStagingCount} does not match expected model count ${input.modelCount}`
      )
    }
    if (ownsLiveLock) {
      throw new Error('Model pricing sync activation did not update the state despite retaining lock ownership')
    }
  }
  assertLockOwnership(stateResult, 'success')
}

export async function markModelPricingSyncFailure(input: {
  db: D1Database
  lockToken: string
  sourceUrl: string
  now: Date
  error: string
  syncGeneration?: string | null
}) {
  const failureStatement = input.db
    .prepare(
      `
      UPDATE model_pricing_sync_state
      SET status = 'failed',
          source_url = ?,
          lock_token = NULL,
          locked_until = NULL,
          last_failure_at = ?,
          last_error = ?,
          updated_at = ?
      WHERE id = ?
        AND status = 'running'
        AND lock_token = ?
        AND locked_until > ?
    `
    )
    .bind(
      input.sourceUrl,
      input.now.toISOString(),
      input.error.slice(0, 1000),
      input.now.toISOString(),
      STATE_ID,
      input.lockToken,
      input.now.toISOString()
    )

  if (!input.syncGeneration) {
    assertLockOwnership(await failureStatement.run(), 'failure')
    return
  }

  const results = await runBatch(
    input.db,
    [
      input.db
        .prepare(
          `
        DELETE FROM model_pricing_staging
        WHERE generation_id = ?
          AND EXISTS (
            SELECT 1 FROM model_pricing_sync_state
            WHERE id = ? AND status = 'running' AND lock_token = ? AND locked_until > ?
          )
      `
        )
        .bind(input.syncGeneration, STATE_ID, input.lockToken, input.now.toISOString()),
      failureStatement
    ],
    'failure'
  )
  const result = results.at(-1)
  assertLockOwnership(result, 'failure')
}

export async function readModelPricingSyncState(db: D1Database) {
  const row = await db
    .prepare(
      `
        SELECT
          status,
          source_url as sourceUrl,
          last_started_at as lastStartedAt,
          last_success_at as lastSuccessAt,
          last_failure_at as lastFailureAt,
          last_source_updated_at as lastSourceUpdatedAt,
          model_count as modelCount,
          active_generation as activeGeneration,
          last_error as lastError,
          updated_at as updatedAt
        FROM model_pricing_sync_state
        WHERE id = ?
        LIMIT 1
      `
    )
    .bind(STATE_ID)
    .first<Record<string, unknown>>()

  if (!row) return null
  if (!isSyncStatus(row.status) || typeof row.sourceUrl !== 'string' || !row.sourceUrl) {
    throw new Error('Model pricing sync state is malformed')
  }
  return {
    status: row.status,
    sourceUrl: row.sourceUrl,
    lastStartedAt: nullableString(row.lastStartedAt, 'lastStartedAt'),
    lastSuccessAt: nullableString(row.lastSuccessAt, 'lastSuccessAt'),
    lastFailureAt: nullableString(row.lastFailureAt, 'lastFailureAt'),
    lastSourceUpdatedAt: nullableString(row.lastSourceUpdatedAt, 'lastSourceUpdatedAt'),
    modelCount: readStoredNonNegativeInteger(row.modelCount ?? 0, 'modelCount'),
    activeGeneration: nullableString(row.activeGeneration, 'activeGeneration'),
    lastError: nullableString(row.lastError, 'lastError'),
    updatedAt: nullableString(row.updatedAt, 'updatedAt')
  } satisfies ModelPricingSyncState
}

export async function isModelPricingSyncLocked(db: D1Database, now: Date) {
  const row = await db
    .prepare(
      `
        SELECT locked_until as lockedUntil
        FROM model_pricing_sync_state
        WHERE id = ?
        LIMIT 1
      `
    )
    .bind(STATE_ID)
    .first<Record<string, unknown>>()

  if (!row || row.lockedUntil === null || row.lockedUntil === undefined) return false
  if (typeof row.lockedUntil !== 'string' || Number.isNaN(Date.parse(row.lockedUntil))) {
    throw new Error('Model pricing sync state has an invalid lockedUntil timestamp')
  }
  return Date.parse(row.lockedUntil) > now.getTime()
}

export async function listModelPricing(
  db: D1Database,
  input: {
    provider?: string
    activeOnly?: boolean
    activeGeneration?: string | null
    limit?: number
    cursor?: string
  }
) {
  const pageSize = input.limit === undefined ? defaultModelPricingPageSize : normalizeModelPricingLimit(input.limit)
  const provider = parseModelPricingProvider(input.provider)
  // Resolve the active generation once so the row predicate and cursor use the
  // same catalogue snapshot, even when callers omit activeGeneration.
  const resolvedActiveGeneration =
    input.activeOnly !== false && input.activeGeneration == null
      ? await readActiveGeneration(db)
      : (input.activeGeneration ?? null)
  const cursorGeneration = input.activeOnly !== false ? resolvedActiveGeneration : null
  const predicates = ['1 = 1']
  const bindings: unknown[] = []
  if (provider) {
    predicates.push('provider = ?')
    bindings.push(provider)
  }
  if (input.activeOnly !== false) {
    if (resolvedActiveGeneration) {
      predicates.push('sync_generation = ?')
      bindings.push(resolvedActiveGeneration)
    } else {
      predicates.push('is_active = 1')
    }
  }
  const cursor = input.cursor ? decodeModelPricingCursor(input.cursor) : null
  if (cursor) {
    if (cursor.providerFilter !== (provider ?? null)) {
      throw new ModelPricingQueryError('Model pricing cursor does not match provider filter')
    }
    if (cursor.activeOnly !== (input.activeOnly !== false)) {
      throw new ModelPricingQueryError('Model pricing cursor does not match inactive filter')
    }
    if (input.activeOnly !== false && cursor.generation !== cursorGeneration) {
      throw new ModelPricingQueryError('Model pricing cursor has expired; restart pagination')
    }
    predicates.push('(provider > ? OR (provider = ? AND model_id > ?))')
    bindings.push(cursor.provider, cursor.provider, cursor.modelId)
  }

  const result = await db
    .prepare(
      `
        SELECT
          provider,
          model_id as modelId,
          display_name as displayName,
          input_cost_per_million as inputCostPerMillion,
          output_cost_per_million as outputCostPerMillion,
          cache_read_cost_per_million as cacheReadCostPerMillion,
          cache_write_cost_per_million as cacheWriteCostPerMillion,
          context_window as contextWindow,
          max_input_tokens as maxInputTokens,
          max_output_tokens as maxOutputTokens,
          release_date as releaseDate,
          source_updated_at as sourceUpdatedAt,
          official_docs_url as officialDocsUrl,
          source_url as sourceUrl,
          pricing_json as pricingJson,
          is_deprecated as isDeprecated,
          is_active as isActive,
          fetched_at as fetchedAt
        FROM model_pricing
        WHERE ${predicates.join(' AND ')}
        ORDER BY provider ASC, model_id ASC
        LIMIT ?
      `
    )
    .bind(...bindings, pageSize + 1)
    .all<Record<string, unknown>>()

  const rows = result.results
  const hasMore = rows.length > pageSize
  const page = hasMore ? rows.slice(0, pageSize) : rows
  const last = page.at(-1)
  return {
    models: page.map((row) => {
      const pricingJson = requiredString(row.pricingJson, 'pricingJson')
      return {
        provider: requiredString(row.provider, 'provider'),
        modelId: requiredString(row.modelId, 'modelId'),
        displayName: requiredString(row.displayName, 'displayName'),
        inputCostPerMillion: requiredNonNegativeNumber(row.inputCostPerMillion, 'inputCostPerMillion'),
        outputCostPerMillion: requiredNonNegativeNumber(row.outputCostPerMillion, 'outputCostPerMillion'),
        cacheReadCostPerMillion: nullableNonNegativeNumber(row.cacheReadCostPerMillion, 'cacheReadCostPerMillion'),
        cacheWriteCostPerMillion: nullableNonNegativeNumber(row.cacheWriteCostPerMillion, 'cacheWriteCostPerMillion'),
        contextWindow: requiredNonNegativeInteger(row.contextWindow, 'contextWindow'),
        maxInputTokens: nullableNonNegativeInteger(row.maxInputTokens, 'maxInputTokens'),
        maxOutputTokens: nullableNonNegativeInteger(row.maxOutputTokens, 'maxOutputTokens'),
        releaseDate: nullableString(row.releaseDate, 'releaseDate'),
        sourceUpdatedAt: nullableString(row.sourceUpdatedAt, 'sourceUpdatedAt'),
        officialDocsUrl: requiredString(row.officialDocsUrl, 'officialDocsUrl'),
        sourceUrl: requiredString(row.sourceUrl, 'sourceUrl'),
        pricingJson,
        pricing: parsePricingJson(pricingJson),
        isDeprecated: readStoredFlag(row.isDeprecated, 'isDeprecated'),
        isActive: readStoredFlag(row.isActive, 'isActive'),
        fetchedAt: requiredString(row.fetchedAt, 'fetchedAt')
      } satisfies StoredModelPricing
    }),
    nextCursor:
      hasMore && last
        ? encodeModelPricingCursor(
            String(last.provider),
            String(last.modelId),
            input.activeOnly !== false,
            cursorGeneration,
            provider ?? null
          )
        : null
  }
}

async function readActiveGeneration(db: D1Database) {
  const row = await db
    .prepare(
      `
        SELECT active_generation as activeGeneration
        FROM model_pricing_sync_state
        WHERE id = ?
        LIMIT 1
      `
    )
    .bind(STATE_ID)
    .first<Record<string, unknown>>()
  return nullableString(row?.activeGeneration, 'activeGeneration')
}

type ModelPricingCursor = {
  activeOnly: boolean
  generation: string | null
  providerFilter: string | null
  provider: string
  modelId: string
}

const maxModelPricingCursorLength = 16_384

function encodeModelPricingCursor(
  provider: string,
  modelId: string,
  activeOnly: boolean,
  generation: string | null,
  providerFilter: string | null
) {
  if (
    hasUnsafeCursorCharacters(provider, true) ||
    hasUnsafeCursorCharacters(providerFilter ?? '') ||
    hasUnsafeCursorCharacters(modelId, true) ||
    hasUnsafeCursorCharacters(generation ?? '')
  ) {
    throw new ModelPricingQueryError('Model pricing cursor is invalid')
  }
  // JSON keeps field boundaries intact for legacy rows containing a literal
  // NUL (the old delimiter-based codec could emit a cursor its decoder could
  // not read). The outer hex encoding remains compatible with the existing
  // transport and lets the decoder continue accepting old cursors.
  const payload = JSON.stringify([
    activeOnly ? 'active' : 'all',
    generation ?? '',
    providerFilter ?? '',
    provider,
    modelId
  ])
  const encoded = Array.from(new TextEncoder().encode(payload), (byte) => byte.toString(16).padStart(2, '0')).join('')
  if (encoded.length > maxModelPricingCursorLength) {
    throw new ModelPricingQueryError('Model pricing cursor is too large')
  }
  return encoded
}

function decodeModelPricingCursor(value: string): ModelPricingCursor {
  if (
    value.length === 0 ||
    value.length > maxModelPricingCursorLength ||
    value.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(value)
  ) {
    throw new ModelPricingQueryError('Model pricing cursor is invalid')
  }
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new ModelPricingQueryError('Model pricing cursor is invalid')
  }
  const fields = decodeModelPricingCursorFields(decoded)
  if (!fields) {
    throw new ModelPricingQueryError('Model pricing cursor is invalid')
  }
  const [scope, generationValue, providerFilterValue, provider, modelId] = fields
  if (!scope || !provider || !modelId) {
    throw new ModelPricingQueryError('Model pricing cursor is invalid')
  }
  if (
    hasUnsafeCursorCharacters(provider, true) ||
    hasUnsafeCursorCharacters(providerFilterValue) ||
    hasUnsafeCursorCharacters(modelId, true) ||
    hasUnsafeCursorCharacters(generationValue)
  ) {
    throw new ModelPricingQueryError('Model pricing cursor is invalid')
  }
  if (scope !== 'active' && scope !== 'all') throw new ModelPricingQueryError('Model pricing cursor is invalid')
  return {
    activeOnly: scope === 'active',
    generation: generationValue || null,
    providerFilter: providerFilterValue || null,
    provider,
    modelId
  }
}

function decodeModelPricingCursorFields(value: string): string[] | null {
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed) && parsed.length === 5 && parsed.every((field) => typeof field === 'string')) {
        return parsed
      }
    } catch {
      return null
    }
  }
  const fields = value.split('\u0000')
  return fields.length === 5 ? fields : null
}

function hasUnsafeCursorCharacters(value: string, allowNull = false) {
  return Array.from(value).some(
    (character) => !(allowNull && character === '\u0000') && /[\p{Cc}\p{Cf}\p{Cs}]/u.test(character)
  )
}

function isSyncStatus(value: unknown): value is ModelPricingSyncState['status'] {
  return value === 'running' || value === 'success' || value === 'failed'
}

function nullableString(value: unknown, field: string) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`Stored model pricing contains an invalid ${field}`)
  return value
}

function nullableNonNegativeNumber(value: unknown, field: string) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Stored model pricing contains an invalid ${field}`)
  }
  return value
}

function nullableNonNegativeInteger(value: unknown, field: string) {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Stored model pricing contains an invalid ${field}`)
  }
  return value as number
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Stored model pricing contains an invalid ${field}`)
  }
  return value
}

function requiredNonNegativeNumber(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Stored model pricing contains an invalid ${field}`)
  }
  return value
}

function requiredNonNegativeInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Stored model pricing contains an invalid ${field}`)
  }
  return value as number
}

function readStoredFlag(value: unknown, field: string) {
  if (value !== 0 && value !== 1) throw new Error(`Stored model pricing contains an invalid ${field}`)
  return value === 1
}

function parsePricingJson(value: unknown) {
  if (typeof value !== 'string') throw new Error('Stored model pricing is missing pricing_json')
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Stored model pricing has an invalid pricing_json object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Stored model pricing')) throw error
    throw new Error(`Stored model pricing has invalid pricing_json: ${errorMessage(error)}`)
  }
}

function readStoredNonNegativeInteger(value: unknown, field: string) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Model pricing sync state has an invalid ${field}`)
  }
  return parsed
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function assertLockOwnership(result: D1Result | undefined, phase: string) {
  const changes = result?.meta?.changes
  if (Number(changes) !== 1) {
    throw new Error(`Model pricing sync lock ownership was lost while recording ${phase}`)
  }
}

async function runBatch(db: D1Database, statements: D1PreparedStatement[], phase: string) {
  const results = await db.batch(statements)
  for (const [index, result] of results.entries()) {
    if (!result || (result as { success?: boolean }).success === false) {
      throw new Error(`Model pricing ${phase} statement ${index + 1} failed`)
    }
  }
  return results
}
