import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CONFIG_FILE = 'wrangler.production.jsonc'
const EXAMPLE_FILE = 'wrangler.production.example.jsonc'

const requiredFields = [
  ['BETTER_AUTH_URL', /"BETTER_AUTH_URL"\s*:/],
  ['d1_databases', /"d1_databases"\s*:/],
  ['database_id', /"database_id"\s*:/]
]

const placeholderPatterns = [
  /<your-[^>]+>/,
  /00000000-0000-0000-0000-000000000000/
]

const configPath = resolve(CONFIG_FILE)

if (!existsSync(configPath)) {
  fail(`Production deploy requires ${CONFIG_FILE}. Copy ${EXAMPLE_FILE} and fill the route, BETTER_AUTH_URL, and D1 database_id.`)
}

const content = readFileSync(configPath, 'utf8')

for (const [field, pattern] of requiredFields) {
  if (!pattern.test(content)) {
    fail(`${CONFIG_FILE} is missing ${field}.`)
  }
}

for (const pattern of placeholderPatterns) {
  if (pattern.test(content)) {
    fail(`${CONFIG_FILE} still contains placeholder values.`)
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
