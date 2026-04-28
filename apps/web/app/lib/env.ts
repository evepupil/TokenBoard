import { z } from 'zod'

export const workerEnvSchema = z.object({
  DB: z.custom<D1Database>()
})

export type WorkerEnv = z.infer<typeof workerEnvSchema>

