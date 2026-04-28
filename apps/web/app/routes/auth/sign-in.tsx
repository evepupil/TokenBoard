import { createRoute } from 'honox/factory'
import { LinkButton, Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Input, Label } from '../../components/ui/input'
import { getOptionalUser } from '../../features/auth/middleware'
import { forwardAuthForm } from '../../features/auth/service'

export const GET = createRoute(async (c) => {
  const user = await getOptionalUser(c)
  if (user) return c.redirect('/dashboard')

  return c.render(<AuthScreen />)
})

export const POST = createRoute(async (c) => {
  const form = await c.req.parseBody()
  return forwardAuthForm(c, 'sign-in/email', {
    email: String(form.email || ''),
    password: String(form.password || ''),
    rememberMe: true
  })
})

function AuthScreen() {
  return (
    <main class="min-h-screen bg-[#10130f] px-5 py-8 text-stone-50">
      <title>Sign in - TokenBoard</title>
      <section class="mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl items-center gap-8 lg:grid-cols-[1.05fr_0.95fr]">
        <div class="relative overflow-hidden rounded-[2rem] border border-lime-200/10 bg-[radial-gradient(circle_at_20%_10%,rgba(190,242,100,.22),transparent_32%),linear-gradient(135deg,#14180f,#0b0d0a)] p-8 shadow-2xl shadow-black/30">
          <div class="absolute -right-20 top-12 h-56 w-56 rounded-full border border-lime-300/20" />
          <p class="text-sm font-semibold uppercase tracking-[0.35em] text-lime-200">TokenBoard</p>
          <h1 class="mt-8 max-w-xl text-5xl font-black leading-none tracking-tight text-stone-50 md:text-7xl">
            Your AI token cockpit.
          </h1>
          <p class="mt-6 max-w-lg text-base leading-7 text-stone-300">
            Collect Claude Code and Codex usage locally, upload only aggregate metrics, then compare daily spend, model mix, and public leaderboard position.
          </p>
          <div class="mt-10 grid gap-3 sm:grid-cols-3">
            <Panel label="Private by default" value="0 prompts" />
            <Panel label="Sources" value="Claude + Codex" />
            <Panel label="Storage" value="D1 aggregates" />
          </div>
        </div>

        <Card class="p-6 backdrop-blur">
          <form method="post">
            <div class="mb-6 flex items-center justify-between gap-4">
              <div>
                <p class="text-sm text-lime-300">Welcome back</p>
                <h2 class="mt-1 text-2xl font-bold">Sign in</h2>
              </div>
              <LinkButton variant="secondary" size="sm" href="/auth/sign-up">Create account</LinkButton>
            </div>
            <Label>Email<Input name="email" type="email" autocomplete="email" required /></Label>
            <Label class="mt-4">Password<Input name="password" type="password" autocomplete="current-password" required /></Label>
            <Button class="mt-6 w-full rounded-xl" type="submit">Enter dashboard</Button>
          </form>
        </Card>
      </section>
    </main>
  )
}

function Panel(props: { label: string; value: string }) {
  return (
    <div class="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <p class="text-xs uppercase tracking-wide text-stone-400">{props.label}</p>
      <p class="mt-2 text-lg font-bold text-stone-50">{props.value}</p>
    </div>
  )
}
