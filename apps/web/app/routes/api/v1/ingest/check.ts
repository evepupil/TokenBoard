import { createRoute } from 'honox/factory'
import { verifyUploadToken } from '../../../../features/auth/middleware'
import { snapshotCheckRequestSchema } from '../../../../features/ingest/schema'
import { checkExistingSnapshots } from '../../../../features/ingest/service'
import { jsonError } from '../../../../lib/http'
import {
  clientIpRateLimitSubject,
  enforceRateLimit,
  writeRateLimitPolicies
} from '../../../../lib/rate-limit'

export const POST = createRoute(async (c) => {
  try {
    await enforceRateLimit(c.env.DB, {
      policy: writeRateLimitPolicies.ingestCheckIp,
      subject: clientIpRateLimitSubject(c.req.raw.headers)
    })
    const user = await verifyUploadToken(c.env, c.req.header('authorization') ?? null)
    await enforceRateLimit(c.env.DB, {
      policy: writeRateLimitPolicies.ingestCheck,
      subject: { kind: 'upload-token', value: user.uploadTokenHash }
    })
    const body = snapshotCheckRequestSchema.parse(await c.req.json())
    const result = await checkExistingSnapshots(c.env.DB, user, body.keys)
    return c.json(result)
  } catch (error) {
    return jsonError(c, error)
  }
})
