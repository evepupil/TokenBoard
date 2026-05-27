import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { ProfilePage } from './profile'

describe('ProfilePage layout', () => {
  test('keeps long public links from collapsing the settings form column', async () => {
    const html = await renderToString(
      <ProfilePage
        email="user@example.com"
        saved={false}
        profile={{
          displayName: 'Example User',
          slug: 'example-long-public-slug',
          timezone: 'UTC',
          isPublic: true,
          participatesInLeaderboards: true,
          shouldUseBrowserTimezoneDefault: true,
          publicJsonUrl: 'https://tokenboard.example/api/public/example-long-public-slug.json',
          publicSvgUrl: 'https://tokenboard.example/api/public/example-long-public-slug.svg',
          publicMarkdown: '[![TokenBoard](https://tokenboard.example/api/public/example-long-public-slug.svg)](https://tokenboard.example)'
        }}
      />
    )

    expect(html).toContain('lg:grid-cols-[minmax(22rem,0.8fr)_minmax(0,1.2fr)]')
    expect(html.match(/class="[^"]*min-w-0[^"]*"/g)).toHaveLength(2)
    expect(html.match(/class="[^"]*whitespace-pre-wrap[^"]*break-all[^"]*"/g)).toHaveLength(3)
    expect(html).toContain('data-timezone-input="true"')
    expect(html).toContain('data-timezone-default="UTC"')
    expect(html).toContain('data-timezone-autofill="true"')
  })
})
