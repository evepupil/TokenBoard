export type Bindings = {
  DB: D1Database
  BETTER_AUTH_SECRET?: string
  BETTER_AUTH_URL?: string
}

export type AppEnv = {
  Bindings: Bindings
}
