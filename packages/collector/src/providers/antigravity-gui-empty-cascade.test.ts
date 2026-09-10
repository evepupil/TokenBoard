import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { collectAntigravityGuiUsage } from './antigravity-gui'

test('rotates the default bounded scan while newer empty cascades arrive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenboard-antigravity-empty-file-rotation-'))
  const conversationDir = join(root, 'conversations')
  const usageCascadeId = cascadeId(999)
  const initialEmptyCascadeIds = Array.from({ length: 12 }, (_, index) => cascadeId(index + 1))
  const newerEmptyCascadeIds = Array.from({ length: 12 }, (_, index) => cascadeId(index + 101))
  try {
    await mkdir(conversationDir)
    await writeCascade(conversationDir, usageCascadeId, '2026-06-24T01:00:00.000Z')
    await Promise.all(
      initialEmptyCascadeIds.map((id, index) =>
        writeCascade(conversationDir, id, new Date(Date.parse('2026-06-24T02:00:00.000Z') + index * 1000).toISOString())
      )
    )
    const calls: string[] = []
    const options = {
      source: 'antigravity' as const,
      stateDir: root,
      conversationDir,
      timezone: 'UTC',
      requestGeneratorMetadata: async (input: { cascadeId: string }) => {
        calls.push(input.cascadeId)
        return input.cascadeId === usageCascadeId ? generatorMetadataResponse() : { generatorMetadata: [] }
      }
    }

    expect(
      await collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-06-24T03:00:00.000Z'
      })
    ).toEqual([])
    expect(calls).toHaveLength(12)
    await Promise.all(
      newerEmptyCascadeIds.map((id, index) =>
        writeCascade(conversationDir, id, new Date(Date.parse('2026-06-24T04:00:00.000Z') + index * 1000).toISOString())
      )
    )
    expect(
      await collectAntigravityGuiUsage({
        ...options,
        collectedAt: '2026-06-24T05:00:00.000Z'
      })
    ).toHaveLength(1)
    await collectAntigravityGuiUsage({
      ...options,
      collectedAt: '2026-06-24T06:00:00.000Z'
    })

    expect(calls.slice(12, 24)).toContain(usageCascadeId)
    expect(calls.filter((id) => initialEmptyCascadeIds.includes(id)).length).toBeGreaterThan(12)
    const cursorText = await readFile(join(root, 'antigravity-cursor.json'), 'utf8')
    for (const id of [usageCascadeId, ...initialEmptyCascadeIds, ...newerEmptyCascadeIds]) {
      expect(cursorText).not.toContain(id)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function cascadeId(index: number) {
  return `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`
}

async function writeCascade(conversationDir: string, id: string, timestamp: string) {
  const path = join(conversationDir, `${id}.pb`)
  await writeFile(path, 'cascade')
  const date = new Date(timestamp)
  await utimes(path, date, date)
}

function generatorMetadataResponse() {
  return {
    generatorMetadata: [
      {
        executionId: 'execution-a',
        stepIndices: [3],
        chatModel: {
          model: 'Gemini 3.5 Flash (Medium)',
          chatStartMetadata: { createdAt: '2026-06-24T01:30:00.000Z' },
          usage: {
            inputTokens: '10',
            outputTokens: '2',
            responseId: 'response-usage'
          }
        }
      }
    ]
  }
}
