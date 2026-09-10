import { readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(scriptDir, '..')

const inputFile = resolve(packageDir, process.argv[2] || 'wrangler.production.example.jsonc')
const outputFile = resolve(packageDir, process.argv[3] || 'wrangler.production.ci.jsonc')

const workerRoute = requireEnv('TOKENBOARD_WORKER_ROUTE')
const betterAuthUrl = requireEnv('BETTER_AUTH_URL')
const d1DatabaseId = requireEnv('D1_DATABASE_ID')
const collectorRepoUrl = requireEnv('TOKENBOARD_COLLECTOR_REPO_URL')
const collectorRepoRef = requireEnv('TOKENBOARD_COLLECTOR_REF')
const dailyReportHistoryDays = optionalIntegerEnv('TOKENBOARD_DAILY_REPORT_HISTORY_DAYS', '30', 1, 31)
const usageSummaryBackfillLimit = optionalIntegerEnv('TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT', '50', 1, 500)
const usageSummaryStrict = optionalBooleanEnv('TOKENBOARD_USAGE_SUMMARY_STRICT', 'false')
const webhookLogRetentionDays = optionalIntegerEnv('TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS', '90', 1, 365)
const webhookCronBatchSize = optionalIntegerEnv('TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE', '5', 1, 5)

validateWorkerRoute(workerRoute)
validateBetterAuthUrl(betterAuthUrl)
validateD1DatabaseId(d1DatabaseId)
validateCollectorRepoUrl(collectorRepoUrl)
validateCollectorRepoRef(collectorRepoRef)

let content = readFileSync(inputFile, 'utf8')

content = replaceRequired(
  content,
  /"pattern"\s*:\s*"<your-tokenboard-domain>"/,
  `"pattern": ${JSON.stringify(workerRoute)}`,
  'route pattern'
)
content = replaceRequired(
  content,
  /"BETTER_AUTH_URL"\s*:\s*"https:\/\/<your-tokenboard-domain>"/,
  `"BETTER_AUTH_URL": ${JSON.stringify(betterAuthUrl)}`,
  'BETTER_AUTH_URL'
)
content = replaceRequired(
  content,
  /"TOKENBOARD_COLLECTOR_REPO_URL"\s*:\s*"<tokenboard-collector-repo-url>"/,
  `"TOKENBOARD_COLLECTOR_REPO_URL": ${JSON.stringify(collectorRepoUrl)}`,
  'TOKENBOARD_COLLECTOR_REPO_URL'
)
content = replaceRequired(
  content,
  /"TOKENBOARD_COLLECTOR_REF"\s*:\s*"<tokenboard-collector-ref>"/,
  `"TOKENBOARD_COLLECTOR_REF": ${JSON.stringify(collectorRepoRef)}`,
  'TOKENBOARD_COLLECTOR_REF'
)
content = replaceRequired(
  content,
  /"database_id"\s*:\s*"<your-d1-database-id>"/,
  `"database_id": ${JSON.stringify(d1DatabaseId)}`,
  'database_id'
)
content = replaceRequired(
  content,
  /"TOKENBOARD_DAILY_REPORT_HISTORY_DAYS"\s*:\s*"<tokenboard-daily-report-history-days>"/,
  `"TOKENBOARD_DAILY_REPORT_HISTORY_DAYS": ${JSON.stringify(dailyReportHistoryDays)}`,
  'TOKENBOARD_DAILY_REPORT_HISTORY_DAYS'
)
content = replaceRequired(
  content,
  /"TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT"\s*:\s*"<tokenboard-usage-summary-backfill-limit>"/,
  `"TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT": ${JSON.stringify(usageSummaryBackfillLimit)}`,
  'TOKENBOARD_USAGE_SUMMARY_BACKFILL_LIMIT'
)
content = replaceRequired(
  content,
  /"TOKENBOARD_USAGE_SUMMARY_STRICT"\s*:\s*"<tokenboard-usage-summary-strict>"/,
  `"TOKENBOARD_USAGE_SUMMARY_STRICT": ${JSON.stringify(usageSummaryStrict)}`,
  'TOKENBOARD_USAGE_SUMMARY_STRICT'
)
content = replaceRequired(
  content,
  /"TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS"\s*:\s*"<tokenboard-webhook-log-retention-days>"/,
  `"TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS": ${JSON.stringify(webhookLogRetentionDays)}`,
  'TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS'
)
content = replaceRequired(
  content,
  /"TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE"\s*:\s*"<tokenboard-webhook-cron-batch-size>"/,
  `"TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE": ${JSON.stringify(webhookCronBatchSize)}`,
  'TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE'
)

if (/<[^>]+>/.test(content)) {
  fail('Generated Wrangler config still contains placeholders.')
}

writeFileSync(outputFile, content)
console.log(`Wrote production Wrangler config to ${outputFile}`)

function requireEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    fail(`${name} is required to generate the production Wrangler config.`)
  }
  return value
}

