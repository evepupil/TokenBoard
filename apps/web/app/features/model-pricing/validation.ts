import { z } from 'zod'
import { ApiError } from '../../lib/errors'

export const maxModelPricingPageSize = 10_000
export const defaultModelPricingPageSize = 100
export const modelPricingProviderPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/

export class ModelPricingQueryError extends ApiError {
  constructor(message: string) {
    super('BAD_REQUEST', message, 400)
    this.name = 'ModelPricingQueryError'
  }
}

export const modelPricingLimitSchema = z
  .string()
  .trim()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(maxModelPricingPageSize))

export const modelPricingProviderSchema = z.string().regex(modelPricingProviderPattern)

export function parseModelPricingLimit(value: string | undefined) {
  if (value === undefined) return undefined
  const parsed = modelPricingLimitSchema.safeParse(value)
  if (!parsed.success) {
    throw new ModelPricingQueryError(
      `Model pricing limit is invalid; must be an integer from 1 to ${maxModelPricingPageSize}`
    )
  }
  return parsed.data
}

export function normalizeModelPricingLimit(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maxModelPricingPageSize) {
    throw new ModelPricingQueryError(
      `Model pricing limit is invalid; must be an integer from 1 to ${maxModelPricingPageSize}`
    )
  }
  return value
}

export function parseModelPricingProvider(value: string | undefined) {
  if (value === undefined) return undefined
  const parsed = modelPricingProviderSchema.safeParse(value)
  if (!parsed.success) {
    throw new ModelPricingQueryError('Model pricing provider must use a valid provider id')
  }
  return parsed.data
}
