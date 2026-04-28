export type Bindings = {
  DB: D1Database
  SEED_USER_ID: string
  SEED_UPLOAD_TOKEN_SHA256: string
}

export type AppEnv = {
  Bindings: Bindings
}
