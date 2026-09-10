import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { UsageSnapshot } from '@tokenboard/usage-core'
import {
  collectHookIncremental,
  readStateDir,
  type HookIncrementalResult,
  type HookPendingSnapshotEntry,
  type HookReconciliationFileEntry
} from './hook-incremental'
import { cursorFileName, readCursor, withCursorLock, writeCursor, type CursorEntry } from './session-cursor-store'
import { resolveCodexSessionRoot } from './codex-symlink-policy'

type CodexHookProfileInput = {
  codexHomes: string[]
  codexSymlinkRoots?: readonly string[]
  stateDir?: string
  stderr?: (line: string) => void
  timezone: string
  collectedAt: string
}

export type CodexHookProfilesResult = {
  changed: boolean
  rangeArgs: string[]
  changedDates: string[]
  changedKeys: Array<{ usageDate: string; model: string }>
  cachedSnapshots: UsageSnapshot[]
  acknowledgedFilesByCursorScope: CodexHookAcknowledgedFilesByCursorScope[]
  unresolvedContextPricingSnapshots?: UsageSnapshot[]
}

export type CodexHookAcknowledgedFile = Pick<HookReconciliationFileEntry, 'relativePath' | 'sha256'>

export type CodexHookAcknowledgedFilesByCursorScope = {
  cursorScope?: string
  files: CodexHookAcknowledgedFile[]
}

type CodexHookAcknowledgementMetadata = {
  byCursorScope: readonly CodexHookAcknowledgedFilesByCursorScope[]
}

export const codexHookAcknowledgementSymbol = Symbol('tokenboard.codexHookAcknowledgement')

type TaggedCodexSnapshot = UsageSnapshot & {
  [codexHookAcknowledgementSymbol]?: CodexHookAcknowledgementMetadata
}

export function attachCodexHookAcknowledgement(
  snapshots: UsageSnapshot[],
  byCursorScope: readonly CodexHookAcknowledgedFilesByCursorScope[]
) {
  const metadata: CodexHookAcknowledgementMetadata = {
    byCursorScope: byCursorScope.map((entry) => ({
      ...(entry.cursorScope === undefined ? {} : { cursorScope: entry.cursorScope }),
      files: entry.files.map((file) => ({ ...file }))
    }))
  }
  for (const snapshot of snapshots) {
    if (Object.prototype.hasOwnProperty.call(snapshot, codexHookAcknowledgementSymbol)) continue
    Object.defineProperty(snapshot as TaggedCodexSnapshot, codexHookAcknowledgementSymbol, {
      configurable: false,
      enumerable: false,
      value: metadata,
      writable: false
    })
  }
  return snapshots
}

export function readCodexHookAcknowledgement(snapshots: readonly UsageSnapshot[]) {
  const byCursorScope = new Map<string | undefined, Map<string, CodexHookAcknowledgedFile>>()
  let found = false
  for (const snapshot of snapshots) {
    const metadata = (snapshot as TaggedCodexSnapshot)[codexHookAcknowledgementSymbol]
    if (!metadata) continue
    found = true
    for (const entry of metadata.byCursorScope) {
      const files = byCursorScope.get(entry.cursorScope) ?? new Map<string, CodexHookAcknowledgedFile>()
      for (const file of entry.files) files.set(`${file.relativePath}\0${file.sha256}`, file)
      byCursorScope.set(entry.cursorScope, files)
    }
  }
  if (!found) return undefined
  return [...byCursorScope.entries()].map(([cursorScope, files]) => ({
    ...(cursorScope === undefined ? {} : { cursorScope }),
    files: [...files.values()]
  }))
}

export type CodexHookCursorPlan = {
  cursorNames: string[]
  cursorScopes: Array<string | undefined>
  usesProfileCursors: boolean
}

