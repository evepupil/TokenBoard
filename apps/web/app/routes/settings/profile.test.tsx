import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { defaultPublicCardConfig } from '../../features/public-card/config'
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
          publicMarkdown: '[![TokenBoard](https://tokenboard.example/api/public/example-long-public-slug.svg)](https://tokenboard.example)',
          publicCardConfig: defaultPublicCardConfig,
          profileNeedsRepair: true
        }}
      />
    )

    expect(html).toContain('lg:grid-cols-[minmax(22rem,0.8fr)_minmax(0,1.2fr)]')
    expect(html).toContain('items-start')
    expect(html).toContain('data-public-card-form="true"')
    expect(html).toContain('min-w-0 self-start')
    expect(html).toContain('grid-cols-[minmax(0,1fr)_auto]')
    expect(html.match(/class="[^"]*whitespace-pre-wrap[^"]*break-all[^"]*"/g)).toHaveLength(3)
    expect(html).toContain('data-timezone-input="true"')
    expect(html).toContain('data-timezone-default="UTC"')
    expect(html).toContain('data-timezone-autofill="true"')
    expect(html).toContain('README SVG 预览')
    expect(html).toContain('data-public-card-preview="true"')
    expect(html).toContain('data-public-card-public-url="https://tokenboard.example/api/public/example-long-public-slug.svg"')
    expect(html).toContain('w-full sm:w-auto')
    expect(html).toContain('>公开</span>')
    expect(html).toContain('README 卡片外观')
    expect(html).toContain('资料里有旧格式字段')
    expect(html).toContain('name="cardLanguage"')
    expect(html).toContain('name="cardMetric1"')
    expect(html).not.toContain('<select')
    expect(html).toContain('data-custom-select="true"')
    expect(html).toContain('data-custom-select-menu="true"')
    expect(html).toContain('还原默认卡片')
  })

  test('renders a private placeholder preview without requesting the public SVG', async () => {
    const html = await renderToString(
      <ProfilePage
        email="user@example.com"
        saved={false}
        profile={{
          displayName: 'Private User',
          slug: 'private-user',
          timezone: 'UTC',
          isPublic: false,
          participatesInLeaderboards: false,
          shouldUseBrowserTimezoneDefault: false,
          publicJsonUrl: 'https://tokenboard.example/api/public/private-user.json',
          publicSvgUrl: 'https://tokenboard.example/api/public/private-user.svg',
          publicMarkdown: '[![TokenBoard](https://tokenboard.example/api/public/private-user.svg)](https://tokenboard.example)',
          publicCardConfig: defaultPublicCardConfig
        }}
      />
    )

    expect(html).toContain('>私有预览</span>')
    expect(html).toContain('src="data:image/svg+xml;charset=utf-8,')
    expect(html).toContain('TokenBoard README SVG 预览')
    expect(html).toContain('Private%20preview')
  })
})
