import { LogIn, ShieldCheck, Trophy } from 'lucide'
import { createRoute } from 'honox/factory'
import { AppNav } from '../../components/app-nav'
import { Button, LinkButton } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { GitHubMark, LucideIcon } from '../../components/ui/icon'
import { getOptionalUser } from '../../features/auth/middleware'
import { forwardGithubSignIn } from '../../features/auth/service'

export const GET = createRoute(async (c) => {
  const user = await getOptionalUser(c)
  if (user) return c.redirect('/dashboard')

  return c.render(<AuthScreen hasError={c.req.query('error') === 'github'} />)
})

export const POST = createRoute((c) => forwardGithubSignIn(c))

function AuthScreen(props: { hasError: boolean }) {
  return (
    <main class="min-h-screen bg-[var(--app-bg)] px-5 py-6 text-[var(--app-text)]">
      <title>登录 - TokenBoard</title>
      <AppNav isAuthenticated={false} />
      <section class="mx-auto grid min-h-[calc(100vh-7rem)] max-w-6xl items-center gap-8 lg:grid-cols-[1.05fr_0.95fr]">
        <div class="relative overflow-hidden rounded-xl border border-lime-200/10 bg-[radial-gradient(circle_at_20%_10%,rgba(190,242,100,.22),transparent_32%),linear-gradient(135deg,var(--app-panel-strong),var(--app-bg-soft))] p-8 shadow-2xl shadow-black/30">
          <div class="absolute -right-20 top-12 h-56 w-56 rounded-full border border-lime-300/20" />
          <p class="text-sm font-semibold uppercase tracking-[0.35em] text-lime-200">TokenBoard</p>
          <h1 class="mt-8 max-w-xl text-5xl font-black leading-none tracking-tight text-[var(--app-text)] md:text-7xl">
            你的 AI token 驾驶舱。
          </h1>
          <p class="mt-6 max-w-lg text-base leading-7 text-[var(--app-muted)]">
            使用 GitHub 登录，连接本地采集器，并只公开你明确允许展示的聚合 token 统计。
          </p>
          <div class="mt-10 grid gap-3 sm:grid-cols-3">
            <Panel icon={ShieldCheck} label="默认私有" value="0 prompt" />
            <Panel icon={LogIn} label="登录方式" value="GitHub OAuth" />
            <Panel icon={Trophy} label="排行榜" value="主动参与" />
          </div>
        </div>

        <Card class="p-6 backdrop-blur">
          <form method="post">
            <div class="mb-6 flex items-center justify-between gap-4">
              <div>
                <p class="text-sm text-lime-300">需要 GitHub 账号</p>
                <h2 class="mt-1 text-2xl font-bold">登录 TokenBoard</h2>
              </div>
              <LinkButton variant="secondary" size="sm" href="/">返回首页</LinkButton>
            </div>
            {props.hasError ? (
              <p class="mb-4 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100">
                GitHub 登录失败。请检查 OAuth 配置后重试。
              </p>
            ) : null}
            <Button class="w-full rounded-md" type="submit">
              <GitHubMark />
              使用 GitHub 继续
            </Button>
            <p class="mt-4 text-sm leading-6 text-[var(--app-muted)]">
              TokenBoard 只使用 GitHub 确认身份；采集端上传仍然使用每台设备独立的 upload token。
            </p>
          </form>
        </Card>
      </section>
    </main>
  )
}

function Panel(props: { icon: typeof ShieldCheck; label: string; value: string }) {
  return (
    <div class="rounded-md border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-4">
      <LucideIcon icon={props.icon} class="text-lime-200" />
      <p class="mt-3 text-xs uppercase tracking-wide text-[var(--app-muted)]">{props.label}</p>
      <p class="mt-2 text-lg font-bold text-[var(--app-text)]">{props.value}</p>
    </div>
  )
}
