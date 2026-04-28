import type { Bindings } from './lib/db'
import type {} from 'hono'

declare module 'hono' {
  interface Env {
    Variables: {}
    Bindings: Bindings
  }
}
