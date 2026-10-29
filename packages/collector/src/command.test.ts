import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test } from 'vitest'
import {
  assertWindowsShellSafeInvocation,
  buildShellInvocation,
  commandShellOption,
  describeCommandFailure,
  runJsonCommand
} from './command'

// Temp directories created below are removed after each test so repeated runs do not
// accumulate directories in the OS temp folder.
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('runJsonCommand', () => {
  test('passes arguments directly without shell parsing', async () => {
    const result = await runJsonCommand(process.execPath, [
      '-e',
      'console.log(JSON.stringify({argv: process.argv.slice(1)}))',
      'value with spaces'
    ])

    expect(result).toEqual({ argv: ['value with spaces'] })
  })

  // Node's raw kill error is a bare `Command failed: <invocation>` with no stderr, which reads
  // exactly like the tool exiting non-zero; the timeout must be named so the log explains
  // itself, with any captured stderr preserved.
  test('fails visibly and names the timeout when a command exceeds its budget', async () => {
    await expect(
      runJsonCommand(process.execPath, ['-e', 'setTimeout(() => console.log(JSON.stringify({ ok: true })), 50)'], {
        timeoutMs: 1
      })
    ).rejects.toThrow(/^Command timed out after 1ms: /)
  })

  // A kill with no captured stderr (the common case) must not append a dangling newline.
  test('omits the stderr line when the killed command wrote none', async () => {
    await expect(
      runJsonCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 100 })
    ).rejects.toThrow(/^Command timed out after 100ms: [^\n]*$/)
  })

  // Node discards a killed child's stderr, so the message cannot promise it — but it must
  // still name the timeout and carry the invocation, which is what a run record needs.
  test('names the timeout even when the child wrote stderr before being killed', async () => {
    await expect(
      runJsonCommand(process.execPath, ['-e', 'console.error("partial diagnostics"); setTimeout(() => {}, 60000)'], {
        timeoutMs: 100
      })
    ).rejects.toThrow(/^Command timed out after 100ms: /)
  })

  test('leaves non-timeout failures untouched', () => {
    const failure = Object.assign(new Error('Command failed: tool exited 1\nboom'), { killed: false, signal: null })
    expect(describeCommandFailure(failure, { command: 'tool', args: ['--x'], timeoutMs: 5 })).toBe(failure)
  })

  test('retries transient package download failures before succeeding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tokenboard-command-'))
    tempDirs.push(dir)
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

  // On a machine with no bundled ccusage binary the command is `npx`/`pnpm dlx`, which
  // downloads and executes a third-party package. That package must not inherit the upload
  // token: it authorizes writes as this device, and nothing ccusage does needs it.
  test('strips credential variables from the child environment', async () => {
    const result = await runJsonCommand(
      process.execPath,
      [
        '-e',
        'console.log(JSON.stringify({ token: process.env.TOKENBOARD_UPLOAD_TOKEN ?? null, ' +
          'pairing: process.env.TOKENBOARD_PAIRING_CODE ?? null, ' +
          'kept: process.env.TOKENBOARD_STATE_DIR ?? null }))'
      ],
      {
        env: {
          ...process.env,
          TOKENBOARD_UPLOAD_TOKEN: 'tb_upload_must_not_leak',
          TOKENBOARD_PAIRING_CODE: 'tb_pair_must_not_leak',
          TOKENBOARD_STATE_DIR: '/tmp/kept-for-the-child'
        }
      }
    )

    expect(result).toEqual({ token: null, pairing: null, kept: '/tmp/kept-for-the-child' })
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
