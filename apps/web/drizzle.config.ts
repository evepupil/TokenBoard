import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './app/db/schema.ts',
  out: './db/migrations',
  dialect: 'sqlite'
})