function optionalIntegerEnv(name, defaultValue, min, max) {
  const value = process.env[name]?.trim() || defaultValue
  if (!/^\d+$/.test(value)) {
    fail(`${name} must be an integer from ${min} to ${max}.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fail(`${name} must be an integer from ${min} to ${max}.`)
  }
  return value
}

function optionalBooleanEnv(name, defaultValue) {
  const value = (process.env[name]?.trim() || defaultValue).toLowerCase()
  if (value === 'true' || value === '1') return 'true'
  if (value === 'false' || value === '0') return 'false'
  fail(`${name} must be true, false, 1, or 0.`)
}

function replaceRequired(content, pattern, replacement, label) {
  if (!pattern.test(content)) {
    fail(`Could not find ${label} placeholder in the Wrangler production example.`)
  }
  return content.replace(pattern, replacement)
}

function validateWorkerRoute(value) {
  const route = value.trim()
  if (!route || /^https?:\/\//i.test(route) || /[/?#\s]/.test(route)) {
    fail('TOKENBOARD_WORKER_ROUTE must be a custom domain host without protocol, path, query, or hash.')
  }
  if (route.includes('*') && !route.startsWith('*.')) {
    fail('TOKENBOARD_WORKER_ROUTE must be a custom domain host without protocol, path, query, or hash.')
  }

  const hostname = route.startsWith('*.') ? route.slice(2) : route
  if (!isValidHostname(hostname) || isUnsafeProductionHostname(hostname)) {
    fail('TOKENBOARD_WORKER_ROUTE must be a custom domain host without protocol, path, query, or hash.')
  }
}

function validateBetterAuthUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail('BETTER_AUTH_URL must be a valid URL.')
  }

  if (url.protocol !== 'https:') {
    fail('BETTER_AUTH_URL must use https for production.')
  }
  if (
    hasExplicitDefaultHttpsPort(value) ||
    url.port ||
    url.username ||
    url.password ||
    isUnsafeProductionHostname(url.hostname) ||
    !isValidHostname(url.hostname)
  ) {
    fail('BETTER_AUTH_URL must use a public hostname without credentials or an explicit port.')
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    fail('BETTER_AUTH_URL must be the production origin without path, query, or hash.')
  }
}

function validateD1DatabaseId(value) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidPattern.test(value)) {
    fail('D1_DATABASE_ID must be the D1 database UUID from Cloudflare.')
  }
}

function validateCollectorRepoUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail('TOKENBOARD_COLLECTOR_REPO_URL must be a valid https GitHub repository URL.')
  }

  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) {
    fail('TOKENBOARD_COLLECTOR_REPO_URL must be a valid https GitHub repository URL.')
  }
  if (!/^\/[^/]+\/[^/]+(?:\.git)?$/.test(url.pathname) || url.search || url.hash) {
    fail('TOKENBOARD_COLLECTOR_REPO_URL must be a valid https GitHub repository URL.')
  }
}

function validateCollectorRepoRef(value) {
  if (!value.trim() || /\s/.test(value)) {
    fail('TOKENBOARD_COLLECTOR_REF must be a non-empty branch or ref name.')
  }
}

function hasExplicitDefaultHttpsPort(value) {
  return /^https:\/\/(?:[^/?#@]*@)?(?:\[[^\]]+\]|[^/?#:]+):0*443(?:[/?#]|$)/i.test(value)
}

function isValidHostname(value) {
  if (value.length === 0 || value.length > 253) return false
  const labels = value.split('.')
  if (labels.length < 2) return false
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
}

function isUnsafeProductionHostname(value) {
  const hostname = value
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
  if (
    !hostname ||
    hostname === 'localhost' ||
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

function fail(message) {
  console.error(message)
  process.exit(1)
}
