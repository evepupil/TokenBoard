import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const packageDir = dirname(fileURLToPath(import.meta.url))

describe('Wrangler deploy config', () => {
  test('standard deploy uses the explicit production config', () => {
    const pkg = JSON.parse(readPackageFile('package.json'))

    expect(pkg.scripts.deploy).toContain('scripts/prepare-production-config.mjs')
    expect(pkg.scripts.deploy).toContain('scripts/check-production-config.mjs')
    expect(pkg.scripts.deploy).toContain('wrangler deploy --config wrangler.production.jsonc')
    expect(pkg.scripts.deploy).not.toContain('wrangler deploy"')
  })

  test('production config can be generated from CI environment variables', () => {
    const script = readPackageFile('scripts/prepare-production-config.mjs')

    expect(script).toContain('TOKENBOARD_PUBLIC_ORIGIN')
    expect(script).toContain('TOKENBOARD_ROUTE_PATTERN')
    expect(script).toContain('TOKENBOARD_D1_DATABASE_ID')
    expect(script).toContain('wrangler.production.jsonc')
    expect(script).not.toMatch(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/i)
    expect(script).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  })

  test('tracked default config stays local-only with placeholder bindings', () => {
    const config = readPackageFile('wrangler.jsonc')

    expect(config).toContain('Local development config')
    expect(config).toContain('"workers_dev": true')
    expect(config).toContain('"database_id": "00000000-0000-0000-0000-000000000000"')
    expect(config).not.toContain('"BETTER_AUTH_URL"')
    expect(config).not.toContain('"routes"')
  })

  test('tracked production example documents required deploy fields without private values', () => {
    const example = readPackageFile('wrangler.production.example.jsonc')

    expect(example).toContain('"workers_dev": false')
    expect(example).toContain('"routes"')
    expect(example).toContain('"BETTER_AUTH_URL": "https://<your-tokenboard-domain>"')
    expect(example).toContain('"database_id": "<your-d1-database-id>"')
    expect(example).not.toMatch(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/i)
    expect(example).not.toMatch(/"pattern":\s*"[a-z0-9.-]+\.[a-z]{2,}"/i)
    expect(example).not.toMatch(/"database_id":\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/i)
  })
})

function readPackageFile(relativePath: string): string {
  return readFileSync(resolve(packageDir, relativePath), 'utf8')
}
