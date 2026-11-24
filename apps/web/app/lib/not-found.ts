import type { Context } from 'hono'

// HonoX installs the root `_404.tsx` handler as a middleware on the whole app, and it rewrites
// the body of *every* 404 the app produces — not only the framework's own. Without a signal, a
// route that renders its own not-found page (an expired shared report link, a device that is
// gone) has that page thrown away and the visitor gets the generic body instead. A route marks
// its response here so the root handler can leave the body it built alone.
//
// The unit tests for those routes call the route handler directly, which is exactly why the
// overwrite went unnoticed: only the assembled app reaches the root handler.
const key = 'tokenboard.routeRenderedNotFound'

export function markRouteRenderedNotFound(c: Context) {
  // The route unit tests call the handler with a minimal context stub that has no state store;
  // a real HonoX context has `set`. The marker is only consulted by the assembled app, where
  // the stub never appears, so a stub that cannot store it just skips the mark.
  if (typeof c.set === 'function') c.set(key, true)
}

export function isRouteRenderedNotFound(c: Context) {
  // Defensive: `NotFoundHandler` is also invoked directly in tests with a minimal context stub
  // that carries no state store.
  return typeof c.get === 'function' && c.get(key) === true
}
