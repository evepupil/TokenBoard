import { createRoute } from 'honox/factory'
import { Button, LinkButton } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Input, Label } from '../../components/ui/input'
import { requireUser } from '../../features/auth/middleware'
import { getProfileSettings, parseProfileForm, updateProfileSettings, type ProfileSettings } from '../../features/settings/service'
import { jsonError } from '../../lib/http'

export const GET = createRoute(async (c) => {
  try {
    const user = await requireUser(c)
    const profile = await getProfileSettings(c.env.DB, user.id, new URL(c.req.url).origin)
    return c.render(<ProfilePage profile={profile} saved={c.req.query('saved') === '1'} />)
  } catch (error) {
    return jsonError(c, error)
  }
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

function ProfilePage(props: { profile: ProfileSettings; saved: boolean }) {
  return (
    <main class="min-h-screen bg-[#10130f] px-5 py-6 text-stone-50">
      <title>公开资料 - TokenBoard</title>
      <nav class="mx-auto mb-6 flex max-w-6xl flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-800 bg-stone-950/75 px-4 py-3">
        <a class="font-black tracking-tight text-lime-200" href="/dashboard">TokenBoard</a>
        <div class="flex flex-wrap items-center gap-2 text-sm text-stone-300">
          <a class="rounded-md px-3 py-1.5 hover:bg-stone-800" href="/dashboard">控制台</a>
          <a class="rounded-md px-3 py-1.5 hover:bg-stone-800" href="/settings/install">安装采集器</a>
          <a class="rounded-md px-3 py-1.5 hover:bg-stone-800" href="/leaderboards">排行榜</a>
        </div>
      </nav>

      <section class="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle class="text-3xl">公开资料设置</CardTitle>
            <CardDescription>默认保持私有；只有开启公开后，JSON 和 SVG 才会返回真实统计。</CardDescription>
          </CardHeader>
          <CardContent>
            {props.saved ? (
              <p class="mb-4 rounded-md border border-lime-300/30 bg-lime-300/10 p-3 text-sm text-lime-100">设置已保存。</p>
            ) : null}
            <form method="post" class="space-y-4">
              <Label>
                显示名称
                <Input name="displayName" value={props.profile.displayName} required />
              </Label>
              <Label>
                公开 slug
                <Input name="slug" value={props.profile.slug} required />
                <span class="mt-1 block text-xs text-stone-500">只能使用小写字母、数字和连字符，长度 3-32。</span>
              </Label>
              <Label>
                时区
                <Input name="timezone" value={props.profile.timezone} required />
              </Label>
              <label class="flex items-start gap-3 rounded-md border border-stone-800 bg-stone-900/60 p-3 text-sm text-stone-300">
                <input class="mt-1" type="checkbox" name="isPublic" checked={props.profile.isPublic} />
                <span>
                  <strong class="block text-stone-100">公开 JSON / SVG</strong>
                  允许任何人通过公开链接查看你的聚合统计。
                </span>
              </label>
              <label class="flex items-start gap-3 rounded-md border border-stone-800 bg-stone-900/60 p-3 text-sm text-stone-300">
                <input class="mt-1" type="checkbox" name="participatesInLeaderboards" checked={props.profile.participatesInLeaderboards} />
                <span>
                  <strong class="block text-stone-100">参与排行榜</strong>
                  只有公开资料开启后，排行榜才会统计你的数据。
                </span>
              </label>
              <div class="flex flex-wrap gap-3 pt-2">
                <Button type="submit">保存设置</Button>
                <LinkButton variant="secondary" href="/dashboard">返回控制台</LinkButton>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>公开链接</CardTitle>
            <CardDescription>README SVG 卡片可以直接嵌入 GitHub 个人页或项目 README。</CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <CopyBlock label="Public JSON" value={props.profile.publicJsonUrl} />
            <CopyBlock label="README SVG" value={props.profile.publicSvgUrl} />
            <CopyBlock label="Markdown" value={`![TokenBoard](${props.profile.publicSvgUrl})`} />
          </CardContent>
        </Card>
      </section>
    </main>
  )
}

function CopyBlock(props: { label: string; value: string }) {
  return (
    <div>
      <p class="mb-2 text-sm font-bold text-stone-300">{props.label}</p>
      <pre class="overflow-x-auto rounded-md border border-stone-800 bg-stone-900 p-3 text-sm text-stone-200">{props.value}</pre>
    </div>
  )
}
