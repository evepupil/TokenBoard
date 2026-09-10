import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export type CodexSymlinkRootsInput = string | readonly string[] | undefined

const symlinkRootsConfigHint =
  'Set TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON to a JSON array of absolute allowed target paths'

export function normalizeCodexSymlinkRoots(input: CodexSymlinkRootsInput): string[] {
  const values = typeof input === 'string' ? parseCodexSymlinkRootsJson(input) : input
  if (values === undefined) return []
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    !values.every((value) => typeof value === 'string' && value.trim().length > 0)
  ) {
    throw new Error(`Invalid Codex symlink roots: expected a non-empty JSON array of paths. ${symlinkRootsConfigHint}`)
  }
  const trimmed = values.map((value) => value.trim())
  if (trimmed.some((value) => !isAbsolute(value))) {
    throw new Error(`Invalid Codex symlink roots: expected absolute paths. ${symlinkRootsConfigHint}`)
  }
  return [...new Set(trimmed.map((value) => resolve(value)))]
}

export function parseCodexSymlinkRootsJson(value: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error('Invalid TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON: expected a JSON array of paths', {
      cause: error
    })
  }
  return normalizeCodexSymlinkRoots(parsed as string[])
}

export async function resolveCodexSessionRoot(
  rootPath: string,
  options: {
    rejectRootSymlink?: boolean
    allowedRootSymlinks?: readonly string[]
    rootBoundary?: string
  } = {}
): Promise<string | null> {
  const details = await lstat(rootPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw new Error(`Unable to inspect session directory ${rootPath}: ${error.message}`, { cause: error })
  })
  if (!details) return null

  const isRootSymlink = details.isSymbolicLink()
  if (isRootSymlink && options.rejectRootSymlink && !options.allowedRootSymlinks?.length) {
    throw new Error(
      `Unable to inspect session directory ${rootPath}: symbolic links are not supported. ${symlinkRootsConfigHint}`
    )
  }
  if (!details.isDirectory() && !isRootSymlink) {
    throw new Error(`Unable to inspect session directory ${rootPath}: path is not a directory`)
  }

  const resolved = await realpath(rootPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' && !isRootSymlink) return null
    if (error.code === 'ENOENT' && isRootSymlink) {
      throw new Error(
        `Unable to resolve session directory ${rootPath}: configured symbolic link target does not exist`,
        {
          cause: error
        }
      )
    }
    throw new Error(`Unable to resolve session directory ${rootPath}: ${error.message}`, { cause: error })
  })
  if (!resolved) return null

  const resolvedDetails = await stat(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' && !isRootSymlink) return null
    throw new Error(`Unable to inspect resolved session directory ${resolved}: ${error.message}`, { cause: error })
  })
  if (!resolvedDetails) return null
  if (!resolvedDetails.isDirectory()) {
    throw new Error(`Unable to inspect session directory ${rootPath}: resolved path is not a directory`)
  }

  if (isRootSymlink && options.rejectRootSymlink) {
    const allowedRoots = normalizeCodexSymlinkRoots(options.allowedRootSymlinks)
    const allowedTargets = await Promise.all(
      allowedRoots.map(async (allowedRoot) => {
        const resolvedAllowedRoot = await realpath(allowedRoot).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') {
            throw new Error(`Configured Codex symlink root does not exist: ${allowedRoot}`)
          }
          throw new Error(`Unable to resolve configured Codex symlink root ${allowedRoot}: ${error.message}`, {
            cause: error
          })
        })
        return resolvedAllowedRoot
      })
    )
    if (!allowedTargets.some((allowedRoot) => isPathInside(allowedRoot, resolved))) {
      throw new Error(
        `Unable to inspect session directory ${rootPath}: symlink target is outside configured Codex symlink roots. ${symlinkRootsConfigHint}`
      )
    }
    return resolved
  }

  if (options.rootBoundary) {
    const boundary = await realpath(options.rootBoundary).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        throw new Error(
          `Unable to resolve session root boundary ${options.rootBoundary}: configured boundary does not exist`,
          {
            cause: error
          }
        )
      }
      throw new Error(`Unable to resolve session root boundary ${options.rootBoundary}: ${error.message}`, {
        cause: error
      })
    })
    if (!isPathInside(boundary, resolved)) {
      throw new Error(`Unable to inspect session directory ${rootPath}: resolved path escapes its configured boundary`)
    }
  }
  return resolved
}

function isPathInside(parent: string, child: string) {
  const childRelative = relative(parent, child)
  return !isAbsolute(childRelative) && childRelative !== '..' && !childRelative.startsWith(`..${sep}`)
}
