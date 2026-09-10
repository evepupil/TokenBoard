import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { assertWindowsShellSafeInvocation, buildShellInvocation, commandShellOption, runJsonCommand } from './command'

describe('runJsonCommand', () => {
  test('passes arguments directly without shell parsing', async () => {
    const result = await runJsonCommand(process.execPath, [
      '-e',
      'console.log(JSON.stringify({argv: process.argv.slice(1)}))',
      'value with spaces'
    ])

    expect(result).toEqual({ argv: ['value with spaces'] })
  })

  test('fails visibly when a command exceeds the configured timeout', async () => {
    await expect(
      runJsonCommand(process.execPath, ['-e', 'setTimeout(() => console.log(JSON.stringify({ ok: true })), 50)'], {
        timeoutMs: 1
      })
    ).rejects.toThrow()
  })

  test('retries transient package download failures before succeeding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tokenboard-command-'))
    const attemptsPath = join(dir, 'attempts.txt')
    const retryLogs: string[] = []

    const result = await runJsonCommand(
      process.execPath,
      [
        '-e',
        `
          const fs = require('node:fs')
          const path = process.argv[1]
          const attempts = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0
          fs.writeFileSync(path, String(attempts + 1))
          if (attempts < 1) {
            console.error('fetch failed')
            process.exit(1)
          }
          console.log(JSON.stringify({ok: true}))
        `,
        attemptsPath
      ],
      {
        retries: 2,
        retryDelayMs: 0,
        onRetry: (line) => retryLogs.push(line)
      }
    )

    await expect(readFile(attemptsPath, 'utf8')).resolves.toBe('2')
    expect(result).toEqual({ ok: true })
    expect(retryLogs).toHaveLength(1)
    expect(retryLogs[0]).toContain('fetch failed')
  })

  test('does not retry non-transient command failures', async () => {
    const retryLogs: string[] = []

    await expect(
      runJsonCommand(process.execPath, ['-e', 'console.error("invalid input"); process.exit(1)'], {
        retries: 2,
        retryDelayMs: 0,
        onRetry: (line) => retryLogs.push(line)
      })
    ).rejects.toThrow()
    expect(retryLogs).toEqual([])
  })

  test('runs Windows command shims through the shell', () => {
    expect(commandShellOption('npm.cmd', 'win32')).toBe(true)
    expect(commandShellOption('pnpm.bat', 'win32')).toBe(true)
    expect(commandShellOption('pnpm', 'win32')).toBe(false)
    expect(commandShellOption('npm.cmd', 'linux')).toBe(false)
  })

  test('rejects shell metacharacters before invoking a Windows command shim', () => {
    expect(() =>
      assertWindowsShellSafeInvocation('npm.cmd', ['exec', 'ccusage', '--timezone', 'UTC&whoami'], true)
    ).toThrow('Windows command argument 3')
    expect(() =>
      assertWindowsShellSafeInvocation('npm.cmd', ['exec', 'ccusage', '--timezone', 'Asia/Shanghai'], true)
    ).not.toThrow()
  })

  test('allows legal parentheses in Windows command arguments', () => {
    expect(() =>
      assertWindowsShellSafeInvocation(
        'npm.cmd',
        ['exec', 'ccusage', '--input-dir', 'C:\\Program Files (x86)\\TokenBoard'],
        true
      )
    ).not.toThrow()
  })

  test('rejects shell metacharacters in a Windows command shim path', () => {
    expect(() => assertWindowsShellSafeInvocation('C:/tools/npm.cmd&whoami', [], true)).toThrow(
      'Windows command shim path'
    )
  })

  test('allows legal parentheses in a Windows command shim path', () => {
    expect(() =>
      assertWindowsShellSafeInvocation(
        'C:/Program Files (x86)/nodejs/npm.cmd',
        ['exec', 'ccusage', '--timezone', 'Asia/Shanghai'],
        true
      )
    ).not.toThrow()
  })

  test('quotes Windows shell arguments including parenthesized paths', () => {
    expect(
      buildShellInvocation(
        'C:/Program Files (x86)/nodejs/npm.cmd',
        ['exec', 'ccusage', '--input-dir', 'C:/checkouts/(repo) with spaces', 'C:\\work\\'],
        true
      )
    ).toEqual({
      command: process.env.ComSpec || 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '""C:/Program Files (x86)/nodejs/npm.cmd" exec ccusage --input-dir "C:/checkouts/(repo) with spaces" "C:\\work\\\\""'
      ],
      shell: false,
      windowsVerbatimArguments: true
    })
  })

  test.skipIf(process.platform !== 'win32')('runs a Windows shim with quoted parenthesized arguments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tokenboard-command-windows-'))
    const shim = join(dir, 'capture shim.cmd')
    const printer = join(dir, 'capture-args.mjs')
    try {
      await writeFile(printer, 'console.log(JSON.stringify({ argv: process.argv.slice(2) }))\r\n', 'utf8')
      await writeFile(shim, `@echo off\r\nnode "${printer}" %*\r\n`, 'utf8')

      await expect(
        runJsonCommand(shim, ['alpha beta', 'C:\\Program Files (x86)\\TokenBoard\\', 'tail'])
      ).resolves.toEqual({
        argv: ['alpha beta', 'C:\\Program Files (x86)\\TokenBoard\\', 'tail']
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
