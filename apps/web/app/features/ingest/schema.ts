import { z } from 'zod'
import { uploadIsoDateIssue, usageModelSchema, usageSnapshotSchema, usageSourceSchema } from '@tokenboard/usage-core'

export const maxIngestSnapshotBatchSize = 500
export const maxSnapshotCheckBatchSize = maxIngestSnapshotBatchSize

// `usageSnapshotSchema` is shared with the collector and validates only the calendar shape of
// a date — a client-side clock is not this server's clock to judge. The window applies here,
// where an upload becomes stored rows: a date beyond the server's today plus a day is not a
// day that has happened, and one before any AI coding tool existed is not a day a collector
// could have measured. Either would land in rows no dashboard or leaderboard window ever
// displays. The message names the bound so a reader of the validation error can see which side
// the date fell on; the API response itself stays a generic 400 (see `jsonError`), so this is
// for diagnostics, not a machine-readable signal.
function uploadUsageDateIssue(value: string) {
  const issue = uploadIsoDateIssue(value)
  if (issue === 'invalid') return 'Invalid ISO date'
  if (issue === 'too-far-future') return 'usageDate too far in the future'
  if (issue === 'before-history-window') return 'usageDate before the supported history window'
  return null
}

const uploadUsageDateSchema = z.string().superRefine((value, ctx) => {
  const message = uploadUsageDateIssue(value)
  if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message })
})

export const ingestRequestSchema = z
  .object({
    snapshots: z.array(usageSnapshotSchema).min(0).max(maxIngestSnapshotBatchSize)
  })
  .superRefine((request, ctx) => {
    request.snapshots.forEach((snapshot, index) => {
      // `usageSnapshotSchema.usageDate` already rejects a malformed date with its own issue, so
      // only the window bounds are added here. Reporting `invalid` again would put two identical
      // issues at the same path — harmless in the response body, which `jsonError` collapses to
      // a generic 400, but noise for anyone reading `error.issues` and a sign the two checks
      // disagree.
      if (uploadIsoDateIssue(snapshot.usageDate) === null) return
      const message = uploadUsageDateIssue(snapshot.usageDate)
      if (!message || message === 'Invalid ISO date') return
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshots', index, 'usageDate'],
        message
      })
    })
  })

export const snapshotCheckRequestSchema = z.object({
  keys: z
    .array(
      z.object({
        source: usageSourceSchema,
        usageDate: uploadUsageDateSchema,
        model: usageModelSchema
      })
    )
    .min(1)
    .max(maxSnapshotCheckBatchSize)
})
