import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(scriptDir, '..')

const inputFile = resolve(packageDir, process.argv[2] || 'wrangler.production.example.jsonc')
const outputFile = resolve(packageDir, process.argv[3] || 'wrangler.production.ci.jsonc')

const workerRoute = requireEnv('TOKENBOARD_WORKER_ROUTE')
const betterAuthUrl = requireEnv('BETTER_AUTH_URL')
const d1DatabaseId = requireEnv('D1_DATABASE_ID')

validateWorkerRoute(workerRoute)
validateBetterAuthUrl(betterAuthUrl)
validateD1DatabaseId(d1DatabaseId)

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
  /"database_id"\s*:\s*"<your-d1-database-id>"/,
  `"database_id": ${JSON.stringify(d1DatabaseId)}`,
  'database_id'
)

if (/<your-[^>]+>/.test(content)) {
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
  if (!isValidHostname(hostname)) {
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
