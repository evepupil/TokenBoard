import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CONFIG_FILE = process.env.TOKENBOARD_WRANGLER_CONFIG?.trim() || 'wrangler.production.jsonc'
const EXAMPLE_FILE = 'wrangler.production.example.jsonc'

const requiredFields = [
  ['triggers.crons', /"crons"\s*:\s*\[/],
  ['workers_dev: false', /"workers_dev"\s*:\s*false/],
  ['routes', /"routes"\s*:/],
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

validateProductionAuthUrl(extractStringField('BETTER_AUTH_URL'))
validateProductionRoute(extractStringField('pattern'))
validateProductionDatabaseId(extractStringField('database_id'))
validateRequiredCronTrigger()

function extractStringField(field) {
  const match = content.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`))
  if (!match) {
    fail(`${CONFIG_FILE} is missing ${field}.`)
  }
  return match[1].trim()
}

function validateProductionAuthUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail(`${CONFIG_FILE} BETTER_AUTH_URL must be a valid production URL.`)
  }
  if (url.protocol !== 'https:') {
    fail(`${CONFIG_FILE} BETTER_AUTH_URL must use https.`)
  }
  if (isLocalHostname(url.hostname)) {
    fail(`${CONFIG_FILE} BETTER_AUTH_URL must not point to localhost.`)
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    fail(`${CONFIG_FILE} BETTER_AUTH_URL must be an origin without path, query, or hash.`)
  }
}

function validateProductionRoute(value) {
  const hostname = extractProductionRouteHostname(value)
  if (isLocalHostname(hostname) || !hostname.includes('.')) {
    fail(`${CONFIG_FILE} route pattern must be a production custom domain host.`)
  }
}

function validateProductionDatabaseId(value) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidPattern.test(value)) {
    fail(`${CONFIG_FILE} database_id must be a Cloudflare D1 database UUID.`)
  }
}

function validateRequiredCronTrigger() {
  if (!/"crons"\s*:\s*\[[\s\S]*"\*\/15 \* \* \* \*"[\s\S]*\]/.test(content)) {
    fail(`${CONFIG_FILE} triggers.crons must include */15 * * * * for scheduled webhook delivery.`)
  }
}

function isLocalHostname(value) {
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(value.toLowerCase())
}

function extractProductionRouteHostname(value) {
  const route = value.trim()
  if (!route || /^https?:\/\//i.test(route) || /[/?#\s]/.test(route)) {
    fail(`${CONFIG_FILE} route pattern must be a production custom domain host.`)
  }
  if (route.includes('*') && !route.startsWith('*.')) {
    fail(`${CONFIG_FILE} route pattern must be a production custom domain host.`)
  }

  const hostname = route.startsWith('*.') ? route.slice(2) : route
  if (!isValidHostname(hostname)) {
    fail(`${CONFIG_FILE} route pattern must be a production custom domain host.`)
  }
  return hostname
}

function isValidHostname(value) {
  if (value.length === 0 || value.length > 253) return false
  const labels = value.split('.')
  if (labels.length < 2) return false
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
