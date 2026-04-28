import { createRoute } from 'honox/factory'
import { D1DevicePairingRepository } from '../../../../features/device/repository'
import { devicePairRequestSchema } from '../../../../features/device/schema'
import { createPairDeviceDeps, pairDevice } from '../../../../features/device/service'
import { jsonError } from '../../../../lib/http'

export const POST = createRoute(async (c) => {
  try {
    const request = devicePairRequestSchema.parse(await c.req.json())
    const repository = new D1DevicePairingRepository(c.env.DB)
    const endpoint = new URL('/api/v1/ingest', c.req.url).toString()
    const result = await pairDevice(repository, request, createPairDeviceDeps(endpoint))
    return c.json(result)
  } catch (error) {
    return jsonError(c, error)
  }
})

