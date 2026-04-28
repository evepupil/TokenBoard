import { z } from 'zod'

export const devicePairRequestSchema = z.object({
  pairingCode: z.string().min(8),
  deviceName: z.string().min(1).max(80).optional(),
  platform: z.string().min(1).max(40).optional(),
  timezone: z.string().min(1).max(80).optional()
})

export type DevicePairRequest = z.infer<typeof devicePairRequestSchema>

