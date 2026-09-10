import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'
import {
  createAntigravityLanguageServerClient,
  formatMetadataRequestHttpError,
  formatMetadataRequestTransportError,
  listAntigravityCascades,
  requestGeneratorMetadata,
  waitForReady,
  type AntigravityCascadeFileSystem
} from './antigravity-gui-client'
import type { AntigravityFileScanState } from './antigravity-file-scan'

const metadataResponseLimitBytes = 32 * 1024 * 1024
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))

vi.mock('node:https', () => ({ request: requestMock }))

describe('createAntigravityLanguageServerClient', () => {
  test('accepts a reachable TLS endpoint without a legacy startup marker', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const server = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      exitCode: null,
      signalCode: null
    }) as unknown as Parameters<typeof waitForReady>[0]
    const probe = vi.fn().mockResolvedValue(undefined)

    await expect(waitForReady(server, 43123, probe)).resolves.toBeUndefined()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith(43123)
  })

  test('rejects without waiting for a hanging readiness probe after the language server has already exited', async () => {
    vi.useFakeTimers()
    vi.stubEnv('TOKENBOARD_ANTIGRAVITY_READY_TIMEOUT_MS', '1')
    const server = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: 1,
      signalCode: null
    }) as unknown as Parameters<typeof waitForReady>[0]
    const probe = vi.fn(() => new Promise<void>(() => {}))
    const readiness = waitForReady(server, 43123, probe)
    const completion = readiness.then(
      () => ({ error: null }),
      (error) => ({ error })
    )

    try {
      expect(probe).not.toHaveBeenCalled()
      await expect(completion).resolves.toMatchObject({
        error: expect.objectContaining({ message: 'Antigravity language server exited before it was ready' })
      })
    } finally {
      await vi.advanceTimersByTimeAsync(1)
      await completion
      vi.unstubAllEnvs()
      vi.useRealTimers()
    }
  })

  test('does not include raw response bodies in metadata HTTP errors', () => {
    const rawBody = [
      'prompt: summarize /Users/test/private/project/file.ts',
      'email: user@example.com',
      'completion: raw local content'
    ].join('\n')
    const message = formatMetadataRequestHttpError('antigravity', 500)

    expect(message).toBe('Antigravity metadata request failed for antigravity: HTTP 500')
    expect(message).not.toContain(rawBody)
    expect(message).not.toContain('/Users/test/private/project/file.ts')
    expect(message).not.toContain('user@example.com')
    expect(message).not.toContain('raw local content')
  })

  test('formats metadata transport errors with a stable source prefix', () => {
    expect(formatMetadataRequestTransportError('antigravity', new Error('socket hang up'))).toBe(
      'Antigravity metadata request transport failed for antigravity: socket hang up'
    )
    expect(formatMetadataRequestTransportError('antigravity', new Error(''))).toBe(
      'Antigravity metadata request transport failed for antigravity: Error'
    )
    expect(formatMetadataRequestTransportError('antigravity', Object.create(null))).toBe(
      'Antigravity metadata request transport failed for antigravity: Unknown error'
    )
  })

  test('rejects and aborts metadata responses larger than the response limit', async () => {
    const response = Object.assign(new PassThrough(), { statusCode: 200 })
    const request = new EventEmitter()
    const expectedMessage = `Antigravity metadata response exceeded the ${metadataResponseLimitBytes}-byte limit for antigravity`
    const destroy = vi.spyOn(response, 'destroy')

    try {
      Object.assign(request, { end: vi.fn() })
      requestMock.mockImplementation((_options, callback) => {
        callback(response)
        return request
      })

      const metadata = requestGeneratorMetadata({
        source: 'antigravity',
        cascadeId: cascadeId(1),
        port: 1,
        csrfToken: 'test-csrf-token'
      })
      response.write(Buffer.alloc(metadataResponseLimitBytes, 0x61))
      expect(destroy).not.toHaveBeenCalled()
      response.end(Buffer.from('a'))

      await expect(metadata).rejects.toThrow(expectedMessage)
      expect(destroy).toHaveBeenCalledWith()
    } finally {
      requestMock.mockReset()
    }
  })

  test('aborts non-success metadata responses instead of draining them', async () => {
    const response = Object.assign(new PassThrough(), { statusCode: 500 })
    const request = new EventEmitter()
    const destroy = vi.spyOn(response, 'destroy')

    try {
      Object.assign(request, { end: vi.fn() })
      requestMock.mockImplementation((_options, callback) => {
        callback(response)
        return request
      })

      const metadata = requestGeneratorMetadata({
        source: 'antigravity',
        cascadeId: cascadeId(2),
        port: 1,
        csrfToken: 'test-csrf-token'
      })

      await expect(metadata).rejects.toThrow('Antigravity metadata request failed for antigravity: HTTP 500')
      expect(destroy).toHaveBeenCalledWith()
    } finally {
      requestMock.mockReset()
    }
  })

  test('reports metadata timeouts without transport-error wrapping', async () => {
    const request = new EventEmitter()
    const destroy = vi.fn((error?: Error) => {
      request.emit('error', error ?? new Error('socket hang up'))
    })

    try {
      Object.assign(request, { destroy, end: vi.fn() })
      requestMock.mockImplementation(() => request)

      const metadata = requestGeneratorMetadata({
        source: 'antigravity',
        cascadeId: cascadeId(3),
        port: 1,
        csrfToken: 'test-csrf-token'
      })
      request.emit('timeout')

      await expect(metadata).rejects.toMatchObject({
        message: 'Antigravity metadata request timed out for antigravity'
      })
      expect(destroy).toHaveBeenCalledWith()
    } finally {
      requestMock.mockReset()
    }
  })

  test.skipIf(process.platform === 'win32')('closes the language server process when startup times out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-ls-'))
    const previousTimeout = process.env.TOKENBOARD_ANTIGRAVITY_READY_TIMEOUT_MS
    const previousPidFile = process.env.TOKENBOARD_ANTIGRAVITY_TEST_PID_FILE
    try {
      const serverPath = join(root, 'server.mjs')
      const pidPath = join(root, 'server.pid')
      await writeFile(
        serverPath,
        ['#!/bin/sh', 'printf "%s" "$$" > "$TOKENBOARD_ANTIGRAVITY_TEST_PID_FILE"', 'while :; do sleep 1; done'].join(
          '\n'
        )
      )
      await chmod(serverPath, 0o700)
      process.env.TOKENBOARD_ANTIGRAVITY_READY_TIMEOUT_MS = '500'
      process.env.TOKENBOARD_ANTIGRAVITY_TEST_PID_FILE = pidPath

      const client = createAntigravityLanguageServerClient({
        source: 'antigravity',
        languageServerPath: serverPath
      })
      const timeoutAssertion = expect(client).rejects.toThrow('Timed out starting Antigravity language server')
      const pid = await readPid(pidPath)

      await timeoutAssertion
      await expectProcessExited(pid)
    } finally {
      restoreEnv('TOKENBOARD_ANTIGRAVITY_READY_TIMEOUT_MS', previousTimeout)
      restoreEnv('TOKENBOARD_ANTIGRAVITY_TEST_PID_FILE', previousPidFile)
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')('does not treat an unrelated port diagnostic as readiness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-ls-port-diagnostic-'))
    const previousTimeout = process.env.TOKENBOARD_ANTIGRAVITY_READY_TIMEOUT_MS
    try {
      const serverPath = join(root, 'server.mjs')
      await writeFile(
        serverPath,
        [
          '#!/usr/bin/env node',
          'const portIndex = process.argv.indexOf("--https_server_port")',
          'const port = process.argv[portIndex + 1]',
          'process.stderr.write(`diagnostic: retrying upstream at 127.0.0.1:${port}`)',
          'setInterval(() => undefined, 1000)'
        ].join('\n')
      )
      await chmod(serverPath, 0o700)
      process.env.TOKENBOARD_ANTIGRAVITY_READY_TIMEOUT_MS = '300'

      const result = await createAntigravityLanguageServerClient({
        source: 'antigravity',
        languageServerPath: serverPath
      }).then(
        async (client) => {
          await client.close()
          return 'resolved'
        },
        (error) => error
      )

      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toContain('Timed out starting Antigravity language server')
    } finally {
      restoreEnv('TOKENBOARD_ANTIGRAVITY_READY_TIMEOUT_MS', previousTimeout)
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')(
    'does not expose language server startup output in exit errors',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-ls-private-output-'))
      try {
        const serverPath = join(root, 'server.mjs')
        await writeFile(
          serverPath,
          [
            '#!/usr/bin/env node',
            'process.stderr.write("/Users/test/private/prompt.txt RAW_LANGUAGE_SERVER_OUTPUT")',
            'process.exit(1)'
          ].join('\n')
        )
        await chmod(serverPath, 0o700)

        const error = await createAntigravityLanguageServerClient({
          source: 'antigravity',
          languageServerPath: serverPath
        }).then(
          () => null,
          (cause) => cause
        )

        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe('Antigravity language server exited before it was ready')
        expect((error as Error).message).not.toContain('/Users/test/private')
        expect((error as Error).message).not.toContain('RAW_LANGUAGE_SERVER_OUTPUT')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})

describe('listAntigravityCascades', () => {
  test('marks cascades that have a SQLite history file', async () => {
    const id = cascadeId(0)
    const fileSystem: AntigravityCascadeFileSystem = {
      listFiles: async function* () {
        yield { name: `${id}.pb`, isFile: () => true }
      },
      stat: async (path) => (path.endsWith('.db') ? { mtimeMs: 200, size: 30 } : { mtimeMs: 100, size: 20 })
    }

    const cascades = await listAntigravityCascades({
      source: 'antigravity',
      conversationDir: '/tmp/tokenboard-antigravity-db-marker',
      fileSystem
    })

    expect(cascades).toEqual([
      {
        id,
        mtimeMs: 200,
        size: 30,
        hasDatabaseFile: true
      }
    ])
  })

  test('selects newest requestable cascades before applying the limit', async () => {
    const statPaths: string[] = []
    const mtimes = new Map([
      [cascadeId(0), 100],
      [cascadeId(1), 300],
      [cascadeId(2), 200]
    ])
    const fileSystem: AntigravityCascadeFileSystem = {
      listFiles: async function* () {
        for (const index of [0, 2, 1]) {
          const name = `${cascadeId(index)}.pb`
          yield {
            name,
            isFile: () => true
          }
        }
      },
      stat: async (path) => {
        statPaths.push(path)
        if (path.endsWith('.db')) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }
        const id = path.match(/[0-9a-f-]{36}/)?.[0]
        return { mtimeMs: mtimes.get(id ?? '') ?? 0, size: 20 }
      }
    }

    const cascades = await listAntigravityCascades({
      source: 'antigravity',
      conversationDir: '/tmp/tokenboard-antigravity-cascades',
      limit: 2,
      fileSystem
    })

    expect(cascades.map((cascade) => cascade.id)).toEqual([cascadeId(1), cascadeId(2)])
    expect(statPaths.some((path) => path.includes(cascadeId(0)))).toBe(true)
    expect(statPaths.some((path) => path.includes(cascadeId(1)))).toBe(true)
    expect(statPaths.some((path) => path.includes(cascadeId(2)))).toBe(true)
  })

  test('bounds metadata stats while retaining candidates from both ends of the directory', async () => {
    const listed: string[] = []
    const statPaths: string[] = []
    const fileSystem: AntigravityCascadeFileSystem = {
      listFiles: async function* () {
        for (let index = 0; index < 500; index += 1) {
          const name = `${cascadeId(index)}.pb`
          listed.push(name)
          yield {
            name,
            isFile: () => true
          }
        }
      },
      stat: async (path) => {
        statPaths.push(path)
        if (path.endsWith('.db')) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }
        const id = path.match(/[0-9a-f-]{36}/)?.[0]
        return { mtimeMs: Number(id?.slice(-12) ?? 0), size: 20 }
      }
    }

    const cascades = await listAntigravityCascades({
      source: 'antigravity',
      conversationDir: '/tmp/tokenboard-antigravity-large-cascades',
      limit: 2,
      fileSystem
    })

    expect(listed).toHaveLength(500)
    expect(statPaths.length).toBeLessThanOrEqual(130)
    expect(cascades).toHaveLength(2)
    expect(cascades.map((cascade) => cascade.id)).toEqual([cascadeId(499), cascadeId(498)])
  })

  test('does not miss newest cascades when directory order lists them after old entries', async () => {
    const fileSystem: AntigravityCascadeFileSystem = {
      listFiles: async function* () {
        for (let index = 0; index < 500; index += 1) {
          yield {
            name: `${cascadeId(index)}.pb`,
            isFile: () => true
          }
        }
      },
      stat: async (path) => {
        if (path.endsWith('.db')) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }
        const id = path.match(/[0-9a-f-]{36}/)?.[0]
        const index = Number(id?.slice(-12) ?? 0)
        return { mtimeMs: index >= 498 ? 10_000 + index : index, size: 20 }
      }
    }

    const cascades = await listAntigravityCascades({
      source: 'antigravity',
      conversationDir: '/tmp/tokenboard-antigravity-unsorted-cascades',
      limit: 2,
      fileSystem
    })

    expect(cascades.map((cascade) => cascade.id)).toEqual([cascadeId(499), cascadeId(498)])
  })

  test('stats required cascades even when they are outside the bounded directory window', async () => {
    const listed: string[] = []
    const statPaths: string[] = []
    const requiredId = cascadeId(499)
    const fileSystem: AntigravityCascadeFileSystem = {
      listFiles: async function* () {
        for (let index = 0; index < 500; index += 1) {
          const name = `${cascadeId(index)}.pb`
          listed.push(name)
          yield {
            name,
            isFile: () => true
          }
        }
      },
      stat: async (path) => {
        statPaths.push(path)
        if (path.endsWith('.db')) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }
        const id = path.match(/[0-9a-f-]{36}/)?.[0]
        return { mtimeMs: Number(id?.slice(-12) ?? 0), size: 20 }
      }
    }

    const cascades = await listAntigravityCascades({
      source: 'antigravity',
      conversationDir: '/tmp/tokenboard-antigravity-required-cascades',
      limit: 2,
      requiredCascadeIds: [requiredId],
      includeCascade: (cascade) => cascade.id === requiredId,
      fileSystem
    })

    expect(listed).toHaveLength(500)
    expect(statPaths.length).toBeLessThanOrEqual(130)
    expect(cascades.map((cascade) => cascade.id)).toEqual([requiredId])
    expect(statPaths.some((path) => path.includes(requiredId))).toBe(true)
  })

  test('keeps metadata stats bounded without truncating newer directory entries', async () => {
    const listed: string[] = []
    const statPaths: string[] = []
    const fileSystem: AntigravityCascadeFileSystem = {
      listFiles: async function* () {
        for (let index = 0; index < 2_000; index += 1) {
          const name = `${cascadeId(index)}.pb`
          listed.push(name)
          yield { name, isFile: () => true }
        }
      },
      stat: async (path) => {
        statPaths.push(path)
        if (path.endsWith('.db')) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        const id = path.match(/[0-9a-f-]{36}/)?.[0]
        return { mtimeMs: Number(id?.slice(-12) ?? 0), size: 20 }
      }
    }

    const cascades = await listAntigravityCascades({
      source: 'antigravity',
      conversationDir: '/tmp/tokenboard-antigravity-bounded-cascades',
      limit: 2,
      fileSystem
    })

    expect(listed).toHaveLength(2_000)
    expect(statPaths).toHaveLength(128)
    expect(cascades.map((cascade) => cascade.id)).toEqual([cascadeId(1_999), cascadeId(1_998)])
  })

  test('rotates bounded metadata scans until middle cascades are indexed', async () => {
    const scanState: AntigravityFileScanState = { nextSequence: 0, files: {} }
    let statCount = 0
    const fileSystem: AntigravityCascadeFileSystem = {
      listFiles: async function* () {
        for (let index = 0; index < 200; index += 1) {
          yield { name: `${cascadeId(index)}.pb`, isFile: () => true }
        }
      },
      stat: async (path) => {
        statCount += 1
        if (path.endsWith('.db')) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        const id = path.match(/[0-9a-f-]{36}/)?.[0]
        const index = Number(id?.slice(-12) ?? 0)
        return { mtimeMs: index === 100 ? 10_000 : index, size: 20 }
      }
    }
    let foundMiddle = false

    for (let run = 0; run < 6; run += 1) {
      statCount = 0
      const cascades = await listAntigravityCascades({
        source: 'antigravity',
        conversationDir: '/tmp/tokenboard-antigravity-rotating-cascades',
        limit: 2,
        fileSystem,
        scanState
      })
      expect(statCount).toBeLessThanOrEqual(128)
      foundMiddle ||= cascades.some((cascade) => cascade.id === cascadeId(100))
    }

    expect(Object.keys(scanState.files)).toHaveLength(200)
    expect(foundMiddle).toBe(true)
  })

  test('refreshes known cascades while unseen files fill the discovery budget', async () => {
    const scanState: AntigravityFileScanState = { nextSequence: 0, files: {} }
    const knownId = cascadeId(0)
    let includeUnseen = false
    const statPaths: string[] = []
    const fileSystem: AntigravityCascadeFileSystem = {
      listFiles: async function* () {
        yield { name: `${knownId}.pb`, isFile: () => true }
        if (!includeUnseen) return
        for (let index = 1; index <= 100; index += 1) {
          yield { name: `${cascadeId(index)}.pb`, isFile: () => true }
        }
      },
      stat: async (path) => {
        statPaths.push(path)
        if (path.endsWith('.db')) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        const id = path.match(/[0-9a-f-]{36}/)?.[0]
        const index = Number(id?.slice(-12) ?? 0)
        return { mtimeMs: id === knownId && includeUnseen ? 10_000 : index, size: 20 }
      }
    }

    await listAntigravityCascades({
      source: 'antigravity',
      conversationDir: '/tmp/tokenboard-antigravity-refresh-cascades',
      limit: 2,
      fileSystem,
      scanState
    })
    includeUnseen = true
    statPaths.length = 0

    const cascades = await listAntigravityCascades({
      source: 'antigravity',
      conversationDir: '/tmp/tokenboard-antigravity-refresh-cascades',
      limit: 2,
      fileSystem,
      scanState
    })

    expect(statPaths).toContain(join('/tmp/tokenboard-antigravity-refresh-cascades', `${knownId}.pb`))
    expect(cascades[0]?.id).toBe(knownId)
  })

  test('fails visibly instead of truncating directories beyond the safety bound', async () => {
    let listed = 0
    const fileSystem: AntigravityCascadeFileSystem = {
      listFiles: async function* () {
        for (let index = 0; index <= 10_000; index += 1) {
          listed += 1
          yield { name: `${cascadeId(index)}.pb`, isFile: () => true }
        }
      },
      stat: async () => ({ mtimeMs: 1, size: 1 })
    }

    await expect(
      listAntigravityCascades({
        source: 'antigravity',
        conversationDir: '/tmp/tokenboard-antigravity-overflow-cascades',
        limit: 2,
        fileSystem
      })
    ).rejects.toThrow('Antigravity conversations directory exceeds the 10000-entry scan limit')
    expect(listed).toBe(10_001)
  })
})

async function readPid(path: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return Number(await readFile(path, 'utf8'))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Expected test language server to write a pid file')
}

async function expectProcessExited(pid: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isProcessRunning(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
  throw new Error(`Expected process ${pid} to exit`)
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function cascadeId(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}
