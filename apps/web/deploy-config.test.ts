import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const packageDir = dirname(fileURLToPath(import.meta.url))

describe('Wrangler deploy config', () => {
  test('standard deploy uses the deployment helper', () => {
    const pkg = JSON.parse(readPackageFile('package.json'))
    const deployScript = pkg.scripts.deploy

    expect(deployScript).toBe('node scripts/deploy.mjs')
  })

  test('tracked wrangler config stays runnable for local preview', () => {
    const config = readPackageFile('wrangler.jsonc')
    const deploymentScript = readPackageFile('scripts/deploy.mjs')
    const productionCheckScript = readPackageFile('scripts/check-production-config.mjs')

    expect(config).not.toContain('"routes"')
    expect(config).not.toContain('<your-tokenboard-domain>')
    expect(config).toContain('"BETTER_AUTH_URL": "http://localhost:8787"')
    expect(config).toContain('"database_id": "local-tokenboard-dev"')
    expect(config).not.toMatch(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/i)
    expect(config).not.toMatch(/"pattern":\s*"[a-z0-9.-]+\.[a-z]{2,}"/i)
    expect(config).not.toMatch(/"database_id":\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/i)
    expect(deploymentScript).toContain('TOKENBOARD_WRANGLER_CONFIG')
    expect(deploymentScript).toContain('wrangler.production.jsonc')
    expect(deploymentScript).toContain('wrangler.production.ci.jsonc')
    expect(deploymentScript).toContain('scripts/write-production-config.mjs')
    expect(deploymentScript).toContain('scripts/check-production-config.mjs')
    expect(deploymentScript).toContain("runPnpm(['run', 'build'])")
    expect(deploymentScript).toContain("process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'")
    expect(deploymentScript).toContain("'d1', 'migrations', 'apply', 'DB'")
    expect(deploymentScript).toContain("'deploy', '--config'")
    expect(productionCheckScript).toContain("|| 'wrangler.production.jsonc'")
    expect(productionCheckScript).not.toContain("|| 'wrangler.jsonc'")
  })

  test('tracked production example documents required deploy fields without private values', () => {
    const example = readPackageFile('wrangler.production.example.jsonc')

    expect(example).toContain('"workers_dev": false')
    expect(example).toContain('"routes"')
    expect(example).toContain('"triggers"')
    expect(example).toContain('"*/15 * * * *"')
    expect(example).toContain('"BETTER_AUTH_URL": "https://<your-tokenboard-domain>"')
    expect(example).toContain('"database_id": "<your-d1-database-id>"')
    expect(example).not.toMatch(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/i)
    expect(example).not.toMatch(/"pattern":\s*"[a-z0-9.-]+\.[a-z]{2,}"/i)
    expect(example).not.toMatch(/"database_id":\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/i)
  })

  test('production workflow deploys after migrations with a generated config', () => {
    const workflow = readRepoFile('.github/workflows/deploy.yml')

    expect(workflow).toContain('TOKENBOARD_WRANGLER_CONFIG: wrangler.production.ci.jsonc')
    expect(workflow).toContain('TOKENBOARD_WORKER_ROUTE: ${{ vars.TOKENBOARD_WORKER_ROUTE }}')
    expect(workflow).toContain('BETTER_AUTH_URL: ${{ vars.BETTER_AUTH_URL }}')
    expect(workflow).toContain('D1_DATABASE_ID: ${{ secrets.D1_DATABASE_ID }}')
    expect(workflow).toContain('node scripts/write-production-config.mjs')
    expect(workflow).toContain('node scripts/check-production-config.mjs')
    expect(workflow).toContain('pnpm run build')
    expect(workflow).toContain('wrangler d1 migrations apply DB --remote --config "$TOKENBOARD_WRANGLER_CONFIG"')
    expect(workflow).toContain('wrangler deploy --config "$TOKENBOARD_WRANGLER_CONFIG"')
    expect(workflow.indexOf('node scripts/check-production-config.mjs')).toBeLessThan(workflow.indexOf('pnpm run build'))
    expect(workflow.indexOf('pnpm run build')).toBeLessThan(
      workflow.indexOf('wrangler d1 migrations apply DB --remote --config "$TOKENBOARD_WRANGLER_CONFIG"')
    )
    expect(workflow.indexOf('wrangler d1 migrations apply DB --remote --config "$TOKENBOARD_WRANGLER_CONFIG"')).toBeLessThan(
      workflow.indexOf('wrangler deploy --config "$TOKENBOARD_WRANGLER_CONFIG"')
    )
    expect(workflow).not.toContain('--config wrangler.jsonc')
  })

  test('Drizzle schema declares webhook migration indexes', () => {
    const schema = readPackageFile('app/db/schema.ts')

    expect(schema).toContain("index('webhook_subscriptions_user_idx')")
    expect(schema).toContain("index('webhook_subscriptions_due_idx')")
    expect(schema).toContain("index('webhook_delivery_logs_subscription_idx')")
    expect(schema).toContain("uniqueIndex('webhook_delivery_logs_daily_success_idx')")
    expect(schema).toContain("= 'success' AND")
    expect(schema).toContain("= 'daily'")
  })

  test('production config generator replaces placeholders from CI environment', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-wrangler-'))
    const outputFile = join(tempDir, 'wrangler.production.ci.jsonc')

    try {
      const result = spawnSync(
        process.execPath,
        [resolve(packageDir, 'scripts/write-production-config.mjs'), 'wrangler.production.example.jsonc', outputFile],
        {
          cwd: packageDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            TOKENBOARD_WORKER_ROUTE: 'tokenboard.example.com',
            BETTER_AUTH_URL: 'https://tokenboard.example.com',
            D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111'
          }
        }
      )

      expect(result.status).toBe(0)

      const generated = readFileSync(outputFile, 'utf8')
      expect(generated).toContain('"pattern": "tokenboard.example.com"')
      expect(generated).toContain('"BETTER_AUTH_URL": "https://tokenboard.example.com"')
      expect(generated).toContain('"database_id": "11111111-1111-4111-8111-111111111111"')
      expect(generated).not.toContain('<your-tokenboard-domain>')
      expect(generated).not.toContain('<your-d1-database-id>')

      const checkResult = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
        cwd: packageDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKENBOARD_WRANGLER_CONFIG: outputFile
        }
      })
      expect(checkResult.status).toBe(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('deploy helper generates production config for clean Cloudflare builds', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-clean-deploy-'))
    const scriptDir = join(tempDir, 'scripts')
    const pnpmStub = join(tempDir, 'pnpm')

    try {
      mkdirSync(scriptDir)
      copyFileSync(resolve(packageDir, 'scripts/deploy.mjs'), join(scriptDir, 'deploy.mjs'))
      copyFileSync(resolve(packageDir, 'scripts/check-production-config.mjs'), join(scriptDir, 'check-production-config.mjs'))
      copyFileSync(resolve(packageDir, 'scripts/write-production-config.mjs'), join(scriptDir, 'write-production-config.mjs'))
      copyFileSync(resolve(packageDir, 'wrangler.production.example.jsonc'), join(tempDir, 'wrangler.production.example.jsonc'))
      writeFileSync(pnpmStub, '#!/bin/sh\nexit 0\n')
      chmodSync(pnpmStub, 0o755)

      const result = spawnSync(process.execPath, ['scripts/deploy.mjs'], {
        cwd: tempDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${tempDir}:${process.env.PATH ?? ''}`,
          TOKENBOARD_WORKER_ROUTE: 'tokenboard.example.com',
          BETTER_AUTH_URL: 'https://tokenboard.example.com',
          D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111'
        }
      })

      expect(result.status).toBe(0)

      const generated = readFileSync(join(tempDir, 'wrangler.production.ci.jsonc'), 'utf8')
      expect(generated).toContain('"pattern": "tokenboard.example.com"')
      expect(generated).toContain('"BETTER_AUTH_URL": "https://tokenboard.example.com"')
      expect(generated).toContain('"database_id": "11111111-1111-4111-8111-111111111111"')
      expect(result.stderr).toBe('')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('production config checker defaults to the private production config path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-empty-config-'))

    try {
      const result = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
        cwd: tempDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKENBOARD_WRANGLER_CONFIG: ''
        }
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('wrangler.production.jsonc')
      expect(result.stderr).not.toContain('wrangler.jsonc')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('production config checker rejects the local preview Wrangler config', () => {
    const result = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
      cwd: packageDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        TOKENBOARD_WRANGLER_CONFIG: 'wrangler.jsonc'
      }
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('wrangler.jsonc is missing workers_dev: false')
  })

  test('production config checker rejects production config without cron triggers', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-no-cron-config-'))
    const outputFile = join(tempDir, 'wrangler.production.no-cron.jsonc')

    try {
      const content = readPackageFile('wrangler.production.example.jsonc')
        .replace('"pattern": "<your-tokenboard-domain>"', '"pattern": "tokenboard.example.com"')
        .replace('"BETTER_AUTH_URL": "https://<your-tokenboard-domain>"', '"BETTER_AUTH_URL": "https://tokenboard.example.com"')
        .replace('"database_id": "<your-d1-database-id>"', '"database_id": "11111111-1111-4111-8111-111111111111"')
        .replace(/\s+"triggers":\s*\{\s*"crons":\s*\[\s*"\*\/15 \* \* \* \*"\s*\]\s*\},/, '')
      writeFileSync(outputFile, content)

      const result = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
        cwd: packageDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKENBOARD_WRANGLER_CONFIG: outputFile
        }
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('triggers.crons')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('production config tooling rejects route values that are not bare hosts', () => {
    for (const badRoute of [
      'tokenboard.example.com/path',
      'tokenboard.example.com?bad=1',
      'tokenboard.example.com#hash'
    ]) {
      const generatorResult = spawnSync(
        process.execPath,
        [resolve(packageDir, 'scripts/write-production-config.mjs'), 'wrangler.production.example.jsonc'],
        {
          cwd: packageDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            TOKENBOARD_WORKER_ROUTE: badRoute,
            BETTER_AUTH_URL: 'https://tokenboard.example.com',
            D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111'
          }
        }
      )

      expect(generatorResult.status).not.toBe(0)
      expect(generatorResult.stderr).toContain('custom domain host')
    }
  })

  test('production config checker rejects configured route values that are not bare hosts', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-bad-route-config-'))

    try {
      for (const badRoute of [
        'tokenboard.example.com/path',
        'tokenboard.example.com?bad=1',
        'tokenboard.example.com#hash'
      ]) {
        const outputFile = join(tempDir, `wrangler.${badRoute.replace(/[^a-z0-9]/gi, '-')}.jsonc`)
        const content = readPackageFile('wrangler.production.example.jsonc')
          .replace('"pattern": "<your-tokenboard-domain>"', `"pattern": "${badRoute}"`)
          .replace('"BETTER_AUTH_URL": "https://<your-tokenboard-domain>"', '"BETTER_AUTH_URL": "https://tokenboard.example.com"')
          .replace('"database_id": "<your-d1-database-id>"', '"database_id": "11111111-1111-4111-8111-111111111111"')
        writeFileSync(outputFile, content)

        const result = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
          cwd: packageDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            TOKENBOARD_WRANGLER_CONFIG: outputFile
          }
        })

        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('custom domain host')
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('production config checker ignores misleading JSONC comments', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-commented-config-'))
    const outputFile = join(tempDir, 'wrangler.production.commented.jsonc')

    try {
      const content = readPackageFile('wrangler.production.example.jsonc')
        .replace('{', '{\n  // "workers_dev": true,\n  // "pattern": "localhost",\n  // "database_id": "00000000-0000-0000-0000-000000000000",')
        .replace('"pattern": "<your-tokenboard-domain>"', '"pattern": "tokenboard.example.com"')
        .replace('"BETTER_AUTH_URL": "https://<your-tokenboard-domain>"', '"BETTER_AUTH_URL": "https://tokenboard.example.com"')
        .replace('"database_id": "<your-d1-database-id>"', '"database_id": "11111111-1111-4111-8111-111111111111"')
      writeFileSync(outputFile, content)

      const result = spawnSync(process.execPath, [resolve(packageDir, 'scripts/check-production-config.mjs')], {
        cwd: packageDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          TOKENBOARD_WRANGLER_CONFIG: outputFile
        }
      })

      expect(result.status).toBe(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

function readPackageFile(relativePath: string): string {
  return readFileSync(resolve(packageDir, relativePath), 'utf8')
}

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(packageDir, '..', '..', relativePath), 'utf8')
}
