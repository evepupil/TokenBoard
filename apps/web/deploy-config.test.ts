import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const packageDir = dirname(fileURLToPath(import.meta.url))

describe('Wrangler deploy config', () => {
  test('standard deploy uses the tracked wrangler config', () => {
    const pkg = JSON.parse(readPackageFile('package.json'))
    const deployScript = pkg.scripts.deploy

    expect(deployScript).toContain('scripts/check-production-config.mjs')
    expect(deployScript).toContain('pnpm run build')
    expect(deployScript).toContain('wrangler d1 migrations apply DB --remote --config wrangler.jsonc')
    expect(deployScript).toContain('wrangler deploy --config wrangler.jsonc')
    expect(deployScript).not.toContain('wrangler deploy"')
    expect(deployScript.indexOf('scripts/check-production-config.mjs')).toBeLessThan(deployScript.indexOf('pnpm run build'))
    expect(deployScript.indexOf('pnpm run build')).toBeLessThan(deployScript.indexOf('wrangler d1 migrations apply DB --remote --config wrangler.jsonc'))
    expect(deployScript.indexOf('wrangler d1 migrations apply DB --remote --config wrangler.jsonc')).toBeLessThan(deployScript.indexOf('wrangler deploy --config wrangler.jsonc'))
  })

  test('tracked wrangler config contains production deploy bindings', () => {
    const config = readPackageFile('wrangler.jsonc')

    expect(config).toContain('"workers_dev": false')
    expect(config).toContain('"routes"')
    expect(config).toContain('"BETTER_AUTH_URL": "https://tokenboard.chaosyn.com"')
    expect(config).toContain('"database_id": "4af5cf99-10d9-4114-b707-f82e75f89746"')
    expect(config).not.toContain('00000000-0000-0000-0000-000000000000')
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
