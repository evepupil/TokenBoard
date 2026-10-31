import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { credentialEnvKeys, scrubbedChildEnv } from './child-env.mjs'
import { runStep } from './upgrade-utils.mjs'

const collectorEnvPath = fileURLToPath(new URL('../../../packages/collector/src/child-env.ts', import.meta.url))

// The skill scripts cannot import @tokenboard/collector, so this list is a
// hand-kept mirror of `credentialEnvKeys` there. Both lists guard the same
// class of leak — a credential the skill exports reaching third-party code it
// downloads and runs — so a key added on one side and not the other reopens
// the hole silently.
test('the skill credential list matches the collector child-env list', () => {
  const source = readFileSync(collectorEnvPath, 'utf8')
  const match = /export const credentialEnvKeys = \[([^\]]*)\]/.exec(source)
  assert.ok(match, 'packages/collector/src/child-env.ts must still declare a flat credentialEnvKeys array')
  const declared = [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1])
  assert.deepEqual(credentialEnvKeys, declared)
})

test('scrubbedChildEnv drops credentials and leaves everything else alone', () => {
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/user',
    TOKENBOARD_UPLOAD_TOKEN: 'tb_upload_secret',
    TOKENBOARD_PAIRING_CODE: 'tb_pair_secret',
    TOKENBOARD_RELEASE_BASE_URL: 'https://user:token@feed.example',
    TOKENBOARD_REPO_URL: 'https://user:token@git.example/mirror.git'
  }
  const scrubbed = scrubbedChildEnv(env)
  assert.deepEqual(scrubbed, { PATH: '/usr/bin:/bin', HOME: '/home/user' })
  // The caller's object must survive: sync.mjs builds the collector env from
  // this same object and still needs the token.
  assert.equal(env.TOKENBOARD_UPLOAD_TOKEN, 'tb_upload_secret')
})

// The install chain runs `git clone` and `pnpm install --frozen-lockfile`, and
// the latter executes dependency lifecycle scripts — third-party code. A
// pairing code exported as an environment variable (a documented usage) must
// not be readable from that child.
test('install steps spawn children without the credential environment', () => {
  let seen
  const runtime = {
    platform: 'linux',
    log: () => {},
    spawn: (command, args, options) => {
      seen = { command, args, env: options.env }
      return { status: 0, stdout: '', stderr: '' }
    }
  }
  const previous = { ...process.env }
  process.env.TOKENBOARD_PAIRING_CODE = 'tb_pair_secret'
  try {
    runStep({ command: 'pnpm', args: ['install', '--frozen-lockfile'], options: { cwd: '/repo' } }, runtime)
  } finally {
    delete process.env.TOKENBOARD_PAIRING_CODE
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key]
    }
  }
  assert.equal(seen.command, 'pnpm')
  assert.ok(seen.env, 'the child must be given an explicit environment')
  assert.equal(seen.env.TOKENBOARD_PAIRING_CODE, undefined)
  assert.ok(seen.env.PATH, 'PATH and the rest of the environment must survive')
})
