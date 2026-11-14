import { lstat, opendir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { resolveCodexSessionRoot } from './codex-symlink-policy'

export type SessionJsonlResolutionOptions = {
  rejectRootSymlink?: boolean
  rootBoundary?: string
  allowedRootSymlinks?: readonly string[]
  /** Recursion cap below the root, matching `bounded-session-scan`'s default. */
  maxDepth?: number
  /** Per-directory entry cap, matching the Antigravity scanner's limit. */
  maxEntries?: number
}

// The codex/claude session tree is outside TokenBoard's control, so the walk needs the same
// ceilings its sibling scanners carry: `bounded-session-scan` caps depth at 8, and the
// Antigravity scanner caps a single directory listing at 10k entries. Symlinked entries are
// already rejected, so a cycle cannot recurse forever — these bounds cover a deliberately
// deep tree and a directory too large to list in one go.
export const maxSessionWalkDepth = 8
export const maxSessionWalkEntries = 10_000

export type SessionJsonlFiles = {
  rootDir: string
  files: AsyncGenerator<string>
}

export async function resolveSessionJsonlFiles(
  rootDir: string,
  options: SessionJsonlResolutionOptions = {}
): Promise<SessionJsonlFiles | null> {
  const resolvedRoot = await resolveSessionRoot(rootDir, options)
  if (!resolvedRoot) return null
  return {
    rootDir: resolvedRoot,
    files: walkDirectory(resolvedRoot, resolvedRoot, options, 0)
  }
}

export async function* walkJsonlFiles(
  rootDir: string,
  options: SessionJsonlResolutionOptions = {}
): AsyncGenerator<string> {
  const resolved = await resolveSessionJsonlFiles(rootDir, options)
  if (!resolved) return
  yield* resolved.files
}

async function resolveSessionRoot(rootDir: string, options: SessionJsonlResolutionOptions) {
  return resolveCodexSessionRoot(rootDir, options)
}

async function* walkDirectory(
  rootDir: string,
  currentDir: string,
  options: SessionJsonlResolutionOptions,
  depth: number
): AsyncGenerator<string> {
  const maxDepth = options.maxDepth ?? maxSessionWalkDepth
  const maxEntries = options.maxEntries ?? maxSessionWalkEntries
  if (depth > maxDepth) {
    throw new Error(`Session directory ${currentDir} exceeds the ${maxDepth}-level scan depth limit`)
  }
  if (!(await assertSessionDirectory(currentDir))) return
  const listing = await readDirectoryEntries(currentDir, maxEntries)
  if (!listing) return
  if (listing.exceeded) {
    throw new Error(`Session directory ${currentDir} exceeds the ${maxEntries}-entry scan limit`)
  }
  const entries = listing.entries
  for (const entry of entries.sort((left, right) => compareDirectoryEntries(rootDir, currentDir, left, right))) {
    const entryPath = join(currentDir, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Unable to read session entry ${entryPath}: symbolic links are not supported`)
    }
    if (entry.isDirectory()) {
      yield* walkDirectory(rootDir, entryPath, options, depth + 1)
      continue
    }
    if (entry.name.endsWith('.jsonl')) {
      yield normalizeSessionRelativePath(relative(rootDir, entryPath))
    }
  }
}

async function assertSessionDirectory(path: string) {
  const details = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw new Error(`Unable to inspect session directory ${path}: ${error.message}`, { cause: error })
  })
  if (!details) return false
  if (details.isSymbolicLink()) {
    throw new Error(`Unable to inspect session directory ${path}: symbolic links are not supported`)
  }
  if (!details.isDirectory()) {
    throw new Error(`Unable to inspect session directory ${path}: path is not a directory`)
  }
  return true
}

async function readDirectoryEntries(
  currentDir: string,
  maxEntries: number
): Promise<{ entries: Dirent[]; exceeded: boolean } | null> {
  let directory
  try {
    // `opendir` streams, so the entry cap is enforced while reading instead of after a
    // directory with an unbounded number of entries has already been loaded whole.
    directory = await opendir(currentDir)
    const entries: Dirent[] = []
    while (entries.length <= maxEntries) {
      const entry = await directory.read()
      if (!entry) return { entries, exceeded: false }
      entries.push(entry)
    }
    return { entries, exceeded: true }
  } catch (error) {
    const cause = error as NodeJS.ErrnoException
    if (cause.code === 'ENOENT') return null
    throw new Error(`Unable to read session directory ${currentDir}: ${cause.message}`)
  } finally {
    await directory?.close().catch(() => {})
  }
}

export function normalizeSessionRelativePath(value: string) {
  return sep === '\\' ? value.split(sep).join('/') : value
}

export function compareSessionRelativePaths(left: string, right: string) {
  const normalizedLeft = normalizeSessionRelativePath(left)
  const normalizedRight = normalizeSessionRelativePath(right)
  if (normalizedLeft === normalizedRight) return 0
  return normalizedLeft < normalizedRight ? -1 : 1
}

function compareDirectoryEntries(
  rootDir: string,
  currentDir: string,
  left: { name: string; isDirectory: () => boolean },
  right: { name: string; isDirectory: () => boolean }
) {
  return compareSessionRelativePaths(
    entrySortPath(rootDir, currentDir, left),
    entrySortPath(rootDir, currentDir, right)
  )
}

function entrySortPath(rootDir: string, currentDir: string, entry: { name: string; isDirectory: () => boolean }) {
  const path = normalizeSessionRelativePath(relative(rootDir, join(currentDir, entry.name)))
  return entry.isDirectory() ? `${path}/` : path
}
