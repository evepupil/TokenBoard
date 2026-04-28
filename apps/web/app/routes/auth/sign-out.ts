import { createRoute } from 'honox/factory'
import { forwardAuthSignOut } from '../../features/auth/service'

export const POST = createRoute((c) => forwardAuthSignOut(c))
