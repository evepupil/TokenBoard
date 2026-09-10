import { z, ZodError } from 'zod'
import { ApiError } from '../../lib/errors'
import { sha256Hex } from '../../lib/crypto'
import { getModelPricing } from './service'
import { modelPricingLimitSchema, modelPricingProviderSchema } from './validation'

const modelPricingQuerySchema = z.object({
  provider: z.preprocess(normalizeOptionalQueryValue, modelPricingProviderSchema.optional()),
  includeInactive: z
    .preprocess(normalizeOptionalQueryValue, z.enum(['0', '1']).optional())
    .transform((value) => value === '1'),
  limit: z.preprocess(normalizeOptionalQueryValue, modelPricingLimitSchema.optional()),
  cursor: z.preprocess(normalizeOptionalQueryValue, z.string().min(1).optional())
})

export async function createModelPricingResponse(input: {
  db: D1Database
  searchParams: URLSearchParams
  requestHeaders?: Headers
}) {
  try {
    const query = modelPricingQuerySchema.parse({
      provider: input.searchParams.get('provider'),
      includeInactive: input.searchParams.get('includeInactive'),
      limit: input.searchParams.get('limit'),
      cursor: input.searchParams.get('cursor')
    })
    const result = await getModelPricing({
      db: input.db,
      provider: query.provider,
      includeInactive: query.includeInactive,
      limit: query.limit,
      cursor: query.cursor
    })
    const body = { models: result.models, nextCursor: result.nextCursor }
    const etag = `"${await sha256Hex(
      JSON.stringify({
        generation: result.state?.activeGeneration ?? null,
        body
      })
    )}"`
    const headers = new Headers({
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      ETag: etag
    })
    if (matchesEtag(input.requestHeaders?.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers })
    }
    return Response.json(body, { headers })
  } catch (error) {
    return modelPricingErrorResponse(error)
  }
}

function matchesEtag(value: string | null | undefined, etag: string) {
  const expected = normalizeEtag(etag)
  return (
    value?.split(',').some((candidate) => {
      const trimmed = candidate.trim()
      return trimmed === '*' || normalizeEtag(trimmed) === expected
    }) ?? false
  )
}

function normalizeEtag(value: string) {
  const trimmed = value.trim()
  return trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed
}

function modelPricingErrorResponse(error: unknown) {
  if (error instanceof ApiError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
  }

  if (error instanceof ZodError) {
    return Response.json({ error: { code: 'BAD_REQUEST', message: 'Invalid request' } }, { status: 400 })
  }

  return Response.json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' } }, { status: 500 })
}

function normalizeOptionalQueryValue(value: unknown) {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') return value
  const normalized = value.trim()
  return normalized || undefined
}
