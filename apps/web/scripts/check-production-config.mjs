import { existsSync, readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { resolve } from 'node:path'

const CONFIG_FILE = process.env.TOKENBOARD_WRANGLER_CONFIG?.trim() || 'wrangler.production.jsonc'
const EXAMPLE_FILE = 'wrangler.production.example.jsonc'
const DAILY_REPORT_HISTORY_DAYS_MAX = 31
const USAGE_SUMMARY_BACKFILL_LIMIT_MAX = 500
const WEBHOOK_LOG_RETENTION_DAYS_MAX = 365
const WEBHOOK_CRON_BATCH_SIZE_MAX = 5
const MODEL_PRICING_SYNC_INTERVAL_HOURS_MAX = 168
const DEFAULT_MODEL_PRICING_SOURCE_URL = 'https://models.dev/api.json'

const configPath = resolve(CONFIG_FILE)

if (!existsSync(configPath)) {
  fail(
    `Production deploy requires ${CONFIG_FILE}. Copy ${EXAMPLE_FILE} and fill the route, BETTER_AUTH_URL, and D1 database_id.`
  )
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
validateCollectorRepoUrl(
  readRequiredString(config.vars?.TOKENBOARD_COLLECTOR_REPO_URL, 'vars.TOKENBOARD_COLLECTOR_REPO_URL')
)
validateCollectorRepoRef(readRequiredString(config.vars?.TOKENBOARD_COLLECTOR_REF, 'vars.TOKENBOARD_COLLECTOR_REF'))
validateProductionRoute(readRequiredString(firstRoute(config).pattern, 'routes[0].pattern'))
validateProductionDatabaseId(readRequiredString(d1Database(config).database_id, 'd1_databases[DB].database_id'))
validateOptionalIntegerString(
  config.vars?.TOKENBOARD_DAILY_REPORT_HISTORY_DAYS,
  'vars.TOKENBOARD_DAILY_REPORT_HISTORY_DAYS',
  1,
  DAILY_REPORT_HISTORY_DAYS_MAX
)
validateOptionalIntegerString(
  config.vars?.TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT,
  'vars.TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT',
  1,
  USAGE_SUMMARY_BACKFILL_LIMIT_MAX
)
validateOptionalBooleanString(config.vars?.TOKENBOARD_USAGE_SUMMARY_STRICT, 'vars.TOKENBOARD_USAGE_SUMMARY_STRICT')
validateOptionalIntegerString(
  config.vars?.TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS,
  'vars.TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS',
  1,
  WEBHOOK_LOG_RETENTION_DAYS_MAX
)
validateOptionalIntegerString(
  config.vars?.TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE,
  'vars.TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE',
  1,
  WEBHOOK_CRON_BATCH_SIZE_MAX
)
validateOptionalBooleanString(
  config.vars?.TOKENBOARD_MODEL_PRICING_SYNC_ENABLED,
  'vars.TOKENBOARD_MODEL_PRICING_SYNC_ENABLED'
)
validateOptionalIntegerString(
  config.vars?.TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS,
  'vars.TOKENBOARD_MODEL_PRICING_SYNC_INTERVAL_HOURS',
  1,
  MODEL_PRICING_SYNC_INTERVAL_HOURS_MAX
)
validateModelPricingSourceUrl(config.vars?.TOKENBOARD_MODEL_PRICING_SOURCE_URL ?? DEFAULT_MODEL_PRICING_SOURCE_URL)
validateRequiredCronTrigger(config)
validateWorkerFirstAssetRoutes(config)

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
    return /<[^>]+>/.test(value) || value === '00000000-0000-0000-0000-000000000000'
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

function validateOptionalIntegerString(value, field, min, max) {
  if (value === undefined) return
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    fail(`${CONFIG_FILE} ${field} must be an integer from ${min} to ${max}.`)
  }
  const parsed = Number(value.trim())
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fail(`${CONFIG_FILE} ${field} must be an integer from ${min} to ${max}.`)
  }
}

