import { sha256Hex } from './crypto'
import { ApiError } from './errors'

export type RateLimitPolicy = {
  id: string
  maxRequests: number
  windowSeconds: number
}

export type RateLimitSubject = {
  kind: 'ip' | 'upload-token' | 'user' | 'sync-token'
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
  pairingCode: { id: 'pairing-code', maxRequests: 30, windowSeconds: 15 * 60 },
  // The notifications form can send a webhook test, which is an outbound request to a
  // user-supplied URL per POST. Ordinary use is a handful of saves per session, so the ceiling
  // is far above that while still bounding a scripted loop that would otherwise turn this form
  // into an outbound request amplifier.
  notificationsForm: { id: 'notifications-form', maxRequests: 60, windowSeconds: 60 },
  modelPricingSyncInvalidIp: { id: 'model-pricing-sync-invalid-ip', maxRequests: 30, windowSeconds: 15 * 60 },
  modelPricingSyncToken: { id: 'model-pricing-sync-token', maxRequests: 5, windowSeconds: 15 * 60 }
} satisfies Record<string, RateLimitPolicy>

// Read-side policies for the unauthenticated GETs. A cached public response costs
// nothing to serve, but a cache miss — and every 404/private-slug lookup, which is
// `no-store` by policy and so never cached — reaches D1. Without a ceiling anyone
// can turn anonymous traffic into D1 reads; past the ceiling the counter read is
// the only query the request makes.
export const readRateLimitPolicies = {
  modelPricingRead: { id: 'model-pricing-read', maxRequests: 120, windowSeconds: 60 },
  // The public alias of the same catalogue. It answers from the Worker cache when it
  // can, but only 200s are stored there: a novel `?cursor=` or a rejected limit is a
  // guaranteed miss that reaches D1, so it needs the same ceiling as the versioned
  // route. Separate id so the two counters do not spend each other's budget.
  publicModelPricingRead: { id: 'public-model-pricing-read', maxRequests: 120, windowSeconds: 60 },
  publicCardRead: { id: 'public-card-read', maxRequests: 120, windowSeconds: 60 },
  // The shared daily-report page is anonymous by design (the `drr_` id is the capability) and
  // `no-store`, so every request — including one for a well-formed but unknown id — reaches D1.
  // Without a ceiling anyone can turn random ids into unbounded reads, the same hazard the
  // public card and pricing endpoints are capped for.
  publicReportRead: { id: 'public-report-read', maxRequests: 120, windowSeconds: 60 }
} satisfies Record<string, RateLimitPolicy>

export async function assertRateLimitAvailable(
  db: D1Database,
  input: {
    policy: RateLimitPolicy
    subject: RateLimitSubject
    now?: Date
  }
): Promise<void> {
  validatePolicy(input.policy)

  const now = input.now ?? new Date()
  const key = await rateLimitKey(input.policy.id, input.subject)
  const existing = await db
    .prepare(
      `SELECT count, reset_at as resetAt
       FROM api_rate_limits
       WHERE key = ?
       LIMIT 1`
    )
    .bind(key)
    .first<{ count: number; resetAt: string }>()
  if (existing && Number(existing.count) >= input.policy.maxRequests) {
    const existingResetTimestamp = Date.parse(existing.resetAt)
    if (Number.isFinite(existingResetTimestamp) && existingResetTimestamp > now.getTime()) {
      throw rateLimitExceeded(existing.resetAt, now, input.policy.windowSeconds)
    }
  }
}

export async function enforceRateLimit(
  db: D1Database,
  input: {
    policy: RateLimitPolicy
    subject: RateLimitSubject
    now?: Date
  }
): Promise<RateLimitResult> {
  const now = input.now ?? new Date()
  await assertRateLimitAvailable(db, { ...input, now })
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
            WHEN julianday(api_rate_limits.reset_at) IS NULL
              OR julianday(api_rate_limits.reset_at) <= julianday(?) THEN 1
            ELSE min(api_rate_limits.count + 1, ?)
          END,
          reset_at = CASE
            WHEN julianday(api_rate_limits.reset_at) IS NULL
              OR julianday(api_rate_limits.reset_at) <= julianday(?) THEN excluded.reset_at
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
    throw rateLimitExceeded(effectiveResetAt, now, input.policy.windowSeconds)
  }

  return {
    limit: input.policy.maxRequests,
    remaining: Math.max(input.policy.maxRequests - count, 0),
    resetAt: effectiveResetAt
  }
}

function rateLimitExceeded(resetAt: string, now: Date, windowSeconds: number) {
  const resetTimestamp = Date.parse(resetAt)
  const retryAfterSeconds = Number.isFinite(resetTimestamp)
    ? Math.max(1, Math.ceil((resetTimestamp - now.getTime()) / 1000))
    : windowSeconds
  return new ApiError('RATE_LIMITED', `Too many requests. Try again after ${resetAt}.`, 429, {
    'Retry-After': String(retryAfterSeconds)
  })
}

export async function pruneExpiredRateLimits(db: D1Database, now = new Date()) {
  const nowIso = now.toISOString()
  await db
    .prepare(
      `DELETE FROM api_rate_limits
       WHERE julianday(reset_at) IS NULL OR julianday(reset_at) <= julianday(?)`
    )
    .bind(nowIso)
    .run()
}

export function clientIpRateLimitSubject(headers: Headers): RateLimitSubject {
  // Cloudflare overwrites this header at the edge. Do not trust forwarded
  // headers from other proxies; the shared fallback is intentionally fail-safe.
  const cfIp = headers.get('cf-connecting-ip')?.trim()
  if (cfIp) return { kind: 'ip', value: cfIp }

  return { kind: 'ip', value: 'unknown' }
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
