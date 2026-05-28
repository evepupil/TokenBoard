import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CONFIG_FILE = 'wrangler.production.jsonc'
const configPath = resolve(CONFIG_FILE)

if (existsSync(configPath)) {
  process.exit(0)
}

const publicOrigin = readRequiredEnv('TOKENBOARD_PUBLIC_ORIGIN')
const routePattern = process.env.TOKENBOARD_ROUTE_PATTERN || new URL(publicOrigin).hostname
const databaseName = process.env.TOKENBOARD_D1_DATABASE_NAME || 'tokenboard'
const databaseId = readRequiredEnv('TOKENBOARD_D1_DATABASE_ID')

const config = {
  '$schema': 'node_modules/wrangler/config-schema.json',
  name: 'tokenboard',
  main: './dist/index.js',
  compatibility_date: '2026-04-28',
  compatibility_flags: ['nodejs_compat'],
  assets: {
    directory: './dist'
  },
  workers_dev: false,
  routes: [
    {
      pattern: routePattern,
      custom_domain: true
    }
  ],
  vars: {
    BETTER_AUTH_URL: publicOrigin
  },
  d1_databases: [
    {
      binding: 'DB',
      database_name: databaseName,
      database_id: databaseId,
      migrations_dir: 'db/migrations'
    }
  ]
}

writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })

function readRequiredEnv(name) {
  const value = process.env[name]?.trim()
  if (value) return value
  fail(`${name} is required to generate ${CONFIG_FILE}.`)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
