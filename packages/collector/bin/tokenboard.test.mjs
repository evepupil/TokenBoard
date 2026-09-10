import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
  assertWindowsShellSafeInvocation,
  buildInvocation,
  buildCollectorEnv,
  buildSpawnInvocation,
  buildWindowsCommandLine,
  formatSpawnFailure,
  shouldUseShell
} from './tokenboard.mjs'

test('builds bun invocation with bun x tsx', () => {
  expect(buildInvocation({ packageManager: 'bun', platform: 'darwin', passthroughArgs: ['preview'] })).toEqual({
    command: 'bun',
    args: ['x', 'tsx', 'src/cli.ts', 'preview']
  })
})

test('passes the bundled ccusage pricing config through the binary entrypoint', () => {
  expect(
    buildCollectorEnv({
      env: { PATH: '/bin' },
      configPath: '/repo/packages/collector/ccusage.json',
      fileExists: () => true
    })
  ).toMatchObject({
    PATH: '/bin',
    TOKENBOARD_CCUSAGE_CONFIG: '/repo/packages/collector/ccusage.json'
  })
  expect(
    buildCollectorEnv({
      env: { TOKENBOARD_CCUSAGE_CONFIG: '/custom/pricing.json' },
      configPath: '/repo/packages/collector/ccusage.json',
      fileExists: () => true
    }).TOKENBOARD_CCUSAGE_CONFIG
  ).toBe('/custom/pricing.json')
})

test('uses bun.exe on Windows', () => {
  expect(buildInvocation({ packageManager: 'bun', platform: 'win32', passthroughArgs: ['sync'] })).toEqual({
    command: 'bun.exe',
    args: ['x', 'tsx', 'src/cli.ts', 'sync']
  })
})

test('uses the Windows command shell for pnpm command shims', () => {
  const invocation = buildInvocation({ packageManager: 'pnpm', platform: 'win32' })
  expect(invocation.command).toBe('pnpm.cmd')
})

test('only enables command shims through the shell on Windows', () => {
  expect(shouldUseShell('pnpm.cmd', 'win32')).toBe(true)
  expect(shouldUseShell('pnpm.cmd', 'linux')).toBe(false)
  expect(shouldUseShell('/opt/tools/pnpm', 'linux')).toBe(false)
})

test('rejects shell metacharacters in Windows command arguments', () => {
  expect(() =>
    assertWindowsShellSafeInvocation('pnpm.cmd', ['exec', 'tsx', 'src/cli.ts', 'sync&whoami'], true)
  ).toThrow('Windows command argument 3')
  expect(() =>
    assertWindowsShellSafeInvocation('pnpm.cmd', ['exec', 'tsx', 'src/cli.ts', 'sync|whoami'], true)
  ).toThrow('Windows command argument 3')
})

test('allows legal Windows paths with parentheses', () => {
  expect(() =>
    assertWindowsShellSafeInvocation(
      'C:/Program Files (x86)/nodejs/pnpm.cmd',
      ['exec', 'tsx', '--input-dir', 'C:/checkouts/(repo)'],
      true
    )
  ).not.toThrow()
})

test('rejects shell metacharacters in Windows command shim paths', () => {
  expect(() => assertWindowsShellSafeInvocation('C:/tools/pnpm.cmd&whoami', [], true)).toThrow(
    'Windows command shim path'
  )
})

test('quotes Windows shim arguments in a single cmd.exe command line', () => {
  expect(
    buildWindowsCommandLine('C:/Program Files (x86)/pnpm.cmd', [
      'exec',
      'tsx',
      '--input-dir',
      'C:/checkouts/(repo) with spaces'
    ])
  ).toBe('""C:/Program Files (x86)/pnpm.cmd" exec tsx --input-dir "C:/checkouts/(repo) with spaces""')
  expect(buildWindowsCommandLine('pnpm.cmd', ['C:\\Program Files\\TokenBoard\\'])).toBe(
    'pnpm.cmd "C:\\Program Files\\TokenBoard\\\\"'
  )

  expect(
    buildSpawnInvocation({
      command: 'pnpm.cmd',
      args: ['exec', 'tsx', 'sync'],
      platform: 'win32'
    })
  ).toEqual({
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', 'pnpm.cmd exec tsx sync'],
    shell: false,
    windowsVerbatimArguments: true
  })
})

test('does not expose passthrough arguments when a shim fails to start', () => {
  const failure = formatSpawnFailure('C:\\Program Files\\pnpm.cmd', {
    code: 'EACCES',
    message: 'spawn C:\\Program Files\\pnpm.cmd EACCES --token secret-token'
  })

  expect(failure).toContain('pnpm.cmd')
  expect(failure).toContain('EACCES')
  expect(failure).not.toContain('secret-token')
  expect(failure).not.toContain('Program Files')
})

test.skipIf(process.platform !== 'win32')('starts the Windows binary entrypoint before invoking its shim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-bin-entry-'))
  const shim = join(root, 'fake shim.cmd')
  await writeFile(shim, '@echo off\r\nexit /b 0\r\n', 'utf8')
  try {
    const entrypoint = fileURLToPath(new URL('./tokenboard.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [entrypoint, '--smoke'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TOKENBOARD_PACKAGE_MANAGER: shim.slice(0, -4)
      }
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== 'win32')('runs a real Windows shim without splitting spaced arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-bin-'))
  const shim = join(root, 'capture shim.cmd')
  const printer = join(root, 'capture-args.mjs')
  try {
    await writeFile(printer, 'console.log(JSON.stringify(process.argv.slice(2)))\r\n', 'utf8')
    await writeFile(shim, `@echo off\r\nnode "${printer}" %*\r\n`, 'utf8')
    const invocation = buildSpawnInvocation({
      command: shim,
      args: ['alpha beta', 'C:\\Program Files (x86)\\TokenBoard\\', 'tail'],
      platform: 'win32'
    })
    const result = spawnSync(invocation.command, invocation.args, {
      shell: invocation.shell,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      encoding: 'utf8'
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(JSON.stringify(['alpha beta', 'C:\\Program Files (x86)\\TokenBoard\\', 'tail']))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
