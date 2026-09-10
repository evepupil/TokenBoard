import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { supportsReliableSignalZero } from './antigravity-statusline-log.mjs'
import { isProcessAlive, tasklistCommand, tasklistContainsPid } from './process-liveness.mjs'

test('statusline lock avoids broken Windows signal-zero Node releases', () => {
  assert.equal(supportsReliableSignalZero('darwin', '22.12.0'), true)
  assert.equal(supportsReliableSignalZero('win32', '22.12.0'), false)
  assert.equal(supportsReliableSignalZero('win32', '22.16.0'), true)
  assert.equal(supportsReliableSignalZero('win32', '23.11.0'), false)
  assert.equal(supportsReliableSignalZero('win32', '24.0.0'), true)
})

test('parses Windows tasklist CSV without depending on localized no-match text', () => {
  assert.equal(tasklistContainsPid('"node.exe","123","Console","1","10,000 K"\r\n', 123), true)
  assert.equal(tasklistContainsPid('INFO: No tasks are running which match the specified criteria.', 123), false)
  assert.equal(tasklistContainsPid('信息: 没有运行的任务匹配指定标准。', 123), false)
})

test('resolves tasklist to System32 instead of PATH', () => {
  assert.equal(tasklistCommand({ SystemRoot: 'D:\\Windows' }), 'D:\\Windows\\System32\\tasklist.exe')
  assert.equal(tasklistCommand({ SystemRoot: 'C:relative' }), 'C:\\Windows\\System32\\tasklist.exe')
  assert.equal(tasklistCommand({}), 'C:\\Windows\\System32\\tasklist.exe')
})

test('bounds legacy Windows tasklist liveness probes', () => {
  let options
  const alive = isProcessAlive(123, {
    platform: 'win32',
    nodeVersion: '22.12.0',
    runTasklist(_command, _args, input) {
      options = input
      return { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }
    }
  })

  assert.equal(alive, true)
  assert.equal(options.timeout, 2_000)
})

test('statusline log recovers a lock when legacy Windows reports the pid missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-windows-orphan-'))
  try {
    const sourcePath = fileURLToPath(new URL('./antigravity-statusline-log.mjs', import.meta.url))
    const livenessPath = fileURLToPath(new URL('./process-liveness.mjs', import.meta.url))
    const modulePath = join(root, 'antigravity-statusline-log.mjs')
    const source = (await readFile(sourcePath, 'utf8')).replace(
      /const lockWaitTimeoutMs = [^\n]+/,
      'const lockWaitTimeoutMs = 500'
    )
    const liveness = (await readFile(livenessPath, 'utf8'))
      .replace('const platform = options.platform || process.platform', "const platform = 'win32'")
      .replace('const nodeVersion = options.nodeVersion || process.versions.node', "const nodeVersion = '22.12.0'")
      .replace('return isWindowsProcessAlive(pid, runTasklist, options.env)', "return 'dead'")
    await writeFile(modulePath, source)
    await writeFile(join(root, 'process-liveness.mjs'), liveness)

    const logPath = join(root, 'events.jsonl')
    const lockPath = `${logPath}.lock`
    await mkdir(lockPath)
    await writeFile(join(lockPath, 'pid'), String(process.pid))
    const module = await import(`${pathToFileURL(modulePath).href}?windows-orphan-test`)
    module.appendBoundedStatuslineEvent(logPath, { value: 'recovered-on-windows' }, 1024)

    assert.match(await readFile(logPath, 'utf8'), /recovered-on-windows/)
    await assert.rejects(stat(lockPath), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('statusline log keeps an expired lock when legacy Windows liveness is positive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-windows-live-'))
  try {
    const sourcePath = fileURLToPath(new URL('./antigravity-statusline-log.mjs', import.meta.url))
    const livenessPath = fileURLToPath(new URL('./process-liveness.mjs', import.meta.url))
    const modulePath = join(root, 'antigravity-statusline-log.mjs')
    const source = (await readFile(sourcePath, 'utf8')).replace(
      /const lockWaitTimeoutMs = [^\n]+/,
      'const lockWaitTimeoutMs = 100'
    )
    const liveness = (await readFile(livenessPath, 'utf8'))
      .replace('const platform = options.platform || process.platform', "const platform = 'win32'")
      .replace('const nodeVersion = options.nodeVersion || process.versions.node', "const nodeVersion = '22.12.0'")
      .replace('return isWindowsProcessAlive(pid, runTasklist, options.env)', "return 'alive'")
    await writeFile(modulePath, source)
    await writeFile(join(root, 'process-liveness.mjs'), liveness)

    const logPath = join(root, 'events.jsonl')
    const lockPath = `${logPath}.lock`
    await mkdir(lockPath)
    await writeFile(join(lockPath, 'pid'), String(process.pid))
    const expiredAt = new Date(Date.now() - 60_000)
    await utimes(lockPath, expiredAt, expiredAt)
    const module = await import(`${pathToFileURL(modulePath).href}?windows-live-test`)

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

test('statusline log never evicts an old lock when legacy Windows liveness is unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-agy-statusline-windows-unknown-'))
  try {
    const sourcePath = fileURLToPath(new URL('./antigravity-statusline-log.mjs', import.meta.url))
    const livenessPath = fileURLToPath(new URL('./process-liveness.mjs', import.meta.url))
    const modulePath = join(root, 'antigravity-statusline-log.mjs')
    const source = (await readFile(sourcePath, 'utf8')).replace(
      /const lockWaitTimeoutMs = [^\n]+/,
      'const lockWaitTimeoutMs = 100'
    )
    const liveness = (await readFile(livenessPath, 'utf8'))
      .replace('const platform = options.platform || process.platform', "const platform = 'win32'")
      .replace('const nodeVersion = options.nodeVersion || process.versions.node', "const nodeVersion = '22.12.0'")
      .replace(
        'const runTasklist = options.runTasklist || spawnSync',
        "const runTasklist = () => ({ error: new Error('timed out') })"
      )
    await writeFile(modulePath, source)
    await writeFile(join(root, 'process-liveness.mjs'), liveness)

    const logPath = join(root, 'events.jsonl')
    const lockPath = `${logPath}.lock`
    await mkdir(lockPath)
    await writeFile(join(lockPath, 'pid'), String(process.pid))
    const expiredAt = new Date(Date.now() - 60_000)
    await utimes(lockPath, expiredAt, expiredAt)
    const module = await import(`${pathToFileURL(modulePath).href}?windows-unknown-test`)

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
