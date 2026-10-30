import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBinaryInstallConfig, buildInstallCollectorPlan, resolveGitInstallOptions } from './install-collector.mjs'
import { defaultReleaseRepo } from './client-binary.mjs'

// A bare re-run is the recovery path sync.mjs names ("run install-collector.mjs
// again"), so it must not reset a configured mirror, ref or package manager to
// the project defaults and quietly move the machine off them.
test('a bare re-run keeps the repo, ref and package manager the config records', () => {
  assert.deepEqual(
    resolveGitInstallOptions({
      flags: {},
      env: {},
      saved: {
        repoUrl: 'https://gitea.example/mirror/TokenBoard.git',
        repoRef: 'release',
        packageManager: 'bun'
      }
    }),
    {
      repoUrl: 'https://gitea.example/mirror/TokenBoard.git',
      repoRef: 'release',
      packageManager: 'bun'
    }
  )
})

test('explicit flags still outrank the saved config', () => {
  assert.deepEqual(
    resolveGitInstallOptions({
      flags: { 'repo-url': 'https://github.com/example/TokenBoard.git', 'repo-ref': 'main', 'package-manager': 'npm' },
      env: {},
      saved: { repoUrl: 'https://gitea.example/mirror/TokenBoard.git', repoRef: 'release', packageManager: 'bun' }
    }),
    {
      repoUrl: 'https://github.com/example/TokenBoard.git',
      repoRef: 'main',
      packageManager: 'npm'
    }
  )
})

test('a first install still falls back to the project defaults', () => {
  assert.deepEqual(resolveGitInstallOptions({ flags: {}, env: {}, saved: {} }), {
    repoUrl: 'https://github.com/evepupil/TokenBoard.git',
    repoRef: null,
    packageManager: 'pnpm'
  })
})

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

// Replacing an existing checkout must not destroy it before the replacement exists. The
// clone lands in a staging sibling first and is swapped in with a backup kept until the
// swap succeeds — the same replace-with-rollback the upgrade path uses — so a failed clone
// (offline, bad ref) leaves the original directory untouched instead of an empty one.
test('replaces an existing non-git collector directory only after a staged clone succeeds', () => {
  const dir = '/home/user/.tokenboard/TokenBoard'
  const stagingDir = `${dir}.tokenboard-install-staging-${process.pid}`
  const backupDir = `${dir}.tokenboard-upgrade-backup-${process.pid}`
  assert.deepEqual(
    buildInstallCollectorPlan({
      dir,
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'bun',
      exists: true,
      isGitRepo: false,
      platform: 'linux'
    }),
    [
      {
        command: 'remove',
        args: [stagingDir],
        options: { recursive: true, force: true }
      },
      {
        command: 'git',
        args: ['clone', '--depth', '1', 'https://github.com/example/TokenBoard.git', stagingDir],
        options: {}
      },
      {
        command: 'replace',
        args: [stagingDir, dir, backupDir],
        options: {}
      },
      {
        command: 'corepack',
        args: ['pnpm', 'install', '--frozen-lockfile'],
        options: { cwd: dir }
      }
    ]
  )
})

test('uses corepack pnpm for workspace dependency install on Windows', () => {
  assert.deepEqual(
    buildInstallCollectorPlan({
      dir: 'C:\\Users\\example\\.tokenboard\\TokenBoard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'npm',
      exists: false,
      platform: 'win32'
    }).at(-1),
    {
      command: 'corepack.cmd',
      args: ['pnpm', 'install', '--frozen-lockfile'],
      options: { cwd: 'C:\\Users\\example\\.tokenboard\\TokenBoard' }
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
        dir: 'C:\\Users\\example\\.tokenboard',
        configDir: 'c:\\users\\example\\.TOKENBOARD',
        repoUrl: 'https://github.com/example/TokenBoard.git',
        packageManager: 'pnpm',
        exists: true,
        isGitRepo: false,
        platform: 'win32'
      }),
    /Refusing to replace TokenBoard config directory/
  )
})

// The install-time release source must outlive the install: every later
// automatic `self-update` resolves the feed on its own, and dropping it would
// move the machine back to the default repository. The tag is not recorded —
// it pins one install and would freeze the client on that version.
test('a binary install records a non-default release source', () => {
  assert.deepEqual(
    buildBinaryInstallConfig({ repo: 'other/TokenBoard', baseUrl: 'https://github.example', updatedAt: 'now' }),
    {
      clientType: 'binary',
      updatedAt: 'now',
      releaseRepo: 'other/TokenBoard',
      releaseBaseUrl: 'https://github.example'
    }
  )
})

test('a default-source binary install records only the switch', () => {
  assert.deepEqual(buildBinaryInstallConfig({ repo: defaultReleaseRepo, updatedAt: 'now' }), {
    clientType: 'binary',
    updatedAt: 'now'
  })
})
