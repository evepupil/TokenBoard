import { z } from 'zod'
import { usageSnapshotSchema } from '@tokenboard/usage-core'

export const ingestRequestSchema = z.object({
  snapshots: z.array(usageSnapshotSchema).min(1).max(500)
})

export type IngestRequest = z.infer<typeof ingestRequestSchema>

