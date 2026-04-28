import { createRoute } from 'honox/factory'
import { requireUser } from '../../../features/auth/middleware'
import { jsonError } from '../../../lib/http'

export const GET = createRoute(async (c) => {
  try {
    const user = await requireUser(c)
    return c.json({ user })
  } catch (error) {
    return jsonError(c, error)
  }
})
