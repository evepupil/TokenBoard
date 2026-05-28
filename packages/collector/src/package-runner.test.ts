import { afterEach, describe, expect, test, vi } from 'vitest'
import { resolvePackageRunner } from './package-runner'

describe('resolvePackageRunner', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('uses npx by default', () => {
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    const runner = resolvePackageRunner()

    expect(runner.command).toBe(platformCommand('npx'))
    expect(runner.runPackageArgs('ccusage@latest', 'ccusage', ['daily', '--json'])).toEqual([
      'ccusage@latest',
      'daily',
      '--json'
    ])
  })

  test('uses Windows command shims on win32', () => {
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    expect(resolvePackageRunner(undefined, 'win32').command).toBe('npx.cmd')
    expect(resolvePackageRunner('npm', 'win32').command).toBe('npm.cmd')
    expect(resolvePackageRunner('pnpm', 'win32').command).toBe('pnpm.cmd')
  })

  test('supports bunx when package manager is bun', () => {
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_BUNX_BIN', '/opt/bin/bunx')
    const runner = resolvePackageRunner('bun')

    expect(runner.command).toBe('/opt/bin/bunx')
    expect(runner.runPackageArgs('ccusage@latest', 'ccusage', ['codex', 'session', '--json'])).toEqual([
      'ccusage@latest',
      'codex',
      'session',
      '--json'
    ])
  })

  test('supports npm exec package invocation', () => {
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
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

  test('supports pnpm dlx package invocation', () => {
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_PNPM_BIN', '/opt/bin/pnpm')
    const runner = resolvePackageRunner('pnpm')

    expect(runner.command).toBe('/opt/bin/pnpm')
    expect(runner.runPackageArgs('ccusage@latest', 'ccusage', ['daily', '--json'])).toEqual([
      'dlx',
      'ccusage@latest',
      'daily',
      '--json'
    ])
  })

  test('uses local ccusage binary for the hot path by default', () => {
    vi.stubEnv('TOKENBOARD_CCUSAGE_BIN', '/opt/bin/ccusage')
    const runner = resolvePackageRunner('pnpm', process.platform, () => true)

    expect(runner.command).toBe('/opt/bin/ccusage')
    expect(runner.runPackageArgs('ccusage@latest', 'ccusage', ['codex', 'daily', '--json'])).toEqual([
      'codex',
      'daily',
      '--json'
    ])
  })

  test('fails when forced ccusage binary is missing', () => {
    vi.stubEnv('TOKENBOARD_CCUSAGE_BIN', '/opt/bin/missing-ccusage')

    expect(() => resolvePackageRunner('pnpm', process.platform, () => false)).toThrow(
      'TOKENBOARD_CCUSAGE_BIN does not exist: /opt/bin/missing-ccusage'
    )
  })

  test('falls back to package runner when local ccusage is missing', () => {
    const runner = resolvePackageRunner('pnpm', process.platform, () => false)

    expect(runner.command).toBe(platformCommand('pnpm'))
    expect(runner.runPackageArgs('ccusage@latest', 'ccusage', ['codex', 'daily', '--json'])).toEqual([
      'dlx',
      'ccusage@latest',
      'codex',
      'daily',
      '--json'
    ])
  })
})

function platformCommand(command: string) {
  return process.platform === 'win32' ? `${command}.cmd` : command
}
