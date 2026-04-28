import { createRoute } from 'honox/factory'
import { LinkButton, Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Input, Label } from '../../components/ui/input'
import { getOptionalUser } from '../../features/auth/middleware'
import { forwardAuthForm } from '../../features/auth/service'

export const GET = createRoute(async (c) => {
  const user = await getOptionalUser(c)
  if (user) return c.redirect('/dashboard')

  return c.render(
    <main class="min-h-screen bg-[#10130f] px-5 py-8 text-stone-50">
      <title>Create account - TokenBoard</title>
      <section class="mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl items-center gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <Card class="p-6 backdrop-blur">
          <form method="post">
            <div class="mb-6 flex items-center justify-between gap-4">
              <div>
                <p class="text-sm text-lime-300">Start tracking</p>
                <h1 class="mt-1 text-2xl font-bold">Create account</h1>
              </div>
              <LinkButton variant="secondary" size="sm" href="/auth/sign-in">Sign in</LinkButton>
            </div>
            <Label>Display name<Input name="name" autocomplete="name" required /></Label>
            <Label class="mt-4">Email<Input name="email" type="email" autocomplete="email" required /></Label>
            <Label class="mt-4">Password<Input name="password" type="password" autocomplete="new-password" minLength={8} required /></Label>
            <Button class="mt-6 w-full rounded-xl" type="submit">Create workspace</Button>
          </form>
        </Card>

        <div class="relative overflow-hidden rounded-[2rem] border border-lime-200/10 bg-[radial-gradient(circle_at_80%_20%,rgba(132,204,22,.26),transparent_28%),linear-gradient(135deg,#11140e,#1a1f14)] p-8">
          <p class="text-sm font-semibold uppercase tracking-[0.35em] text-lime-200">Multi-user first</p>
          <h2 class="mt-8 max-w-xl text-5xl font-black leading-none tracking-tight md:text-7xl">Public stats when you choose.</h2>
          <p class="mt-6 max-w-lg text-base leading-7 text-stone-300">
            TokenBoard starts private. Enable public cards or leaderboard participation later from settings.
          </p>
        </div>
      </section>
    </main>
  )
})

export const POST = createRoute(async (c) => {
  const form = await c.req.parseBody()
  return forwardAuthForm(c, 'sign-up/email', {
    name: String(form.name || ''),
    email: String(form.email || ''),
    password: String(form.password || ''),
    rememberMe: true
  })
})
