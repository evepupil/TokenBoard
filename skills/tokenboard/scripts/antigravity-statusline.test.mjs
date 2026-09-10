import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, readFile, rm, stat, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { extractStatuslineEvent } from './antigravity-statusline.mjs'
import { terminateOriginalCommandTree, windowsTaskkillCommand } from './antigravity-statusline-original.mjs'
import { createHash } from 'node:crypto'

const scriptPath = fileURLToPath(new URL('./antigravity-statusline.mjs', import.meta.url))

test('extracts only sanitized Antigravity statusline usage fields', () => {
  const raw = JSON.stringify(
    statuslinePayload({
      conversation_id: 'raw-conversation-id',
      cwd: '/Users/example/private',
      email: 'user@example.com'
    })
  )

  const event = extractStatuslineEvent(raw, '2026-06-23T10:00:00.000Z')

  assert.equal(event.schemaVersion, 'antigravity-statusline/v1')
  assert.equal(event.capturedAt, '2026-06-23T10:00:00.000Z')
  assert.equal(event.model, 'Gemini 3.5 Flash (Medium)')
  assert.equal(event.usage.inputTokens, 100)
  assert.equal(event.usage.outputTokens, 12)
  assert.equal(event.usage.cacheCreationTokens, 3)
  assert.equal(event.usage.cacheReadTokens, 40)
  assert.equal(event.conversationHash, legacyHash('raw-conversation-id'))
  assert.deepEqual(event.conversationHashAliases, [plainHash('raw-conversation-id')])
  assert.deepEqual(Object.keys(event).sort(), [
    'capturedAt',
    'conversationHash',
    'conversationHashAliases',
    'model',
    'schemaVersion',
    'usage'
  ])
})

test('preserves a local capture id for distinct statusline calls', () => {
  const raw = JSON.stringify(statuslinePayload({ conversation_id: 'capture-id-session' }))
  const event = extractStatuslineEvent(raw, '2026-06-23T10:00:00.000Z', 'a'.repeat(32))

  assert.equal(event.captureId, 'a'.repeat(32))
})

test('hashes a stable upstream statusline identifier without persisting it', () => {
  const rawMessageId = 'raw-provider-message-id'
  const raw = JSON.stringify(statuslinePayload({ message_id: rawMessageId }))

  const event = extractStatuslineEvent(raw, '2026-06-23T10:00:00.000Z')

  assert.equal(event.statuslineEventHash, statuslineEventHash('message_id', rawMessageId))
  assert.doesNotMatch(JSON.stringify(event), /raw-provider-message-id/)
})

test('keeps valid usage when an optional upstream event identifier is too long', () => {
  const raw = JSON.stringify(statuslinePayload({ message_id: 'x'.repeat(4097) }))

  const event = extractStatuslineEvent(raw, '2026-06-23T10:00:00.000Z')

  assert.equal(event.model, 'Gemini 3.5 Flash (Medium)')
  assert.equal(event.usage.inputTokens, 100)
  assert.equal(event.statuslineEventHash, undefined)
})

