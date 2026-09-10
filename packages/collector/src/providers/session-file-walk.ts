import { lstat, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { resolveCodexSessionRoot } from './codex-symlink-policy'

export type SessionJsonlResolutionOptions = {
  rejectRootSymlink?: boolean
  rootBoundary?: string
  allowedRootSymlinks?: readonly string[]
}

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
    files: walkDirectory(resolvedRoot, resolvedRoot)
  }
}

export async function* walkJsonlFiles(rootDir: string): AsyncGenerator<string> {
  const resolved = await resolveSessionJsonlFiles(rootDir)
  if (!resolved) return
  yield* resolved.files
}

async function resolveSessionRoot(rootDir: string, options: SessionJsonlResolutionOptions) {
  return resolveCodexSessionRoot(rootDir, options)
}

async function* walkDirectory(rootDir: string, currentDir: string): AsyncGenerator<string> {
  if (!(await assertSessionDirectory(currentDir))) return
  const entries = await readDirectoryEntries(currentDir)
  if (!entries) return
  for (const entry of entries.sort((left, right) => compareDirectoryEntries(rootDir, currentDir, left, right))) {
    const entryPath = join(currentDir, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Unable to read session entry ${entryPath}: symbolic links are not supported`)
    }
    if (entry.isDirectory()) {
      yield* walkDirectory(rootDir, entryPath)
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

async function readDirectoryEntries(currentDir: string) {
  try {
    return await readdir(currentDir, { withFileTypes: true })
  } catch (error) {
    const cause = error as NodeJS.ErrnoException
    if (cause.code === 'ENOENT') return null
    throw new Error(`Unable to read session directory ${currentDir}: ${cause.message}`)
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
