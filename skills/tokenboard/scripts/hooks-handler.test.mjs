import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildNotifyHandler } from './hooks.mjs'

test('notify handler does not forward payload args to the TokenBoard background process', () => {
  const source = buildNotifyHandler({
    stateDir: '/home/user/.tokenboard',
    notifyScriptPath: '/repo/scripts/notify.mjs',
    nodePath: '/usr/bin/node'
  })

  assert.match(source, /spawn\(NODE_PATH, \[NOTIFY_SCRIPT, "--source", source\]/)
  assert.doesNotMatch(source, /spawn\(NODE_PATH, \[NOTIFY_SCRIPT, "--source", source, \.\.\.payloadArgs\]/)
})

test('notify handler preserves payload source args for the original Codex notify command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-'))
  const handlerPath = join(root, 'notify.cjs')
  const backgroundScript = join(root, 'background.mjs')
  const originalScript = join(root, 'original.mjs')
  const backgroundArgsPath = join(root, 'background-args.json')
  const originalArgsPath = join(root, 'original-args.json')

  try {
    await writeFile(backgroundScript, [
      'import { writeFileSync } from "node:fs"',
      `writeFileSync(${JSON.stringify(backgroundArgsPath)}, JSON.stringify(process.argv.slice(2)))`
    ].join('\n'))
    await writeFile(originalScript, [
      'import { writeFileSync } from "node:fs"',
      `writeFileSync(${JSON.stringify(originalArgsPath)}, JSON.stringify(process.argv.slice(2)))`
    ].join('\n'))
    await writeFile(join(root, 'codex_notify_original.json'), `${JSON.stringify({
      notify: [process.execPath, originalScript]
    })}\n`)
    await writeFile(handlerPath, buildNotifyHandler({
      stateDir: root,
      notifyScriptPath: backgroundScript,
      nodePath: process.execPath
    }))

    const result = spawnSync(process.execPath, [
      handlerPath,
      '--source=codex',
      '--source',
      'payload-source',
      '--payload',
      'value'
    ])

    assert.equal(result.status, 0)
    assert.match(await readFile(join(root, 'notify.signal'), 'utf8'), /"source":"codex"/)
    assert.deepEqual(await readJsonFile(backgroundArgsPath), ['--source', 'codex'])
    assert.deepEqual(await readJsonFile(originalArgsPath), ['--source', 'payload-source', '--payload', 'value'])
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
  assert.match(source, /recordHandlerError\("background", error\)/)
})

test('notify handler records invalid source without enqueueing background work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-hook-handler-'))
  const handlerPath = join(root, 'notify.cjs')
  const backgroundScript = join(root, 'background.mjs')
  const backgroundArgsPath = join(root, 'background-args.json')

  try {
    await writeFile(backgroundScript, [
      'import { writeFileSync } from "node:fs"',
      `writeFileSync(${JSON.stringify(backgroundArgsPath)}, JSON.stringify(process.argv.slice(2)))`
    ].join('\n'))
    await writeFile(handlerPath, buildNotifyHandler({
      stateDir: root,
      notifyScriptPath: backgroundScript,
      nodePath: process.execPath
    }))

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

async function readJsonFile(path) {
  let lastError
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw lastError
}
