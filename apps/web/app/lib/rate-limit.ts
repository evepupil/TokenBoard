import { sha256Hex } from './crypto'
import { ApiError } from './errors'

export type RateLimitPolicy = {
  id: string
  maxRequests: number
  windowSeconds: number
}

export type RateLimitSubject = {
  kind: 'ip' | 'upload-token' | 'user'
  value: string
}

export type RateLimitResult = {
  limit: number
  remaining: number
  resetAt: string
}

export const writeRateLimitPolicies = {
  ingest: { id: 'ingest', maxRequests: 120, windowSeconds: 60 },
  ingestIp: { id: 'ingest-ip', maxRequests: 300, windowSeconds: 60 },
  ingestCheck: { id: 'ingest-check', maxRequests: 240, windowSeconds: 60 },
  ingestCheckIp: { id: 'ingest-check-ip', maxRequests: 300, windowSeconds: 60 },
  devicePair: { id: 'device-pair', maxRequests: 20, windowSeconds: 15 * 60 },
  pairingCode: { id: 'pairing-code', maxRequests: 30, windowSeconds: 15 * 60 }
} satisfies Record<string, RateLimitPolicy>

export async function enforceRateLimit(
  db: D1Database,
  input: {
    policy: RateLimitPolicy
    subject: RateLimitSubject
    now?: Date
  }
): Promise<RateLimitResult> {
  validatePolicy(input.policy)

  const now = input.now ?? new Date()
  const nowIso = now.toISOString()
  const resetAt = new Date(now.getTime() + input.policy.windowSeconds * 1000).toISOString()
  const key = await rateLimitKey(input.policy.id, input.subject)
  const row = await db
    .prepare(
      `
        INSERT INTO api_rate_limits (key, count, reset_at, updated_at)
        VALUES (?, 1, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          count = CASE
            WHEN api_rate_limits.reset_at <= ? THEN 1
            ELSE min(api_rate_limits.count + 1, ?)
          END,
          reset_at = CASE
            WHEN api_rate_limits.reset_at <= ? THEN excluded.reset_at
            ELSE api_rate_limits.reset_at
          END,
          updated_at = excluded.updated_at
        RETURNING count, reset_at as resetAt
      `
    )
    .bind(key, resetAt, nowIso, nowIso, input.policy.maxRequests + 1, nowIso)
    .first<{ count: number; resetAt: string }>()

  const count = Number(row?.count ?? input.policy.maxRequests + 1)
  const effectiveResetAt = row?.resetAt ?? resetAt
  if (count > input.policy.maxRequests) {
    throw new ApiError('RATE_LIMITED', `Too many requests. Try again after ${effectiveResetAt}.`, 429)
  }

  return {
    limit: input.policy.maxRequests,
    remaining: Math.max(input.policy.maxRequests - count, 0),
    resetAt: effectiveResetAt
  }
}

export async function pruneExpiredRateLimits(db: D1Database, now = new Date()) {
  await db
    .prepare('DELETE FROM api_rate_limits WHERE reset_at <= ?')
    .bind(now.toISOString())
    .run()
}

export function clientIpRateLimitSubject(headers: Headers): RateLimitSubject {
  const cfIp = headers.get('cf-connecting-ip')?.trim()
  if (cfIp) return { kind: 'ip', value: cfIp }

  const forwardedIp = headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return { kind: 'ip', value: forwardedIp || 'unknown' }
}

async function rateLimitKey(policyId: string, subject: RateLimitSubject) {
  const hash = await sha256Hex(subject.value)
  return `rl:v1:${policyId}:${subject.kind}:${hash}`
}

function validatePolicy(policy: RateLimitPolicy) {
  if (!policy.id || policy.maxRequests < 1 || policy.windowSeconds < 1) {
    throw new Error('Invalid rate limit policy')
  }
}
