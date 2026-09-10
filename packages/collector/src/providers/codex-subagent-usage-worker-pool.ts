import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import type { ChildUsageEvent, DatedUsage } from './codex-subagent-usage-child'
import type { ReadChildUsageByDate, ReadChildUsageEvents } from './codex-subagent-usage-cache'

const defaultMaxWorkers = 4
const absoluteMaxWorkers = 8
const maxWorkerWarningLength = 4_096

type WorkerRequest = {
  id: number
  kind: 'by-date' | 'events'
  filePath: string
  timestamp: string
  timezone: string
}

type WorkerResponse = {
  id: number
  warning?: string
  result?: unknown
  error?: {
    name: string
    message: string
  }
}

type PendingTask = {
  request: WorkerRequest
  stderr?: (line: string) => void
  resolve: (value: DatedUsage[] | ChildUsageEvent[]) => void
  reject: (error: Error) => void
}

type PoolWorker = {
  worker: Worker
  task?: PendingTask
}

type WorkerFactory = () => Worker

export type CodexSubagentUsageWorkerPool = {
  concurrency: number
  read: ReadChildUsageByDate
  readEvents: ReadChildUsageEvents
  close: () => Promise<void>
}

export function defaultCodexSubagentWorkerCount() {
  return Math.max(1, Math.min(defaultMaxWorkers, availableParallelism()))
}

export function normalizeCodexSubagentWorkerCount(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > absoluteMaxWorkers) {
    throw new Error(`Invalid Codex subagent worker count: expected an integer from 1 to ${absoluteMaxWorkers}`)
  }
  return value
}

export function createCodexSubagentUsageWorkerPool(
  workerCount = defaultCodexSubagentWorkerCount(),
  workerFactory: WorkerFactory = createUsageWorker
): CodexSubagentUsageWorkerPool {
  const concurrency = normalizeCodexSubagentWorkerCount(workerCount)
  const workers = Array.from({ length: concurrency }, () => createPoolWorker(workerFactory))
  const queue: PendingTask[] = []
  let nextTaskId = 1
  let closing = false
  let fatalError: Error | undefined
  let closePromise: Promise<void> | undefined

  for (const poolWorker of workers) {
    poolWorker.worker.on('message', (message) => onWorkerMessage(poolWorker, message))
    poolWorker.worker.on('error', (error) => failPool(normalizeWorkerError(error)))
    poolWorker.worker.on('exit', (code) => {
      if (!closing) failPool(new Error(`Codex subagent usage worker exited unexpectedly with code ${code}`))
    })
  }

  return {
    concurrency,
    read: (filePath, timestamp, timezone, stderr) =>
      enqueue<DatedUsage[]>('by-date', filePath, timestamp, timezone, stderr),
    readEvents: (filePath, timestamp, timezone, stderr) =>
      enqueue<ChildUsageEvent[]>('events', filePath, timestamp, timezone, stderr),
    close
  }

  function enqueue<T extends DatedUsage[] | ChildUsageEvent[]>(
    kind: WorkerRequest['kind'],
    filePath: string,
    timestamp: string,
    timezone: string,
    stderr?: (line: string) => void
  ): Promise<T> {
    if (closing) return Promise.reject(new Error('Codex subagent usage worker pool is closed'))
    if (fatalError) return Promise.reject(fatalError)
    return new Promise<T>((resolve, reject) => {
      queue.push({
        request: { id: nextTaskId++, kind, filePath, timestamp, timezone },
        stderr,
        resolve: resolve as PendingTask['resolve'],
        reject
      })
      dispatch()
    })
  }

  function dispatch() {
    if (closing || fatalError) return
    for (const poolWorker of workers) {
      if (poolWorker.task) continue
      const task = queue.shift()
      if (!task) return
      poolWorker.task = task
      try {
        poolWorker.worker.postMessage(task.request)
      } catch (error) {
        failPool(normalizeWorkerError(error))
        return
      }
    }
  }

  function onWorkerMessage(poolWorker: PoolWorker, value: unknown) {
    const task = poolWorker.task
    if (!task) {
      failPool(new Error('Codex subagent usage worker replied without an active task'))
      return
    }
    if (!isWorkerResponse(value) || value.id !== task.request.id) {
      failPool(new Error('Codex subagent usage worker returned an invalid response'))
      return
    }
    if (value.warning !== undefined) {
      if (value.warning.length > maxWorkerWarningLength) {
        failPool(new Error('Codex subagent usage worker returned an oversized warning'))
        return
      }
      task.stderr?.(value.warning)
      return
    }

    poolWorker.task = undefined
    if (value.error) {
      const error = new Error(value.error.message)
      error.name = value.error.name
      task.reject(error)
    } else if (Array.isArray(value.result)) {
      task.resolve(value.result as DatedUsage[] | ChildUsageEvent[])
    } else {
      task.reject(new Error('Codex subagent usage worker returned an invalid result'))
    }
    dispatch()
  }

  function failPool(error: Error) {
    if (fatalError) return
    fatalError = error
    for (const poolWorker of workers) {
      poolWorker.task?.reject(error)
      poolWorker.task = undefined
    }
    for (const task of queue.splice(0)) task.reject(error)
  }

  function close() {
    if (closePromise) return closePromise
    closing = true
    const error = fatalError ?? new Error('Codex subagent usage worker pool closed before completing queued work')
    for (const poolWorker of workers) {
      poolWorker.task?.reject(error)
      poolWorker.task = undefined
    }
    for (const task of queue.splice(0)) task.reject(error)
    closePromise = Promise.all(workers.map(({ worker }) => worker.terminate())).then(() => undefined)
    return closePromise
  }
}

function createPoolWorker(workerFactory: WorkerFactory): PoolWorker {
  return {
    worker: workerFactory()
  }
}

function createUsageWorker() {
  return new Worker(new URL('./codex-subagent-usage-worker.mjs', import.meta.url), {
    name: 'tokenboard-codex-subagent-usage'
  })
}

function normalizeWorkerError(value: unknown) {
  return value instanceof Error ? value : new Error('Codex subagent usage worker failed', { cause: value })
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<WorkerResponse>
  if (!Number.isSafeInteger(candidate.id) || Number(candidate.id) < 1) return false
  if (candidate.warning !== undefined) return typeof candidate.warning === 'string'
  if (candidate.error !== undefined) {
    return (
      Boolean(candidate.error) &&
      typeof candidate.error.name === 'string' &&
      typeof candidate.error.message === 'string'
    )
  }
  return Array.isArray(candidate.result)
}
