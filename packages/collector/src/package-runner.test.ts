import { afterEach, describe, expect, test, vi } from 'vitest'
import { resolvePackageRunner } from './package-runner'

describe('resolvePackageRunner', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('uses npx by default', () => {
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    const runner = resolvePackageRunner()

    expect(runner.command).toBe('npx')
    expect(runner.runPackageArgs('ccusage@latest', 'ccusage', ['daily', '--json'])).toEqual([
      'ccusage@latest',
      'daily',
      '--json'
    ])
  })

  test('supports bunx when package manager is bun', () => {
    vi.stubEnv('TOKENBOARD_BUNX_BIN', '/opt/bin/bunx')
    const runner = resolvePackageRunner('bun')

    expect(runner.command).toBe('/opt/bin/bunx')
    expect(runner.runPackageArgs('@ccusage/codex@latest', 'ccusage-codex', ['session', '--json'])).toEqual([
      '@ccusage/codex@latest',
      'session',
      '--json'
    ])
  })

  test('supports npm exec package invocation', () => {
    vi.stubEnv('TOKENBOARD_NPM_BIN', '/opt/bin/npm')
    const runner = resolvePackageRunner('npm')

    expect(runner.command).toBe('/opt/bin/npm')
    expect(runner.runPackageArgs('ccusage@latest', 'ccusage', ['daily', '--json'])).toEqual([
      'exec',
      '--yes',
      '--package',
      'ccusage@latest',
      '--',
      'ccusage',
      'daily',
      '--json'
    ])
  })
})
