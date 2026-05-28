import { createReadStream } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { walkJsonlFiles } from './session-file-walk'
const CODEX_SESSIONS_DIR = 'sessions'

type CodexSessionScopeOptions = {
  codexHome?: string
  since?: string
  until?: string
  now?: Date
  batchSize?: number
  onMissingSessionFile?: (sessionPath: string) => void
}

export type CodexSessionScope = { codexHome: string; cleanup: () => Promise<void> }

export async function createCodexSessionScope(
  options: CodexSessionScopeOptions = {}
): Promise<CodexSessionScope | null> {
  const scan = await prepareSessionScan(options)
  if (!scan) {
    return null
  }

  const scope = await createEmptyScope()
  let copied = 0
  try {
    for await (const file of iterateMatchingSessionFiles(scan)) {
      if (await copySessionFile(scan.sourceSessionsDir, scope.codexHome, file, options.onMissingSessionFile)) {
        copied += 1
      }
    }

    if (copied === 0) {
      await scope.cleanup()
      return null
    }

    return scope
  } catch (error) {
    await scope.cleanup()
    throw error
  }
}

export async function* createCodexSessionScopeBatches(
  options: CodexSessionScopeOptions = {}
): AsyncGenerator<CodexSessionScope> {
  const scan = await prepareSessionScan(options)
  if (!scan) {
    return
  }

  const batchSize = normalizeBatchSize(options.batchSize)
  const batch: string[] = []
  for await (const file of iterateMatchingSessionFiles(scan)) {
    batch.push(file)
    if (batch.length >= batchSize) {
      const scope = await createScope(
        scan.sourceSessionsDir,
        batch.splice(0, batch.length),
        options.onMissingSessionFile
      )
      if (scope) {
        yield scope
      }
    }
  }

  if (batch.length > 0) {
    const scope = await createScope(scan.sourceSessionsDir, batch, options.onMissingSessionFile)
    if (scope) {
      yield scope
    }
  }
}

async function prepareSessionScan(options: CodexSessionScopeOptions = {}) {
  const since = parseFilterDate(options.since, 'start')
  const until = parseFilterDate(options.until, 'end')
  const includeAll = options.since === 'all' && !until
  if (!includeAll && !since && !until) {
    return null
  }

  const sourceCodexHome = resolve(options.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex'))
  const sourceSessionsDir = join(sourceCodexHome, CODEX_SESSIONS_DIR)
  const directory = await stat(sourceSessionsDir).catch(() => null)
  if (!directory?.isDirectory()) {
    return null
  }

  return {
    sourceSessionsDir,
    includeAll,
    filter: { since, until, now: options.now || new Date() }
  }
}

async function* iterateMatchingSessionFiles(scan: {
  sourceSessionsDir: string
  includeAll: boolean
  filter: { since?: Date; until?: Date; now: Date }
}) {
  for await (const file of walkJsonlFiles(scan.sourceSessionsDir)) {
    const absoluteFile = isAbsolute(file) ? file : join(scan.sourceSessionsDir, file)
    if (!scan.includeAll && !(await isActiveSessionFile(absoluteFile, scan.filter))) {
      continue
    }

    yield absoluteFile
  }
}

async function createScope(
  sourceSessionsDir: string,
  files: string[],
  onMissingSessionFile?: (sessionPath: string) => void
) {
  const scope = await createEmptyScope()
  let copied = 0
  try {
    for (const file of files) {
      if (await copySessionFile(sourceSessionsDir, scope.codexHome, file, onMissingSessionFile)) {
        copied += 1
      }
    }
    if (copied === 0) {
      await scope.cleanup()
      return null
    }
    return scope
  } catch (error) {
    await scope.cleanup()
    throw error
  }
}

async function createEmptyScope() {
  const scopedHome = await mkdtemp(join(tmpdir(), 'tokenboard-codex-home-'))
  await mkdir(join(scopedHome, CODEX_SESSIONS_DIR), { recursive: true })
  return {
    codexHome: scopedHome,
    cleanup: () => rm(scopedHome, { recursive: true, force: true })
  }
}

async function copySessionFile(
  sourceSessionsDir: string,
  scopedHome: string,
  file: string,
  onMissingSessionFile?: (sessionPath: string) => void
) {
  const relativePath = relative(sourceSessionsDir, file)
  const target = join(scopedHome, CODEX_SESSIONS_DIR, relativePath)
  await mkdir(dirname(target), { recursive: true })
  try {
    await cp(file, target)
    return true
  } catch (error) {
    const cause = error as NodeJS.ErrnoException
    if (cause.code === 'ENOENT') {
      onMissingSessionFile?.(relativePath)
      return false
    }
    throw error
  }
}

function normalizeBatchSize(value: number | undefined) {
  if (!value || !Number.isFinite(value) || value < 1) {
    return 200
  }
  return Math.min(Math.floor(value), 1000)
}

async function isActiveSessionFile(
  file: string,
  options: { since?: Date; until?: Date; now: Date }
) {
  const fileStat = await stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null
    }
    throw new Error(`Unable to stat Codex session file ${file}: ${error.message}`)
  })
  if (!fileStat) {
    return false
  }
  if (!fileStat.isFile()) {
    throw new Error(`Unable to read Codex session file ${file}: path is not a file`)
  }
  if (isDateInRange(fileStat.mtime, options)) {
    return true
  }

  const tokenCountActivity = await readTokenCountActivity(file, options)
  if (tokenCountActivity.hasInRangeTimestamp) {
    return true
  }
  if (tokenCountActivity.hasAnyTimestamp) {
    return false
  }

  return false
}

