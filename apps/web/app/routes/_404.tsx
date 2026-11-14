import type { NotFoundHandler } from 'hono'
import { SkipLinkTarget } from '../components/skip-link-target'
import { isRouteRenderedNotFound } from '../lib/not-found'

const handler: NotFoundHandler = (c) => {
  // A 404 is not a representation of a resource, so nothing should hold on to it: without
  // a directive a browser may cache it heuristically, and `.csv`/`.json` style paths are on
  // Cloudflare's cache-by-extension list. That would keep answering "not found" for a path
  // that starts existing later. Matches the app's other error surfaces.
  c.header('Cache-Control', 'no-store')

  // HonoX runs this handler for every 404 the app returns, including one a page route rendered
  // itself. A route that marked its response did so because it produced a specific not-found
  // page; keep that body rather than replacing it with the generic one.
  if (isRouteRenderedNotFound(c)) {
    return c.res
  }

  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404)
  }

  c.status(404)
  return c.render(
    <>
      <SkipLinkTarget />
      404 Not Found
    </>
  )
}

export default handler
