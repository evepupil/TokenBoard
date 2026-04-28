import { createRoute } from 'honox/factory'
import { InstallCommand } from '../../features/device/components/install-command'
import { D1DevicePairingRepository } from '../../features/device/repository'
import { createPairingCode, createPairingCodeDeps } from '../../features/device/service'
import { jsonError } from '../../lib/http'

export const GET = createRoute((c) => {
  return c.render(
    <main class="min-h-screen bg-zinc-950 px-6 py-8 text-zinc-50">
      <title>Connect TokenBoard</title>
      <InstallCommand baseUrl={new URL(c.req.url).origin} timezone="Asia/Shanghai" />
    </main>
  )
})

export const POST = createRoute(async (c) => {
  try {
    const form = await c.req.parseBody()
    const timezone = String(form.timezone || 'Asia/Shanghai')
    const repository = new D1DevicePairingRepository(c.env.DB)
    // Temporary bootstrap path until Better Auth user sessions are wired in.
    const result = await createPairingCode(
      repository,
      c.env.SEED_USER_ID,
      createPairingCodeDeps()
    )

    return c.render(
      <main class="min-h-screen bg-zinc-950 px-6 py-8 text-zinc-50">
        <title>Connect TokenBoard</title>
        <InstallCommand
          baseUrl={new URL(c.req.url).origin}
          timezone={timezone}
          pairingCode={result.pairingCode}
          expiresAt={result.expiresAt}
        />
      </main>
    )
  } catch (error) {
    return jsonError(c, error)
  }
})
