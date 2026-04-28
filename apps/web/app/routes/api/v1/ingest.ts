import { createRoute } from 'honox/factory'
import { verifyUploadToken } from '../../../features/auth/middleware'
import { ingestRequestSchema } from '../../../features/ingest/schema'
import { ingestSnapshots } from '../../../features/ingest/service'
import { jsonError } from '../../../lib/http'

export const POST = createRoute(async (c) => {
  try {
    const user = await verifyUploadToken(c.env, c.req.header('authorization') ?? null)
    const body = ingestRequestSchema.parse(await c.req.json())
    const result = await ingestSnapshots(c.env.DB, user.id, body.snapshots)
    return c.json(result)
  } catch (error) {
    return jsonError(c, error)
  }
})
