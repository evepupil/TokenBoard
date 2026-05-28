import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { walkJsonlFiles } from './session-file-walk'

describe('walkJsonlFiles', () => {
  test('returns no files when the root directory disappears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-walk-'))
    await rm(root, { recursive: true, force: true })

    const files = []
    for await (const file of walkJsonlFiles(root)) {
      files.push(file)
    }

    expect(files).toEqual([])
  })

  test('walks nested JSONL paths in stable relative order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-walk-'))
    try {
      await writeFile(join(root, 'b.jsonl'), '')
      await writeFile(join(root, 'a.jsonl'), '')

      const files = []
      for await (const file of walkJsonlFiles(root)) {
        files.push(file)
      }

      expect(files).toEqual(['a.jsonl', 'b.jsonl'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('recurses into directories whose names end with jsonl', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-walk-'))
    try {
      await mkdir(join(root, 'sessions.jsonl'))
      await writeFile(join(root, 'sessions.jsonl', 'nested.jsonl'), '')

      const files = []
      for await (const file of walkJsonlFiles(root)) {
        files.push(file)
      }

      expect(files).toEqual(['sessions.jsonl/nested.jsonl'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
