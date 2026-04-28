import { createRoute } from 'honox/factory'
import { D1DevicePairingRepository } from '../../../../features/device/repository'
import { createPairingCode, createPairingCodeDeps } from '../../../../features/device/service'
import { jsonError } from '../../../../lib/http'

export const POST = createRoute(async (c) => {
  try {
    const repository = new D1DevicePairingRepository(c.env.DB)
    // Temporary bootstrap path until Better Auth user sessions are wired in.
    const result = await createPairingCode(
      repository,
      c.env.SEED_USER_ID,
      createPairingCodeDeps()
    )
    const baseUrl = new URL(c.req.url).origin

    return c.json({
      ...result,
      baseUrl
    })
  } catch (error) {
    return jsonError(c, error)
  }
})
