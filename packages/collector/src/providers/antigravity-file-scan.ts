import { createHash } from 'node:crypto'

export const maxAntigravityDirectoryEntries = 10_000

export type AntigravityDirectoryEntry = {
  name: string
  isFile: () => boolean
}

export type AntigravityFileScanEntry = {
  mtimeMs: number
  size: number
  hasDatabaseFile: boolean
  checkedSequence: number
  // SQLite-backed sources use these optional fields to anchor incremental
  // metadata cursors to the exact row that was last processed.
  metadataRowHighWater?: number
  metadataCursorRowIndex?: number
  metadataCursorRowSha256?: string
}

export type AntigravityFileScanState = {
  nextSequence: number
  files: Record<string, AntigravityFileScanEntry>
}

export async function listAntigravityDirectoryFileNames(entries: AsyncIterable<AntigravityDirectoryEntry>) {
  const names: string[] = []
  let entriesRead = 0
  for await (const entry of entries) {
    entriesRead += 1
    if (entriesRead > maxAntigravityDirectoryEntries) {
      throw new Error(
        `Antigravity conversations directory exceeds the ${maxAntigravityDirectoryEntries}-entry scan limit`
      )
    }
    if (entry.isFile()) names.push(entry.name)
  }
  return names
}

export function beginAntigravityFileScan(state: AntigravityFileScanState) {
  if (
    !Number.isSafeInteger(state.nextSequence) ||
    state.nextSequence < 0 ||
    state.nextSequence === Number.MAX_SAFE_INTEGER
  ) {
    throw new Error('Invalid Antigravity file scan sequence')
  }
  const sequence = state.nextSequence
  state.nextSequence += 1
  return sequence
}

export function selectAntigravityFileScanIds(ids: string[], state: AntigravityFileScanState, limit: number) {
  if (limit === Number.POSITIVE_INFINITY) return [...ids]
  const capacity = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  if (capacity === 0) return []
  const candidates = Array.from(new Set(ids), (id) => ({
    id,
    entry: state.files[antigravityFileScanKey(id)]
  }))
  const unseen = candidates.filter((candidate) => !candidate.entry).map((candidate) => candidate.id)
  const known = candidates.filter((candidate): candidate is KnownScanCandidate => Boolean(candidate.entry))
  if (unseen.length === 0) return selectKnownScanIds(known, capacity)
  if (known.length === 0) return selectFromBothEnds(unseen, capacity)
  if (capacity === 1) {
    return state.nextSequence % 2 === 0 ? selectKnownScanIds(known, 1) : selectFromBothEnds(unseen, 1)
  }

  let discoveryCapacity = Math.min(unseen.length, Math.ceil(capacity / 2))
  let refreshCapacity = Math.min(known.length, capacity - discoveryCapacity)
  let remaining = capacity - discoveryCapacity - refreshCapacity
  const extraDiscovery = Math.min(unseen.length - discoveryCapacity, remaining)
  discoveryCapacity += extraDiscovery
  remaining -= extraDiscovery
  refreshCapacity += Math.min(known.length - refreshCapacity, remaining)
  return [...selectFromBothEnds(unseen, discoveryCapacity), ...selectKnownScanIds(known, refreshCapacity)]
}

export function markAntigravityFileScanned(
  state: AntigravityFileScanState,
  id: string,
  entry: Omit<AntigravityFileScanEntry, 'checkedSequence'>,
  checkedSequence: number
) {
  state.files[antigravityFileScanKey(id)] = { ...entry, checkedSequence }
}

export function readAntigravityFileScanEntry(state: AntigravityFileScanState, id: string) {
  return state.files[antigravityFileScanKey(id)]
}

export function removeAntigravityFileScanEntry(state: AntigravityFileScanState, id: string) {
  delete state.files[antigravityFileScanKey(id)]
}

export function pruneAntigravityFileScanState(state: AntigravityFileScanState, ids: Iterable<string>) {
  const retained = new Set(Array.from(ids, antigravityFileScanKey))
  for (const key of Object.keys(state.files)) {
    if (!retained.has(key)) delete state.files[key]
  }
}

export function isValidAntigravityFileScanState(value: unknown): value is AntigravityFileScanState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as AntigravityFileScanState
  return (
    Number.isSafeInteger(candidate.nextSequence) &&
    candidate.nextSequence >= 0 &&
    Boolean(candidate.files) &&
    typeof candidate.files === 'object' &&
    !Array.isArray(candidate.files) &&
    Object.entries(candidate.files).every(([key, entry]) => /^[a-f0-9]{64}$/.test(key) && isValidEntry(entry))
  )
}

function selectFromBothEnds(ids: string[], limit: number) {
  const selected: string[] = []
  let left = 0
  let right = ids.length - 1
  while (selected.length < limit && left <= right) {
    selected.push(ids[left])
    left += 1
    if (selected.length < limit && left <= right) {
      selected.push(ids[right])
      right -= 1
    }
  }
  return selected
}

type KnownScanCandidate = {
  id: string
  entry: AntigravityFileScanEntry
}

function selectKnownScanIds(candidates: KnownScanCandidate[], limit: number) {
  if (candidates.length <= limit) return candidates.map((candidate) => candidate.id)
  const hotLimit = Math.floor(limit / 2)
  const hot = [...candidates]
    .sort(
      (left, right) =>
        right.entry.mtimeMs - left.entry.mtimeMs ||
        right.entry.size - left.entry.size ||
        left.id.localeCompare(right.id)
    )
    .slice(0, hotLimit)
  const hotIds = new Set(hot.map((candidate) => candidate.id))
  const stale = [...candidates]
    .sort((left, right) => left.entry.checkedSequence - right.entry.checkedSequence || left.id.localeCompare(right.id))
    .filter((candidate) => !hotIds.has(candidate.id))
    .slice(0, limit - hot.length)
  return [...hot, ...stale].map((candidate) => candidate.id)
}

function antigravityFileScanKey(id: string) {
  return createHash('sha256').update(id).digest('hex')
}

function isValidEntry(value: unknown): value is AntigravityFileScanEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as AntigravityFileScanEntry
  return (
    Number.isFinite(entry.mtimeMs) &&
    entry.mtimeMs >= 0 &&
    Number.isFinite(entry.size) &&
    entry.size >= 0 &&
    typeof entry.hasDatabaseFile === 'boolean' &&
    Number.isSafeInteger(entry.checkedSequence) &&
    entry.checkedSequence >= 0
  )
}
