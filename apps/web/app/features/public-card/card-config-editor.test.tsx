import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { PublicCardConfigEditor } from './components/card-config-editor'
import { defaultPublicCardConfig } from './config'

// The preview status line is toggled with the `hidden` attribute, not the
// `hidden` utility class. The class sets display:none in the stylesheet and no
// script removes it, so a line carrying both would stay invisible after the
// attribute came off — the failure it reports would never be shown.

describe('PublicCardConfigEditor preview status line', () => {
  test('hides the status line with the attribute only, not the utility class', async () => {
    const html = await renderToString(
      <PublicCardConfigEditor
        config={defaultPublicCardConfig}
        isPublic={false}
        preview={{
          displayName: 'Example User',
          publicUrl: 'Private preview',
          totalTokens: 1,
          totalTokensWithoutCacheRead: 1,
          totalCostUsd: 0,
          monthTokens: 1,
          monthTokensWithoutCacheRead: 1,
          monthCostUsd: 0,
          todayTokens: 1,
          todayTokensWithoutCacheRead: 1,
          todayCostUsd: 0
        }}
      />
    )

    const statusLine = html.match(/<p[^>]*data-public-card-preview-status[^>]*>/)?.[0] ?? ''
    expect(statusLine).not.toBe('')
    expect(statusLine).toContain('hidden')
    expect(statusLine).toContain('role="status"')
    // The class list must not carry the utility class: assert on the class
    // attribute's tokens rather than the whole tag, which also holds the word
    // "hidden" for the attribute itself.
    const classes = statusLine.match(/class="([^"]*)"/)?.[1].split(/\s+/) ?? []
    expect(classes).not.toContain('hidden')
  })
})
