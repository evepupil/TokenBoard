import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { appendBoundedStatuslineEvent } from './antigravity-statusline-log.mjs'

const scriptPath = fileURLToPath(new URL('./antigravity-statusline.mjs', import.meta.url))

test('statusline CLI compacts its private JSONL within the configured byte limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-bounded-'))
  try {
    const logPath = join(root, 'events.jsonl')
    for (let index = 1; index <= 12; index += 1) {
      const result = spawnSync(
        process.execPath,
        [scriptPath, '--state-dir', root, '--log-path', logPath, '--max-log-bytes', '1024'],
        {
          input: JSON.stringify(statuslinePayload({ conversation_id: `conversation-${index}` })),
          encoding: 'utf8'
        }
      )
      assert.equal(result.status, 0)
    }

    assert.ok((await stat(logPath)).size <= 1024)
    const lines = (await readFile(logPath, 'utf8')).trim().split('\n')
    for (const line of lines) JSON.parse(line)
    const header = JSON.parse(lines[0])
    assert.equal(header.schemaVersion, 'antigravity-statusline-log/v1')
    assert.match(header.generation, /^[a-f0-9]{32}$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline compaction records lineage for generation-aware cursor translation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-lineage-'))
  try {
    const logPath = join(root, 'events.jsonl')
    const previousGeneration = 'a'.repeat(32)
    await writeFile(
      logPath,
      `${JSON.stringify({
        schemaVersion: 'antigravity-statusline-log/v1',
        generation: previousGeneration
      })}\n${JSON.stringify({ value: 'x'.repeat(160) })}\n`
    )

    appendBoundedStatuslineEvent(logPath, { value: 'new-event' }, 240)

    const header = JSON.parse((await readFile(logPath, 'utf8')).split('\n', 1)[0])
    assert.equal(header.previousGeneration, undefined)
    assert.equal(typeof header.retainedFrom, 'number')
    assert.ok(header.retainedFrom > 0)
    assert.equal(header.generation, compactedGeneration(previousGeneration, header.retainedFrom))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline compaction leaves the original log untouched when lineage does not converge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-lineage-exhausted-'))
  try {
    const sourcePath = fileURLToPath(new URL('./antigravity-statusline-log.mjs', import.meta.url))
    const modulePath = join(root, 'antigravity-statusline-log.mjs')
    const source = (await readFile(sourcePath, 'utf8')).replace(
      'const compactionLineageMaxAttempts = 8',
      'const compactionLineageMaxAttempts = 1'
    )
    await writeFile(modulePath, source)
    await writeFile(
      join(root, 'process-liveness.mjs'),
      await readFile(new URL('./process-liveness.mjs', import.meta.url))
    )

    const logPath = join(root, 'events.jsonl')
    const previousGeneration = 'a'.repeat(32)
    const original = `${JSON.stringify({
      schemaVersion: 'antigravity-statusline-log/v1',
      generation: previousGeneration
    })}\n${Array.from({ length: 8 }, (_, index) => JSON.stringify({ value: `${index}-${'x'.repeat(32)}` })).join('\n')}\n`
    await writeFile(logPath, original)
    const module = await import(`${pathToFileURL(modulePath).href}?lineage-exhausted-test`)

    assert.throws(
      () => module.appendBoundedStatuslineEvent(logPath, { value: 'new-event' }, 240),
      /Antigravity statusline log compaction did not converge/
    )
    assert.equal(await readFile(logPath, 'utf8'), original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline CLI keeps concurrent events while compacting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-concurrent-'))
  try {
    const logPath = join(root, 'events.jsonl')
    await writeFile(
      logPath,
      Array.from({ length: 4 }, (_, index) =>
        JSON.stringify({
          schemaVersion: 'antigravity-statusline/v1',
          capturedAt: '2026-06-23T10:00:00.000Z',
          conversationHash: plainHash(`old-${index}`),
          model: 'Gemini 3.5 Flash (Medium)',
          usage: { inputTokens: 10, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }
        })
      ).join('\n')
    )

    await Promise.all([
      runStatuslineProcess(root, logPath, 'concurrent-a'),
      runStatuslineProcess(root, logPath, 'concurrent-b')
    ])

    const content = await readFile(logPath, 'utf8')
    assert.match(content, new RegExp(legacyHash('concurrent-a')))
    assert.match(content, new RegExp(legacyHash('concurrent-b')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline log recovers a lock owned by a stopped process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-orphan-lock-'))
  try {
    const logPath = join(root, 'events.jsonl')
    const lockPath = `${logPath}.lock`
    await mkdir(lockPath)
    await writeFile(join(lockPath, 'pid'), '999999999')

    appendBoundedStatuslineEvent(logPath, { value: 'recovered' }, 1024)

    assert.match(await readFile(logPath, 'utf8'), /recovered/)
    await assert.rejects(stat(lockPath), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline log retry budget covers orphan lock recovery grace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-orphan-grace-'))
  try {
    const sourcePath = fileURLToPath(new URL('./antigravity-statusline-log.mjs', import.meta.url))
    const modulePath = join(root, 'antigravity-statusline-log.mjs')
    const source = (await readFile(sourcePath, 'utf8')).replace(
      /const orphanLockGraceMs = [^\n]+/,
      'const orphanLockGraceMs = 600'
    )
    await writeFile(modulePath, source)
    await writeFile(
      join(root, 'process-liveness.mjs'),
      await readFile(new URL('./process-liveness.mjs', import.meta.url))
    )

    const logPath = join(root, 'events.jsonl')
    await mkdir(`${logPath}.lock`)
    const module = await import(`${pathToFileURL(modulePath).href}?grace-test`)

    module.appendBoundedStatuslineEvent(logPath, { value: 'recovered-after-grace' }, 1024)

    assert.match(await readFile(logPath, 'utf8'), /recovered-after-grace/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline log keeps a fresh malformed lock until its recovery grace expires', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-malformed-lock-'))
  try {
    const sourcePath = fileURLToPath(new URL('./antigravity-statusline-log.mjs', import.meta.url))
    const modulePath = join(root, 'antigravity-statusline-log.mjs')
    const source = (await readFile(sourcePath, 'utf8')).replace(
      /const orphanLockGraceMs = [^\n]+/,
      'const orphanLockGraceMs = 600'
    )
    await writeFile(modulePath, source)
    await writeFile(
      join(root, 'process-liveness.mjs'),
      await readFile(new URL('./process-liveness.mjs', import.meta.url))
    )

    const logPath = join(root, 'events.jsonl')
    const lockPath = `${logPath}.lock`
    await mkdir(lockPath)
    await writeFile(join(lockPath, 'pid'), 'invalid')
    const module = await import(`${pathToFileURL(modulePath).href}?malformed-lock-test`)
    const startedAt = Date.now()

    module.appendBoundedStatuslineEvent(logPath, { value: 'recovered-after-malformed-lock' }, 1024)

    assert.ok(Date.now() - startedAt >= 500)
    assert.match(await readFile(logPath, 'utf8'), /recovered-after-malformed-lock/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline log does not reclaim an old lock while its owner pid is alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-reused-pid-'))
  try {
    const sourcePath = fileURLToPath(new URL('./antigravity-statusline-log.mjs', import.meta.url))
    const modulePath = join(root, 'antigravity-statusline-log.mjs')
    const source = (await readFile(sourcePath, 'utf8'))
      .replace(/const lockWaitTimeoutMs = [^\n]+/, 'const lockWaitTimeoutMs = 100')
      .replace(/const orphanLockGraceMs = [^\n]+/, 'const orphanLockGraceMs = 20')
    await writeFile(modulePath, source)
    await writeFile(
      join(root, 'process-liveness.mjs'),
      await readFile(new URL('./process-liveness.mjs', import.meta.url))
    )

    const logPath = join(root, 'events.jsonl')
    const lockPath = `${logPath}.lock`
    await mkdir(lockPath)
    await writeFile(join(lockPath, 'pid'), String(process.pid))
    const expiredAt = new Date(Date.now() - 1_000)
    await utimes(lockPath, expiredAt, expiredAt)
    const module = await import(`${pathToFileURL(modulePath).href}?reused-pid-test`)

    assert.throws(
      () => module.appendBoundedStatuslineEvent(logPath, { value: 'not-written' }, 1024),
      /Timed out waiting for Antigravity statusline log lock/
    )
    assert.equal(await readFile(join(lockPath, 'pid'), 'utf8'), String(process.pid))
    await assert.rejects(stat(logPath), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline log does not overwrite or remove a replacement lock owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-replaced-lock-'))
  const logPath = join(root, 'events.jsonl')
  const lockPath = `${logPath}.lock`
  const originalWriteFileSync = fs.writeFileSync
  let replaced = false
  try {
    fs.writeFileSync = (path, ...args) => {
      if (!replaced && basename(String(path)) === 'pid') {
        replaced = true
        fs.rmSync(lockPath, { recursive: true, force: true })
        fs.mkdirSync(lockPath, { mode: 0o700 })
        originalWriteFileSync(join(lockPath, 'pid'), String(process.pid), { mode: 0o600 })
      }
      return originalWriteFileSync(path, ...args)
    }
    syncBuiltinESMExports()

    assert.throws(
      () => appendBoundedStatuslineEvent(logPath, { value: 'not-written' }, 1024),
      /Timed out waiting for Antigravity statusline log lock/
    )
    assert.equal(await readFile(join(lockPath, 'pid'), 'utf8'), String(process.pid))
    await assert.rejects(stat(logPath), { code: 'ENOENT' })
  } finally {
    fs.writeFileSync = originalWriteFileSync
    syncBuiltinESMExports()
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline log removes a partial lock when pid write fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-pid-failure-'))
  const logPath = join(root, 'events.jsonl')
  const originalWriteFileSync = fs.writeFileSync
  try {
    fs.writeFileSync = (path, ...args) => {
      if (basename(String(path)) === 'pid') {
        const error = new Error('pid write failed')
        error.code = 'EIO'
        throw error
      }
      return originalWriteFileSync(path, ...args)
    }
    syncBuiltinESMExports()

    assert.throws(() => appendBoundedStatuslineEvent(logPath, { value: 'not-written' }, 1024), /pid write failed/)
    await assert.rejects(stat(`${logPath}.lock`), { code: 'ENOENT' })
  } finally {
    fs.writeFileSync = originalWriteFileSync
    syncBuiltinESMExports()
    await rm(root, { recursive: true, force: true })
  }
})

function statuslinePayload(overrides = {}) {
  return {
    conversation_id: 'conversation-1',
    model: { id: 'Gemini 3.5 Flash (Medium)' },
    context_window: {
      current_usage: {
        input_tokens: 100,
        output_tokens: 12,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 40
      }
    },
    ...overrides
  }
}

function plainHash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function legacyHash(value) {
  return createHash('sha256').update('tokenboard-antigravity-cli\0').update(value).digest('hex')
}

function compactedGeneration(previousGeneration, retainedFromOffsetBytes) {
  const previousHash = createHash('sha256').update(previousGeneration).digest('hex')
  return createHash('sha256')
    .update(previousHash)
    .update('\0')
    .update(String(retainedFromOffsetBytes))
    .digest('hex')
    .slice(0, 32)
}

function runStatuslineProcess(root, logPath, conversationId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [scriptPath, '--state-dir', root, '--log-path', logPath, '--max-log-bytes', '1024'],
      { stdio: ['pipe', 'ignore', 'pipe'] }
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (status) => {
      if (status === 0) resolve(undefined)
      else reject(new Error(stderr || `statusline process exited with ${status}`))
    })
    child.stdin.end(JSON.stringify(statuslinePayload({ conversation_id: conversationId })))
  })
}
