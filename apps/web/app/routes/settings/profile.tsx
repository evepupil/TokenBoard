import { createRoute } from 'honox/factory'
import { Copy } from 'lucide'
import { AppNav } from '../../components/app-nav'
import { Button, LinkButton } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { LucideIcon } from '../../components/ui/icon'
import { Input, Label } from '../../components/ui/input'
import { requireUser } from '../../features/auth/middleware'
import { PublicCardConfigEditor } from '../../features/public-card/components/card-config-editor'
import { settingsFormErrorMessage, settingsFormErrorCodeForRedirect } from '../../features/settings/errors'
import {
  getCanonicalPublicOrigin,
  getProfileSettings,
  parseProfilePageForm,
  updateProfilePageSettings,
  type ProfileSettings
} from '../../features/settings/service'
import { jsonError } from '../../lib/http'
import {
  findMismatchedUsageTimezones,
  listActiveUsageTimezones
} from '../../features/usage/queries/usage-timezone-scope'

export const GET = createRoute(async (c) => {
  const user = await requireUser(c)
  const publicOrigin = getCanonicalPublicOrigin({
    configuredOrigin: c.env.BETTER_AUTH_URL,
    requestOrigin: new URL(c.req.url).origin
  })
  const [profile, collectorTimezones] = await Promise.all([
    getProfileSettings(c.env.DB, user.id, publicOrigin),
    listActiveUsageTimezones(c.env.DB, user.id)
  ])
  return c.render(
    <ProfilePage
      profile={profile}
      saved={c.req.query('saved') === '1'}
      formError={settingsFormErrorMessage(c.req.query('error'))}
      email={user.email}
      collectorTimezones={collectorTimezones}
    />
  )
})

export const POST = createRoute(async (c) => {
  try {
    const user = await requireUser(c)
    const input = parseProfilePageForm(await c.req.parseBody())
    await updateProfilePageSettings(c.env.DB, user.id, input)
    return c.redirect('/settings/profile?saved=1', 303)
  } catch (error) {
    const formErrorCode = settingsFormErrorCodeForRedirect(error)
    if (formErrorCode) return c.redirect(`/settings/profile?error=${formErrorCode}`, 303)
    return jsonError(c, error)
  }
})

export function ProfilePage(props: {
  profile: ProfileSettings
  saved: boolean
  formError?: string
  email: string
  collectorTimezones?: string[]
}) {
  return (
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-8 sm:py-6">
      <title>公开资料 - TokenBoard</title>
      <AppNav active="profile" email={props.email} />

      <div class="app-folio-container space-y-8 pb-14">
        <header class="space-y-2">
          <p class="app-folio-kicker">07 — 公开资料与遥测卡片 · PUBLIC PROFILE</p>
          <h1 class="app-folio-h2">公开资料</h1>
        </header>

        <form
          method="post"
          class="app-folio-spread items-start"
          data-public-card-form="true"
          data-submit-feedback="true"
        >
          <div class="app-folio-spread-left min-w-0">
            <ProfileSettingsCard
              profile={props.profile}
              saved={props.saved}
              formError={props.formError}
              collectorTimezones={props.collectorTimezones}
            />
          </div>
          <div class="app-folio-spread-right min-w-0">
            <PublicLinksCard profile={props.profile} />
          </div>
        </form>
      </div>
    </main>
  )
}

function ProfileSettingsCard(props: {
  profile: ProfileSettings
  saved: boolean
  formError?: string
  collectorTimezones?: string[]
}) {
  return (
    <Card class="min-w-0 self-start">
      <CardHeader>
        <CardTitle class="text-xl sm:text-2xl">公开资料设置</CardTitle>
        <CardDescription>默认保持私有；只有开启公开后，JSON 和 SVG 才会返回真实统计。</CardDescription>
      </CardHeader>
      <CardContent>
        {props.saved ? <p class="app-flash-success mb-4 p-3 text-sm">设置已保存。</p> : null}
        {props.formError ? (
          <p class="app-flash-error mb-4 p-3 text-sm" role="alert">
            {props.formError}
          </p>
        ) : null}
        {props.profile.profileNeedsRepair ? (
          <p class="app-flash-error mb-4 p-3 text-sm">资料里有旧格式字段，请检查后保存一次。</p>
        ) : null}
        <ProfileSettingsFields profile={props.profile} collectorTimezones={props.collectorTimezones} />
      </CardContent>
    </Card>
  )
}

function ProfileSettingsFields(props: { profile: ProfileSettings; collectorTimezones?: string[] }) {
  return (
    <div class="space-y-4">
      <Label>
        显示名称
        <Input
          name="displayName"
          value={props.profile.displayName}
          autocomplete="name"
          required
          maxLength={80}
        />
      </Label>
      <ProfileSlugInput profile={props.profile} />
      <Label>
        时区
        <Input
          name="timezone"
          value={props.profile.timezone}
          autocomplete="off"
          required
          data-timezone-input="true"
          data-timezone-default={props.profile.timezone}
          data-timezone-autofill={props.profile.shouldUseBrowserTimezoneDefault ? 'true' : 'false'}
        />
      </Label>
      <CollectorTimezoneNotice timezone={props.profile.timezone} collectorTimezones={props.collectorTimezones} />
      <ProfileCheckbox name="isPublic" checked={props.profile.isPublic} title="公开 JSON / SVG">
        允许任何人通过公开链接查看你的聚合统计。
      </ProfileCheckbox>
      <ProfileCheckbox
        name="participatesInLeaderboards"
        checked={props.profile.participatesInLeaderboards}
        title="参与排行榜"
      >
        开启后会自动公开资料，排行榜才会统计你的数据。
      </ProfileCheckbox>
      <div class="flex flex-col gap-3 pt-2 sm:flex-row sm:flex-wrap">
        <Button class="w-full sm:w-auto" type="submit" data-submitting-label="正在保存...">
          保存设置
        </Button>
        <LinkButton class="w-full sm:w-auto" variant="secondary" href="/dashboard">
          返回控制台
        </LinkButton>
      </div>
    </div>
  )
}

