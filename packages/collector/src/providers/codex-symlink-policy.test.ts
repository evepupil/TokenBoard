import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { normalizeCodexSymlinkRoots, resolveCodexSessionRoot } from './codex-symlink-policy'

describe('Codex symlink policy', () => {
  test('rejects relative configured symlink roots', () => {
    expect(() => normalizeCodexSymlinkRoots(['relative/archive'])).toThrow(
      'Invalid Codex symlink roots: expected absolute paths'
    )
  })

  test.skipIf(process.platform === 'win32')('rejects a missing configured root boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-symlink-policy-'))
    const sessionRoot = join(root, 'codex', 'sessions')
    try {
      await mkdir(sessionRoot, { recursive: true })

      await expect(
        resolveCodexSessionRoot(sessionRoot, {
          rootBoundary: join(root, 'missing-boundary')
        })
      ).rejects.toThrow('configured boundary does not exist')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')('allows an explicitly configured root target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-symlink-policy-'))
    const target = join(root, 'archive-target')
    const linked = join(root, 'codex', 'archived_sessions')
    try {
      await mkdir(target, { recursive: true })
      await mkdir(join(root, 'codex'), { recursive: true })
      await symlink(target, linked)

      await expect(
        resolveCodexSessionRoot(linked, {
          rejectRootSymlink: true,
          rootBoundary: join(root, 'codex'),
          allowedRootSymlinks: [target]
        })
      ).resolves.toBe(await realpath(target))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')('rejects an unconfigured root target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-symlink-policy-'))
    const target = join(root, 'archive-target')
    const linked = join(root, 'codex', 'archived_sessions')
    try {
      await mkdir(target, { recursive: true })
      await mkdir(join(root, 'different-target'), { recursive: true })
      await mkdir(join(root, 'codex'), { recursive: true })
      await symlink(target, linked)

      await expect(
        resolveCodexSessionRoot(linked, {
          rejectRootSymlink: true,
          rootBoundary: join(root, 'codex'),
          allowedRootSymlinks: [join(root, 'different-target')]
        })
      ).rejects.toThrow(/outside configured Codex symlink roots/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')('reports a broken configured root symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-symlink-policy-'))
    const linked = join(root, 'codex', 'archived_sessions')
    try {
      await mkdir(join(root, 'codex'), { recursive: true })
      await symlink(join(root, 'missing-target'), linked)

      await expect(
        resolveCodexSessionRoot(linked, {
          rejectRootSymlink: true,
          rootBoundary: join(root, 'codex'),
          allowedRootSymlinks: [join(root, 'missing-target')]
        })
      ).rejects.toThrow('configured symbolic link target does not exist')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
