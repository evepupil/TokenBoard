import assert from 'node:assert/strict'
import test from 'node:test'
import { buildInstallCollectorPlan } from './install-collector.mjs'

test('clones the configured collector repo before installing dependencies', () => {
  assert.deepEqual(
    buildInstallCollectorPlan({
      dir: '/home/user/.tokenboard/TokenBoard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'pnpm',
      exists: false,
      platform: 'linux'
    }),
    [
      {
        command: 'git',
        args: [
          'clone',
          '--depth',
          '1',
          'https://github.com/example/TokenBoard.git',
          '/home/user/.tokenboard/TokenBoard'
        ],
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
      isGitRepo: true,
      platform: 'linux'
    }),
    [
      {
        command: 'git',
        args: ['remote', 'set-url', 'origin', 'https://github.com/example/TokenBoard.git'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'git-ensure-default-branch',
        args: [],
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

test('pins an existing collector checkout to a configured ref', () => {
  assert.deepEqual(
    buildInstallCollectorPlan({
      dir: '/home/user/.tokenboard/TokenBoard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      repoRef: 'research/agy-token-support-plan',
      packageManager: 'pnpm',
      exists: true,
      isGitRepo: true,
      platform: 'linux'
    }),
    [
      {
        command: 'git',
        args: ['remote', 'set-url', 'origin', 'https://github.com/example/TokenBoard.git'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'git-fetch-branch-or-ref',
        args: ['research/agy-token-support-plan'],
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

test('clones the configured collector ref when provided', () => {
  assert.deepEqual(
    buildInstallCollectorPlan({
      dir: '/home/user/.tokenboard/TokenBoard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      repoRef: 'research/agy-token-support-plan',
      packageManager: 'pnpm',
      exists: false,
      platform: 'linux'
    }),
    [
      {
        command: 'git',
        args: [
          'clone',
          '--depth',
          '1',
          '--no-checkout',
          'https://github.com/example/TokenBoard.git',
          '/home/user/.tokenboard/TokenBoard'
        ],
        options: {}
      },
      {
        command: 'git-fetch-branch-or-ref',
        args: ['research/agy-token-support-plan'],
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

test('treats all-hex collector refs as branch candidates when installing', () => {
  assert.deepEqual(
    buildInstallCollectorPlan({
      dir: '/home/user/.tokenboard/TokenBoard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      repoRef: 'deadbeef',
      packageManager: 'pnpm',
      exists: false,
      platform: 'linux'
    }),
    [
      {
        command: 'git',
        args: [
          'clone',
          '--depth',
          '1',
          '--no-checkout',
          'https://github.com/example/TokenBoard.git',
          '/home/user/.tokenboard/TokenBoard'
        ],
        options: {}
      },
      {
        command: 'git-fetch-branch-or-ref',
        args: ['deadbeef'],
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

test('clones a configured full ref detached when provided', () => {
  assert.deepEqual(
    buildInstallCollectorPlan({
      dir: '/home/user/.tokenboard/TokenBoard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      repoRef: 'refs/tags/v1.2.3',
      packageManager: 'pnpm',
      exists: false,
      platform: 'linux'
    }),
    [
      {
        command: 'git',
        args: [
          'clone',
          '--depth',
          '1',
          '--no-checkout',
          'https://github.com/example/TokenBoard.git',
          '/home/user/.tokenboard/TokenBoard'
        ],
        options: {}
      },
      {
        command: 'git',
        args: ['fetch', '--depth', '1', 'origin', 'refs/tags/v1.2.3'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'git',
        args: ['checkout', 'FETCH_HEAD'],
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
      isGitRepo: false,
      platform: 'linux'
    }),
    [
      {
        command: 'remove',
        args: ['/home/user/.tokenboard/TokenBoard'],
        options: { recursive: true, force: true }
      },
      {
        command: 'git',
        args: [
          'clone',
          '--depth',
          '1',
          'https://github.com/example/TokenBoard.git',
          '/home/user/.tokenboard/TokenBoard'
        ],
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
    () =>
      buildInstallCollectorPlan({
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

test('refuses a case-variant Windows config directory as a non-git collector', () => {
  assert.throws(
    () =>
      buildInstallCollectorPlan({
        dir: 'C:\\Users\\QDM\\.tokenboard',
        configDir: 'c:\\users\\qdm\\.TOKENBOARD',
        repoUrl: 'https://github.com/example/TokenBoard.git',
        packageManager: 'pnpm',
        exists: true,
        isGitRepo: false,
        platform: 'win32'
      }),
    /Refusing to replace TokenBoard config directory/
  )
})
