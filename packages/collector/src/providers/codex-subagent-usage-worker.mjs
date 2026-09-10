import { parentPort } from 'node:worker_threads'
import { register } from 'tsx/esm/api'

register()

if (!parentPort) {
  throw new Error('Codex subagent usage worker requires a parent message port')
}

const { readChildLastUsageByDate, readChildLastUsageEvents } = await import('./codex-subagent-usage-child.ts')

parentPort.on('message', async (request) => {
  const id = request?.id
  try {
    assertRequest(request)
    const stderr = (line) => parentPort.postMessage({ id, warning: line })
    const result =
      request.kind === 'by-date'
        ? await readChildLastUsageByDate(request.filePath, request.timestamp, request.timezone, stderr)
        : await readChildLastUsageEvents(request.filePath, request.timestamp, request.timezone, stderr)
    parentPort.postMessage({ id, result })
  } catch (error) {
    parentPort.postMessage({
      id,
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error)
      }
    })
  }
})

function assertRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('Invalid Codex subagent worker request')
  if (!Number.isSafeInteger(request.id) || request.id < 1) {
    throw new Error('Invalid Codex subagent worker request id')
  }
  if (request.kind !== 'by-date' && request.kind !== 'events') {
    throw new Error('Invalid Codex subagent worker request kind')
  }
  for (const key of ['filePath', 'timestamp', 'timezone']) {
    if (typeof request[key] !== 'string' || request[key].length === 0) {
      throw new Error(`Invalid Codex subagent worker request ${key}`)
    }
  }
}
