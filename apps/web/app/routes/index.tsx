import { createRoute } from 'honox/factory'
import { getOptionalUser } from '../features/auth/middleware'

export default createRoute(async (c) => {
  const user = await getOptionalUser(c)
  if (user) return c.redirect('/dashboard')

  return c.render(
    <main class="min-h-screen overflow-hidden bg-[#f4f0e8] text-stone-950">
      <title>TokenBoard</title>
      <section class="relative mx-auto grid min-h-screen max-w-7xl items-center gap-10 px-6 py-10 lg:grid-cols-[1fr_0.9fr]">
        <div class="absolute left-8 top-8 h-24 w-24 rounded-full bg-lime-300 blur-3xl" />
        <div class="relative z-10">
          <p class="text-sm font-black uppercase tracking-[0.45em] text-stone-600">TokenBoard</p>
          <h1 class="mt-8 max-w-4xl text-6xl font-black leading-[0.9] tracking-tight md:text-8xl">
            AI usage stats that are built for sharing.
          </h1>
          <p class="mt-6 max-w-2xl text-lg leading-8 text-stone-700">
            Connect local Claude Code and Codex collectors, upload aggregate token metrics, and publish only the views you explicitly enable.
          </p>
          <div class="mt-8 flex flex-wrap gap-3">
            <a class="rounded-full bg-stone-950 px-5 py-3 text-sm font-black text-lime-200" href="/auth/sign-up">Create account</a>
            <a class="rounded-full border border-stone-400 px-5 py-3 text-sm font-bold text-stone-800" href="/auth/sign-in">Sign in</a>
          </div>
        </div>
        <div class="relative z-10 rounded-[2rem] border border-stone-300 bg-stone-950 p-5 text-stone-50 shadow-2xl shadow-stone-400/40">
          <div class="grid gap-3 sm:grid-cols-2">
            <Metric label="Today tokens" value="128,420" />
            <Metric label="Month cost" value="$42.31" />
            <Metric label="Top model" value="gpt-5.4" />
            <Metric label="Sync streak" value="18 days" />
          </div>
          <div class="mt-4 rounded-2xl border border-stone-800 bg-stone-900 p-4">
            <div class="mb-4 flex items-center justify-between text-sm">
              <span class="font-bold text-lime-200">Source split</span>
              <span class="text-stone-400">last 30 days</span>
            </div>
            <div class="h-4 overflow-hidden rounded-full bg-stone-800">
              <div class="h-full w-[63%] bg-lime-300" />
            </div>
            <div class="mt-3 flex justify-between text-xs text-stone-400">
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
    <div class="rounded-2xl border border-stone-800 bg-stone-900 p-4">
      <p class="text-xs uppercase tracking-wide text-stone-500">{props.label}</p>
      <p class="mt-3 text-2xl font-black text-stone-50">{props.value}</p>
    </div>
  )
}
