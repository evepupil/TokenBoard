import { EventEmitter } from 'node:events'
import { constants } from 'node:fs'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'
import { createCodexSessionCloner } from './codex-session-cloner'

describe('Codex session cloner', () => {
  test('uses one persistent macOS clone helper for multiple clone requests and closes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cloner-test-'))
    const firstSource = join(root, 'first-source.jsonl')
    const secondSource = join(root, 'second-source.jsonl')
    const firstTarget = join(root, 'first-target.jsonl')
    const secondTarget = join(root, 'second-target.jsonl')
    const helper = createFakeMacOsHelper(async (request) => {
      await copyFile(request.source, request.target, constants.COPYFILE_EXCL)
      return { ok: true }
    })
    const spawnProcess = vi.fn(() => helper.child) as unknown as typeof import('node:child_process').spawn

    try {
      await writeFile(firstSource, 'first\n')
      await writeFile(secondSource, 'second\n')
      const cloner = createCodexSessionCloner({ platform: 'darwin', spawnProcess })

      await cloner.copy(firstSource, firstTarget)
      await cloner.copy(secondSource, secondTarget)
      await cloner.close()

      expect(spawnProcess).toHaveBeenCalledTimes(1)
      expect(helper.requests).toEqual([
        { source: firstSource, target: firstTarget },
        { source: secondSource, target: secondTarget }
      ])
      await expect(readFile(firstTarget, 'utf8')).resolves.toBe('first\n')
      await expect(readFile(secondTarget, 'utf8')).resolves.toBe('second\n')
      expect(helper.closeCount).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('falls back once to bounded standard copies when macOS clonefile is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cloner-test-'))
    const firstSource = join(root, 'first-source.jsonl')
    const secondSource = join(root, 'second-source.jsonl')
    const firstTarget = join(root, 'first-target.jsonl')
    const secondTarget = join(root, 'second-target.jsonl')
    const helper = createFakeMacOsHelper(async () => ({ ok: false, errno: 45 }))
    const copyModes: Array<number | undefined> = []
    const fallback = vi.fn()
    const injectedCopy = async (
      source: Parameters<typeof copyFile>[0],
      target: Parameters<typeof copyFile>[1],
      mode?: Parameters<typeof copyFile>[2]
    ) => {
      copyModes.push(mode)
      await copyFile(source, target, mode)
    }

    try {
      await writeFile(firstSource, 'first\n')
      await writeFile(secondSource, 'second\n')
      const cloner = createCodexSessionCloner({
        platform: 'darwin',
        spawnProcess: vi.fn(() => helper.child) as unknown as typeof import('node:child_process').spawn,
        copyFile: injectedCopy,
        onFallback: fallback
      })

      await cloner.copy(firstSource, firstTarget)
      await cloner.copy(secondSource, secondTarget)
      await cloner.close()

      expect(fallback).toHaveBeenCalledTimes(1)
      expect(copyModes).toEqual([constants.COPYFILE_EXCL, constants.COPYFILE_EXCL])
      expect(helper.requests).toHaveLength(1)
      await expect(readFile(firstTarget, 'utf8')).resolves.toBe('first\n')
      await expect(readFile(secondTarget, 'utf8')).resolves.toBe('second\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('falls back when the macOS clone helper emits an asynchronous ENOENT', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cloner-test-'))
    const source = join(root, 'source.jsonl')
    const target = join(root, 'target.jsonl')
    const helper = createFakeMacOsHelper(async () => await new Promise<never>(() => {}))
    const fallback = vi.fn()

    try {
      await writeFile(source, 'source\n')
      const cloner = createCodexSessionCloner({
        platform: 'darwin',
        spawnProcess: vi.fn(() => {
          queueMicrotask(() => helper.failToStart())
          return helper.child
        }) as unknown as typeof import('node:child_process').spawn,
        onFallback: fallback
      })

      await cloner.copy(source, target)
      await cloner.close()

      expect(fallback).toHaveBeenCalledTimes(1)
      await expect(readFile(target, 'utf8')).resolves.toBe('source\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails a clone request when a live macOS helper never responds', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cloner-test-'))
    const source = join(root, 'source.jsonl')
    const target = join(root, 'target.jsonl')
    const helper = createFakeMacOsHelper(async () => await new Promise<never>(() => {}))
    const cloner = createCodexSessionCloner({
      platform: 'darwin',
      spawnProcess: vi.fn(() => helper.child) as unknown as typeof import('node:child_process').spawn
    })
    let settled = false
    let copy: Promise<{ error: unknown }> | undefined

    try {
      await writeFile(source, 'source\n')
      copy = cloner.copy(source, target).then(
        () => {
          settled = true
          return { error: null }
        },
        (error) => {
          settled = true
          return { error }
        }
      )

      await vi.advanceTimersByTimeAsync(30_001)

      expect(settled).toBe(true)
      await expect(copy).resolves.toMatchObject({
        error: expect.objectContaining({ code: 'ERR_MACOS_CLONE_PROCESS_FAILED' })
      })
    } finally {
      helper.closeUnexpectedly()
      await copy
      await cloner.close().catch(() => undefined)
      vi.useRealTimers()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails a pending clone when the macOS helper stderr stream errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cloner-test-'))
    const source = join(root, 'source.jsonl')
    const target = join(root, 'target.jsonl')
    const helper = createFakeMacOsHelper(async () => await new Promise<never>(() => {}))
    const cloner = createCodexSessionCloner({
      platform: 'darwin',
      spawnProcess: vi.fn(() => helper.child) as unknown as typeof import('node:child_process').spawn
    })
    let copy: Promise<void> | undefined

    try {
      await writeFile(source, 'source\n')
      copy = cloner.copy(source, target)

      expect(() => helper.failStderr()).not.toThrow()
      await expect(copy).rejects.toThrow('macOS clonefile helper stderr failed')
    } finally {
      helper.closeUnexpectedly()
      await copy?.catch(() => undefined)
      await cloner.close().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not silently downgrade a macOS permission failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cloner-test-'))
    const source = join(root, 'source.jsonl')
    const target = join(root, 'target.jsonl')
    const helper = createFakeMacOsHelper(async () => ({ ok: false, errno: 1 }))
    const fallback = vi.fn()
    const injectedCopy = vi.fn()

    try {
      await writeFile(source, 'source\n')
      const cloner = createCodexSessionCloner({
        platform: 'darwin',
        spawnProcess: vi.fn(() => helper.child) as unknown as typeof import('node:child_process').spawn,
        copyFile: injectedCopy,
        onFallback: fallback
      })

      await expect(cloner.copy(source, target)).rejects.toMatchObject({
        message: expect.stringContaining('macOS clonefile failed'),
        code: 'EPERM'
      })
      await cloner.close()

      expect(fallback).not.toHaveBeenCalled()
      expect(injectedCopy).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails a malformed helper response instead of treating it as an unsupported clone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cloner-test-'))
    const source = join(root, 'source.jsonl')
    const target = join(root, 'target.jsonl')
    const helper = createFakeMacOsHelper(async () => 'not-json')
    const fallback = vi.fn()

    try {
      await writeFile(source, 'source\n')
      const cloner = createCodexSessionCloner({
        platform: 'darwin',
        spawnProcess: vi.fn(() => helper.child) as unknown as typeof import('node:child_process').spawn,
        onFallback: fallback
      })

      await expect(cloner.copy(source, target)).rejects.toMatchObject({ code: 'ERR_MACOS_CLONE_PROCESS_FAILED' })
      await expect(cloner.close()).rejects.toMatchObject({ code: 'ERR_MACOS_CLONE_PROCESS_FAILED' })
      expect(helper.closeCount).toBe(1)

      expect(fallback).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reports an unexpected helper exit after a successful copy during scope cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cloner-test-'))
    const source = join(root, 'source.jsonl')
    const target = join(root, 'target.jsonl')
    const helper = createFakeMacOsHelper(async () => ({ ok: true }))

    try {
      await writeFile(source, 'source\n')
      const cloner = createCodexSessionCloner({
        platform: 'darwin',
        spawnProcess: vi.fn(() => helper.child) as unknown as typeof import('node:child_process').spawn
      })

      await cloner.copy(source, target)
      helper.closeUnexpectedly()

      await expect(cloner.close()).rejects.toMatchObject({ code: 'ERR_MACOS_CLONE_PROCESS_FAILED' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('falls back once on non-macOS only after a forced reflink reports unsupported', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-cloner-test-'))
    const firstSource = join(root, 'first-source.jsonl')
    const secondSource = join(root, 'second-source.jsonl')
    const firstTarget = join(root, 'first-target.jsonl')
    const secondTarget = join(root, 'second-target.jsonl')
    const modes: Array<number | undefined> = []
    const fallback = vi.fn()
    const forcedCloneMode = constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE
    const injectedCopy = async (
      source: Parameters<typeof copyFile>[0],
      target: Parameters<typeof copyFile>[1],
      mode?: Parameters<typeof copyFile>[2]
    ) => {
      modes.push(mode)
      if (mode === forcedCloneMode) {
        throw Object.assign(new Error('reflink unavailable'), { code: 'ENOSYS' })
      }
      await copyFile(source, target, mode)
    }

    try {
      await writeFile(firstSource, 'first\n')
      await writeFile(secondSource, 'second\n')
      const cloner = createCodexSessionCloner({
        platform: 'linux',
        copyFile: injectedCopy,
        onFallback: fallback
      })

      await cloner.copy(firstSource, firstTarget)
      await cloner.copy(secondSource, secondTarget)
      await cloner.close()

      expect(modes).toEqual([forcedCloneMode, constants.COPYFILE_EXCL, constants.COPYFILE_EXCL])
      expect(fallback).toHaveBeenCalledTimes(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

type CloneRequest = { source: string; target: string }
type CloneResponse = { ok: true } | { ok: false; errno: number } | string

function createFakeMacOsHelper(respond: (request: CloneRequest) => Promise<CloneResponse>) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const emitter = new EventEmitter()
  const requests: CloneRequest[] = []
  let closeCount = 0
  let input = ''
  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill: () => {
      queueMicrotask(() => emitter.emit('close', null, 'SIGTERM'))
      return true
    }
  }) as unknown as import('node:child_process').ChildProcessWithoutNullStreams

  stdin.setEncoding('utf8')
  stdin.on('data', (chunk: string) => {
    input += chunk
    for (;;) {
      const newline = input.indexOf('\n')
      if (newline < 0) return
      const line = input.slice(0, newline)
      input = input.slice(newline + 1)
      const request = JSON.parse(line) as CloneRequest
      requests.push(request)
      void respond(request).then(
        (response) => {
          stdout.write(typeof response === 'string' ? `${response}\n` : `${JSON.stringify(response)}\n`)
        },
        (error) => emitter.emit('error', error)
      )
    }
  })
  stdin.once('finish', () => {
    closeCount += 1
    queueMicrotask(() => emitter.emit('close', 0, null))
  })

  return {
    child,
    requests,
    failToStart: () => {
      emitter.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
      emitter.emit('close', -2, null)
    },
    failStderr: () => stderr.emit('error', new Error('macOS clonefile helper stderr failed')),
    closeUnexpectedly: () => emitter.emit('close', null, 'SIGTERM'),
    get closeCount() {
      return closeCount
    }
  }
}
