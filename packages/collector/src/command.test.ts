import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { commandShellOption, runJsonCommand } from './command'

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
      runJsonCommand(
        process.execPath,
        ['-e', 'setTimeout(() => console.log(JSON.stringify({ ok: true })), 50)'],
        { timeoutMs: 1 }
      )
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
      runJsonCommand(
        process.execPath,
        ['-e', 'console.error("invalid input"); process.exit(1)'],
        {
          retries: 2,
          retryDelayMs: 0,
          onRetry: (line) => retryLogs.push(line)
        }
      )
    ).rejects.toThrow()
    expect(retryLogs).toEqual([])
  })

  test('runs Windows command shims through the shell', () => {
    expect(commandShellOption('npm.cmd', 'win32')).toBe(true)
    expect(commandShellOption('pnpm.bat', 'win32')).toBe(true)
    expect(commandShellOption('pnpm', 'win32')).toBe(false)
    expect(commandShellOption('npm.cmd', 'linux')).toBe(false)
  })
})
