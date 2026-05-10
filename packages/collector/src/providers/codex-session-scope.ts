import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { glob } from 'node:fs/promises'

const CODEX_SESSIONS_DIR = 'sessions'
const JSONL_GLOB = '**/*.jsonl'

type CodexSessionScopeOptions = {
  codexHome?: string
  since?: string
  until?: string
  now?: Date
  batchSize?: number
}

export type CodexSessionScope = {
  codexHome: string
  cleanup: () => Promise<void>
}

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
      await copySessionFile(scan.sourceSessionsDir, scope.codexHome, file)
      copied += 1
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
      yield await createScope(scan.sourceSessionsDir, batch.splice(0, batch.length))
    }
  }

  if (batch.length > 0) {
    yield await createScope(scan.sourceSessionsDir, batch)
  }
}

async function prepareSessionScan(options: CodexSessionScopeOptions = {}) {
  const since = parseFilterDate(options.since, 'start')
  const until = parseFilterDate(options.until, 'end')
  const includeAll = options.since === 'all' && !until
  if (!includeAll && !since && !until) {
    return null
  }

  const sourceCodexHome = resolve(options.codexHome || process.env.CODEX_HOME || join(process.env.HOME || '', '.codex'))
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
  for await (const file of glob(JSONL_GLOB, { cwd: scan.sourceSessionsDir })) {
    const absoluteFile = isAbsolute(file) ? file : join(scan.sourceSessionsDir, file)
    if (!scan.includeAll && !(await isActiveSessionFile(absoluteFile, scan.filter))) {
      continue
    }

    yield absoluteFile
  }
}

async function createScope(sourceSessionsDir: string, files: string[]) {
  const scope = await createEmptyScope()
  try {
    for (const file of files) {
      await copySessionFile(sourceSessionsDir, scope.codexHome, file)
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

async function copySessionFile(sourceSessionsDir: string, scopedHome: string, file: string) {
  const relativePath = relative(sourceSessionsDir, file)
  const target = join(scopedHome, CODEX_SESSIONS_DIR, relativePath)
  await mkdir(dirname(target), { recursive: true })
  await cp(file, target)
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
  const content = await readFile(file, 'utf8').catch(() => '')
  const tokenCountActivity = readTokenCountActivity(content, options)
  if (tokenCountActivity.hasInRangeTimestamp) {
    return true
  }
  if (tokenCountActivity.hasAnyTimestamp) {
    return false
  }

  const fileStat = await stat(file).catch(() => null)
  return fileStat ? isDateInRange(fileStat.mtime, options) : false
}

function readTokenCountActivity(content: string, options: { since?: Date; until?: Date }) {
  const activity = {
    hasAnyTimestamp: false,
    hasInRangeTimestamp: false
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const entry = parseJsonRecord(trimmed)
    if (!entry || entry.type !== 'event_msg') continue
    const payload = readRecord(entry.payload)
    if (payload?.type !== 'token_count') continue

    const timestamp = typeof entry.timestamp === 'string' ? new Date(entry.timestamp) : null
    if (!timestamp || Number.isNaN(timestamp.getTime())) {
      continue
    }
    activity.hasAnyTimestamp = true
    if (isDateInRange(timestamp, options)) {
      activity.hasInRangeTimestamp = true
      return activity
    }
  }

  return activity
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

  const date = new Date(Date.UTC(
    Number.parseInt(compact.slice(0, 4), 10),
    Number.parseInt(compact.slice(4, 6), 10) - 1,
    Number.parseInt(compact.slice(6, 8), 10)
  ))
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
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
