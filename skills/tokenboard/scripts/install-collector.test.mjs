import assert from 'node:assert/strict'
import test from 'node:test'
import { buildInstallCollectorPlan } from './install-collector.mjs'

test('clones the configured collector repo before installing dependencies', () => {
  assert.deepEqual(
    buildInstallCollectorPlan({
      dir: '/home/user/.tokenboard/TokenBoard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'pnpm',
      exists: false
    }),
    [
      {
        command: 'git',
        args: ['clone', '--depth', '1', 'https://github.com/example/TokenBoard.git', '/home/user/.tokenboard/TokenBoard'],
        options: {}
      },
      {
        command: 'corepack',
        args: ['pnpm', 'install', '--frozen-lockfile'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      }
    ]
  )
})

test('updates the existing collector origin before pulling', () => {
  assert.deepEqual(
    buildInstallCollectorPlan({
      dir: '/home/user/.tokenboard/TokenBoard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'npm',
      exists: true,
      isGitRepo: true
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

test('removes an existing non-git collector directory before cloning', () => {
  assert.deepEqual(
    buildInstallCollectorPlan({
      dir: '/home/user/.tokenboard/TokenBoard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'bun',
      exists: true,
      isGitRepo: false
    }),
    [
      {
        command: 'remove',
        args: ['/home/user/.tokenboard/TokenBoard'],
        options: { recursive: true, force: true }
      },
      {
        command: 'git',
        args: ['clone', '--depth', '1', 'https://github.com/example/TokenBoard.git', '/home/user/.tokenboard/TokenBoard'],
        options: {}
      },
      {
        command: 'corepack',
        args: ['pnpm', 'install', '--frozen-lockfile'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      }
    ]
  )
})

test('uses corepack pnpm for workspace dependency install on Windows', () => {
  assert.deepEqual(
    buildInstallCollectorPlan({
      dir: 'C:\\Users\\QDM\\.tokenboard\\TokenBoard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'npm',
      exists: false,
      platform: 'win32'
    }).at(-1),
    {
      command: 'corepack.cmd',
      args: ['pnpm', 'install', '--frozen-lockfile'],
      options: { cwd: 'C:\\Users\\QDM\\.tokenboard\\TokenBoard' }
    }
  )
})

test('refuses to replace the config directory as a non-git collector', () => {
  assert.throws(
    () => buildInstallCollectorPlan({
      dir: '/home/user/.tokenboard',
      configDir: '/home/user/.tokenboard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'pnpm',
      exists: true,
      isGitRepo: false
    }),
    /Refusing to replace TokenBoard config directory/
  )
})
