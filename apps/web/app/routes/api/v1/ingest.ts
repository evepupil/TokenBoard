import { createRoute } from 'honox/factory'
import { verifyUploadToken } from '../../../features/auth/middleware'
import { ingestRequestSchema } from '../../../features/ingest/schema'
import { ingestSnapshots } from '../../../features/ingest/service'
import { jsonError } from '../../../lib/http'
import {
  clientIpRateLimitSubject,
  enforceRateLimit,
  writeRateLimitPolicies
} from '../../../lib/rate-limit'

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
    const body = ingestRequestSchema.parse(await c.req.json())
    const result = await ingestSnapshots(c.env.DB, user, body.snapshots)
    return c.json(result)
  } catch (error) {
    return jsonError(c, error)
  }
})
