import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fingerprintCodexSessionFile, type CodexSessionFileFingerprint } from './codex-session-attribution-cache'
import {
  CODEX_SESSION_COPY_FALLBACK_MESSAGE,
  createCodexSessionCloner,
  type CodexSessionCloner
} from './codex-session-cloner'
import { resolveCodexHomes as resolveConfiguredCodexHomes } from './codex-homes'
import {
  compareSessionRelativePaths,
  normalizeSessionRelativePath,
  resolveSessionJsonlFiles
} from './session-file-walk'
import { resolveCodexSessionRoot } from './codex-symlink-policy'
import {
  codexChildSessionReadLimits,
  maxCodexChildSessionLineBytes,
  maxDiscardedCodexChildSessionLineBytes
} from './codex-subagent-usage-child'
import { readJsonlRecordsFromStream } from './codex-subagent-usage-json'
import { isAllDateFilter } from '../iso-calendar-date'

const codexSessionRoots = ['sessions', 'archived_sessions'] as const
const DEFAULT_CODEX_SESSION_FILE_BYTES = 4 * 1024 * 1024 * 1024
const DEFAULT_CODEX_SESSION_BATCH_BYTES = 4 * 1024 * 1024 * 1024
const DEFAULT_CODEX_SESSION_GROUP_BYTES = 8 * 1024 * 1024 * 1024
const DEFAULT_CODEX_SESSION_PREFILTER_BYTES = 8 * 1024 * 1024
const DEFAULT_CODEX_SESSION_PREFILTER_LINE_BYTES = 1024 * 1024
const CODEX_SESSION_READ_CHUNK_BYTES = 64 * 1024
const CODEX_SESSION_PROJECTION_READ_CHUNK_BYTES = 1024 * 1024
type CodexSessionRootName = (typeof codexSessionRoots)[number]

type CodexSessionScopeOptions = {
  codexHome?: string
  codexHomes?: string[]
  since?: string
  until?: string
  now?: Date
  batchSize?: number
  files?: string[]
  onMissingSessionFile?: (sessionPath: string) => void
  onCopyFallback?: (message: string) => void
  onProjectionDiagnostic?: (message: string) => void
  maxFileBytes?: number
  maxBatchBytes?: number
  maxGroupBytes?: number
  maxPrefilterBytes?: number
  maxPrefilterLineBytes?: number
  codexSymlinkRoots?: readonly string[]
}

type CodexSessionScopeLimits = {
  maxFileBytes: number
  maxBatchBytes: number
  maxGroupBytes: number
  maxPrefilterBytes: number
  maxPrefilterLineBytes: number
}

type CodexSessionRoot = {
  name: CodexSessionRootName
  path: string
  resolvedPath: string
  isSymlink: boolean
  homeIndex: number
}

type CodexSessionCandidate = {
  root: CodexSessionRoot
  homeIndex: number
  file: string
  sourceFile: string
  relativePath: string
}

type PreparedCandidateGroup = {
  candidates: CodexSessionCandidate[]
  bytes: number
  hasOversizedFile: boolean
}

type CodexSessionScan = {
  roots: CodexSessionRoot[]
  includeAll: boolean
  filter: { since?: Date; until?: Date; now: Date }
  limits: CodexSessionScopeLimits
}

type CodexSessionScans = {
  scans: CodexSessionScan[]
  homeCount: number
  limits: CodexSessionScopeLimits
}

export type CodexSessionScope = {
  codexHome: string
  codexHomes: string[]
  cleanup: () => Promise<void>
  sourceFiles: Map<string, string>
  sourceFileHomeIndexes: Map<string, number>
  sourceFileFingerprints: Map<string, CodexSessionFileFingerprint>
  projectedSourceFiles: Set<string>
}

export type CodexSessionScopeFile = {
  codexHome: string
  filePath: string
}

export type CodexSessionScopeFileGroup = {
  files: CodexSessionScopeFile[]
}

