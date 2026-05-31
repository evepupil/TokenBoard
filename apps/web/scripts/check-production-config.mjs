import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CONFIG_FILE = process.env.TOKENBOARD_WRANGLER_CONFIG?.trim() || 'wrangler.production.jsonc'
const EXAMPLE_FILE = 'wrangler.production.example.jsonc'

const configPath = resolve(CONFIG_FILE)

if (!existsSync(configPath)) {
  fail(`Production deploy requires ${CONFIG_FILE}. Copy ${EXAMPLE_FILE} and fill the route, BETTER_AUTH_URL, and D1 database_id.`)
}

const content = readFileSync(configPath, 'utf8')
const config = parseJsoncConfig(content)

if (hasPlaceholderValue(config)) {
  fail(`${CONFIG_FILE} still contains placeholder values.`)
}

if (config.workers_dev !== false) {
  fail(`${CONFIG_FILE} is missing workers_dev: false.`)
}

validateProductionAuthUrl(readRequiredString(config.vars?.BETTER_AUTH_URL, 'vars.BETTER_AUTH_URL'))
validateProductionRoute(readRequiredString(firstRoute(config).pattern, 'routes[0].pattern'))
validateProductionDatabaseId(readRequiredString(d1Database(config).database_id, 'd1_databases[DB].database_id'))
validateRequiredCronTrigger(config)

function parseJsoncConfig(value) {
  try {
    return JSON.parse(stripJsonc(value))
  } catch (error) {
    fail(`${CONFIG_FILE} must be valid JSONC: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function stripJsonc(value) {
  let result = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    const next = value[index + 1]
    if (inString) {
      result += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      result += char
      continue
    }
    if (char === '/' && next === '/') {
      while (index < value.length && value[index] !== '\n') index += 1
      result += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < value.length && !(value[index] === '*' && value[index + 1] === '/')) index += 1
      index += 1
      continue
    }
    result += char
  }
  return stripTrailingCommas(result)
}

function stripTrailingCommas(value) {
  let result = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (inString) {
      result += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      result += char
      continue
    }
    if (char === ',') {
      let nextIndex = index + 1
      while (/\s/.test(value[nextIndex] ?? '')) nextIndex += 1
      if (value[nextIndex] === '}' || value[nextIndex] === ']') continue
    }
    result += char
  }
  return result
}

function hasPlaceholderValue(value) {
  if (typeof value === 'string') {
    return /<your-[^>]+>/.test(value) || value === '00000000-0000-0000-0000-000000000000'
  }
  if (Array.isArray(value)) return value.some(hasPlaceholderValue)
  if (value && typeof value === 'object') {
    return Object.values(value).some(hasPlaceholderValue)
  }
  return false
}

function readRequiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(`${CONFIG_FILE} is missing ${field}.`)
  }
  return value.trim()
}

function firstRoute(config) {
  if (!Array.isArray(config.routes) || config.routes.length === 0 || !config.routes[0]) {
    fail(`${CONFIG_FILE} is missing routes.`)
  }
  return config.routes[0]
}

function d1Database(config) {
  if (!Array.isArray(config.d1_databases) || config.d1_databases.length === 0) {
    fail(`${CONFIG_FILE} is missing d1_databases.`)
  }
  const database = config.d1_databases.find((item) => item?.binding === 'DB') ?? config.d1_databases[0]
  return database
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

function validateRequiredCronTrigger(config) {
  if (!Array.isArray(config.triggers?.crons) || !config.triggers.crons.includes('*/15 * * * *')) {
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
