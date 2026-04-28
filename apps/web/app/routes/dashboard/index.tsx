import { createRoute } from 'honox/factory'
import { requireUser } from '../../features/auth/middleware'
import { DashboardPreview } from '../../features/usage/components/dashboard-preview'
import { getDashboardSummary } from '../../features/usage/service'

export default createRoute(async (c) => {
  const user = await requireUser(c)
  const summary = await getDashboardSummary(c.env.DB, user.id)

  return c.render(
    <main class="min-h-screen bg-[#10130f] px-5 py-6 text-stone-50">
      <title>Dashboard - TokenBoard</title>
      <AppNav email={user.email} />
      <DashboardPreview summary={summary} userName={user.name} />
    </main>
  )
})

function AppNav(props: { email: string }) {
  return (
    <nav class="mx-auto mb-6 flex max-w-6xl flex-wrap items-center justify-between gap-3 rounded-2xl border border-stone-800 bg-stone-950/75 px-4 py-3">
      <a class="font-black tracking-tight text-lime-200" href="/dashboard">TokenBoard</a>
      <div class="flex flex-wrap items-center gap-2 text-sm text-stone-300">
        <a class="rounded-full px-3 py-1.5 hover:bg-stone-800" href="/dashboard">Dashboard</a>
        <a class="rounded-full px-3 py-1.5 hover:bg-stone-800" href="/leaderboards">Leaderboards</a>
        <a class="rounded-full px-3 py-1.5 hover:bg-stone-800" href="/settings/install">Install</a>
        <span class="hidden text-stone-600 sm:inline">{props.email}</span>
        <form method="post" action="/auth/sign-out">
          <button class="rounded-full border border-stone-700 px-3 py-1.5 hover:border-lime-300 hover:text-lime-200" type="submit">Sign out</button>
        </form>
      </div>
    </nav>
  )
}
