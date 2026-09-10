import { createRoute } from 'honox/factory'
import { AppNav } from '../components/app-nav'
import { getOptionalUser } from '../features/auth/middleware'

export default createRoute(async (c) => {
  const user = await getOptionalUser(c)
  if (user) return c.redirect('/dashboard')

  return c.render(
    <main class="min-h-screen overflow-hidden bg-[var(--app-bg)] px-4 py-4 text-[var(--app-text)] sm:px-5 sm:py-6">
      <title>TokenBoard</title>
      <AppNav isAuthenticated={false} />
      <section class="relative mx-auto grid min-h-[calc(100vh-7rem)] w-full min-w-0 max-w-7xl grid-cols-[minmax(0,1fr)] items-center gap-8 py-8 sm:gap-10 sm:py-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <div class="absolute left-8 top-8 h-24 w-24 rounded-full bg-lime-300 blur-3xl" />
        <div class="relative z-10 min-w-0">
          <p class="text-sm font-black uppercase tracking-[0.45em] text-[var(--app-muted)]">TokenBoard</p>
          <h1 class="mt-8 max-w-full text-4xl font-black leading-[0.95] tracking-tight [overflow-wrap:anywhere] sm:max-w-4xl sm:text-5xl md:text-8xl">
            为分享而生的 AI 用量面板。
          </h1>
          <p class="mt-6 max-w-full text-lg leading-8 text-[var(--app-muted)] [overflow-wrap:anywhere] sm:max-w-2xl">
            连接本机 Claude Code、Codex 与 Antigravity 采集器，只上传聚合后的 token 指标，并由你决定哪些视图可以公开。
          </p>
          <div class="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <a
              class="inline-flex min-h-11 items-center justify-center rounded-xl bg-lime-300 px-5 py-3 text-sm font-black text-stone-950 transition hover:bg-lime-200"
              href="/auth/sign-in"
            >
              使用 GitHub 登录
            </a>
            <a
              class="inline-flex min-h-11 items-center justify-center rounded-xl border border-[var(--app-border)] px-5 py-3 text-sm font-bold text-[var(--app-text)] transition hover:border-lime-300"
              href="/leaderboards"
            >
              查看排行榜
            </a>
          </div>
        </div>
        <div class="app-surface-floating relative z-10 min-w-0 max-w-full overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-strong)] p-5 text-[var(--app-text)]">
          <div class="grid gap-3 sm:grid-cols-2">
            <Metric label="今日 tokens" value="128,420" />
            <Metric label="不含缓存读" value="97,850" />
            <Metric label="本月费用" value="$42.31" />
            <Metric label="主要模型" value="gpt-5.4" />
          </div>
          <div class="app-surface-subtle mt-4 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-4">
            <div class="mb-4 flex items-center justify-between text-sm">
              <span class="app-accent-text font-bold">来源占比</span>
              <span class="text-[var(--app-muted)]">最近 30 天</span>
            </div>
            <div class="flex h-4 overflow-hidden rounded-full bg-[var(--app-border)]">
              <div class="h-full bg-lime-300" style="width:55%" />
              <div class="h-full bg-lime-200" style="width:28%" />
              <div class="h-full bg-lime-500" style="width:17%" />
            </div>
            <div class="mt-3 flex flex-wrap justify-between gap-2 text-xs text-[var(--app-muted)]">
              <span>Claude Code 55%</span>
              <span>Codex 28%</span>
              <span>Antigravity 17%</span>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
})

function Metric(props: { label: string; value: string }) {
  return (
    <div class="app-surface-subtle rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-4">
      <p class="text-xs uppercase tracking-wide text-[var(--app-muted)]">{props.label}</p>
      <p class="mt-3 text-2xl font-black text-[var(--app-text)]">{props.value}</p>
    </div>
  )
}