function validateOptionalBooleanString(value, field) {
  if (value === undefined) return
  if (typeof value !== 'string') {
    fail(`${CONFIG_FILE} ${field} must be true, false, 1, or 0.`)
  }
  const normalized = value.trim().toLowerCase()
  if (!['true', 'false', '1', '0'].includes(normalized)) {
    fail(`${CONFIG_FILE} ${field} must be true, false, 1, or 0.`)
  }
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
  if (
    hasExplicitDefaultHttpsPort(value) ||
    url.port ||
    url.username ||
    url.password ||
    isUnsafeProductionHostname(url.hostname) ||
    !isValidHostname(url.hostname)
  ) {
    fail(`${CONFIG_FILE} BETTER_AUTH_URL must use a public hostname without credentials or an explicit port.`)
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    fail(`${CONFIG_FILE} BETTER_AUTH_URL must be an origin without path, query, or hash.`)
  }
}

function validateCollectorRepoUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail(`${CONFIG_FILE} vars.TOKENBOARD_COLLECTOR_REPO_URL must be a valid https GitHub repository URL.`)
  }

  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) {
    fail(`${CONFIG_FILE} vars.TOKENBOARD_COLLECTOR_REPO_URL must be a valid https GitHub repository URL.`)
  }
  if (!/^\/[^/]+\/[^/]+(?:\.git)?$/.test(url.pathname) || url.search || url.hash) {
    fail(`${CONFIG_FILE} vars.TOKENBOARD_COLLECTOR_REPO_URL must be a valid https GitHub repository URL.`)
  }
}

function validateCollectorRepoRef(value) {
  if (!value.trim() || /\s/.test(value)) {
    fail(`${CONFIG_FILE} vars.TOKENBOARD_COLLECTOR_REF must be a non-empty branch or ref name.`)
  }
}

function validateModelPricingSourceUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail(`${CONFIG_FILE} vars.TOKENBOARD_MODEL_PRICING_SOURCE_URL must be https://models.dev/api.json.`)
  }
  if (
    hasExplicitDefaultHttpsPort(value) ||
    url.protocol !== 'https:' ||
    url.hostname !== 'models.dev' ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/api.json' ||
    url.search ||
    url.hash
  ) {
    fail(`${CONFIG_FILE} vars.TOKENBOARD_MODEL_PRICING_SOURCE_URL must be https://models.dev/api.json.`)
  }
}

function hasExplicitDefaultHttpsPort(value) {
  return /^https:\/\/(?:[^/?#@]*@)?(?:\[[^\]]+\]|[^/?#:]+):0*443(?:[/?#]|$)/i.test(value)
}

function validateProductionRoute(value) {
  const hostname = extractProductionRouteHostname(value)
  if (isUnsafeProductionHostname(hostname) || !hostname.includes('.')) {
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

function validateWorkerFirstAssetRoutes(config) {
  if (config.assets?.binding !== 'ASSETS' || config.assets?.run_worker_first !== true) {
    fail(
      `${CONFIG_FILE} assets.binding must be ASSETS and assets.run_worker_first must be true so dynamic JSON, SVG, CSV, and static asset fallback routes are served correctly.`
    )
  }
}

function isLocalHostname(value) {
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(value.toLowerCase())
}

function isUnsafeProductionHostname(value) {
  const hostname = value
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
  if (
    !hostname ||
    isLocalHostname(hostname) ||
    hostname.endsWith('.local') ||
    isIP(hostname) !== 0 ||
    hostname.includes(':')
  ) {
    return true
  }

  // WHATWG URL parsing accepts abbreviated, hexadecimal, and octal IPv4
  // spellings (for example 127.1 and 0x7f.0.0.1). Reject them after parsing
  // as well, otherwise a route that looks like a hostname can resolve to a
  // private or loopback address in production.
  try {
    const parsedHostname = new URL(`https://${hostname}`).hostname.replace(/^\[|\]$/g, '')
    return isIP(parsedHostname) !== 0
  } catch {
    return false
  }
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