export async function collectCodexHookProfiles(input: CodexHookProfileInput): Promise<CodexHookProfilesResult> {
  const stateDir = input.stateDir ?? readStateDir()
  const plan = await resolveCodexHookCursorPlan({ codexHomes: input.codexHomes, stateDir })
  const hasLegacyPending =
    plan.usesProfileCursors &&
    (await migrateLegacyCodexHookCursor({
      codexHomes: input.codexHomes,
      stateDir,
      codexSymlinkRoots: input.codexSymlinkRoots
    }))
  const profileIncrementals = await Promise.all(
    input.codexHomes.map((codexHome, index) =>
      collectHookIncremental({
        source: 'codex',
        sessionsDir: join(codexHome, 'sessions'),
        sessionDirs: [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')],
        allowedRootSymlinks: input.codexSymlinkRoots,
        cursorName: plan.cursorNames[index],
        cursorProfileHash: codexHookProfileHash(codexHome),
        stateDir,
        stderr: input.stderr,
        timezone: input.timezone,
        collectedAt: input.collectedAt,
        includePendingSnapshotEntries: true,
        includeReconciliationFileEntries: true
      })
    )
  )
  const scopedIncrementals: Array<{ cursorScope?: string; incremental: HookIncrementalResult }> =
    profileIncrementals.map((incremental, index) => ({
      ...(plan.usesProfileCursors ? { cursorScope: input.codexHomes[index] } : {}),
      incremental
    }))
  const incrementals = profileIncrementals.slice() as HookIncrementalResult[]
  if (hasLegacyPending) {
    const incremental = await collectHookIncremental({
      source: 'codex',
      sessionsDir: '',
      cursorName: 'codex-cursor.json',
      stateDir,
      stderr: input.stderr,
      timezone: input.timezone,
      collectedAt: input.collectedAt,
      includePendingSnapshotEntries: true,
      includeReconciliationFileEntries: true,
      skipSessionScan: true
    })
    incrementals.push(incremental)
    scopedIncrementals.push({ incremental })
  }
  return {
    ...mergeCodexHookIncrementals(incrementals),
    acknowledgedFilesByCursorScope: scopedIncrementals.map(({ cursorScope, incremental }) => ({
      ...(cursorScope === undefined ? {} : { cursorScope }),
      files: acknowledgeableFiles(incremental)
    }))
  }
}

export function codexHookProfileCursorName(codexHome: string) {
  return cursorFileName('codex', resolve(codexHome))
}

export function codexHookProfileHash(codexHome: string) {
  return createHash('sha256').update(resolve(codexHome)).digest('hex')
}

export async function resolveCodexHookCursorPlan(input: {
  codexHomes: string[]
  stateDir: string
}): Promise<CodexHookCursorPlan> {
  const [legacyCursor, hasProfileCursor] = await Promise.all([
    readLegacyCodexHookCursor(input.stateDir),
    Promise.all(
      input.codexHomes.map((codexHome) => isRegularFile(join(input.stateDir, codexHookProfileCursorName(codexHome))))
    )
  ])
  const activeProfileHash = input.codexHomes.length === 1 ? codexHookProfileHash(input.codexHomes[0]) : undefined
  const legacyBelongsToActiveProfile = legacyCursor?.codexHookProfileHash === activeProfileHash
  const usesProfileCursors =
    input.codexHomes.length > 1 ||
    hasProfileCursor.some(Boolean) ||
    (legacyCursor !== null && !legacyBelongsToActiveProfile)
  return {
    cursorNames: usesProfileCursors ? input.codexHomes.map(codexHookProfileCursorName) : ['codex-cursor.json'],
    cursorScopes: usesProfileCursors ? input.codexHomes : [undefined],
    usesProfileCursors
  }
}

async function readLegacyCodexHookCursor(stateDir: string) {
  const cursorPath = join(stateDir, 'codex-cursor.json')
  if (!(await isRegularFile(cursorPath))) return null
  return readCursor(cursorPath, 'codex')
}

async function migrateLegacyCodexHookCursor(input: {
  codexHomes: string[]
  stateDir: string
  codexSymlinkRoots?: readonly string[]
}) {
  const legacyCursorPath = join(input.stateDir, 'codex-cursor.json')
  if (!(await isRegularFile(legacyCursorPath))) return false
  return withCursorLock(legacyCursorPath, async () => {
    const legacy = await readCursor(legacyCursorPath, 'codex')
    const persistedMatches = await matchingPersistedLegacyEntries({
      codexHomes: input.codexHomes,
      stateDir: input.stateDir,
      legacy
    })
    let changed = false
    for (const [relativePath, entry] of Object.entries(legacy.files)) {
      if (persistedMatches.has(relativePath)) {
        delete legacy.files[relativePath]
        changed = true
        continue
      }
      const matchingHomes = await matchingCodexHomes({
        codexHomes: input.codexHomes,
        relativePath,
        entry,
        codexSymlinkRoots: input.codexSymlinkRoots
      })
      if (matchingHomes.length === 0) {
        if (!entry.pendingUpload) {
          delete legacy.files[relativePath]
          changed = true
        }
        continue
      }
      for (const codexHome of matchingHomes) {
        await copyLegacyCursorEntry({ codexHome, relativePath, entry, stateDir: input.stateDir })
      }
      delete legacy.files[relativePath]
      changed = true
    }
    if (changed) await writeCursor(legacyCursorPath, legacy)
    return Object.values(legacy.files).some((entry) => entry.pendingUpload)
  })
}

async function matchingPersistedLegacyEntries(input: {
  codexHomes: string[]
  stateDir: string
  legacy: Awaited<ReturnType<typeof readCursor>>
}) {
  const matches = new Set<string>()
  for (const codexHome of input.codexHomes) {
    const cursorPath = join(input.stateDir, codexHookProfileCursorName(codexHome))
    if (!(await isRegularFile(cursorPath))) continue
    await withCursorLock(cursorPath, async () => {
      const cursor = await readCursor(cursorPath, 'codex')
      for (const [relativePath, legacyEntry] of Object.entries(input.legacy.files)) {
        if (!isSha256(legacyEntry.sha256)) continue
        if (cursor.files[relativePath]?.sha256 === legacyEntry.sha256) {
          matches.add(relativePath)
        }
      }
    })
  }
  return matches
}

async function copyLegacyCursorEntry(input: {
  codexHome: string
  relativePath: string
  entry: CursorEntry
  stateDir: string
}) {
  const cursorPath = join(input.stateDir, codexHookProfileCursorName(input.codexHome))
  await withCursorLock(cursorPath, async () => {
    const cursor = await readCursor(cursorPath, 'codex')
    if (cursor.files[input.relativePath]) return
    cursor.files[input.relativePath] = copyCursorEntry(input.entry)
    await writeCursor(cursorPath, cursor)
  })
}

async function matchingCodexHomes(input: {
  codexHomes: string[]
  relativePath: string
  entry: CursorEntry
  codexSymlinkRoots?: readonly string[]
}) {
  if (!isSha256(input.entry.sha256)) return []
  const matches = await Promise.all(
    input.codexHomes.map(async (codexHome) => {
      const sessionPaths = await resolveSessionPaths(codexHome, input.relativePath, input.codexSymlinkRoots)
      const activePath = sessionPaths[0]
      const archivedPath = sessionPaths[1]
      const activeDetails = activePath ? await inspectLegacySessionPath(activePath) : null
      const candidate = activeDetails ? activePath : archivedPath
      if (!candidate) return null
      return (await matchesLegacySessionContent(candidate, input.entry)) ? codexHome : null
    })
  )
  return matches.filter((codexHome): codexHome is string => codexHome !== null)
}

async function inspectLegacySessionPath(sessionPath: string) {
  return lstat(sessionPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw new Error(`Unable to inspect legacy Codex session file: ${error.message}`, { cause: error })
  })
}

