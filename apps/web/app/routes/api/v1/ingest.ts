import { createRoute } from 'honox/factory'
import { verifyUploadToken } from '../../../features/auth/middleware'
import { toIngestErrorDetails } from '../../../features/ingest/error-details'
import { ingestRequestSchema, maxIngestSnapshotBatchSize } from '../../../features/ingest/schema'
import { ingestSnapshots } from '../../../features/ingest/service'
import { ApiError } from '../../../lib/errors'
import { jsonError } from '../../../lib/http'
import { clientIpRateLimitSubject, enforceRateLimit, writeRateLimitPolicies } from '../../../lib/rate-limit'

// A full batch is 500 snapshots at a few hundred bytes each. The ceiling leaves an order of
// magnitude of headroom while keeping a request that is not a collector batch from being
// parsed into memory at all: the body is only materialised by `c.req.json()`, after this check.
export const maxIngestBodyBytes = maxIngestSnapshotBatchSize * 4096

export const POST = createRoute(async (c) => {
  try {
    await enforceRateLimit(c.env.DB, {
      policy: writeRateLimitPolicies.ingestIp,
      subject: clientIpRateLimitSubject(c.req.raw.headers)
    })
    const user = await verifyUploadToken(c.env, c.req.header('authorization') ?? null)
    await enforceRateLimit(c.env.DB, {
      policy: writeRateLimitPolicies.ingest,
      subject: { kind: 'upload-token', value: user.uploadTokenHash }
    })
    const declaredLength = Number(c.req.header('content-length') ?? '')
    if (Number.isFinite(declaredLength) && declaredLength > maxIngestBodyBytes) {
      throw new ApiError('PAYLOAD_TOO_LARGE', 'Request body too large', 413)
    }
    const parsed = ingestRequestSchema.safeParse(await c.req.json())
    if (!parsed.success) {
      // The details let the collector isolate the rejected rows and deliver the rest; without
      // them a single bad row fails the whole batch until uploads pause for a day.
      throw new ApiError('BAD_REQUEST', 'Invalid request', 400, undefined, toIngestErrorDetails(parsed.error))
    }
    const result = await ingestSnapshots(c.env.DB, user, parsed.data.snapshots)
    return c.json(result)
  } catch (error) {
    return jsonError(c, error)
  }
})
