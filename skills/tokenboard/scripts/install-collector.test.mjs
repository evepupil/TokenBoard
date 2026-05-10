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
        command: 'pnpm',
        args: ['install'],
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
      exists: true
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
        command: 'npm',
        args: ['install'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      }
    ]
  )
})
