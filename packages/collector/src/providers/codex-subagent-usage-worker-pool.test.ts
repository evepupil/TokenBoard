import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { describe, expect, test } from 'vitest'
import { createCodexSubagentUsageWorkerPool } from './codex-subagent-usage-worker-pool'

describe('Codex subagent usage worker pool', () => {
  test('parses usage in a real worker and preserves worker errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-subagent-worker-'))
    const filePath = join(root, 'child.jsonl')
    const pool = createCodexSubagentUsageWorkerPool(1)

    try {
      await writeFile(filePath, `${JSON.stringify(usageRecord())}\n`)

      await expect(pool.read(filePath, '2026-07-25T00:00:00.000Z', 'UTC')).resolves.toEqual([
        {
          usageDate: '2026-07-25',
          inputTokens: 10,
          outputTokens: 2,
          cacheCreationTokens: 3,
          cacheReadTokens: 4,
          totalTokens: 19
        }
      ])
      await expect(pool.read(filePath, '2026-07-25T00:00:00.000Z', 'Invalid/Timezone')).rejects.toThrow(
        'Invalid timezone for Codex subagent usage date'
      )
    } finally {
      await Promise.all([pool.close(), rm(root, { recursive: true, force: true })])
    }
  })

  test('rejects queued work when a worker exits successfully but unexpectedly', async () => {
    const workers: Worker[] = []
    const pool = createCodexSubagentUsageWorkerPool(1, () => {
      const worker = new Worker(
        `
        const { parentPort } = require('node:worker_threads')
        parentPort.once('message', () => process.exit(0))
      `,
        { eval: true }
      )
      workers.push(worker)
      return worker
    })

    const pending = pool.read('/unused', '2026-07-25T00:00:00.000Z', 'UTC')
    await expect(pending).rejects.toThrow('exited unexpectedly with code 0')
    await pool.close()

    expect(workers.map((worker) => worker.threadId)).toEqual([-1])
  })

  test('close rejects in-flight work and waits for every worker to terminate', async () => {
    const workers: Worker[] = []
    const pool = createCodexSubagentUsageWorkerPool(2, () => {
      const worker = new Worker(
        `
        const { parentPort } = require('node:worker_threads')
        parentPort.on('message', () => undefined)
      `,
        { eval: true }
      )
      workers.push(worker)
      return worker
    })
    const pending = pool.read('/unused', '2026-07-25T00:00:00.000Z', 'UTC')

    const firstClose = pool.close()
    const secondClose = pool.close()
    await expect(pending).rejects.toThrow('closed before completing queued work')
    await Promise.all([firstClose, secondClose])

    expect(workers.map((worker) => worker.threadId)).toEqual([-1, -1])
    await expect(pool.read('/unused', '2026-07-25T00:00:00.000Z', 'UTC')).rejects.toThrow('worker pool is closed')
  })
})

function usageRecord() {
  return {
    timestamp: '2026-07-25T01:00:00.000Z',
    payload: {
      info: {
        total_token_usage: tokenUsage(),
        last_token_usage: tokenUsage()
      }
    }
  }
}

function tokenUsage() {
  return {
    input_tokens: 10,
    output_tokens: 2,
    cached_input_tokens: 4,
    cache_creation_input_tokens: 3,
    total_tokens: 19
  }
}
