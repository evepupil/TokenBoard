import { createRoute } from 'honox/factory'
import { ingestRequestSchema } from '../../../features/ingest/schema'
import { ingestSnapshots } from '../../../features/ingest/service'
import { jsonError } from '../../../lib/http'

export const POST = createRoute(async (c) => {
  try {
    const body = ingestRequestSchema.parse(await c.req.json())
    const result = await ingestSnapshots('placeholder-user', body.snapshots)
    return c.json(result)
  } catch (error) {
    return jsonError(c, error)
  }
})

