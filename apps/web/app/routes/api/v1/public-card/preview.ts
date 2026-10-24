import { createRoute } from 'honox/factory'
import { z } from 'zod'
import { requireSessionUser } from '../../../../features/auth/middleware'
import { parsePublicCardConfig } from '../../../../features/public-card/config'
import { renderUsageCardSvg } from '../../../../features/public-card/svg'
import { ApiError } from '../../../../lib/errors'
import { jsonError } from '../../../../lib/http'

// The envelope is validated here; the config's own fields are parsed by
// `parsePublicCardConfig`, which falls back to defaults the same way the stored
// settings do. Coercing a non-string display name with `String()` would render
// `[object Object]` into the preview instead of telling the client its body is
// wrong.
const previewRequestSchema = z.object({
  displayName: z.string().max(80).optional(),
  publicUrl: z.string().max(160).optional(),
  config: z.record(z.string(), z.unknown()).optional()
})

export const POST = createRoute(async (c) => {
  try {
    await requireSessionUser(c)
    // `c.req.json()` returns `null` for a literal `null` body and throws on malformed JSON.
    // Dereferencing a null body would raise a TypeError that lands on the 500 path; the client
    // sent a bad request, so reject it as one.
    const body = await c.req.json<unknown>()
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError('BAD_REQUEST', 'Invalid request body')
    }
    const request = previewRequestSchema.parse(body)
    const config = parsePublicCardConfig(request.config)
    const displayName = request.displayName || 'TokenBoard'
    const publicUrl = request.publicUrl || 'Private preview'

    const svg = renderUsageCardSvg(
      {
        displayName,
        publicUrl,
        totalTokens: 1234567,
        totalTokensWithoutCacheRead: 345678,
        totalCostUsd: 42.5,
        monthTokens: 89012,
        monthTokensWithoutCacheRead: 45678,
        monthCostUsd: 6.78,
        todayTokens: 1200,
        todayTokensWithoutCacheRead: 860,
        todayCostUsd: 0.2
      },
      config
    )

    return new Response(svg, {
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'no-store'
      }
    })
  } catch (error) {
    return jsonError(c, error)
  }
})
