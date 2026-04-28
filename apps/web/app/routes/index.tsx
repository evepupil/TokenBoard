import { createRoute } from 'honox/factory'
import { AppNav } from '../components/app-nav'
import { getOptionalUser } from '../features/auth/middleware'

export default createRoute(async (c) => {
  const user = await getOptionalUser(c)
  if (user) return c.redirect('/dashboard')

  return c.render(
    <main class="min-h-screen overflow-hidden bg-[var(--app-bg)] px-5 py-6 text-[var(--app-text)]">
      <title>TokenBoard</title>
      <AppNav isAuthenticated={false} />
      <section class="relative mx-auto grid min-h-[calc(100vh-7rem)] max-w-7xl items-center gap-10 py-10 lg:grid-cols-[1fr_0.9fr]">
        <div class="absolute left-8 top-8 h-24 w-24 rounded-full bg-lime-300 blur-3xl" />
        <div class="relative z-10">
          <p class="text-sm font-black uppercase tracking-[0.45em] text-[var(--app-muted)]">TokenBoard</p>
          <h1 class="mt-8 max-w-4xl text-6xl font-black leading-[0.9] tracking-tight md:text-8xl">
            为分享而生的 AI 用量面板。
          </h1>
          <p class="mt-6 max-w-2xl text-lg leading-8 text-[var(--app-muted)]">
            连接本机 Claude Code 与 Codex 采集器，只上传聚合后的 token 指标，并由你决定哪些视图可以公开。
          </p>
          <div class="mt-8 flex flex-wrap gap-3">
            <a class="rounded-xl bg-lime-300 px-5 py-3 text-sm font-black text-stone-950 transition hover:bg-lime-200" href="/auth/sign-in">使用 GitHub 登录</a>
            <a class="rounded-xl border border-[var(--app-border)] px-5 py-3 text-sm font-bold text-[var(--app-text)] transition hover:border-lime-300" href="/leaderboards">查看排行榜</a>
          </div>
        </div>
        <div class="relative z-10 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-strong)] p-5 text-[var(--app-text)] shadow-2xl shadow-black/15">
          <div class="grid gap-3 sm:grid-cols-2">
            <Metric label="今日 tokens" value="128,420" />
            <Metric label="本月费用" value="$42.31" />
            <Metric label="主要模型" value="gpt-5.4" />
            <Metric label="连续同步" value="18 天" />
          </div>
          <div class="mt-4 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-4">
            <div class="mb-4 flex items-center justify-between text-sm">
              <span class="font-bold text-lime-300">来源占比</span>
              <span class="text-[var(--app-muted)]">最近 30 天</span>
            </div>
            <div class="h-4 overflow-hidden rounded-full bg-[var(--app-border)]">
              <div class="h-full w-[63%] bg-lime-300" />
            </div>
            <div class="mt-3 flex justify-between text-xs text-[var(--app-muted)]">
              <span>Claude Code 63%</span>
              <span>Codex 37%</span>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
})

function Metric(props: { label: string; value: string }) {
  return (
    <div class="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-4">
      <p class="text-xs uppercase tracking-wide text-[var(--app-muted)]">{props.label}</p>
      <p class="mt-3 text-2xl font-black text-[var(--app-text)]">{props.value}</p>
    </div>
  )
}
