import { createRoute } from 'honox/factory'
import { createAuth } from '../../../features/auth/auth'

export const GET = createRoute((c) => createAuth(c.env, c.req.raw).handler(c.req.raw))
export const POST = createRoute((c) => createAuth(c.env, c.req.raw).handler(c.req.raw))
