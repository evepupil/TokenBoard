import { KeyRound, ShieldCheck, Upload, type IconNode } from 'lucide'
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
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
      <title>登录 - TokenBoard</title>
      <AppNav isAuthenticated={false} />
      <section class="mx-auto grid min-h-[calc(100vh-7rem)] max-w-5xl items-center gap-8 py-8 sm:gap-10 sm:py-10 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,26rem)] lg:gap-12">
        <div class="order-2 min-w-0 lg:order-1">
          <p class="app-accent-text text-sm font-semibold uppercase tracking-[0.28em]">TokenBoard</p>
          <h1 class="mt-4 max-w-xl text-3xl font-black leading-tight text-balance text-[var(--app-text)] sm:text-4xl">
            管理你的 <span class="whitespace-nowrap">AI token</span> 用量。
          </h1>
          <p class="mt-4 max-w-xl text-base leading-7 text-pretty text-[var(--app-muted)]">
            连接本机采集器，按日期、来源和模型查看聚合后的使用数据。
          </p>
          <dl
            class="mt-8 max-w-xl divide-y divide-[var(--app-border)] border-y border-[var(--app-border)]"
            data-auth-benefits="true"
          >
            <AuthBenefit
              icon={ShieldCheck}
              title="使用数据默认私有"
              description="不上传对话正文；公开范围由你主动开启。"
            />
            <AuthBenefit icon={KeyRound} title="GitHub 只用于登录" description="采集器不会使用你的网页登录会话。" />
            <AuthBenefit icon={Upload} title="设备独立上传" description="每台设备使用独立上传令牌，便于单独管理。" />
          </dl>
        </div>

        <Card class="app-login-card order-1 w-full p-5 sm:p-6 lg:order-2" data-login-card="true">
          <form method="post" data-submit-feedback="true">
            <div class="mb-6 flex items-start justify-between gap-4 max-[359px]:flex-col max-[359px]:gap-3">
              <div>
                <p class="app-accent-text text-sm font-semibold">安全登录</p>
                <h2 class="mt-1 text-2xl font-black">登录 TokenBoard</h2>
              </div>
              <LinkButton class="max-[359px]:self-start" variant="secondary" size="sm" href="/">
                返回首页
              </LinkButton>
            </div>
            {props.hasError ? (
              <p class="app-flash-error mb-4 p-3 text-sm" role="alert">
                GitHub 登录失败。请检查 OAuth 配置后重试。
              </p>
            ) : null}
            <Button class="w-full" type="submit" data-login-primary="true" data-submitting-label="正在跳转 GitHub...">
              <GitHubMark />
              使用 GitHub 继续
            </Button>
            <p class="mt-4 text-sm leading-6 text-[var(--app-muted)]">
              GitHub 仅用于确认身份。本机采集器使用每台设备独立的上传令牌。
            </p>
          </form>
        </Card>
      </section>
    </main>
  )
}

function AuthBenefit(props: { icon: IconNode; title: string; description: string }) {
  return (
    <div class="py-4 first:pt-0 last:pb-0">
      <dt class="flex items-center gap-3 text-sm font-bold text-[var(--app-text)]">
        <LucideIcon icon={props.icon} class="app-accent-text" size={18} />
        {props.title}
      </dt>
      <dd class="mt-1 pl-[30px] text-sm leading-6 text-[var(--app-muted)]">{props.description}</dd>
    </div>
  )
}
