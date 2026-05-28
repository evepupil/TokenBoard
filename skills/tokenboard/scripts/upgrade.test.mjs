import assert from 'node:assert/strict'
import test from 'node:test'
import { buildUpgradePlan, resolveArchiveUrl, resolveRepoUrl, runUpgrade } from './upgrade.mjs'

test('updates collector and installed skill from the collector checkout', () => {
  assert.deepEqual(
    buildUpgradePlan({
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      skillDir: '/home/user/.codex/skills/tokenboard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'pnpm',
      collectorExists: true,
      collectorIsGitRepo: true,
      skillExists: true,
      platform: 'linux'
    }),
    [
      {
        command: 'git',
        args: ['remote', 'set-url', 'origin', 'https://github.com/example/TokenBoard.git'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'git',
        args: ['pull', '--ff-only'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'copy',
        args: ['/home/user/.tokenboard/TokenBoard/skills/tokenboard', '/home/user/.codex/skills/tokenboard'],
        options: { recursive: true, force: true }
      },
      {
        command: 'corepack',
        args: ['pnpm', 'install', '--frozen-lockfile'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      }
    ]
  )
})

test('does not copy the installed skill onto itself', () => {
  assert.deepEqual(
    buildUpgradePlan({
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      skillDir: '/home/user/.tokenboard/TokenBoard/skills/tokenboard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'pnpm',
      collectorExists: true,
      collectorIsGitRepo: true,
      platform: 'linux'
    }),
    [
      {
        command: 'git',
        args: ['remote', 'set-url', 'origin', 'https://github.com/example/TokenBoard.git'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'git',
        args: ['pull', '--ff-only'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'corepack',
        args: ['pnpm', 'install', '--frozen-lockfile'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      }
    ]
  )
})

test('clones collector before installing skill when collector is missing', () => {
  assert.deepEqual(
    buildUpgradePlan({
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      skillDir: '/home/user/.codex/skills/tokenboard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'npm',
      collectorExists: false,
      collectorIsGitRepo: false,
      skillExists: false,
      platform: 'win32'
    }),
    [
      {
        command: 'git',
        args: ['clone', '--depth', '1', 'https://github.com/example/TokenBoard.git', '/home/user/.tokenboard/TokenBoard'],
        options: {}
      },
      {
        command: 'copy',
        args: ['/home/user/.tokenboard/TokenBoard/skills/tokenboard', '/home/user/.codex/skills/tokenboard'],
        options: { recursive: true, force: true }
      },
      {
        command: 'corepack.cmd',
        args: ['pnpm', 'install', '--frozen-lockfile'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      }
    ]
  )
})

test('does not archive-replace an existing git checkout after git upgrade fails', () => {
  const calls = []
  assert.throws(
    () => runUpgrade({
      flags: {},
      env: {
        TOKENBOARD_CONFIG_DIR: '/home/user/.tokenboard',
        TOKENBOARD_COLLECTOR_DIR: '/home/user/.tokenboard/TokenBoard'
      },
      readConfigFile: () => ({
        collectorDir: '/home/user/.tokenboard/TokenBoard',
        repoUrl: 'https://github.com/example/TokenBoard.git',
        packageManager: 'pnpm'
      }),
      mergeConfigFile: (...args) => calls.push({ command: 'mergeConfig', args }),
      configDirectory: '/home/user/.tokenboard',
      exists: (path) =>
        path === '/home/user/.tokenboard/TokenBoard' ||
        path === '/home/user/.tokenboard/TokenBoard/.git',
      spawn: (command, args) => {
        calls.push({ command, args })
        return { status: command === 'git' && args[0] === 'pull' ? 1 : 0 }
      },
      copy: (...args) => calls.push({ command: 'copy', args }),
      mkdir: (...args) => calls.push({ command: 'mkdir', args }),
      readDir: () => [],
      remove: (...args) => calls.push({ command: 'remove', args }),
      log: () => {}
    }),
    /git failed with exit code 1/
  )

  assert.deepEqual(
    calls.map((call) => call.command),
    ['git', 'git']
  )
})

test('prepares a replacement checkout before touching an existing non-git collector', () => {
  assert.deepEqual(
    buildUpgradePlan({
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      skillDir: '/home/user/.codex/skills/tokenboard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'pnpm',
      collectorExists: true,
      collectorIsGitRepo: false,
      workDir: '/home/user/.tokenboard/upgrade-work',
      platform: 'linux'
    }),
    [
      {
        command: 'remove',
        args: ['/home/user/.tokenboard/upgrade-work'],
        options: { recursive: true, force: true }
      },
      {
        command: 'git',
        args: ['clone', '--depth', '1', 'https://github.com/example/TokenBoard.git', '/home/user/.tokenboard/upgrade-work/TokenBoard'],
        options: {}
      },
      {
        command: 'remove',
        args: ['/home/user/.tokenboard/TokenBoard'],
        options: { recursive: true, force: true }
      },
      {
        command: 'copy',
        args: ['/home/user/.tokenboard/upgrade-work/TokenBoard', '/home/user/.tokenboard/TokenBoard'],
        options: { recursive: true, force: true }
      },
      {
        command: 'remove',
        args: ['/home/user/.tokenboard/upgrade-work'],
        options: { recursive: true, force: true }
      },
      {
        command: 'copy',
        args: ['/home/user/.tokenboard/TokenBoard/skills/tokenboard', '/home/user/.codex/skills/tokenboard'],
        options: { recursive: true, force: true }
      },
      {
        command: 'corepack',
        args: ['pnpm', 'install', '--frozen-lockfile'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      }
    ]
  )
})

test('refuses to copy into the TokenBoard config directory', () => {
  assert.throws(
    () => buildUpgradePlan({
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      skillDir: '/home/user/.tokenboard',
      configDir: '/home/user/.tokenboard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'pnpm',
      collectorExists: true,
      collectorIsGitRepo: true
    }),
    /Refusing to replace TokenBoard config directory/
  )
})

test('uses configured git repo URLs but ignores legacy zip download URLs', () => {
  assert.equal(
    resolveRepoUrl({
      flags: {},
      env: {},
      config: { repoUrl: 'https://github.com/example/TokenBoard.git' }
    }),
    'https://github.com/example/TokenBoard.git'
  )

  assert.equal(
    resolveRepoUrl({
      flags: {},
      env: {},
      config: { repoUrl: 'https://github.com/example/TokenBoard/archive/refs/heads/master.zip' }
    }),
    'https://github.com/evepupil/TokenBoard.git'
  )

  assert.equal(
    resolveRepoUrl({
      flags: { 'repo-url': 'https://github.com/example/fork.git' },
      env: { TOKENBOARD_REPO_URL: 'https://github.com/example/env.git' },
      config: { repoUrl: 'https://github.com/example/config.git' }
    }),
    'https://github.com/example/fork.git'
  )
})

test('resolves archive fallback URLs from explicit, legacy, and github repo values', () => {
  assert.equal(
    resolveArchiveUrl({
      flags: { 'archive-url': 'https://example.test/tokenboard.zip' },
      env: {},
      config: {},
      repoUrl: 'https://github.com/example/TokenBoard.git'
    }),
    'https://example.test/tokenboard.zip'
  )

  assert.equal(
    resolveArchiveUrl({
      flags: {},
      env: {},
      config: { repoUrl: 'https://github.com/example/TokenBoard/archive/refs/heads/master.zip' },
      repoUrl: 'https://github.com/example/TokenBoard.git'
    }),
    'https://github.com/example/TokenBoard/archive/refs/heads/master.zip'
  )

  assert.equal(
    resolveArchiveUrl({
      flags: {},
      env: {},
      config: {},
      repoUrl: 'https://github.com/example/TokenBoard.git'
    }),
    'https://github.com/example/TokenBoard/archive/refs/heads/master.zip'
  )
})
