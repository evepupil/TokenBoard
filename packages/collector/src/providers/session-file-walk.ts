import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

export async function* walkJsonlFiles(rootDir: string): AsyncGenerator<string> {
  yield* walkDirectory(rootDir, rootDir)
}

async function* walkDirectory(rootDir: string, currentDir: string): AsyncGenerator<string> {
  const entries = await readDirectoryEntries(currentDir)
  if (!entries) return
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = join(currentDir, entry.name)
    if (entry.isDirectory()) {
      yield* walkDirectory(rootDir, entryPath)
      continue
    }
    if (entry.name.endsWith('.jsonl')) {
      yield normalizeRelativePath(relative(rootDir, entryPath))
    }
  }
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

function normalizeRelativePath(value: string) {
  return value.split('\\').join('/')
}
