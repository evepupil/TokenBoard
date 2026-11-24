import { createRoute } from 'honox/factory'
import { clientVersion, serverVersion } from '../../../lib/version'

// Machine-readable version identity: who answers this request (serverVersion) and which
// client build the deployment is paired with (clientVersion). Not cached: a version that
// lags behind the deployment is worse than no version at all, and the payload is two
// strings.
export const GET = createRoute((c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({ serverVersion, clientVersion })
})
