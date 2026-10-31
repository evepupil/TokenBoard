import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { minimumNodeRange } from './node-version.mjs'

const scriptPath = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url))
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const declaredPackages = [
  'package.json',
  'apps/web/package.json',
  'packages/collector/package.json',
  'packages/usage-core/package.json'
]

// The engine range lives in four manifests, a .npmrc, a runtime preflight and two
// docs. Drift between them is silent: a manifest that still says 22.18 lets pnpm
// install on a release with the TLS bypass fixed only in 22.23.4, and the docs
// would tell the user to install that release.
test('every workspace manifest declares the same Node floor', () => {
  for (const manifest of declaredPackages) {
    const { engines } = JSON.parse(readFileSync(join(repoRoot, manifest), 'utf8'))
    assert.equal(engines?.node, minimumNodeRange, `${manifest} must declare engines.node as ${minimumNodeRange}`)
  }
})

test('the repository makes engines a hard requirement for installs', () => {
  const npmrc = readFileSync(join(repoRoot, '.npmrc'), 'utf8')
  assert.match(
    npmrc,
    /^engine-strict=true$/m,
    'without engine-strict every package manager only warns, so an unsupported Node still produces a working-looking install'
  )
})

// Bun ignores .npmrc's engine-strict and pnpm cannot see a Node that was
// downgraded after the install, so the scripts themselves refuse to run on an
// unsupported runtime.
for (const name of ['setup.mjs', 'sync.mjs', 'install-collector.mjs']) {
  test(`${name} refuses to run on an unsupported Node before touching local state`, () => {
    const root = mkdtempSync(join(tmpdir(), 'tokenboard-node-floor-'))
    const preload = join(root, 'pretend-old-node.mjs')
    const stateDir = join(root, 'state')
    const collectorDir = join(root, 'collector')
    // Every command the entry point could shell out to (a clone, corepack, the
    // collector itself) resolves to a shim that records the call and fails, so
    // the assertion below proves the refusal happened before any side effect —
    // not merely that an error was printed after one.
    const shimDir = join(root, 'bin')
    const markerPath = join(root, 'spawned-commands.log')
    mkdirSync(shimDir, { recursive: true })
    for (const command of ['git', 'corepack', 'pnpm', 'npm', 'bun']) {
      writeFileSync(join(shimDir, command), `#!/bin/sh\necho "$0" >> '${markerPath}'\nexit 1\n`, { mode: 0o755 })
    }
    // process.versions.node is non-writable but configurable, so a preload can
    // replace it before the entry point imports the floor.
    writeFileSync(
      preload,
      "Object.defineProperty(process.versions, 'node', { value: '22.18.0', configurable: true, writable: true, enumerable: true })\n"
    )
    try {
      // Windows rejects a bare drive path as an ESM specifier ("C:" reads as a
      // protocol), so the preload has to be passed as a file:// URL there.
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, scriptPath(name)], {
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          PATH: `${shimDir}:/usr/bin:/bin`,
          HOME: root,
          TMPDIR: process.env.TMPDIR || tmpdir(),
          TOKENBOARD_CONFIG_DIR: stateDir,
          TOKENBOARD_COLLECTOR_DIR: collectorDir,
          TOKENBOARD_LOG_DIR: join(stateDir, 'logs'),
          TOKENBOARD_BASE_URL: 'http://127.0.0.1:1',
          TOKENBOARD_REPO_URL: 'http://127.0.0.1:1/tokenboard.git',
          TOKENBOARD_TRIGGER: 'MCP_TOOL'
        }
      })

      assert.equal(result.status, 1, `${name} must exit 1 on Node 22.18: ${result.stdout}${result.stderr}`)
      assert.match(result.stderr, /22\.18\.0/, 'the refusal must name the version actually running')
      assert.match(result.stderr, /22\.23\.4/, 'the refusal must state the supported floor')
      assert.equal(existsSync(markerPath), false, `${name} ran an external command before refusing`)
      assert.equal(existsSync(stateDir), false, `${name} created the state directory before refusing`)
      assert.equal(existsSync(collectorDir), false, `${name} created the collector directory before refusing`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
