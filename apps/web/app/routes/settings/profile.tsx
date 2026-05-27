import { createRoute } from 'honox/factory'
import { Copy } from 'lucide'
import { AppNav } from '../../components/app-nav'
import { Button, LinkButton } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { LucideIcon } from '../../components/ui/icon'
import { Input, Label } from '../../components/ui/input'
import { requireUser } from '../../features/auth/middleware'
import { getCanonicalPublicOrigin, getProfileSettings, parseProfileForm, updateProfileSettings, type ProfileSettings } from '../../features/settings/service'
import { jsonError } from '../../lib/http'

export const GET = createRoute(async (c) => {
  const user = await requireUser(c)
  const publicOrigin = getCanonicalPublicOrigin({
    configuredOrigin: c.env.BETTER_AUTH_URL,
    requestOrigin: new URL(c.req.url).origin
  })
  const profile = await getProfileSettings(c.env.DB, user.id, publicOrigin)
  return c.render(<ProfilePage profile={profile} saved={c.req.query('saved') === '1'} email={user.email} />)
})

export const POST = createRoute(async (c) => {
  try {
    const user = await requireUser(c)
    const input = parseProfileForm(await c.req.parseBody())
    await updateProfileSettings(c.env.DB, user.id, input)
    return c.redirect('/settings/profile?saved=1', 303)
  } catch (error) {
    return jsonError(c, error)
  }
})

export function ProfilePage(props: { profile: ProfileSettings; saved: boolean; email: string }) {
  return (
    <main class="min-h-screen bg-[var(--app-bg)] px-5 py-6 text-[var(--app-text)]">
      <title>公开资料 - TokenBoard</title>
      <AppNav active="profile" email={props.email} />

      <section class="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(22rem,0.8fr)_minmax(0,1.2fr)]">
        <ProfileSettingsCard profile={props.profile} saved={props.saved} />
        <PublicLinksCard profile={props.profile} />
      </section>
    </main>
  )
}

function ProfileSettingsCard(props: { profile: ProfileSettings; saved: boolean }) {
  return (
    <Card class="min-w-0">
      <CardHeader>
        <CardTitle class="text-3xl">公开资料设置</CardTitle>
        <CardDescription>默认保持私有；只有开启公开后，JSON 和 SVG 才会返回真实统计。</CardDescription>
      </CardHeader>
      <CardContent>
        {props.saved ? (
          <p class="mb-4 rounded-md border border-lime-300/30 bg-lime-300/10 p-3 text-sm text-lime-100">设置已保存。</p>
        ) : null}
        <ProfileSettingsForm profile={props.profile} />
      </CardContent>
    </Card>
  )
}

function ProfileSettingsForm(props: { profile: ProfileSettings }) {
  return (
    <form method="post" class="space-y-4">
      <Label>
        显示名称
        <Input name="displayName" value={props.profile.displayName} required />
      </Label>
      <ProfileSlugInput profile={props.profile} />
      <Label>
        时区
        <Input
          name="timezone"
          value={props.profile.timezone}
          required
          data-timezone-input="true"
          data-timezone-default={props.profile.timezone}
          data-timezone-autofill={props.profile.shouldUseBrowserTimezoneDefault ? 'true' : 'false'}
        />
      </Label>
      <ProfileCheckbox name="isPublic" checked={props.profile.isPublic} title="公开 JSON / SVG">
        允许任何人通过公开链接查看你的聚合统计。
      </ProfileCheckbox>
      <ProfileCheckbox name="participatesInLeaderboards" checked={props.profile.participatesInLeaderboards} title="参与排行榜">
        开启后会自动公开资料，排行榜才会统计你的数据。
      </ProfileCheckbox>
      <div class="flex flex-wrap gap-3 pt-2">
        <Button type="submit">保存设置</Button>
        <LinkButton variant="secondary" href="/dashboard">返回控制台</LinkButton>
      </div>
    </form>
  )
}

function ProfileSlugInput(props: { profile: ProfileSettings }) {
  return (
    <Label>
      公开 slug
      <Input name="slug" value={props.profile.slug} required />
      <span class="mt-1 block text-xs text-[var(--app-muted)]">只能使用小写字母、数字和连字符，长度 3-32。</span>
    </Label>
  )
}

function ProfileCheckbox(props: {
  name: string
  checked: boolean
  title: string
  children: string
}) {
  return (
    <label class="flex items-start gap-3 rounded-md border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-3 text-sm text-[var(--app-muted)]">
      <input class="mt-1" type="checkbox" name={props.name} checked={props.checked} />
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
        <CardTitle>公开链接</CardTitle>
        <CardDescription>README SVG 卡片可以直接嵌入 GitHub 个人页或项目 README。</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <CopyBlock label="Public JSON" value={props.profile.publicJsonUrl} targetId="public-json-url-text" />
        <CopyBlock label="README SVG" value={props.profile.publicSvgUrl} targetId="public-svg-url-text" />
        <CopyBlock label="Markdown" value={props.profile.publicMarkdown} targetId="public-markdown-text" />
      </CardContent>
    </Card>
  )
}

function CopyBlock(props: { label: string; value: string; targetId: string }) {
  return (
    <div>
      <p class="mb-2 text-sm font-bold text-[var(--app-muted)]">{props.label}</p>
      <div class="relative">
        <button
          type="button"
          class="absolute right-3 top-3 inline-flex h-11 w-11 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-muted)] shadow-sm transition hover:border-lime-300/50 hover:text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-lime-300/30"
          data-copy-target={props.targetId}
          aria-label={`复制 ${props.label}`}
          title={`复制 ${props.label}`}
        >
          <LucideIcon icon={Copy} size={17} />
        </button>
        <pre id={props.targetId} class="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-3 pr-16 text-sm text-[var(--app-text)]">{props.value}</pre>
      </div>
    </div>
  )
}