function ProfileSlugInput(props: { profile: ProfileSettings }) {
  return (
    <Label>
      公开 slug
      <Input name="slug" value={props.profile.slug} autocomplete="off" required />
      <span class="mt-1 block font-mono text-xs normal-case text-[var(--app-subtle)]">
        只能使用小写字母、数字和连字符，长度 3-32。
      </span>
    </Label>
  )
}

function CollectorTimezoneNotice(props: { timezone: string; collectorTimezones?: string[] }) {
  const collectorTimezones = props.collectorTimezones ?? []
  if (collectorTimezones.length === 0) return null

  const stale = findMismatchedUsageTimezones(props.timezone, collectorTimezones)

  return (
    <p
      class="app-surface-subtle border border-[var(--app-border)] bg-[var(--app-bg-soft)] px-3 py-2 text-xs text-[var(--app-muted)]"
      data-timezone-collector-notice="true"
    >
      当前采集端按 {collectorTimezones.join('、')} 写入日期。
      {stale.length > 0
        ? `与这里的时区不一致时，控制台的「今日」会显示为 0；改动后请在「连接设备」页重新安装采集器。`
        : '修改此项不会同步到已安装的采集器，改动后请在「连接设备」页重新安装。'}{' '}
      <a class="app-accent-link font-bold underline underline-offset-4" href="/settings/install">
        去连接设备
      </a>
    </p>
  )
}

function ProfileCheckbox(props: { name: string; checked: boolean; title: string; children: string }) {
  return (
    <label class="app-surface-subtle flex items-start gap-3 border border-[var(--app-border)] bg-[var(--app-panel-strong)] p-3 text-sm text-[var(--app-muted)]">
      <input class="mt-1 accent-[var(--app-accent-bar)]" type="checkbox" name={props.name} checked={props.checked} />
      <span>
        <strong class="block text-[var(--app-text)]">{props.title}</strong>
        {props.children}
      </span>
    </label>
  )
}

function PublicLinksCard(props: { profile: ProfileSettings }) {
  return (
    <Card class="min-w-0">
      <CardHeader>
        <CardTitle>公开链接与 README SVG</CardTitle>
        <CardDescription>README SVG 卡片可以直接嵌入 GitHub 个人页或项目 README。</CardDescription>
      </CardHeader>
      <CardContent class="space-y-5">
        <CopyBlock label="Public JSON" value={props.profile.publicJsonUrl} targetId="public-json-url-text" />
        <CopyBlock label="README SVG" value={props.profile.publicSvgUrl} targetId="public-svg-url-text" />
        <CopyBlock label="Markdown" value={props.profile.publicMarkdown} targetId="public-markdown-text" />
        <PublicCardConfigEditor
          config={props.profile.publicCardConfig}
          isPublic={props.profile.isPublic}
          preview={{
            displayName: props.profile.displayName,
            publicUrl: props.profile.isPublic ? props.profile.publicSvgUrl : 'Private preview',
            totalTokens: 1234567,
            totalTokensWithoutCacheRead: 345678,
            totalCostUsd: 42.5,
            monthTokens: 89012,
            monthTokensWithoutCacheRead: 45678,
            monthCostUsd: 6.78,
            todayTokens: 1200,
            todayTokensWithoutCacheRead: 860,
            todayCostUsd: 0.2
          }}
        />
      </CardContent>
    </Card>
  )
}

function CopyBlock(props: { label: string; value: string; targetId: string }) {
  return (
    <div>
      <p class="mb-2 font-mono text-xs font-semibold uppercase tracking-wide text-[var(--app-muted)]">{props.label}</p>
      <div class="app-surface-subtle grid min-w-0 grid-cols-[minmax(0,1fr)_auto] overflow-hidden border border-[var(--app-border)] bg-[var(--app-panel-strong)]">
        <pre
          id={props.targetId}
          class="min-h-12 overflow-x-auto whitespace-pre-wrap break-all p-3 font-mono text-xs leading-6 text-[var(--app-text)]"
        >
          {props.value}
        </pre>
        <button
          type="button"
          class="inline-flex h-full min-h-12 w-12 items-center justify-center border-l border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-muted)] transition hover:bg-[var(--app-text)] hover:text-[var(--app-bg)] focus:outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--app-accent-bar)]"
          data-copy-target={props.targetId}
          aria-label={`复制 ${props.label}`}
          title={`复制 ${props.label}`}
        >
          <LucideIcon icon={Copy} size={16} />
        </button>
      </div>
    </div>
  )
}
