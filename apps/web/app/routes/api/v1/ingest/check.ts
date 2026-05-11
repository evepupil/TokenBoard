import { createRoute } from 'honox/factory'
import { verifyUploadToken } from '../../../../features/auth/middleware'
import { snapshotCheckRequestSchema } from '../../../../features/ingest/schema'
import { checkExistingSnapshots } from '../../../../features/ingest/service'
import { jsonError } from '../../../../lib/http'

export const POST = createRoute(async (c) => {
  try {
    const user = await verifyUploadToken(c.env, c.req.header('authorization') ?? null)
    const body = snapshotCheckRequestSchema.parse(await c.req.json())
    const result = await checkExistingSnapshots(c.env.DB, user, body.keys)
    return c.json(result)
  } catch (error) {
    return jsonError(c, error)
  }
})
