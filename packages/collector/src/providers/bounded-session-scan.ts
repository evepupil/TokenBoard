import { createReadStream } from 'node:fs'
import { opendir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * Bounded, symlink-safe scanning for session logs under a user's home
 * directory.
 *
 * These roots are outside TokenBoard's control, so a scan must not be able to
 * hang or exhaust memory: recursion is depth-capped, symlinked directories are
 * never followed (a cycle would otherwise recurse forever), and oversized files
 * are skipped. Session logs are read line by line because a single one can be
 * tens of megabytes.
 */
export const maxScanDepth = 8
export const maxSessionFileBytes = 256 * 1024 * 1024

export type ScannedSessionFile = {
  path: string
  mtimeMs: number
  size: number
}

export type ScanOptions = {
  /** Accepts a file name and returns whether it is a session log. */
  matches: (fileName: string) => boolean
  maxDepth?: number
  maxFileBytes?: number
  onSkipped?: (path: string, reason: string) => void
}

/**
 * Yield every session log under `rootDir`, in a stable order.
 *
 * A missing root yields nothing: the tool simply is not installed.
 */
export async function* scanSessionFiles(rootDir: string, options: ScanOptions): AsyncGenerator<ScannedSessionFile> {
  yield* scanDirectory(rootDir, options, 0)
}

async function* scanDirectory(
  currentDir: string,
  options: ScanOptions,
  depth: number
): AsyncGenerator<ScannedSessionFile> {
  if (depth > (options.maxDepth ?? maxScanDepth)) {
    options.onSkipped?.(currentDir, 'max-depth')
    return
  }

  const entries = await readDirectoryEntries(currentDir)
  if (!entries) return

  for (const entry of entries) {
    const entryPath = join(currentDir, entry.name)
    if (entry.isSymbolicLink()) {
      // Never follow a link: a cycle under the root would recurse forever.
      options.onSkipped?.(entryPath, 'symlink')
      continue
    }
    if (entry.isDirectory()) {
      yield* scanDirectory(entryPath, options, depth + 1)
      continue
    }
    if (!entry.isFile() || !options.matches(entry.name)) continue

    const stats = await statFile(entryPath)
    if (!stats) continue
    if (stats.size > (options.maxFileBytes ?? maxSessionFileBytes)) {
      options.onSkipped?.(entryPath, 'max-size')
      continue
    }
    yield { path: entryPath, mtimeMs: stats.mtimeMs, size: stats.size }
  }
}

async function readDirectoryEntries(currentDir: string) {
  try {
    const directory = await opendir(currentDir)
    try {
      const entries = []
      while (true) {
        const entry = await directory.read()
        if (!entry) break
        entries.push(entry)
      }
      // Stable order keeps repeated scans and their diagnostics reproducible.
      return entries.sort((left, right) => left.name.localeCompare(right.name))
    } finally {
      await directory.close()
    }
  } catch (error) {
    if (isIgnorableScanError(error)) return null
    const cause = error as NodeJS.ErrnoException
    throw new Error(`Unable to read session directory ${currentDir}: ${cause.message}`)
  }
}

async function statFile(filePath: string) {
  try {
    return await stat(filePath)
  } catch (error) {
    // A session log can be rotated away mid-scan; that is not a failure.
    if (isIgnorableScanError(error)) return null
    throw error
  }
}

/** Read a session log line by line so a large file never lands in memory. */
export async function* readSessionLines(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      yield line
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}

function isIgnorableScanError(error: unknown) {
  if (!(error instanceof Error) || !('code' in error)) return false
  // ENOENT: removed mid-scan. EACCES/EPERM: not ours to read. ENOTDIR: raced.
  return error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'ENOTDIR'
}