async function resolveSessionPaths(codexHome: string, relativePath: string, codexSymlinkRoots?: readonly string[]) {
  const resolvedPaths: Array<string | null> = []
  for (const rootName of ['sessions', 'archived_sessions']) {
    const configuredRoot = join(codexHome, rootName)
    const resolvedRoot = await resolveCodexSessionRoot(configuredRoot, {
      rejectRootSymlink: true,
      allowedRootSymlinks: codexSymlinkRoots,
      rootBoundary: codexHome
    })
    if (!resolvedRoot) {
      resolvedPaths.push(null)
      continue
    }
    const sessionPath = resolve(resolvedRoot, relativePath)
    if (!isPathInside(resolvedRoot, sessionPath)) {
      throw new Error('Invalid legacy Codex cursor session path')
    }
    resolvedPaths.push(sessionPath)
  }
  return resolvedPaths
}

async function matchesLegacySessionContent(sessionPath: string, entry: CursorEntry) {
  const details = await lstat(sessionPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw new Error(`Unable to inspect legacy Codex session file: ${error.message}`, { cause: error })
  })
  if (details?.isSymbolicLink()) {
    throw new Error(`Unable to inspect legacy Codex session file: symbolic links are not supported`)
  }
  if (!details?.isFile() || details.size < entry.size || !Number.isSafeInteger(entry.size) || entry.size < 0) {
    return false
  }
  const hash = createHash('sha256')
  let handle
  try {
    handle = await open(sessionPath, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Legacy Codex session file changed while matching profile cursors; retry the sync', {
        cause: error
      })
    }
    throw new Error(`Unable to inspect legacy Codex session file: ${(error as Error).message}`, { cause: error })
  }

  try {
    const opened = await handle.stat()
    const pathAfterOpen = await lstat(sessionPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw new Error(`Unable to inspect legacy Codex session file: ${error.message}`, { cause: error })
    })
    if (
      !pathAfterOpen ||
      pathAfterOpen.isSymbolicLink() ||
      !pathAfterOpen.isFile() ||
      !sameSessionFileMetadata(details, opened) ||
      !sameSessionFileMetadata(opened, pathAfterOpen)
    ) {
      throw new Error('Legacy Codex session file changed while matching profile cursors; retry the sync')
    }

    let offset = 0
    const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, entry.size)))
    while (offset < entry.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, entry.size - offset), offset)
      if (result.bytesRead === 0) {
        throw new Error('Legacy Codex session file changed while matching profile cursors; retry the sync')
      }
      hash.update(buffer.subarray(0, result.bytesRead))
      offset += result.bytesRead
    }

    const after = await handle.stat()
    const pathAfterRead = await lstat(sessionPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw new Error(`Unable to inspect legacy Codex session file: ${error.message}`, { cause: error })
    })
    if (
      !pathAfterRead ||
      pathAfterRead.isSymbolicLink() ||
      !pathAfterRead.isFile() ||
      !sameSessionFileMetadata(details, after) ||
      !sameSessionFileMetadata(after, pathAfterRead)
    ) {
      throw new Error('Legacy Codex session file changed while matching profile cursors; retry the sync')
    }
    return hash.digest('hex') === entry.sha256
  } finally {
    await handle.close()
  }
}