async function readTokenCountActivity(file: string, options: { since?: Date; until?: Date }) {
  const activity = {
    hasAnyTimestamp: false,
    hasInRangeTimestamp: false
  }

  try {
    const stream = createReadStream(file, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of lines) {
      const timestamp = readTokenCountTimestamp(line)
      if (!timestamp) continue
      activity.hasAnyTimestamp = true
      if (isDateInRange(timestamp, options)) {
        activity.hasInRangeTimestamp = true
        lines.close()
        break
      }
    }
  } catch (error) {
    const cause = error as NodeJS.ErrnoException
    if (cause.code === 'ENOENT') {
      return activity
    }
    throw new Error(`Unable to read Codex session file ${file}: ${cause.message}`)
  }

  return activity
}

function readTokenCountTimestamp(line: string) {
  const trimmed = line.trim()
  if (!trimmed) return null

  const entry = parseJsonRecord(trimmed)
  if (!entry || entry.type !== 'event_msg') return null
  const payload = readRecord(entry.payload)
  if (payload?.type !== 'token_count') return null

  const timestamp = typeof entry.timestamp === 'string' ? new Date(entry.timestamp) : null
  return timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp : null
}

function isDateInRange(date: Date, options: { since?: Date; until?: Date }) {
  if (Number.isNaN(date.getTime())) {
    return false
  }
  if (options.since && date < options.since) {
    return false
  }
  if (options.until && date > options.until) {
    return false
  }
  return true
}

function parseFilterDate(value: string | undefined, boundary: 'start' | 'end') {
  if (!value || value === 'all') {
    return undefined
  }

  const compact = value.replaceAll('-', '').trim()
  if (!/^\d{8}$/.test(compact)) {
    throw new Error(`Invalid Codex usage date filter: ${value}. Expected YYYYMMDD or YYYY-MM-DD.`)
  }

  const year = Number.parseInt(compact.slice(0, 4), 10)
  const month = Number.parseInt(compact.slice(4, 6), 10) - 1
  const day = Number.parseInt(compact.slice(6, 8), 10)
  const date = new Date(Date.UTC(year, month, day))
  if (boundary === 'end') {
    date.setUTCHours(23, 59, 59, 999)
  }
  return date
}

function parseJsonRecord(value: string) {
  try {
    return readRecord(JSON.parse(value))
  } catch {
    return null
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