export async function createCodexSessionScope(
  options: CodexSessionScopeOptions = {}
): Promise<CodexSessionScope | null> {
  if (options.files) return createExplicitScope(options)

  const scans = await prepareSessionScans(options)
  if (!scans) return null

  const reportCopyFallback = createCopyFallbackReporter(options.onCopyFallback)
  const scope = await createEmptyScope(scans.homeCount)
  try {
    const copied = await copyCandidates(
      scope,
      matchingSessionCandidatesAcrossHomes(scans.scans),
      options.onMissingSessionFile,
      scans.limits,
      undefined,
      reportCopyFallback,
      options.onProjectionDiagnostic
    )
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
  const scans = await prepareSessionScans(options)
  if (!scans) return

  const reportCopyFallback = createCopyFallbackReporter(options.onCopyFallback)
  yield* createScopeBatches({
    candidateGroups: matchingSessionCandidateGroups(scans.scans),
    homeCount: scans.homeCount,
    limits: scans.limits,
    batchSize: normalizeBatchSize(options.batchSize),
    onMissingSessionFile: options.onMissingSessionFile,
    reportCopyFallback,
    onProjectionDiagnostic: options.onProjectionDiagnostic
  })
}

export async function* createCodexSessionScopeBatchesForFiles(input: {
  codexHomes: string[]
  groups: CodexSessionScopeFileGroup[]
  batchSize?: number
  onMissingSessionFile?: (sessionPath: string) => void
  onCopyFallback?: (message: string) => void
  onProjectionDiagnostic?: (message: string) => void
  maxFileBytes?: number
  maxBatchBytes?: number
  maxGroupBytes?: number
  maxPrefilterBytes?: number
  maxPrefilterLineBytes?: number
  codexSymlinkRoots?: readonly string[]
}): AsyncGenerator<CodexSessionScope> {
  const limits = resolveSessionScopeLimits(input)
  const codexHomes = resolveCodexHomes({ codexHomes: input.codexHomes })
  const rootsByHome = await Promise.all(
    codexHomes.map((codexHome, homeIndex) => readSessionRoots(codexHome, homeIndex, input.codexSymlinkRoots))
  )
  const homeIndexes = new Map(codexHomes.map((codexHome, index) => [codexHome, index]))
  const candidateGroups = input.groups.map((group) =>
    selectCandidateGroup({
      group,
      codexHomes,
      homeIndexes,
      rootsByHome
    })
  )
  const reportCopyFallback = createCopyFallbackReporter(input.onCopyFallback)

  yield* createScopeBatches({
    candidateGroups,
    homeCount: codexHomes.length,
    limits,
    batchSize: normalizeBatchSize(input.batchSize),
    onMissingSessionFile: input.onMissingSessionFile,
    reportCopyFallback,
    onProjectionDiagnostic: input.onProjectionDiagnostic
  })
}

async function* createScopeBatches(input: {
  candidateGroups: AsyncIterable<CodexSessionCandidate[]> | Iterable<CodexSessionCandidate[]>
  homeCount: number
  limits: CodexSessionScopeLimits
  batchSize: number
  onMissingSessionFile?: (sessionPath: string) => void
  reportCopyFallback: () => void
  onProjectionDiagnostic?: (message: string) => void
}): AsyncGenerator<CodexSessionScope> {
  const batch: CodexSessionCandidate[] = []
  let batchGroups = 0
  let batchBytes = 0
  for await (const candidates of input.candidateGroups) {
    const group = await prepareCandidateGroup(candidates, input.limits, input.onMissingSessionFile)
    if (group.candidates.length === 0) continue
    if (group.hasOversizedFile) {
      if (batch.length > 0) {
        const scope = await createScope(
          batch.splice(0, batch.length),
          input.homeCount,
          input.onMissingSessionFile,
          input.limits,
          input.limits.maxBatchBytes,
          input.reportCopyFallback,
          input.onProjectionDiagnostic
        )
        if (scope) yield scope
        batchGroups = 0
        batchBytes = 0
      }
      const scope = await createScope(
        group.candidates,
        input.homeCount,
        input.onMissingSessionFile,
        input.limits,
        input.limits.maxBatchBytes,
        input.reportCopyFallback,
        input.onProjectionDiagnostic
      )
      if (scope) yield scope
      continue
    }
    if (group.bytes > input.limits.maxGroupBytes) {
      throw new Error(
        `Codex session group exceeds scoped collection group byte limit (${group.bytes} > ${input.limits.maxGroupBytes})`
      )
    }
    if (group.bytes > input.limits.maxBatchBytes) {
      if (batch.length > 0) {
        const scope = await createScope(
          batch.splice(0, batch.length),
          input.homeCount,
          input.onMissingSessionFile,
          input.limits,
          input.limits.maxBatchBytes,
          input.reportCopyFallback,
          input.onProjectionDiagnostic
        )
        if (scope) yield scope
        batchGroups = 0
        batchBytes = 0
      }
      const scope = await createScope(
        group.candidates,
        input.homeCount,
        input.onMissingSessionFile,
        input.limits,
        group.bytes,
        input.reportCopyFallback,
        input.onProjectionDiagnostic
      )
      if (scope) yield scope
      continue
    }
    if (batchGroups > 0 && (batchGroups >= input.batchSize || batchBytes + group.bytes > input.limits.maxBatchBytes)) {
      const scope = await createScope(
        batch.splice(0, batch.length),
        input.homeCount,
        input.onMissingSessionFile,
        input.limits,
        input.limits.maxBatchBytes,
        input.reportCopyFallback,
        input.onProjectionDiagnostic
      )
      if (scope) yield scope
      batchGroups = 0
      batchBytes = 0
    }
    batch.push(...group.candidates)
    batchGroups += 1
    batchBytes += group.bytes
    if (batchGroups >= input.batchSize) {
      const scope = await createScope(
        batch.splice(0, batch.length),
        input.homeCount,
        input.onMissingSessionFile,
        input.limits,
        input.limits.maxBatchBytes,
        input.reportCopyFallback,
        input.onProjectionDiagnostic
      )
      if (scope) yield scope
      batchGroups = 0
      batchBytes = 0
    }
  }

  if (batch.length > 0) {
    const scope = await createScope(
      batch,
      input.homeCount,
      input.onMissingSessionFile,
      input.limits,
      input.limits.maxBatchBytes,
      input.reportCopyFallback,
      input.onProjectionDiagnostic
    )
    if (scope) yield scope
  }
}

async function createExplicitScope(options: CodexSessionScopeOptions): Promise<CodexSessionScope | null> {
  const limits = resolveSessionScopeLimits(options)
  const codexHomes = resolveCodexHomes(options)
  if (codexHomes.length !== 1) {
    throw new Error('Explicit Codex session scope requires exactly one Codex home')
  }
  const roots = await readSessionRoots(codexHomes[0], 0, options.codexSymlinkRoots)
  if (roots.length === 0) {
    throw new Error('Unable to read Codex session directories for canonical session attribution')
  }

  const candidates = selectCandidates(options.files ?? [], roots)
  const reportCopyFallback = createCopyFallbackReporter(options.onCopyFallback)
  const scope = await createEmptyScope(1)
  try {
    const copied = await copyCandidates(
      scope,
      candidates,
      options.onMissingSessionFile,
      limits,
      undefined,
      reportCopyFallback,
      options.onProjectionDiagnostic
    )
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

async function createScope(
  candidates: CodexSessionCandidate[],
  homeCount: number,
  onMissingSessionFile: ((sessionPath: string) => void) | undefined,
  limits: CodexSessionScopeLimits,
  maxScopeBytes: number,
  reportCopyFallback: () => void,
  onProjectionDiagnostic?: (message: string) => void
): Promise<CodexSessionScope | null> {
  const scope = await createEmptyScope(homeCount)
  try {
    const copied = await copyCandidates(
      scope,
      candidates,
      onMissingSessionFile,
      limits,
      maxScopeBytes,
      reportCopyFallback,
      onProjectionDiagnostic
    )
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

async function copyCandidates(
  scope: CodexSessionScope,
  candidates: Iterable<CodexSessionCandidate> | AsyncIterable<CodexSessionCandidate>,
  onMissingSessionFile: ((sessionPath: string) => void) | undefined,
  limits: CodexSessionScopeLimits,
  maxScopeBytes = limits.maxBatchBytes,
  reportCopyFallback: () => void,
  onProjectionDiagnostic?: (message: string) => void
) {
  const cloner = createCodexSessionCloner({ onFallback: reportCopyFallback })
  let copied = 0
  let copiedBytes = 0
  let copyError: unknown
  try {
    for await (const candidate of candidates) {
      const bytes = await copySessionCandidate(
        scope,
        cloner,
        candidate,
        onMissingSessionFile,
        limits,
        copiedBytes,
        maxScopeBytes,
        onProjectionDiagnostic
      )
      if (bytes === null) continue
      copied += 1
      copiedBytes += bytes
    }
    return copied
  } catch (error) {
    copyError = error
    throw error
  } finally {
    try {
      await cloner.close()
    } catch (closeError) {
      if (copyError) {
        throw new AggregateError([copyError, closeError], 'Codex scoped collection clone helper cleanup failed')
      }
      throw closeError
    }
  }
}

async function copySessionCandidate(
  scope: CodexSessionScope,
  cloner: CodexSessionCloner,
  candidate: CodexSessionCandidate,
  onMissingSessionFile: ((sessionPath: string) => void) | undefined,
  limits: CodexSessionScopeLimits,
  copiedBytes: number,
  maxScopeBytes: number,
  onProjectionDiagnostic?: (message: string) => void
) {
  const scopedHome = scope.codexHomes[candidate.homeIndex]
  if (!scopedHome) {
    throw new Error('Codex scoped collection lost its profile mapping')
  }
  const targetRoot = join(scopedHome, candidate.root.name)
  const target = resolve(targetRoot, candidate.relativePath)
  const fileIsInsideConfiguredRoot = isPathInside(candidate.root.path, candidate.file)
  const fileIsInsideResolvedRoot = isPathInside(candidate.root.resolvedPath, candidate.file)
  if ((!fileIsInsideConfiguredRoot && !fileIsInsideResolvedRoot) || !isPathInside(targetRoot, target)) {
    throw new Error('Invalid Codex session file path for scoped collection')
  }
  const source = await inspectSessionFile(candidate.file, limits.maxFileBytes, true)
  if (!source) {
    onMissingSessionFile?.(candidate.relativePath)
    return null
  }
  if (source.size <= limits.maxFileBytes && copiedBytes + source.size > maxScopeBytes) {
    throw new Error(
      `Codex scoped collection batch exceeds byte limit (${copiedBytes + source.size} > ${maxScopeBytes})`
    )
  }
  await mkdir(dirname(target), { recursive: true })
  try {
    if (source.size > limits.maxFileBytes) {
      if (maxScopeBytes <= copiedBytes) {
        throw new Error(`Codex scoped collection batch exceeds byte limit (${copiedBytes} >= ${maxScopeBytes})`)
      }
      onProjectionDiagnostic?.(
        `Codex session file exceeds the ${limits.maxFileBytes}-byte scoped file limit; using bounded metadata projection`
      )
      const projectedBytes = await projectOversizedSessionFile({
        sourceFile: candidate.file,
        targetFile: target,
        maxBytes: maxScopeBytes - copiedBytes,
        stderr: onProjectionDiagnostic
      })
      if (projectedBytes === null) return null
      const copiedDetails = await lstat(target)
      if (copiedDetails.isSymbolicLink() || !copiedDetails.isFile()) {
        await rm(target, { force: true }).catch(() => undefined)
        throw new Error(`Unable to read Codex session file ${candidate.file}: projected path is not a file`)
      }
      const sourceAfterProjection = await inspectSessionFile(candidate.file, limits.maxFileBytes, true)
      if (!sourceAfterProjection || !sameFileMetadata(source, sourceAfterProjection)) {
        throw new Error(`Codex session changed during scoped collection; retry the sync`)
      }
      scope.sourceFiles.set(target, candidate.sourceFile)
      scope.sourceFileHomeIndexes.set(candidate.sourceFile, candidate.homeIndex)
      scope.sourceFileFingerprints.set(candidate.sourceFile, await fingerprintCodexSessionFile(candidate.file))
      scope.projectedSourceFiles.add(candidate.sourceFile)
      return projectedBytes
    }

    await cloner.copy(candidate.file, target)
    const copiedDetails = await lstat(target)
    if (copiedDetails.isSymbolicLink()) {
      await rm(target, { force: true }).catch(() => undefined)
      throw new Error(`Unable to read Codex session file ${candidate.file}: symbolic links are not supported`)
    }
    if (!copiedDetails.isFile()) {
      await rm(target, { force: true }).catch(() => undefined)
      throw new Error(`Unable to read Codex session file ${candidate.file}: path is not a file`)
    }
    if (copiedDetails.size > limits.maxFileBytes || copiedDetails.size > maxScopeBytes) {
      await rm(target, { force: true }).catch(() => undefined)
      throw new Error(`Codex session file exceeds scoped collection byte limit after copy; retry the sync`)
    }
    if (copiedDetails.size !== source.size) {
      throw new Error(`Codex session changed during scoped collection; retry the sync`)
    }
    const sourceAfterCopy = await inspectSessionFile(candidate.file, limits.maxFileBytes)
    if (!sourceAfterCopy || !sameFileMetadata(source, sourceAfterCopy)) {
      throw new Error(`Codex session changed during scoped collection; retry the sync`)
    }
    const [sourceFingerprint, copiedFingerprint] = await Promise.all([
      fingerprintCodexSessionFile(candidate.file),
      fingerprintCodexSessionFile(target)
    ])
    if (
      !sameFileMetadata(sourceAfterCopy, sourceFingerprint) ||
      !sameCopiedFileContent(sourceFingerprint, copiedFingerprint)
    ) {
      throw new Error(`Codex session changed during scoped collection; retry the sync`)
    }
    scope.sourceFiles.set(target, candidate.sourceFile)
    scope.sourceFileHomeIndexes.set(candidate.sourceFile, candidate.homeIndex)
    scope.sourceFileFingerprints.set(candidate.sourceFile, sourceFingerprint)
    return source.size
  } catch (error) {
    const cause = error as NodeJS.ErrnoException
    if (cause.code === 'ENOENT') {
      const sourceAfterFailure = await inspectSessionFile(candidate.file, limits.maxFileBytes, true)
      if (!sourceAfterFailure) {
        onMissingSessionFile?.(candidate.relativePath)
        return null
      }
    }
    throw error
  }
}

async function projectOversizedSessionFile(input: {
  sourceFile: string
  targetFile: string
  maxBytes: number
  stderr?: (message: string) => void
}): Promise<number | null> {
  const target = await open(input.targetFile, 'wx', 0o600)
  const sourceStream = createReadStream(input.sourceFile, {
    highWaterMark: CODEX_SESSION_PROJECTION_READ_CHUNK_BYTES
  })
  let projectedBytes = 0
  let projectedRecords = 0
  let malformedRows = 0
  let completed = false
  const report = (message: string) => {
    if (message.startsWith('Skipping malformed Codex subagent JSONL row at line ')) malformedRows += 1
    input.stderr?.(message)
  }

  try {
    for await (const record of readJsonlRecordsFromStream(sourceStream, report, {
      maxLineBytes: maxCodexChildSessionLineBytes,
      maxDiscardedLineBytes: maxDiscardedCodexChildSessionLineBytes,
      relevantMetadataKeys: codexChildSessionReadLimits.relevantMetadataKeys,
      discardableLineTypes: codexChildSessionReadLimits.discardableLineTypes,
      label: 'Codex oversized session projection'
    })) {
      if (!isProjectionRecord(record)) continue
      const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
      const nextBytes = projectedBytes + line.byteLength
      if (nextBytes > input.maxBytes) {
        throw new Error(
          `Codex projected session file exceeds scoped collection byte limit (${nextBytes} > ${input.maxBytes})`
        )
      }
      await writeFileHandleFully(target, line)
      projectedBytes = nextBytes
      projectedRecords += 1
    }
    completed = true
    if (malformedRows > 0) {
      throw new Error(
        `Codex oversized session projection encountered ${malformedRows} malformed JSONL row${malformedRows === 1 ? '' : 's'}`
      )
    }
    if (projectedRecords === 0) {
      await rm(input.targetFile, { force: true })
      return null
    }
    return projectedBytes
  } finally {
    sourceStream.destroy()
    await closeFileHandle(target)
    if (!completed) await rm(input.targetFile, { force: true }).catch(() => undefined)
  }
}

export async function writeFileHandleFully(handle: FileHandle, data: Uint8Array) {
  let offset = 0
  while (offset < data.byteLength) {
    const remaining = data.byteLength - offset
    const { bytesWritten } = await handle.write(data.subarray(offset))
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
      throw new Error(
        `Codex oversized session projection write made no valid progress (${bytesWritten} of ${remaining} bytes)`
      )
    }
    offset += bytesWritten
  }
}

function isProjectionRecord(record: Record<string, unknown>) {
  if (record.type === 'session_meta' || record.type === 'turn_context') return true
  if (record.type !== 'event_msg') return false
  const payload = readRecord(record.payload)
  const type = typeof payload?.type === 'string' ? payload.type : ''
  return type === 'token_count' || type === 'thread_settings_applied'
}

async function closeFileHandle(handle: FileHandle) {
  try {
    await handle.close()
  } catch (error) {
    const cause = error as NodeJS.ErrnoException
    if (cause.code !== 'EBADF') throw error
  }
}

function createCopyFallbackReporter(onCopyFallback?: (message: string) => void) {
  let reported = false
  return () => {
    if (reported) return
    reported = true
    onCopyFallback?.(CODEX_SESSION_COPY_FALLBACK_MESSAGE)
  }
}

async function prepareCandidateGroup(
  candidates: CodexSessionCandidate[],
  limits: CodexSessionScopeLimits,
  onMissingSessionFile?: (sessionPath: string) => void
): Promise<PreparedCandidateGroup> {
  const prepared: CodexSessionCandidate[] = []
  let bytes = 0
  let hasOversizedFile = false
  for (const candidate of candidates) {
    const details = await inspectSessionFile(candidate.file, limits.maxFileBytes, true)
    if (!details) {
      onMissingSessionFile?.(candidate.relativePath)
      continue
    }
    prepared.push(candidate)
    if (details.size > limits.maxFileBytes) {
      hasOversizedFile = true
      bytes += limits.maxBatchBytes
    } else {
      bytes += details.size
    }
  }
  return { candidates: prepared, bytes, hasOversizedFile }
}

async function inspectSessionFile(file: string, maxFileBytes: number, allowOverflow = false) {
  const details = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw new Error(`Unable to read Codex session file ${file}: ${error.message}`)
  })
  if (!details) return null
  if (details.isSymbolicLink()) {
    throw new Error(`Unable to read Codex session file ${file}: symbolic links are not supported`)
  }
  if (!details.isFile()) {
    throw new Error(`Unable to read Codex session file ${file}: path is not a file`)
  }
  if (!allowOverflow && details.size > maxFileBytes) {
    throw new Error(`Codex session file exceeds scoped collection byte limit (${details.size} > ${maxFileBytes})`)
  }
  return details
}

function resolveSessionScopeLimits(options: CodexSessionScopeOptions): CodexSessionScopeLimits {
  const limits = {
    maxFileBytes: readByteLimit(options.maxFileBytes, DEFAULT_CODEX_SESSION_FILE_BYTES, 'file byte limit'),
    maxBatchBytes: readByteLimit(options.maxBatchBytes, DEFAULT_CODEX_SESSION_BATCH_BYTES, 'batch byte limit'),
    maxGroupBytes: readByteLimit(options.maxGroupBytes, DEFAULT_CODEX_SESSION_GROUP_BYTES, 'group byte limit'),
    maxPrefilterBytes: readByteLimit(
      options.maxPrefilterBytes,
      DEFAULT_CODEX_SESSION_PREFILTER_BYTES,
      'prefilter read limit'
    ),
    maxPrefilterLineBytes: readByteLimit(
      options.maxPrefilterLineBytes,
      DEFAULT_CODEX_SESSION_PREFILTER_LINE_BYTES,
      'prefilter line limit'
    )
  }
  if (limits.maxGroupBytes < limits.maxBatchBytes) {
    throw new Error('Codex session group byte limit must be at least the batch byte limit')
  }
  return limits
}

function sameFileMetadata(
  left: { size: number; mtimeMs: number; ctimeMs: number },
  right: { size: number; mtimeMs: number; ctimeMs: number }
) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function sameCopiedFileContent(source: CodexSessionFileFingerprint, copied: CodexSessionFileFingerprint) {
  return source.size === copied.size && source.tailSha256 === copied.tailSha256
}

function readByteLimit(value: number | undefined, fallback: number, label: string) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid Codex session ${label}`)
  }
  return value
}

async function prepareSessionScans(options: CodexSessionScopeOptions): Promise<CodexSessionScans | null> {
  const limits = resolveSessionScopeLimits(options)
  const since = parseFilterDate(options.since, 'start')
  const until = parseFilterDate(options.until, 'end')
  const includeAll = isAllDateFilter(options.since) && !until
  if (!includeAll && !since && !until) return null

  const codexHomes = resolveCodexHomes(options)
  const maybeScans: Array<CodexSessionScan | null> = await Promise.all(
    codexHomes.map(async (codexHome, homeIndex) => {
      const roots = await readSessionRoots(codexHome, homeIndex, options.codexSymlinkRoots)
      if (roots.length === 0) return null
      return {
        roots,
        includeAll,
        filter: { since, until, now: options.now || new Date() },
        limits
      }
    })
  )
  const scans = maybeScans.filter((scan): scan is CodexSessionScan => scan !== null)
  if (scans.length === 0) return null
  return { scans, homeCount: codexHomes.length, limits }
}

async function readSessionRoots(codexHome: string, homeIndex: number, codexSymlinkRoots?: readonly string[]) {
  const roots: CodexSessionRoot[] = []
  for (const name of codexSessionRoots) {
    const path = join(codexHome, name)
    const resolvedRoot = await resolveCodexSessionRoot(path, {
      rejectRootSymlink: true,
      allowedRootSymlinks: codexSymlinkRoots,
      rootBoundary: codexHome
    })
    if (resolvedRoot) {
      // The session root may be rotated or removed between resolveCodexSessionRoot
      // and this metadata read. Treat that normal concurrent disappearance like
      // a missing root; other filesystem failures remain actionable.
      const details = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw new Error(`Unable to inspect session directory ${path}: ${error.message}`, { cause: error })
      })
      if (!details) continue
      // Keep the configured path as the source identity. The resolved path is
      // used only for scanning so macOS /var aliases do not change cache keys.
      roots.push({
        name,
        path,
        resolvedPath: resolvedRoot,
        isSymlink: details.isSymbolicLink(),
        homeIndex
      })
    }
  }
  return roots
}

async function* matchingSessionCandidates(scan: CodexSessionScan): AsyncGenerator<CodexSessionCandidate> {
  const iterators = scan.roots.map((root) => candidatesInRoot(root)[Symbol.asyncIterator]())
  const pending = await Promise.all(iterators.map((iterator) => iterator.next()))
  while (pending.some((result) => !result.done)) {
    const active = pending
      .map((result, index) => (result.done ? null : { candidate: result.value, index }))
      .filter((value): value is { candidate: CodexSessionCandidate; index: number } => value !== null)
    const relativePath = active.reduce(
      (smallest, value) =>
        compareSessionRelativePaths(value.candidate.relativePath, smallest) < 0
          ? value.candidate.relativePath
          : smallest,
      active[0].candidate.relativePath
    )
    const matching = active.filter((value) => value.candidate.relativePath === relativePath)
    const candidate = matching.map((value) => value.candidate).sort(compareCandidates)[0]
    for (const { index } of matching) {
      pending[index] = await iterators[index].next()
    }
    if (scan.includeAll || (await isActiveSessionFile(candidate, scan.filter, scan.limits))) {
      yield candidate
    }
  }
}

async function* matchingSessionCandidateGroups(scans: CodexSessionScan[]): AsyncGenerator<CodexSessionCandidate[]> {
  const iterators = scans.map((scan) => matchingSessionCandidates(scan)[Symbol.asyncIterator]())
  const pending = await Promise.all(iterators.map((iterator) => iterator.next()))
  while (pending.some((result) => !result.done)) {
    const active = pending
      .map((result, index) => (result.done ? null : { candidate: result.value, index }))
      .filter((value): value is { candidate: CodexSessionCandidate; index: number } => value !== null)
    const relativePath = active.reduce(
      (smallest, value) =>
        compareSessionRelativePaths(value.candidate.relativePath, smallest) < 0
          ? value.candidate.relativePath
          : smallest,
      active[0].candidate.relativePath
    )
    const matching = active.filter((value) => value.candidate.relativePath === relativePath)
    for (const { index } of matching) {
      pending[index] = await iterators[index].next()
    }
    yield matching
      .map((value) => value.candidate)
      .sort((left, right) => left.homeIndex - right.homeIndex || compareCandidates(left, right))
  }
}

async function* matchingSessionCandidatesAcrossHomes(scans: CodexSessionScan[]): AsyncGenerator<CodexSessionCandidate> {
  for await (const group of matchingSessionCandidateGroups(scans)) {
    yield* group
  }
}

async function* candidatesInRoot(root: CodexSessionRoot): AsyncGenerator<CodexSessionCandidate> {
  const sessionFiles = await resolveSessionJsonlFiles(root.resolvedPath)
  if (!sessionFiles) return
  for await (const file of sessionFiles.files) {
    const candidate = candidateForFile(root, file, root.path, sessionFiles.rootDir)
    if (!candidate) continue
    yield candidate
  }
}

function selectCandidates(files: string[], roots: CodexSessionRoot[]) {
  const candidates = new Map<string, CodexSessionCandidate>()
  for (const file of files) {
    const candidate = candidateForRoots(roots, file)
    if (!candidate) {
      throw new Error('Invalid Codex session file path for canonical session attribution')
    }
    const existing = candidates.get(candidate.relativePath)
    if (!existing || rootPriority(candidate.root) < rootPriority(existing.root)) {
      candidates.set(candidate.relativePath, candidate)
    }
  }
  return [...candidates.values()].sort(compareCandidates)
}

function selectCandidateGroup(input: {
  group: CodexSessionScopeFileGroup
  codexHomes: string[]
  homeIndexes: ReadonlyMap<string, number>
  rootsByHome: CodexSessionRoot[][]
}) {
  if (input.group.files.length === 0) {
    throw new Error('Explicit Codex session scope group must include at least one file')
  }
  const candidates: CodexSessionCandidate[] = []
  const seenFiles = new Set<string>()
  for (const source of input.group.files) {
    const codexHome = resolve(source.codexHome)
    const homeIndex = input.homeIndexes.get(codexHome)
    if (homeIndex === undefined || input.codexHomes[homeIndex] !== codexHome) {
      throw new Error('Explicit Codex session scope file uses an unknown Codex home')
    }
    const candidate = candidateForRoots(input.rootsByHome[homeIndex], source.filePath)
    if (!candidate) {
      throw new Error('Invalid Codex session file path for canonical session attribution')
    }
    if (!seenFiles.has(candidate.file)) {
      candidates.push(candidate)
      seenFiles.add(candidate.file)
    }
  }
  return candidates.sort((left, right) => left.homeIndex - right.homeIndex || compareCandidates(left, right))
}

function candidateForRoots(roots: CodexSessionRoot[], file: string) {
  for (const root of roots) {
    const candidate = candidateForFile(root, file)
    if (candidate) return candidate
  }
  return null
}

function candidateForFile(
  root: CodexSessionRoot,
  file: string,
  sourceRootPath = root.path,
  scanRootPath = root.resolvedPath
): CodexSessionCandidate | null {
  const logicalFile = isAbsolute(file) ? resolve(file) : null
  const relativePath = logicalFile
    ? isPathInside(root.path, logicalFile)
      ? normalizeSessionRelativePath(relative(root.path, logicalFile))
      : isPathInside(scanRootPath, logicalFile)
        ? normalizeSessionRelativePath(relative(scanRootPath, logicalFile))
        : null
    : isPathInside(scanRootPath, resolve(scanRootPath, file))
      ? normalizeSessionRelativePath(relative(scanRootPath, resolve(scanRootPath, file)))
      : null
  if (!relativePath || isAbsolute(relativePath)) return null
  const absoluteFile = resolve(scanRootPath, relativePath)
  return {
    root,
    homeIndex: root.homeIndex,
    file: absoluteFile,
    // An explicitly approved root symlink is read through its resolved target.
    // Keep that physical path as the cache/fingerprint identity too: lstat on
    // the configured symlink path is deliberately rejected by the file policy.
    sourceFile: root.isSymlink ? absoluteFile : resolve(sourceRootPath, relativePath),
    relativePath
  }
}

function compareCandidates(left: CodexSessionCandidate, right: CodexSessionCandidate) {
  return (
    rootPriority(left.root) - rootPriority(right.root) ||
    compareSessionRelativePaths(left.relativePath, right.relativePath)
  )
}

function rootPriority(root: CodexSessionRoot) {
  return root.name === 'sessions' ? 0 : 1
}

async function createEmptyScope(homeCount: number): Promise<CodexSessionScope> {
  const codexHomes = await Promise.all(
    Array.from({ length: homeCount }, async () => {
      const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-codex-home-'))
      await Promise.all(codexSessionRoots.map((name) => mkdir(join(codexHome, name), { recursive: true })))
      return codexHome
    })
  )
  if (codexHomes.some((codexHome) => codexHome.includes(','))) {
    await Promise.all(codexHomes.map((codexHome) => rm(codexHome, { recursive: true, force: true })))
    throw new Error('Temporary Codex session scope path contains a comma and cannot be serialized as CODEX_HOME')
  }
  const sourceFiles = new Map<string, string>()
  const sourceFileHomeIndexes = new Map<string, number>()
  const sourceFileFingerprints = new Map<string, CodexSessionFileFingerprint>()
  const projectedSourceFiles = new Set<string>()
  return {
    codexHome: codexHomes.join(','),
    codexHomes,
    cleanup: async () => {
      await Promise.all(codexHomes.map((codexHome) => rm(codexHome, { recursive: true, force: true })))
    },
    sourceFiles,
    sourceFileHomeIndexes,
    sourceFileFingerprints,
    projectedSourceFiles
  }
}

function resolveCodexHomes(options: CodexSessionScopeOptions) {
  return resolveConfiguredCodexHomes({
    explicitHomes: options.codexHomes,
    legacyValue: options.codexHome ?? (options.codexHomes === undefined ? process.env.CODEX_HOME : undefined),
    jsonValue:
      options.codexHomes === undefined && options.codexHome === undefined
        ? process.env.TOKENBOARD_CODEX_HOMES_JSON
        : undefined
  })
}

function isPathInside(parent: string, child: string) {
  const path = relative(parent, child)
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}

function normalizeBatchSize(value: number | undefined) {
  if (!value || !Number.isFinite(value) || value < 1) return 200
  return Math.min(Math.floor(value), 1000)
}

async function isActiveSessionFile(
  candidate: CodexSessionCandidate,
  options: { since?: Date; until?: Date; now: Date },
  limits: CodexSessionScopeLimits
) {
  const fileStat = await inspectSessionFile(candidate.file, limits.maxFileBytes, true)
  if (!fileStat) return false
  if (isDateInRange(fileStat.mtime, options)) return true

  const sessionStart = readSessionPathDate(candidate.relativePath)
  if (sessionStart) {
    return dateIntervalsOverlap(sessionStart, fileStat.mtime, options)
  }

  try {
    const tokenCountActivity = await readTokenCountActivity(candidate.file, options, limits)
    return tokenCountActivity.hasInRangeTimestamp
  } catch (error) {
    // A bounded prefilter is only an optimization. If it cannot reach a
    // conclusion within its own limits, keep the file and let the existing
    // bounded projection/ccusage path apply the exact date window.
    if (error instanceof Error && error.message.startsWith('Codex session prefilter')) return true
    throw error
  }
}

function readSessionPathDate(relativePath: string) {
  const parts = relativePath.split(/[\\/]/)
  if (parts.length >= 4 && /^\d{4}$/.test(parts[0]) && /^\d{2}$/.test(parts[1]) && /^\d{2}$/.test(parts[2])) {
    return createUtcCalendarDate(parts[0], parts[1], parts[2])
  }

  const rolloutDate = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(parts.at(-1) ?? '')
  return rolloutDate ? createUtcCalendarDate(rolloutDate[1], rolloutDate[2], rolloutDate[3]) : null
}

function createUtcCalendarDate(yearValue: string, monthValue: string, dayValue: string) {
  const year = Number.parseInt(yearValue, 10)
  const month = Number.parseInt(monthValue, 10) - 1
  const day = Number.parseInt(dayValue, 10)
  const date = new Date(Date.UTC(year, month, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? date : null
}

function dateIntervalsOverlap(left: Date, right: Date, options: { since?: Date; until?: Date }) {
  const startMs = Math.min(left.getTime(), right.getTime())
  const endMs = Math.max(left.getTime(), right.getTime())
  if (options.since && endMs < options.since.getTime()) return false
  if (options.until && startMs > options.until.getTime()) return false
  return true
}

async function readTokenCountActivity(
  file: string,
  options: { since?: Date; until?: Date },
  limits: CodexSessionScopeLimits
) {
  const activity = { hasAnyTimestamp: false, hasInRangeTimestamp: false }
  try {
    const stream = createReadStream(file, {
      highWaterMark: Math.min(CODEX_SESSION_READ_CHUNK_BYTES, limits.maxPrefilterBytes)
    })
    let readBytes = 0
    let pendingLine = Buffer.alloc(0)
    for await (const chunk of stream) {
      readBytes += chunk.length
      if (readBytes > limits.maxPrefilterBytes) {
        throw new Error(`Codex session prefilter read limit exceeded for ${file}`)
      }

      let offset = 0
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset)
        const end = newline < 0 ? chunk.length : newline
        const segment = chunk.subarray(offset, end)
        if (pendingLine.length + segment.length > limits.maxPrefilterLineBytes) {
          throw new Error(`Codex session prefilter line limit exceeded for ${file}`)
        }
        if (newline < 0) {
          pendingLine = pendingLine.length === 0 ? Buffer.from(segment) : Buffer.concat([pendingLine, segment])
          break
        }

        const line =
          pendingLine.length === 0 ? segment.toString('utf8') : Buffer.concat([pendingLine, segment]).toString('utf8')
        pendingLine = Buffer.alloc(0)
        if (recordTokenCountActivity(activity, line, options)) {
          return activity
        }
        offset = newline + 1
      }
    }
    if (pendingLine.length > 0) recordTokenCountActivity(activity, pendingLine.toString('utf8'), options)
  } catch (error) {
    const cause = error as NodeJS.ErrnoException
    if (cause.code === 'ENOENT') return activity
    if (error instanceof Error && error.message.startsWith('Codex session prefilter')) throw error
    throw new Error(`Unable to read Codex session file ${file}: ${cause.message}`)
  }
  return activity
}

function recordTokenCountActivity(
  activity: { hasAnyTimestamp: boolean; hasInRangeTimestamp: boolean },
  line: string,
  options: { since?: Date; until?: Date }
) {
  const timestamp = readTokenCountTimestamp(line)
  if (!timestamp) return false
  activity.hasAnyTimestamp = true
  if (!isDateInRange(timestamp, options)) return false
  activity.hasInRangeTimestamp = true
  return true
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
  if (Number.isNaN(date.getTime())) return false
  if (options.since && date < options.since) return false
  if (options.until && date > options.until) return false
  return true
}

function parseFilterDate(value: string | undefined, boundary: 'start' | 'end') {
  if (!value || isAllDateFilter(value)) return undefined

  const trimmed = value.trim()
  if (!/^\d{8}$/.test(trimmed) && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`Invalid Codex usage date filter: ${value}. Expected YYYYMMDD or YYYY-MM-DD.`)
  }
  const compact = trimmed.replaceAll('-', '')
  const year = Number.parseInt(compact.slice(0, 4), 10)
  const month = Number.parseInt(compact.slice(4, 6), 10) - 1
  const day = Number.parseInt(compact.slice(6, 8), 10)
  const date = new Date(Date.UTC(year, month, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    throw new Error(`Invalid Codex usage date filter: ${value}. Expected YYYYMMDD or YYYY-MM-DD.`)
  }

  // This scan is only a timezone-agnostic prefilter; ccusage applies the exact local date window.
  if (boundary === 'end') {
    date.setUTCHours(23, 59, 59, 999)
    date.setUTCDate(date.getUTCDate() + 1)
  } else {
    date.setUTCDate(date.getUTCDate() - 1)
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
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
