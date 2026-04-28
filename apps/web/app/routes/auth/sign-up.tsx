import { createRoute } from 'honox/factory'

export const GET = createRoute((c) => c.redirect('/auth/sign-in', 303))
export const POST = createRoute((c) => c.redirect('/auth/sign-in', 303))
