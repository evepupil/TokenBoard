import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { maxScanDirectoryEntries, readSessionLinesBounded, scanSessionFiles } from './bounded-session-scan'

// The scanner reads roots outside TokenBoard's control, so an over-large directory listing must
// be *reported* through `onSkipped` rather than loaded whole — a single abnormal directory must
// not be able to exhaust memory just by existing.
describe('bounded session scan', () => {
  const created: string[] = []

  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function withRoot() {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-scan-'))
    created.push(root)
    return root
  }

  test('reports a directory whose listing exceeds the entry cap instead of loading it whole', async () => {
    const home = await withRoot()
    const overfull = join(home, 'sessions')
    await mkdir(overfull)
    // Create just past the cap: the scan must stop at the boundary rather than read the whole
    // listing into memory before sorting it.
    for (let i = 0; i < maxScanDirectoryEntries + 1; i++) {
      await writeFile(join(overfull, `${String(i).padStart(5, '0')}.jsonl`), '{}\n')
    }

    const files: string[] = []
    const skipReasons: Array<[string, string]> = []
    for await (const file of scanSessionFiles(home, {
      matches: () => true,
      onSkipped: (path, reason) => skipReasons.push([path, reason])
    })) {
      files.push(file.path)
    }

    expect(files).toEqual([])
    expect(skipReasons).toEqual([[overfull, 'max-entries']])
  }, 30_000)

  // A session log within maxSessionFileBytes (256 MiB) can still carry one enormous line, and
  // readline hands it back whole. The Go client caps a line at 64 MiB, so an unbounded TS reader
  // is both a memory hazard and a cross-client divergence.
  describe('bounded session line reader', () => {
    const created: string[] = []
    afterEach(async () => {
      for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true })
    })

    test('skips a line past the cap and keeps reading the rest of the file', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tokenboard-bounded-lines-'))
      created.push(dir)
      const file = join(dir, 'session.jsonl')
      await writeFile(file, `${'x'.repeat(200)}\n{"kept":true}\n`, 'utf8')

      const lines: string[] = []
      const skipped: number[] = []
      for await (const line of readSessionLinesBounded(file, {
        maxLineBytes: 100,
        onSkippedLine: (bytes) => skipped.push(bytes)
      })) {
        lines.push(line)
      }

      expect(lines).toEqual(['{"kept":true}'])
      expect(skipped).toEqual([200])
    })

    test('yields every line when none exceeds the cap', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tokenboard-bounded-lines-'))
      created.push(dir)
      const file = join(dir, 'session.jsonl')
      await writeFile(file, '{"a":1}\n{"b":2}\n', 'utf8')

      const lines: string[] = []
      for await (const line of readSessionLinesBounded(file, { maxLineBytes: 100 })) lines.push(line)

      expect(lines).toEqual(['{"a":1}', '{"b":2}'])
    })
  })
})
