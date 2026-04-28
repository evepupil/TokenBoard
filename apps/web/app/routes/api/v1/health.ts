import { createRoute } from 'honox/factory'

export const GET = createRoute((c) => {
  return c.json({ ok: true, name: 'TokenBoard' })
})

