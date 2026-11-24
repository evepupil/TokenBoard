import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ccusagePackageSpecifier, resolvePackageRunner } from './package-runner'

const expectedCcusagePackageSpecifier = 'ccusage@20.0.33'
const packageJsonPath = join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json')

describe('resolvePackageRunner', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('pins package runner ccusage to the adapted version', () => {
    expect(ccusagePackageSpecifier).toBe(expectedCcusagePackageSpecifier)
    expect(ccusagePackageSpecifier).not.toBe('ccusage@latest')
  })

  test('keeps package runner ccusage version aligned with package dependency', () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }

    expect(ccusagePackageSpecifier).toBe(`ccusage@${packageJson.dependencies?.ccusage}`)
  })

  test('uses npx by default', () => {
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    const runner = resolvePackageRunner()

    expect(runner.command).toBe(platformCommand('npx'))
    expect(runner.runPackageArgs(expectedCcusagePackageSpecifier, 'ccusage', ['daily', '--json'])).toEqual([
      expectedCcusagePackageSpecifier,
      'daily',
      '--json'
    ])
  })

  test('passes the checkout pricing configuration when explicitly provided', () => {
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')
    vi.stubEnv('TOKENBOARD_CCUSAGE_CONFIG', packageConfigPath())

    expect(
      resolvePackageRunner().runPackageArgs(expectedCcusagePackageSpecifier, 'ccusage', ['daily', '--json'])
    ).toEqual([expectedCcusagePackageSpecifier, 'daily', '--json', '--config', packageConfigPath()])
  })

  // A hook runs inside the editor lifecycle and must not reach the network. The local binary
  // check above would have covered the normal install; reaching here means none exists, so the
  // runner must refuse the `npx`/`pnpm dlx` fallback that would fetch one mid-session. The Go
  // client refuses the same way in hook mode (`ccusage/acquire.go`).
  test('hook mode refuses to fall back to a network package runner', () => {
    vi.stubEnv('TOKENBOARD_PACKAGE_MANAGER', '')
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '')
    vi.stubEnv('TOKENBOARD_CCUSAGE_BIN', '')

    expect(() => resolvePackageRunner(undefined, 'linux', () => false, {}, true)).toThrow(
      'hook mode does not download it'
    )
  })

  test('hook mode honors an explicit operator forced package runner', () => {
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '')
    expect(() =>
      resolvePackageRunner(undefined, 'linux', () => false, { TOKENBOARD_FORCE_PACKAGE_RUNNER: '1' }, true)
    ).not.toThrow()
  })

  test('prefers the generated dynamic pricing configuration over the static override', () => {
    const dynamicPath = '/tmp/tokenboard/ccusage.dynamic.json'
    const runner = resolvePackageRunner('', process.platform, (path) => path === dynamicPath, {
      TOKENBOARD_FORCE_PACKAGE_RUNNER: '1',
      TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG: dynamicPath,
      TOKENBOARD_CCUSAGE_CONFIG: packageConfigPath()
    })

    expect(runner.runPackageArgs(expectedCcusagePackageSpecifier, 'ccusage', ['daily', '--json'])).toEqual([
      'ccusage@20.0.33',
      'daily',
      '--json',
      '--config',
      dynamicPath
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
    expect(runner.runPackageArgs(expectedCcusagePackageSpecifier, 'ccusage', ['codex', 'session', '--json'])).toEqual([
      expectedCcusagePackageSpecifier,
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
    expect(runner.runPackageArgs(expectedCcusagePackageSpecifier, 'ccusage', ['daily', '--json'])).toEqual([
      'exec',
      '--yes',
      '--package',
      expectedCcusagePackageSpecifier,
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
    expect(runner.runPackageArgs(expectedCcusagePackageSpecifier, 'ccusage', ['daily', '--json'])).toEqual([
      'dlx',
      expectedCcusagePackageSpecifier,
      'daily',
      '--json'
    ])
  })

  test('uses local ccusage binary for the hot path by default', () => {
    vi.stubEnv('TOKENBOARD_CCUSAGE_BIN', '/opt/bin/ccusage')
    const runner = resolvePackageRunner('pnpm', process.platform, () => true)

    expect(runner.command).toBe('/opt/bin/ccusage')
    expect(runner.runPackageArgs(expectedCcusagePackageSpecifier, 'ccusage', ['codex', 'daily', '--json'])).toEqual([
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
    expect(runner.runPackageArgs(expectedCcusagePackageSpecifier, 'ccusage', ['codex', 'daily', '--json'])).toEqual([
      'dlx',
      expectedCcusagePackageSpecifier,
      'codex',
      'daily',
      '--json'
    ])
  })
})

function platformCommand(command: string) {
  return process.platform === 'win32' ? `${command}.cmd` : command
}

function packageConfigPath() {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'ccusage.json')
}
