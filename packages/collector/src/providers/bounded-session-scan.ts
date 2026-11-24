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
// One JSONL line. Matches the Go client's `sessionscan.maxLineBytes` so the same
// file yields the same rows on both sides rather than one skipping what the other
// parses. A real session line is kilobytes; this only catches a pathological one.
export const maxSessionLineBytes = 64 * 1024 * 1024
// A directory listing that is too large to sort in one go is rejected rather than loaded
// whole; the sibling walkers carry the same ceiling (`session-file-walk` matches it, the
// Antigravity scanner uses 10k). A single abnormal directory must not be able to exhaust
// memory just by existing.
export const maxScanDirectoryEntries = 10_000

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
  maxDirectoryEntries?: number
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

  const entries = await readDirectoryEntries(
    currentDir,
    options.maxDirectoryEntries ?? maxScanDirectoryEntries,
    options
  )
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

    const stats = await statFile(entryPath, options)
    if (!stats) continue
    if (stats.size > (options.maxFileBytes ?? maxSessionFileBytes)) {
      options.onSkipped?.(entryPath, 'max-size')
      continue
    }
    yield { path: entryPath, mtimeMs: stats.mtimeMs, size: stats.size }
  }
}

async function readDirectoryEntries(currentDir: string, maxEntries: number, options: ScanOptions) {
  let directory
  try {
    // `opendir` succeeds on an unreadable directory on some platforms (the EACCES surfaces on
    // the first `read()`), so the whole listing runs inside this try, not just the open.
    directory = await opendir(currentDir)
    const entries = []
    while (true) {
      const entry = await directory.read()
      if (!entry) break
      entries.push(entry)
      // Bound the listing before sorting it, so a directory with an unbounded number of
      // entries cannot be loaded whole. The cap is a hard ceiling, not a budget: exceeding
      // it is reported and the directory is skipped, the same way an oversized file is.
      if (entries.length > maxEntries) {
        options.onSkipped?.(currentDir, 'max-entries')
        return null
      }
    }
    // Stable order keeps repeated scans and their diagnostics reproducible.
    return entries.sort((left, right) => left.name.localeCompare(right.name))
  } catch (error) {
    if (isIgnorableScanError(error)) {
      // A directory the scan cannot read (EACCES/EPERM) or that raced away (ENOENT/ENOTDIR)
      // is skipped, but never silently: a whole root that is unreadable would otherwise look
      // like an uninstalled tool and its usage would vanish without a trace.
      const cause = error as NodeJS.ErrnoException
      options.onSkipped?.(currentDir, cause.code === 'EACCES' || cause.code === 'EPERM' ? 'unreadable' : 'vanished')
      return null
    }
    const cause = error as NodeJS.ErrnoException
    throw new Error(`Unable to read session directory ${currentDir}: ${cause.message}`)
  } finally {
    await directory?.close().catch(() => {})
  }
}

async function statFile(filePath: string, options: ScanOptions) {
  try {
    return await stat(filePath)
  } catch (error) {
    // A session log can be rotated away mid-scan; that is not a failure. A file the scan is not
    // allowed to read is reported rather than dropped, for the same reason as the directory case.
    if (isIgnorableScanError(error)) {
      const cause = error as NodeJS.ErrnoException
      options.onSkipped?.(filePath, cause.code === 'EACCES' || cause.code === 'EPERM' ? 'unreadable' : 'vanished')
      return null
    }
    throw error
  }
}

/**
 * Read a session log line by line so a large file never lands in memory, skipping
 * any single line longer than `maxLineBytes` before it reaches the parser.
 *
 * readline has no per-line ceiling: a file within `maxSessionFileBytes` (256 MiB)
 * can hand back a 256 MiB string, which then goes into `JSON.parse` as a full
 * object graph. readline still materializes that one line to hand it over, so the
 * cap bounds what reaches the parser, not the reader's peak allocation for an
 * oversized row. The Go client caps a line at 64 MiB, so an unbounded reader is
 * both a memory hazard and a cross-client divergence.
 *
 * A skipped line is reported, not silently dropped — the caller decides whether a
 * diagnostic is enough. The rest of the file is still read, which is the same
 * policy the claude-code/codex reader applies to an oversized assistant row.
 */
export async function* readSessionLinesBounded(
  filePath: string,
  options: { maxLineBytes?: number; onSkippedLine?: (bytes: number) => void } = {}
): AsyncGenerator<string> {
  const maxLineBytes = options.maxLineBytes ?? maxSessionLineBytes
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      // Byte length, not `line.length`: a string of multi-byte characters occupies
      // several times its code-unit count in memory, and the Go side compares bytes.
      const bytes = Buffer.byteLength(line, 'utf8')
      if (bytes > maxLineBytes) {
        options.onSkippedLine?.(bytes)
        continue
      }
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
