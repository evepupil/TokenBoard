import { createRoute } from 'honox/factory'
import { AppNav } from '../../components/app-nav'
import { GitHubMark } from '../../components/ui/icon'
import { getOptionalUser } from '../../features/auth/middleware'
import { forwardGithubSignIn } from '../../features/auth/service'

const githubLoginBenefits = [
  {
    index: '01',
    title: '不上传对话正文',
    description: '采集器只在本地读取用量统计，只上传 token、模型、日期与会话汇总。'
  },
  {
    index: '02',
    title: '每台设备使用独立上传令牌',
    description: '多台机器各自配对上报，换机或停用时可单独撤销，不影响其他设备。'
  },
  {
    index: '03',
    title: '随时管理公开资料与卡片',
    description: '公开主页、排行榜可见性与 README SVG 卡片都在个人设置里集中控制。'
  }
]

export const GET = createRoute(async (c) => {
  c.header('Cache-Control', 'no-store')

  const user = await getOptionalUser(c)
  if (user) {
    return c.redirect('/dashboard')
  }

  const error = c.req.query('error')

  return c.render(
    <main class="min-h-screen bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-8 sm:py-6">
      <title>登录 - TokenBoard</title>
      <AppNav isAuthenticated={false} />

      <section class="app-folio-container pb-14">
        <div class="app-folio-spread items-start">
          <div class="app-folio-spread-left order-2 min-w-0 lg:order-1">
            <p class="app-folio-kicker">01 — 身份认证 · GITHUB OAUTH</p>
            <h1 class="app-folio-h2 mt-4 max-w-full [overflow-wrap:anywhere] sm:max-w-2xl">
              连接你的 <span class="whitespace-nowrap">AI token</span> 统计与公开卡片。
            </h1>
            <div class="mt-6 border-t border-[var(--app-border-strong)] pt-5">
              <p class="max-w-xl text-base leading-7 text-[var(--app-muted)]">
                TokenBoard 仅使用 GitHub OAuth 登录。登录后即可生成本机安装提示词、查看每日明细，并配置可嵌入 README 的
                SVG 遥测卡片。
              </p>
            </div>
            <ol
              class="mt-8 divide-y divide-[var(--app-border)] border-y border-[var(--app-border)]"
              data-auth-benefits="true"
            >
              {githubLoginBenefits.map((benefit) => (
                <li class="flex items-start gap-4 py-4">
                  <span class="font-mono text-xs font-bold text-[var(--app-accent)]">{benefit.index}</span>
                  <div class="min-w-0">
                    <p class="text-sm font-bold text-[var(--app-text)]">{benefit.title}</p>
                    <p class="mt-1 text-sm leading-6 text-[var(--app-muted)]">{benefit.description}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div class="app-folio-spread-right order-1 min-w-0 lg:order-2">
            <section class="app-login-card order-1 border border-[var(--app-border-strong)] bg-[var(--app-panel-strong)]">
              <div data-login-card="true" tabindex={-1}>
                <div class="border-b border-[var(--app-border)] px-6 py-5">
                  <p class="app-folio-kicker">AUTH // GITHUB</p>
                  <h2 class="mt-1.5 text-xl font-extrabold tracking-tight">使用 GitHub 登录</h2>
                  <p class="mt-1.5 text-sm leading-6 text-[var(--app-muted)]">
                    无需创建密码，直接使用 GitHub 账号同步你的个人控制台与设备列表。
                  </p>
                </div>
                <div class="space-y-4 p-6">
                  {error ? (
                    <p class="app-flash-error p-3 text-sm" role="alert">
                      GitHub 登录失败。请检查 OAuth 配置后重试。
                    </p>
                  ) : null}
                  <form method="post" action="/auth/sign-in" data-submit-feedback="true">
                    <button
                      class="inline-flex min-h-12 w-full items-center justify-center gap-3 border border-[var(--app-border-strong)] bg-[var(--app-text)] px-5 py-3 text-sm font-bold text-[var(--app-bg)] transition hover:border-[var(--app-accent-bar)] hover:bg-[var(--app-accent-bar)] hover:text-[var(--app-accent-bar-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent-bar)]"
                      type="submit"
                      data-login-primary="true"
                      data-submitting-label="正在跳转 GitHub..."
                    >
                      <GitHubMark size={18} />
                      使用 GitHub 继续 →
                    </button>
                  </form>
                  <div class="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--app-border)] pt-3 text-xs text-[var(--app-muted)] max-[359px]:flex-col max-[359px]:items-start">
                    <span>首次登录会自动初始化个人资料</span>
                    <a class="app-accent-link font-mono font-bold underline underline-offset-4" href="/leaderboards">
                      先看排行榜 →
                    </a>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </section>
    </main>
  )
})

export const POST = createRoute((c) => forwardGithubSignIn(c))