function copyCursorEntry(entry: CursorEntry): CursorEntry {
  return {
    ...entry,
    snapshots: entry.snapshots.map((snapshot) => ({ ...snapshot }))
  }
}

async function isRegularFile(path: string) {
  const details = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw new Error(`Unable to inspect legacy Codex cursor: ${error.message}`, { cause: error })
  })
  if (details?.isSymbolicLink()) {
    throw new Error(`Unable to inspect legacy Codex cursor: symbolic links are not supported`)
  }
  return details?.isFile() ?? false
}

function sameSessionFileMetadata(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function isPathInside(parent: string, child: string) {
  const path = relative(parent, child)
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}

function isSha256(value: string) {
  return /^[a-f0-9]{64}$/.test(value)
}

function mergeCodexHookIncrementals(incrementals: HookIncrementalResult[]): CodexHookProfilesResult {
  const changedDates = new Set<string>()
  const changedKeys = new Map<string, { usageDate: string; model: string }>()
  const pendingSnapshotEntries: HookPendingSnapshotEntry[] = []
  const reconciliationFileEntries = new Set<string>()
  for (const incremental of incrementals) {
    for (const date of incremental.changedDates) changedDates.add(date)
    for (const key of incremental.changedKeys) {
      changedKeys.set(snapshotKey(key), key)
    }
    pendingSnapshotEntries.push(...(incremental.pendingSnapshotEntries ?? []))
    for (const entry of incremental.reconciliationFileEntries ?? []) {
      reconciliationFileEntries.add(reconciliationFileKey(entry))
    }
  }
  const dates = [...changedDates].sort()
  const unreconciledEntries = pendingSnapshotEntries.filter(
    (entry) => !isPendingSnapshotReconciled(entry, reconciliationFileEntries)
  )
  const deduplicatedEntries = deduplicateCopiedPendingEntries(unreconciledEntries)
  const unresolvedEntries = deduplicatedEntries.filter((entry) => entry.contextPricingPending)
  return {
    changed: incrementals.some((incremental) => incremental.changed),
    rangeArgs: dateRangeArgs(dates),
    changedDates: dates,
    changedKeys: [...changedKeys.values()].sort(compareSnapshotKeys),
    cachedSnapshots: sortPendingSnapshots(deduplicatedEntries),
    acknowledgedFilesByCursorScope: [],
    ...(unresolvedEntries.length > 0
      ? { unresolvedContextPricingSnapshots: sortPendingSnapshots(unresolvedEntries) }
      : {})
  }
}

function acknowledgeableFiles(incremental: HookIncrementalResult): CodexHookAcknowledgedFile[] {
  const files = new Map<string, CodexHookAcknowledgedFile>()
  for (const entry of incremental.reconciliationFileEntries ?? []) {
    files.set(reconciliationFileKey(entry), {
      relativePath: entry.relativePath,
      sha256: entry.sha256
    })
  }
  const reconciliationFiles = new Set(files.keys())
  const pendingSnapshotEntries = incremental.pendingSnapshotEntries ?? []
  const unresolvedFiles = new Set(
    pendingSnapshotEntries.filter((entry) => entry.contextPricingPending).map(reconciliationFileKey)
  )
  for (const entry of pendingSnapshotEntries) {
    const key = reconciliationFileKey(entry)
    if (reconciliationFiles.has(key) || unresolvedFiles.has(key)) continue
    files.set(key, {
      relativePath: entry.relativePath,
      sha256: entry.sha256
    })
  }
  return [...files.values()].sort(
    (left, right) => left.relativePath.localeCompare(right.relativePath) || left.sha256.localeCompare(right.sha256)
  )
}

function isPendingSnapshotReconciled(entry: HookPendingSnapshotEntry, reconciliationFileEntries: ReadonlySet<string>) {
  return reconciliationFileEntries.has(reconciliationFileKey(entry))
}

function deduplicateCopiedPendingEntries(entries: HookPendingSnapshotEntry[]) {
  const deduplicated = new Map<string, HookPendingSnapshotEntry>()
  for (const entry of entries) {
    const key = copiedPendingSnapshotKey(entry)
    deduplicated.set(key, entry)
  }
  return [...deduplicated.values()]
}

function sortPendingSnapshots(entries: HookPendingSnapshotEntry[]) {
  return entries
    .map((entry) => entry.snapshot)
    .sort((left, right) => left.usageDate.localeCompare(right.usageDate) || left.model.localeCompare(right.model))
}

function copiedPendingSnapshotKey(entry: HookPendingSnapshotEntry) {
  const snapshot = entry.snapshot
  return [
    entry.relativePath,
    entry.sha256,
    snapshot.source,
    snapshot.usageDate,
    snapshot.timezone,
    snapshot.model,
    snapshot.inputTokens,
    snapshot.outputTokens,
    snapshot.cacheCreationTokens,
    snapshot.cacheReadTokens,
    snapshot.totalTokens,
    snapshot.costUsd,
    snapshot.sessionCount
  ].join('\0')
}

function reconciliationFileKey(entry: HookReconciliationFileEntry) {
  return [entry.relativePath, entry.sha256].join('\0')
}

function dateRangeArgs(dates: string[]) {
  if (dates.length === 0) return []
  return ['--since', dates[0].replaceAll('-', ''), '--until', dates[dates.length - 1].replaceAll('-', '')]
}

function snapshotKey(input: { usageDate: string; model: string }) {
  return `${input.usageDate}\0${input.model}`
}

function compareSnapshotKeys(left: { usageDate: string; model: string }, right: { usageDate: string; model: string }) {
  return left.usageDate.localeCompare(right.usageDate) || left.model.localeCompare(right.model)
}