test('statusline CLI writes sanitized JSONL and preserves original command output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-'))
  try {
    const originalPath = join(root, 'original.mjs')
    const backupPath = join(root, 'original.json')
    const logPath = join(root, 'events.jsonl')
    await writeFile(
      originalPath,
      [
        'let raw = ""',
        'process.stdin.setEncoding("utf8")',
        'process.stdin.on("data", (chunk) => { raw += chunk })',
        'process.stdin.on("end", () => { process.stdout.write("original-statusline") })'
      ].join('\n')
    )
    await writeFile(backupPath, `${JSON.stringify({ command: shellCommand(process.execPath, originalPath) })}\n`)

    const result = spawnSync(
      process.execPath,
      [scriptPath, '--state-dir', root, '--log-path', logPath, '--original-command-file', backupPath],
      {
        input: JSON.stringify(statuslinePayload({ conversation_id: 'raw-session-id' })),
        encoding: 'utf8'
      }
    )

    assert.equal(result.status, 0)
    assert.equal(result.stdout, 'original-statusline')
    const event = JSON.parse(await readFile(logPath, 'utf8'))
    assert.equal(event.schemaVersion, 'antigravity-statusline/v1')
    assert.equal(event.model, 'Gemini 3.5 Flash (Medium)')
    assert.match(event.captureId, /^[a-f0-9]{32}$/)
    assert.notEqual(event.conversationHash, 'raw-session-id')
    assert.equal(event.conversationHash, legacyHash('raw-session-id'))
    assert.deepEqual(event.conversationHashAliases, [plainHash('raw-session-id')])
    assert.match(event.conversationHash, /^[a-f0-9]{64}$/)
    assert.doesNotMatch(await readFile(logPath, 'utf8'), /raw-session-id|\/Users\/example|user@example\.com/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline CLI forwards oversized input to the original command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-oversized-'))
  try {
    const originalPath = join(root, 'original.mjs')
    const backupPath = join(root, 'original.json')
    const logPath = join(root, 'events.jsonl')
    const errorPath = join(root, 'errors.log')
    await writeFile(
      originalPath,
      [
        'import { createHash } from "node:crypto"',
        'const hash = createHash("sha256")',
        'process.stdin.on("data", (chunk) => { hash.update(chunk) })',
        'process.stdin.on("end", () => { process.stdout.write(hash.digest("hex")) })'
      ].join('\n')
    )
    await writeFile(backupPath, `${JSON.stringify({ command: shellCommand(process.execPath, originalPath) })}\n`)
    const raw = Buffer.alloc(2 * 1024 * 1024, 0xff)

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        '--state-dir',
        root,
        '--log-path',
        logPath,
        '--error-path',
        errorPath,
        '--original-command-file',
        backupPath,
        '--max-input-bytes',
        '1024'
      ],
      { input: raw, encoding: 'utf8' }
    )

    assert.equal(result.status, 0)
    assert.equal(result.stdout, createHash('sha256').update(raw).digest('hex'))
    await assert.rejects(readFile(logPath, 'utf8'))
    assert.match(await readFile(errorPath, 'utf8'), /payload too large/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline CLI preserves successful original output when the original command closes stdin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-epipe-'))
  try {
    const originalPath = join(root, 'original.mjs')
    const backupPath = join(root, 'original.json')
    const errorPath = join(root, 'errors.log')
    await writeFile(originalPath, ['process.stdout.write("static-output")', 'process.stdin.destroy()'].join('\n'))
    await writeFile(backupPath, `${JSON.stringify({ command: shellCommand(process.execPath, originalPath) })}\n`)

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        '--state-dir',
        root,
        '--error-path',
        errorPath,
        '--original-command-file',
        backupPath,
        '--max-input-bytes',
        '1024'
      ],
      { input: Buffer.alloc(2 * 1024 * 1024), encoding: 'utf8', timeout: 8000 }
    )

    assert.equal(result.status, 0)
    assert.equal(result.stdout, 'static-output')
    const errors = await readErrorRecords(errorPath)
    assert.ok(
      errors.some(
        (record) => record.stage === 'original' && typeof record.message === 'string' && record.message.length > 0
      )
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline CLI force-terminates an original command that ignores its timeout signal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-timeout-'))
  try {
    const originalPath = join(root, 'original.mjs')
    const backupPath = join(root, 'original.json')
    const errorPath = join(root, 'errors.log')
    await writeFile(
      originalPath,
      ['process.on("SIGTERM", () => {})', 'process.stdin.resume()', 'setTimeout(() => {}, 6000)'].join('\n')
    )
    await writeFile(backupPath, `${JSON.stringify({ command: shellCommand(process.execPath, originalPath) })}\n`)
    const startedAt = Date.now()

    const result = spawnSync(
      process.execPath,
      [scriptPath, '--state-dir', root, '--error-path', errorPath, '--original-command-file', backupPath],
      { input: '{}', encoding: 'utf8', timeout: 8000 }
    )

    assert.equal(result.status, 0)
    assert.ok(Date.now() - startedAt < 5000)
    assert.equal(result.stdout, '')
    assert.match(await readFile(errorPath, 'utf8'), /timed out/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline command termination uses taskkill for the full Windows process tree', () => {
  const calls = []
  let unrefCount = 0
  const child = {
    pid: 4321,
    kill() {
      throw new Error('direct child kill should not be used when taskkill starts')
    }
  }
  const spawnTreeKiller = (command, args, options) => {
    calls.push({ command, args, options })
    return {
      once() {},
      unref() {
        unrefCount += 1
      }
    }
  }

  terminateOriginalCommandTree(child, 'SIGTERM', { platform: 'win32', spawnTreeKiller })
  terminateOriginalCommandTree(child, 'SIGKILL', { platform: 'win32', spawnTreeKiller })

  assert.deepEqual(calls, [
    {
      command: 'C:\\Windows\\System32\\taskkill.exe',
      args: ['/PID', '4321', '/T'],
      options: { stdio: 'ignore', windowsHide: true }
    },
    {
      command: 'C:\\Windows\\System32\\taskkill.exe',
      args: ['/PID', '4321', '/T', '/F'],
      options: { stdio: 'ignore', windowsHide: true }
    }
  ])
  assert.equal(unrefCount, 2)
})

test('resolves taskkill from SystemRoot without relying on PATH', () => {
  assert.equal(windowsTaskkillCommand({ SystemRoot: 'D:\\Windows' }), 'D:\\Windows\\System32\\taskkill.exe')
  assert.equal(windowsTaskkillCommand({ SystemRoot: 'relative\\Windows' }), 'C:\\Windows\\System32\\taskkill.exe')
  assert.equal(
    windowsTaskkillCommand({ SystemRoot: '\\\\server\\share\\Windows' }),
    'C:\\Windows\\System32\\taskkill.exe'
  )
})

test('statusline command termination falls back when Windows taskkill exits nonzero', () => {
  const listeners = new Map()
  const killSignals = []
  const child = {
    pid: 4321,
    kill(signal) {
      killSignals.push(signal)
    }
  }
  const spawnTreeKiller = () => ({
    once(event, listener) {
      listeners.set(event, listener)
    },
    unref() {}
  })

  terminateOriginalCommandTree(child, 'SIGKILL', { platform: 'win32', spawnTreeKiller })
  assert.equal(typeof listeners.get('close'), 'function')
  listeners.get('close')(1)

  assert.deepEqual(killSignals, ['SIGKILL'])
})

test(
  'statusline CLI force-terminates descendants after the original command exits on timeout',
  {
    skip: process.platform === 'win32'
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-descendant-timeout-'))
    const descendantPath = join(root, 'descendant.mjs')
    const originalPath = join(root, 'original.mjs')
    const descendantPidPath = join(root, 'descendant.pid')
    const backupPath = join(root, 'original.json')
    const errorPath = join(root, 'errors.log')
    let descendantPid
    try {
      await writeFile(descendantPath, ['process.on("SIGTERM", () => {})', 'setInterval(() => {}, 1000)'].join('\n'))
      await writeFile(
        originalPath,
        [
          'import { spawn } from "node:child_process"',
          'import { writeFileSync } from "node:fs"',
          `const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(descendantPath)}], { stdio: "ignore" })`,
          `writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid))`,
          'process.stdin.resume()',
          'setInterval(() => {}, 1000)'
        ].join('\n')
      )
      await writeFile(backupPath, `${JSON.stringify({ command: shellCommand(process.execPath, originalPath) })}\n`)

      const result = spawnSync(
        process.execPath,
        [scriptPath, '--state-dir', root, '--error-path', errorPath, '--original-command-file', backupPath],
        { input: '{}', encoding: 'utf8', timeout: 8000 }
      )
      descendantPid = Number(await readFile(descendantPidPath, 'utf8'))

      assert.equal(result.status, 0)
      assert.equal(isProcessAlive(descendantPid), false)
      assert.match(await readFile(errorPath, 'utf8'), /timed out/)
    } finally {
      if (descendantPid && isProcessAlive(descendantPid)) process.kill(descendantPid, 'SIGKILL')
      await rm(root, { recursive: true, force: true })
    }
  }
)

test('statusline CLI preserves the original output-limit error when stdin forwarding also fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-error-priority-'))
  try {
    const originalPath = join(root, 'original.mjs')
    const backupPath = join(root, 'original.json')
    const errorPath = join(root, 'errors.log')
    await writeFile(originalPath, ['process.stdout.write("x".repeat(9000))', 'process.stdin.destroy()'].join('\n'))
    await writeFile(backupPath, `${JSON.stringify({ command: shellCommand(process.execPath, originalPath) })}\n`)

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        '--state-dir',
        root,
        '--error-path',
        errorPath,
        '--original-command-file',
        backupPath,
        '--max-input-bytes',
        '1024'
      ],
      { input: Buffer.alloc(4 * 1024 * 1024), encoding: 'utf8', timeout: 8000 }
    )

    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
    assert.match(await readFile(errorPath, 'utf8'), /output exceeded the limit/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline CLI suppresses partial output from a failed original command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-nonzero-'))
  try {
    const originalPath = join(root, 'original.mjs')
    const backupPath = join(root, 'original.json')
    const errorPath = join(root, 'errors.log')
    await writeFile(
      originalPath,
      [
        'process.stdin.resume()',
        'process.stdin.on("end", () => {',
        '  process.stdout.write("partial-output")',
        '  process.exitCode = 2',
        '})'
      ].join('\n')
    )
    await writeFile(backupPath, `${JSON.stringify({ command: shellCommand(process.execPath, originalPath) })}\n`)

    const result = spawnSync(
      process.execPath,
      [scriptPath, '--state-dir', root, '--error-path', errorPath, '--original-command-file', backupPath],
      { input: JSON.stringify(statuslinePayload()), encoding: 'utf8', timeout: 8000 }
    )

    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
    assert.ok(
      (await readErrorRecords(errorPath)).some(
        (record) => record.stage === 'original' && /exited with 2/.test(record.message)
      )
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline CLI rejects an explicitly empty input limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-empty-limit-'))
  try {
    const logPath = join(root, 'events.jsonl')
    const errorPath = join(root, 'errors.log')
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--state-dir', root, '--log-path', logPath, '--error-path', errorPath, '--max-input-bytes='],
      { input: JSON.stringify(statuslinePayload()), encoding: 'utf8' }
    )

    assert.equal(result.status, 0)
    await assert.rejects(readFile(logPath, 'utf8'))
    assert.match(await readFile(errorPath, 'utf8'), /Invalid Antigravity statusline input limit/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline CLI does not run an original command that was disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-disabled-'))
  try {
    const originalPath = join(root, 'original.mjs')
    const backupPath = join(root, 'original.json')
    const logPath = join(root, 'events.jsonl')
    const markerPath = join(root, 'original-ran')
    await writeFile(
      originalPath,
      [
        `import { writeFileSync } from 'node:fs'`,
        `writeFileSync(${JSON.stringify(markerPath)}, 'ran')`,
        `process.stdout.write('disabled-original')`
      ].join('\n')
    )
    await writeFile(
      backupPath,
      `${JSON.stringify({
        statusLine: {
          enabled: false,
          command: shellCommand(process.execPath, originalPath)
        },
        command: shellCommand(process.execPath, originalPath)
      })}\n`
    )

    const result = spawnSync(
      process.execPath,
      [scriptPath, '--state-dir', root, '--log-path', logPath, '--original-command-file', backupPath],
      {
        input: JSON.stringify(statuslinePayload({ conversation_id: 'raw-session-id' })),
        encoding: 'utf8'
      }
    )

    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
    await assert.rejects(readFile(markerPath, 'utf8'))
    const event = JSON.parse(await readFile(logPath, 'utf8'))
    assert.equal(event.schemaVersion, 'antigravity-statusline/v1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline CLI tightens existing log file permissions after appending', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX file mode assertion')
    return
  }

  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-mode-'))
  try {
    const logPath = join(root, 'events.jsonl')
    await writeFile(logPath, '')
    await chmod(logPath, 0o644)

    const result = spawnSync(process.execPath, [scriptPath, '--state-dir', root, '--log-path', logPath], {
      input: JSON.stringify(statuslinePayload({ conversation_id: 'raw-session-id' })),
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    assert.equal((await stat(logPath)).mode & 0o777, 0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline CLI records malformed payload errors outside the usage JSONL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-'))
  try {
    const logPath = join(root, 'events.jsonl')
    const errorPath = join(root, 'errors.log')
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--state-dir', root, '--log-path', logPath, '--error-path', errorPath],
      {
        input: '{bad json}',
        encoding: 'utf8'
      }
    )

    assert.equal(result.status, 0)
    await assert.rejects(readFile(logPath, 'utf8'))
    assert.match(await readFile(errorPath, 'utf8'), /Malformed Antigravity statusline payload/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline CLI bounds repeated error records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-bounded-errors-'))
  try {
    const errorPath = join(root, 'errors.log')
    for (let index = 0; index < 40; index += 1) {
      const result = spawnSync(
        process.execPath,
        [scriptPath, '--state-dir', root, '--error-path', errorPath, '--max-log-bytes', '1024'],
        {
          input: '{bad json',
          encoding: 'utf8'
        }
      )
      assert.equal(result.status, 0)
    }

    assert.ok((await stat(errorPath)).size <= 1024)
    for (const line of (await readFile(errorPath, 'utf8')).trim().split('\n')) JSON.parse(line)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline CLI defaults missing cache token fields to zero', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-'))
  try {
    const logPath = join(root, 'events.jsonl')
    const payload = statuslinePayload({
      context_window: {
        current_usage: {
          input_tokens: 100,
          output_tokens: 12
        }
      }
    })
    const result = spawnSync(process.execPath, [scriptPath, '--state-dir', root, '--log-path', logPath], {
      input: JSON.stringify(payload),
      encoding: 'utf8'
    })

    assert.equal(result.status, 0)
    const event = JSON.parse(await readFile(logPath, 'utf8'))
    assert.equal(event.usage.cacheCreationTokens, 0)
    assert.equal(event.usage.cacheReadTokens, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline CLI records invalid token values outside the usage JSONL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-'))
  try {
    const logPath = join(root, 'events.jsonl')
    const errorPath = join(root, 'errors.log')
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--state-dir', root, '--log-path', logPath, '--error-path', errorPath],
      {
        input: JSON.stringify(
          statuslinePayload({
            context_window: {
              current_usage: {
                input_tokens: -1,
                output_tokens: 12,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0
              }
            }
          })
        ),
        encoding: 'utf8'
      }
    )

    assert.equal(result.status, 0)
    await assert.rejects(readFile(logPath, 'utf8'))
    assert.match(await readFile(errorPath, 'utf8'), /input_tokens must be a bounded nonnegative integer/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function statuslinePayload(overrides = {}) {
  return {
    product: 'antigravity',
    version: '1.0.10',
    conversation_id: 'conversation-1',
    cwd: '/Users/example/private',
    email: 'user@example.com',
    model: {
      id: 'Gemini 3.5 Flash (Medium)',
      display_name: 'Gemini 3.5 Flash (Medium)'
    },
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

function shellCommand(executable, script) {
  return [executable, script].map(shellQuote).join(' ')
}

function shellQuote(value) {
  const text = String(value)
  if (process.platform === 'win32') return `"${text.replaceAll('"', '""')}"`
  return `'${text.replaceAll("'", "'\\''")}'`
}

async function readErrorRecords(errorPath) {
  return (await readFile(errorPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

function plainHash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function statuslineEventHash(field, value) {
  return createHash('sha256')
    .update('tokenboard-antigravity-statusline-event\0')
    .update(field)
    .update('\0')
    .update(value)
    .digest('hex')
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function legacyHash(value) {
  return createHash('sha256').update('tokenboard-antigravity-cli\0').update(value).digest('hex')
}
