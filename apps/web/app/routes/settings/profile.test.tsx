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
          publicMarkdown:
            '[![TokenBoard](https://tokenboard.example/api/public/example-long-public-slug.svg)](https://tokenboard.example)',
          publicCardConfig: defaultPublicCardConfig,
          profileNeedsRepair: true
        }}
      />
    )

    expect(html).toContain('app-folio-spread')
    expect(html).toContain('data-public-card-form="true"')
    expect(html).toContain('data-submit-feedback="true"')
    expect(html).toContain('data-submitting-label="正在保存..."')
    expect(html).toContain('>公开资料</h1>')
    expect(html).toContain('>公开资料设置</h2>')
    expect(html).toContain('data-submitting-label="正在还原..."')
    expect(html).toContain('data-link-button="true"')
    expect(html).toContain('min-w-0 self-start')
    expect(html).toContain('grid-cols-[minmax(0,1fr)_auto]')
    expect(html).toContain('grid min-w-0')
    expect(html.match(/class="[^"]*whitespace-pre-wrap[^"]*break-all[^"]*"/g)).toHaveLength(3)
    expect(html).toContain('data-timezone-input="true"')
    expect(html).toContain('data-timezone-default="UTC"')
    expect(html).toContain('data-timezone-autofill="true"')
    expect(html).toContain('name="displayName"')
    expect(html).toContain('autocomplete="name"')
    expect(html).toContain('name="slug"')
    expect(html).toContain('autocomplete="off"')
    expect(html).toContain('README SVG 预览')
    expect(html).toContain('overflow-hidden border')
    expect(html).toContain('data-public-card-preview="true"')
    expect(html).toContain(
      'data-public-card-public-url="https://tokenboard.example/api/public/example-long-public-slug.svg"'
    )
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
          publicMarkdown:
            '[![TokenBoard](https://tokenboard.example/api/public/private-user.svg)](https://tokenboard.example)',
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

// This is the moment the split is created. Saving here writes only the profile; the collector's
// zone was frozen into its config at install time and nothing propagates the change to it. The
// user has no way to know that from the form, so the consequence has to be stated where the
// change is made rather than only afterwards on the dashboard, where it looks like a quiet day.
describe('ProfilePage timezone consequence', () => {
  test('says that changing the zone requires reinstalling the collector', async () => {
    const html = await renderToString(
      <ProfilePage email="user@example.com" saved={false} profile={profile()} collectorTimezones={['UTC']} />
    )

    expect(html).toContain('data-timezone-collector-notice="true"')
    expect(html).toContain('/settings/install')
  })

  // The dashboard uses the canonical comparison; the profile page must agree, or the two
  // surfaces tell opposite stories about the same install ("UTC" vs "Etc/UTC").
  test('does not flag a collector zone that is an alias of the profile zone', async () => {
    const html = await renderToString(
      <ProfilePage email="user@example.com" saved={false} profile={profile()} collectorTimezones={['Etc/UTC']} />
    )

    expect(html).toContain('data-timezone-collector-notice="true"')
    expect(html).not.toContain('与这里的时区不一致')
  })

  test('does not tell a user with no devices to reinstall anything', async () => {
    const html = await renderToString(
      <ProfilePage email="user@example.com" saved={false} profile={profile()} collectorTimezones={[]} />
    )

    expect(html).not.toContain('data-timezone-collector-notice="true"')
  })

  test('names the zone a collector is still using', async () => {
    const html = await renderToString(
      <ProfilePage email="user@example.com" saved={false} profile={profile()} collectorTimezones={['Asia/Shanghai']} />
    )

    expect(html).toContain('Asia/Shanghai')
    // The positive half of the canonical comparison: a zone that is really
    // different (no alias folds UTC onto Asia/Shanghai) must render the
    // mismatch sentence, or the alias test above proves only that nothing is
    // ever flagged.
    expect(html).toContain('与这里的时区不一致')
  })

  // The freshness stamp is a stored card option; the settings page is the only
  // way to reach it, so the control has to be on the page users find.
  // The preview is a data URI rendered from the server; there is no network request to
  // defer, so `loading="lazy"` bought nothing and earned a DevTools complaint. The explicit
  // width/height stay: they are what keeps the layout stable when the live preview swaps
  // the source.
  test('renders the card preview without lazy loading', async () => {
    const html = await renderToString(<ProfilePage email="user@example.com" saved={false} profile={profile()} />)

    const img = html.match(/<img[^>]*data-public-card-preview="true"[^>]*>/)?.[0]
    expect(img).toBeDefined()
    expect(img).not.toContain('loading="lazy"')
    expect(img).toContain('width="520"')
    expect(img).toContain('height="220"')
  })

  test('offers the data-updated stamp, off by default', async () => {
    const html = await renderToString(<ProfilePage email="user@example.com" saved={false} profile={profile()} />)

    expect(html).toContain('name="cardShowUpdatedAt"')
    expect(html).toContain('显示数据更新时间')
    // defaultPublicCardConfig.showUpdatedAt === false, so the checkbox renders
    // without the checked attribute: opting in is the user's click, never the
    // page's default.
    const tag = html.match(/<input[^>]*name="cardShowUpdatedAt"[^>]*>/)?.[0]
    expect(tag).toBeDefined()
    expect(tag).not.toContain('checked')
  })
})

describe('ProfilePage form errors', () => {
  test('renders the failure the redirect carried back', async () => {
    const html = await renderToString(
      <ProfilePage
        email="user@example.com"
        saved={false}
        formError="这个 slug 已被占用，请换一个。"
        profile={profile()}
      />
    )

    expect(html).toContain('这个 slug 已被占用，请换一个。')
    expect(html).toContain('role="alert"')
  })

  test('renders no alert when there is no error', async () => {
    const html = await renderToString(<ProfilePage email="user@example.com" saved={false} profile={profile()} />)

    expect(html).not.toContain('role="alert"')
  })
})

function profile() {
  return {
    displayName: 'Example User',
    slug: 'example-user',
    timezone: 'UTC',
    isPublic: false,
    participatesInLeaderboards: false,
    shouldUseBrowserTimezoneDefault: false,
    publicJsonUrl: 'https://tokenboard.example/api/public/example-user.json',
    publicSvgUrl: 'https://tokenboard.example/api/public/example-user.svg',
    publicMarkdown:
      '[![TokenBoard](https://tokenboard.example/api/public/example-user.svg)](https://tokenboard.example)',
    publicCardConfig: defaultPublicCardConfig
  }
}
