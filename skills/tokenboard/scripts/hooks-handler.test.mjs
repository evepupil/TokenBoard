import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { buildNotifyHandler, notifyHandlerErrorLogMaxBytes } from './hooks.mjs'
import { currentProcessStartIdentity } from './process-liveness.mjs'

const backgroundResultTimeoutMs = 5_000
const backgroundResultRetryMs = 25
const processIdentityAvailable = Boolean(currentProcessStartIdentity())

test('notify handler does not forward payload args to the TokenBoard background process', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })

  assert.match(source, /spawn\(NODE_PATH, \[NOTIFY_SCRIPT, "--source", source\]/)
  assert.doesNotMatch(source, /spawn\(NODE_PATH, \[NOTIFY_SCRIPT, "--source", source, \.\.\.payloadArgs\]/)
  assert.match(source, /function acquireDispatchLock\(\)/)
  assert.match(source, /notify\.dispatch\.lock/)
  assert.match(source, /notify\.dispatch\.worker/)
  assert.match(source, /TOKENBOARD_NOTIFY_DISPATCH_LOCK_TOKEN/)
  assert.match(source, /TOKENBOARD_NOTIFY_DISPATCH_WORKER_PATH/)
  assert.match(source, /const TASKLIST_TIMEOUT_MS = 2000;/)
  assert.match(source, /timeout: TASKLIST_TIMEOUT_MS/)
  assert.match(source, /recordHandlerError\(\s*"process-liveness"/)
  assert.match(source, /DISPATCH_WORKER_IDENTITY_PROBE_GRACE_MS/)
  assert.match(source, /identityProbeStartedAt/)
  const workerMarkerStart = source.indexOf('function setDispatchWorkerPid')
  const workerMarkerEnd = source.indexOf('function releaseDispatchLock', workerMarkerStart)
  assert.ok(workerMarkerStart >= 0 && workerMarkerEnd > workerMarkerStart)
  assert.match(source.slice(workerMarkerStart, workerMarkerEnd), /identityProbeStartedAt: workerStartedAt/)
  assert.match(source, /PROCESS_IDENTITY_CACHE_PATH/)
  assert.doesNotMatch(source, /updateDispatchLockPid/)
  assert.match(
    source,
    /if \(currentIdentity\.status === "known"\) return currentIdentity\.value === worker\.processStartIdentity/
  )
})

test('notify handler coalesces background workers while the current worker is alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-'))
  const handlerPath = join(root, 'notify.cjs')
  const backgroundScript = join(root, 'background.mjs')
  const countPath = join(root, 'background-count.txt')

  try {
    await writeFile(
      backgroundScript,
      [
        'import { readFileSync, writeFileSync } from "node:fs"',
        `const countPath = ${JSON.stringify(countPath)}`,
        'let count = 0',
        'try { count = Number(readFileSync(countPath, "utf8")) || 0 } catch {}',
        'writeFileSync(countPath, String(count + 1))',
        'await new Promise((resolve) => setTimeout(resolve, 1000))'
      ].join('\n')
    )
    await writeFile(
      handlerPath,
      buildNotifyHandler({
        stateDir: root,
        notifyScriptPath: backgroundScript,
        nodePath: process.execPath
      })
    )

    assert.equal(spawnSync(process.execPath, [handlerPath, '--source=codex']).status, 0)
    assert.equal(spawnSync(process.execPath, [handlerPath, '--source=codex']).status, 0)
    await waitFor(
      async () => {
        if (!existsSync(countPath)) return false
        return (await readFile(countPath, 'utf8')).trim() === '1'
      },
      () => readDispatchDiagnostic(root)
    )
    assert.deepEqual(await readdir(join(root, 'notify.signal.d')), ['codex.json'])
    await assert.rejects(readFile(join(root, 'notify.signal'), 'utf8'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test(
  'notify handler replaces a dispatch worker marker when its pid was reused',
  { skip: !processIdentityAvailable },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-dispatch-worker-reused-'))
    const handlerPath = join(root, 'notify.cjs')
    const backgroundScript = join(root, 'background.mjs')
    const countPath = join(root, 'background-count.txt')
    const dispatchToken = 'reused-dispatch-owner'
    const staleIdentity = 'reused-process-identity'

    try {
      await writeFile(
        backgroundScript,
        ['import { writeFileSync } from "node:fs"', `writeFileSync(${JSON.stringify(countPath)}, "started")`].join('\n')
      )
      await writeFile(
        join(root, 'notify.dispatch.lock'),
        JSON.stringify({
          pid: process.pid,
          token: dispatchToken,
          startedAt: '2000-01-01T00:00:00.000Z',
          processStartIdentity: staleIdentity
        })
      )
      await writeFile(
        join(root, `notify.dispatch.worker.${dispatchToken}`),
        JSON.stringify({
          pid: process.pid,
          token: dispatchToken,
          startedAt: '2000-01-01T00:00:00.000Z',
          processStartIdentity: staleIdentity
        })
      )
      await writeFile(
        handlerPath,
        buildNotifyHandler({
          stateDir: root,
          notifyScriptPath: backgroundScript,
          nodePath: process.execPath
        })
      )

      assert.equal(spawnSync(process.execPath, [handlerPath, '--source=codex']).status, 0)
      await waitFor(
        () => existsSync(countPath),
        () => readDispatchDiagnostic(root)
      )
      assert.equal(await readTextFile(countPath), 'started')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

test('notify handler does not trust a live pid-only dispatch worker marker after startup grace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-dispatch-worker-legacy-'))
  const handlerPath = join(root, 'notify.cjs')
  const backgroundScript = join(root, 'background.mjs')
  const countPath = join(root, 'background-count.txt')
  const dispatchToken = 'legacy-dispatch-owner'

  try {
    await writeFile(
      backgroundScript,
      ['import { writeFileSync } from "node:fs"', `writeFileSync(${JSON.stringify(countPath)}, "started")`].join('\n')
    )
    await writeFile(
      join(root, 'notify.dispatch.lock'),
      JSON.stringify({
        pid: process.pid,
        token: dispatchToken,
        startedAt: '2000-01-01T00:00:00.000Z'
      })
    )
    await writeFile(
      join(root, `notify.dispatch.worker.${dispatchToken}`),
      JSON.stringify({
        pid: process.pid,
        token: dispatchToken,
        startedAt: '2000-01-01T00:00:00.000Z'
      })
    )
    await writeFile(
      handlerPath,
      buildNotifyHandler({
        stateDir: root,
        notifyScriptPath: backgroundScript,
        nodePath: process.execPath
      })
    )

    assert.equal(spawnSync(process.execPath, [handlerPath, '--source=codex']).status, 0)
    await waitFor(
      () => existsSync(countPath),
      () => readDispatchDiagnostic(root)
    )
    assert.equal(await readTextFile(countPath), 'started')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notify handler reclaims a markerless dispatch lock after startup grace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-dispatch-markerless-'))
  const handlerPath = join(root, 'notify.cjs')
  const backgroundScript = join(root, 'background.mjs')
  const countPath = join(root, 'background-count.txt')

  try {
    await writeFile(
      backgroundScript,
      ['import { writeFileSync } from "node:fs"', `writeFileSync(${JSON.stringify(countPath)}, "started")`].join('\n')
    )
    await writeFile(
      join(root, 'notify.dispatch.lock'),
      JSON.stringify({
        pid: process.pid,
        token: 'markerless-dispatch-owner',
        startedAt: '2000-01-01T00:00:00.000Z'
      })
    )
    await writeFile(
      handlerPath,
      buildNotifyHandler({
        stateDir: root,
        notifyScriptPath: backgroundScript,
        nodePath: process.execPath
      })
    )

    assert.equal(spawnSync(process.execPath, [handlerPath, '--source=codex']).status, 0)
    await waitFor(
      () => existsSync(countPath),
      () => readDispatchDiagnostic(root)
    )
    assert.equal(await readTextFile(countPath), 'started')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notify handler recovers a malformed dispatch lock before starting a worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-dispatch-recovery-'))
  const handlerPath = join(root, 'notify.cjs')
  const backgroundScript = join(root, 'background.mjs')
  const countPath = join(root, 'background-count.txt')

  try {
    await writeFile(
      backgroundScript,
      ['import { writeFileSync } from "node:fs"', `writeFileSync(${JSON.stringify(countPath)}, "started")`].join('\n')
    )
    await writeFile(join(root, 'notify.dispatch.lock'), '{ truncated')
    await writeFile(
      handlerPath,
      buildNotifyHandler({
        stateDir: root,
        notifyScriptPath: backgroundScript,
        nodePath: process.execPath
      })
    )

    assert.equal(spawnSync(process.execPath, [handlerPath, '--source=codex']).status, 0)
    await waitFor(
      async () => {
        try {
          return (await readFile(countPath, 'utf8')).trim() === 'started'
        } catch {
          return false
        }
      },
      () => readDispatchDiagnostic(root)
    )
    assert.equal(await readTextFile(countPath), 'started')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notify handler keeps the original notify alive when dispatch lock is a directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-dispatch-directory-'))
  const handlerPath = join(root, 'notify.cjs')
  const originalScript = join(root, 'original.mjs')
  const originalResult = join(root, 'original-result.txt')

  try {
    await writeFile(
      originalScript,
      ['import { writeFileSync } from "node:fs"', `writeFileSync(${JSON.stringify(originalResult)}, "forwarded")`].join(
        '\n'
      )
    )
    await writeFile(
      join(root, 'codex_notify_original.json'),
      JSON.stringify({
        notify: [process.execPath, originalScript]
      })
    )
    await writeFile(
      handlerPath,
      buildNotifyHandler({
        stateDir: root,
        notifyScriptPath: join(root, 'missing-background.mjs'),
        nodePath: process.execPath
      })
    )
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, 'notify.dispatch.lock')))

    const result = spawnSync(process.execPath, [handlerPath, '--source=codex'])

    assert.equal(result.status, 0)
    await waitFor(
      () => existsSync(originalResult),
      () => readDispatchDiagnostic(root)
    )
    assert.equal(await readTextFile(originalResult), 'forwarded')
    assert.match(await readFile(join(root, 'notify-handler-errors.log'), 'utf8'), /dispatch-lock/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notify handler records a background spawn error and releases its dispatch lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-spawn-error-'))
  const handlerPath = join(root, 'notify.cjs')

  try {
    await writeFile(
      handlerPath,
      buildNotifyHandler({
        stateDir: root,
        notifyScriptPath: '\u0000',
        nodePath: process.execPath
      })
    )

    assert.equal(
      spawnSync(process.execPath, [handlerPath, '--source=codex'], {
        timeout: backgroundResultTimeoutMs
      }).status,
      0
    )
    await waitFor(async () => {
      try {
        return (await readFile(join(root, 'notify-handler-errors.log'), 'utf8')).includes('"stage":"background"')
      } catch {
        return false
      }
    })
    const log = await readFile(join(root, 'notify-handler-errors.log'), 'utf8')
    assert.equal(log.includes(root), false)
    assert.equal(log.includes('\\u0000'), false)
    assert.equal(existsSync(join(root, 'notify.dispatch.lock')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notify handler leaves cooldown work to a live trailing process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-trailing-'))
  const handlerPath = join(root, 'notify.cjs')
  const backgroundScript = join(root, 'background.mjs')
  const countPath = join(root, 'background-count.txt')
  const trailingScript = join(root, 'trailing.mjs')
  const trailingLockPath = join(root, 'trailing.lock')
  let trailingPid

  try {
    await writeFile(
      backgroundScript,
      ['import { writeFileSync } from "node:fs"', `writeFileSync(${JSON.stringify(countPath)}, "started")`].join('\n')
    )
    await writeFile(
      trailingScript,
      [
        'import { writeFileSync } from "node:fs"',
        `writeFileSync(${JSON.stringify(trailingLockPath)}, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))`,
        'await new Promise((resolve) => setTimeout(resolve, 5000))'
      ].join('\n')
    )
    await writeFile(
      handlerPath,
      buildNotifyHandler({
        stateDir: root,
        notifyScriptPath: backgroundScript,
        nodePath: process.execPath
      })
    )
    const trailing = spawn(process.execPath, [trailingScript], { detached: true, stdio: 'ignore' })
    trailingPid = trailing.pid
    trailing.unref()

    await waitFor(() => existsSync(trailingLockPath))
    let processStartIdentity
    await waitFor(() => {
      processStartIdentity = currentProcessStartIdentity({ pid: trailingPid })
      return Boolean(processStartIdentity)
    })
    assert.ok(processStartIdentity)
    await writeFile(
      trailingLockPath,
      JSON.stringify({
        pid: trailingPid,
        startedAt: new Date().toISOString(),
        processStartIdentity
      })
    )
    assert.equal(spawnSync(process.execPath, [handlerPath, '--source=codex']).status, 0)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(existsSync(countPath), false)
    assert.match(await readFile(join(root, 'notify.signal.d', 'codex.json'), 'utf8'), /"source":"codex"/)
  } finally {
    if (trailingPid) {
      try {
        process.kill(trailingPid, 'SIGTERM')
      } catch {}
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('notify handler does not trust a legacy pid-only trailing lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-trailing-legacy-'))
  const handlerPath = join(root, 'notify.cjs')
  const backgroundScript = join(root, 'background.mjs')
  const countPath = join(root, 'background-count.txt')
  const trailingScript = join(root, 'trailing.mjs')
  const trailingLockPath = join(root, 'trailing.lock')
  let trailingPid

  try {
    await writeFile(
      backgroundScript,
      ['import { writeFileSync } from "node:fs"', `writeFileSync(${JSON.stringify(countPath)}, "started")`].join('\n')
    )
    await writeFile(
      trailingScript,
      [
        'import { writeFileSync } from "node:fs"',
        `writeFileSync(${JSON.stringify(trailingLockPath)}, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))`,
        'await new Promise((resolve) => setTimeout(resolve, 5000))'
      ].join('\n')
    )
    await writeFile(
      handlerPath,
      buildNotifyHandler({
        stateDir: root,
        notifyScriptPath: backgroundScript,
        nodePath: process.execPath
      })
    )
    const trailing = spawn(process.execPath, [trailingScript], { detached: true, stdio: 'ignore' })
    trailingPid = trailing.pid
    trailing.unref()

    await waitFor(() => existsSync(trailingLockPath))
    assert.equal(spawnSync(process.execPath, [handlerPath, '--source=codex']).status, 0)
    await waitFor(
      () => existsSync(countPath),
      () => readDispatchDiagnostic(root)
    )
    assert.equal(await readTextFile(countPath), 'started')
  } finally {
    if (trailingPid) {
      try {
        process.kill(trailingPid, 'SIGTERM')
      } catch {}
    }
    await rm(root, { recursive: true, force: true })
  }
})

test(
  'notify handler dispatches when a live trailing pid has been reused',
  { skip: !processIdentityAvailable },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-trailing-reused-'))
    const handlerPath = join(root, 'notify.cjs')
    const backgroundScript = join(root, 'background.mjs')
    const countPath = join(root, 'background-count.txt')
    const trailingScript = join(root, 'trailing.mjs')
    const trailingLockPath = join(root, 'trailing.lock')
    let trailingPid

    try {
      await writeFile(
        backgroundScript,
        ['import { writeFileSync } from "node:fs"', `writeFileSync(${JSON.stringify(countPath)}, "started")`].join('\n')
      )
      await writeFile(
        trailingScript,
        [
          'import { writeFileSync } from "node:fs"',
          `writeFileSync(${JSON.stringify(trailingLockPath)}, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), processStartIdentity: "reused-process-identity" }))`,
          'await new Promise((resolve) => setTimeout(resolve, 5000))'
        ].join('\n')
      )
      await writeFile(
        handlerPath,
        buildNotifyHandler({
          stateDir: root,
          notifyScriptPath: backgroundScript,
          nodePath: process.execPath
        })
      )
      const trailing = spawn(process.execPath, [trailingScript], { detached: true, stdio: 'ignore' })
      trailingPid = trailing.pid
      trailing.unref()

      await waitFor(() => existsSync(trailingLockPath))
      assert.equal(spawnSync(process.execPath, [handlerPath, '--source=codex']).status, 0)
      await waitFor(
        () => existsSync(countPath),
        () => readDispatchDiagnostic(root)
      )
      assert.equal(await readTextFile(countPath), 'started')
    } finally {
      if (trailingPid) {
        try {
          process.kill(trailingPid, 'SIGTERM')
        } catch {}
      }
      await rm(root, { recursive: true, force: true })
    }
  }
)

test('detached notify worker releases dispatch ownership after scheduling trailing work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-dispatch-'))
  const handlerPath = join(root, 'notify.cjs')
  const notifyPath = fileURLToPath(new URL('./notify.mjs', import.meta.url))
  let trailingPid

  try {
    await writeFile(join(root, 'config.json'), JSON.stringify({ updatedAt: new Date().toISOString() }))
    await writeFile(join(root, 'last-success.json'), new Date().toISOString())
    await writeFile(
      handlerPath,
      buildNotifyHandler({
        stateDir: root,
        notifyScriptPath: notifyPath,
        nodePath: process.execPath
      })
    )

    assert.equal(spawnSync(process.execPath, [handlerPath, '--source=codex']).status, 0)
    await assertTrailingLockAlwaysParses(join(root, 'trailing.lock'))
    trailingPid = JSON.parse(await readFile(join(root, 'trailing.lock'), 'utf8')).pid
    await waitFor(() => !existsSync(join(root, 'notify.dispatch.lock')))
    await waitFor(
      async () => !(await readdir(root)).some((name) => name.startsWith('notify.dispatch.worker.')),
      () => readDispatchDiagnostic(root)
    )
    assert.equal(existsSync(join(root, 'notify.dispatch.worker')), false)
    assert.equal(
      (await readdir(root)).some((name) => name.startsWith('notify.dispatch.worker.')),
      false
    )
  } finally {
    if (trailingPid) {
      try {
        process.kill(trailingPid, 'SIGTERM')
      } catch {}
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('notify handler preserves payload source args for the original Codex notify command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-'))
  const handlerPath = join(root, 'notify.cjs')
  const backgroundScript = join(root, 'background.mjs')
  const originalScript = join(root, 'original.mjs')
  const backgroundArgsPath = join(root, 'background-args.json')
  const originalArgsPath = join(root, 'original-args.json')

  try {
    await writeFile(
      backgroundScript,
      [
        'import { writeFileSync } from "node:fs"',
        `writeFileSync(${JSON.stringify(backgroundArgsPath)}, JSON.stringify(process.argv.slice(2)))`
      ].join('\n')
    )
    await writeFile(
      originalScript,
      [
        'import { writeFileSync } from "node:fs"',
        `writeFileSync(${JSON.stringify(originalArgsPath)}, JSON.stringify(process.argv.slice(2)))`
      ].join('\n')
    )
    await writeFile(
      join(root, 'codex_notify_original.json'),
      `${JSON.stringify({
        notify: [process.execPath, originalScript]
      })}\n`
    )
    await writeFile(
      handlerPath,
      buildNotifyHandler({
        stateDir: root,
        notifyScriptPath: backgroundScript,
        nodePath: process.execPath
      })
    )

    const result = spawnSync(process.execPath, [
      handlerPath,
      '--source=codex',
      '--source',
      'payload-source',
      '--payload',
      'value'
    ])

    assert.equal(result.status, 0)
    assert.match(await readFile(join(root, 'notify.signal.d', 'codex.json'), 'utf8'), /"source":"codex"/)
    assert.deepEqual(await readJsonFile(backgroundArgsPath), ['--source', 'codex'])
    assert.deepEqual(await readJsonFile(originalArgsPath), ['--source', 'payload-source', '--payload', 'value'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notify handler records an original notify spawn error without blocking the hook', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-original-error-'))
  const handlerPath = join(root, 'notify.cjs')

  try {
    await writeFile(
      join(root, 'codex_notify_original.json'),
      JSON.stringify({
        notify: [join(root, 'missing-original-command')]
      })
    )
    await writeFile(
      handlerPath,
      buildNotifyHandler({
        stateDir: root,
        notifyScriptPath: join(root, 'missing-background.mjs'),
        nodePath: process.execPath
      })
    )

    assert.equal(
      spawnSync(process.execPath, [handlerPath, '--source=codex'], {
        timeout: backgroundResultTimeoutMs
      }).status,
      0
    )
    await waitFor(async () => {
      try {
        return (await readFile(join(root, 'notify-handler-errors.log'), 'utf8')).includes('"stage":"original"')
      } catch {
        return false
      }
    })
    const log = await readFile(join(root, 'notify-handler-errors.log'), 'utf8')
    assert.equal(log.includes(root), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notify handler records foreground failures for local diagnosis', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })

  assert.match(source, /notify-handler-errors\.log/)
  assert.match(source, /recordHandlerError\("enqueue", error\)/)
  assert.match(source, /recordHandlerError\("background", error, \[NODE_PATH, NOTIFY_SCRIPT\]\)/)
  assert.match(source, /function errorMessage\(error\)/)
  assert.match(source, /function safeErrorString\(value\)/)
  assert.doesNotMatch(source, /: String\(error\)/)
  assert.match(source, /return "Unknown error"/)
})

test('notify handler formats hostile errors without throwing at runtime', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })
  const helperStart = source.indexOf('function errorMessage(error)')
  const helperEnd = source.indexOf('function isMissingFileError(error)')

  assert.notEqual(helperStart, -1)
  assert.notEqual(helperEnd, -1)
  const results = runInNewContext(`
    ${source.slice(helperStart, helperEnd)}
    const hostileError = new Error("failed");
    Object.defineProperties(hostileError, {
      message: { get() { throw new Error("message failed"); } },
      name: { get() { throw new Error("name failed"); } }
    });
    [
      errorMessage(new Error("")),
      errorMessage(Object.create(null)),
      errorMessage({ toString() { throw new Error("toString failed"); } }),
      errorMessage(hostileError)
    ];
  `)

  assert.deepEqual(Array.from(results), ['Error', 'Unknown error', 'Unknown error', 'Unknown error'])
})

test('notify handler records invalid source without enqueueing background work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-'))
  const handlerPath = join(root, 'notify.cjs')
  const backgroundScript = join(root, 'background.mjs')
  const backgroundArgsPath = join(root, 'background-args.json')

  try {
    await writeFile(
      backgroundScript,
      [
        'import { writeFileSync } from "node:fs"',
        `writeFileSync(${JSON.stringify(backgroundArgsPath)}, JSON.stringify(process.argv.slice(2)))`
      ].join('\n')
    )
    await writeFile(
      handlerPath,
      buildNotifyHandler({
        stateDir: root,
        notifyScriptPath: backgroundScript,
        nodePath: process.execPath
      })
    )

    const result = spawnSync(process.execPath, [handlerPath, '--source=bad-source'])

    assert.equal(result.status, 0)
    await assert.rejects(readFile(join(root, 'notify.signal'), 'utf8'))
    await assert.rejects(readFile(backgroundArgsPath, 'utf8'))
    const log = await readFile(join(root, 'notify-handler-errors.log'), 'utf8')
    assert.match(log, /Unsupported TokenBoard hook source/)
    assert.doesNotMatch(log, /bad-source/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notify handler bounds its error log while retaining recent diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-log-bound-'))
  const handlerPath = join(root, 'notify.cjs')
  const logPath = join(root, 'notify-handler-errors.log')

  try {
    const oldLine = '{"stage":"old"}\n'
    await writeFile(
      logPath,
      oldLine.repeat(Math.ceil((notifyHandlerErrorLogMaxBytes + oldLine.length) / oldLine.length))
    )
    await writeFile(
      handlerPath,
      buildNotifyHandler({
        stateDir: root,
        notifyScriptPath: join(root, 'missing-background.mjs'),
        nodePath: process.execPath
      })
    )

    assert.equal(spawnSync(process.execPath, [handlerPath, '--source=bad-source']).status, 0)
    const log = await readFile(logPath, 'utf8')
    assert.ok(Buffer.byteLength(log) <= notifyHandlerErrorLogMaxBytes)
    assert.match(log.trimEnd().split('\n').at(-1) ?? '', /"stage":"source"/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function readJsonFile(path) {
  let lastError
  const deadline = Date.now() + backgroundResultTimeoutMs
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, backgroundResultRetryMs))
    }
  }
  throw lastError
}

async function readTextFile(path) {
  let lastError
  const deadline = Date.now() + backgroundResultTimeoutMs
  while (Date.now() < deadline) {
    try {
      return (await readFile(path, 'utf8')).trim()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, backgroundResultRetryMs))
    }
  }
  throw lastError
}

async function waitFor(condition, diagnostic) {
  const deadline = Date.now() + backgroundResultTimeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, backgroundResultRetryMs))
  }
  assert.fail(`Timed out waiting for detached notify worker state${diagnostic ? `: ${await diagnostic()}` : ''}`)
}

async function assertTrailingLockAlwaysParses(lockPath) {
  await waitFor(() => existsSync(lockPath))
  const deadline = Date.now() + 250
  while (Date.now() < deadline) {
    const lock = JSON.parse(await readFile(lockPath, 'utf8'))
    assert.equal(Number.isSafeInteger(lock.pid), true)
    assert.equal(lock.pid > 0, true)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

async function readDispatchDiagnostic(root) {
  const readJson = async (name) => {
    try {
      return JSON.parse(await readFile(join(root, name), 'utf8'))
    } catch {
      return null
    }
  }
  const [lock, worker, run, entries] = await Promise.all([
    readJson('notify.dispatch.lock'),
    readJson('notify.dispatch.worker'),
    readJson('last-run.json'),
    readdir(root)
  ])
  return JSON.stringify({
    lockPid: lock?.pid ?? null,
    workerPid: worker?.pid ?? null,
    tokenWorkers: entries.filter((name) => name.startsWith('notify.dispatch.worker.')),
    runStatus: run?.status ?? null,
    skippedReason: run?.coordination?.skippedReason ?? null
  })
}
