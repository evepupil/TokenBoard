import { createRoute } from 'honox/factory'
import { serverVersion } from '../../../lib/version'

export const GET = createRoute((c) => {
  // A health probe that an intermediary can cache reports a stale verdict: the endpoint
  // would keep answering "ok" after the deployment behind it stopped being healthy.
  c.header('Cache-Control', 'no-store')
  // The version rides along so a probe can also answer "which deployment is behind this
  // URL" — the question that took a static-asset hash comparison to settle once.
  return c.json({ ok: true, name: 'TokenBoard', version: serverVersion })
})
