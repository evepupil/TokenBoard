import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const appRoot = resolve(import.meta.dirname)

// The client bundle runs under `script-src 'self' 'sha256-…'`, which forbids `unsafe-eval`.
// Merely *importing* zod trips that policy: its JIT object validators probe `Function("")`
// at module scope, and the browser reports a blocked eval even though the probe catches the
// error. Importing `@tokenboard/usage-core` therefore puts a red CSP error in every visitor's
// console. The timezone check was such an import; it now comes from the zod-free
// `@tokenboard/usage-core/timezone` subpath.
//
// This walks the client entry's runtime import graph and fails on zod or the usage-core
// barrel, so the error cannot come back through a new import. Type-only imports are skipped:
// they are erased before bundling and cannot reach the browser.
describe('client bundle import graph', () => {
  test('never reaches zod or the usage-core barrel', async () => {
    const visited = new Set<string>()
    const violations: string[] = []

    async function walk(file: string) {
      if (visited.has(file)) return
      visited.add(file)

      let source: string
      try {
        source = await readFile(file, 'utf8')
      } catch {
        return
      }

      for (const specifier of runtimeImportSpecifiers(source)) {
        if (specifier === 'zod' || specifier.startsWith('zod/')) {
          violations.push(`${file.slice(appRoot.length + 1)} imports ${specifier}`)
          continue
        }
        if (specifier === '@tokenboard/usage-core') {
          violations.push(
            `${file.slice(appRoot.length + 1)} imports the usage-core barrel (it pulls in zod); ` +
              'use the @tokenboard/usage-core/timezone subpath instead'
          )
          continue
        }
        if (!specifier.startsWith('.')) continue
        const target = await resolveModule(dirname(file), specifier)
        if (target) await walk(target)
      }
    }

    await walk(join(appRoot, 'client.ts'))

    expect(violations).toEqual([])
    // A graph that resolved nothing would pass vacuously; the entry alone pulls several files.
    expect(visited.size).toBeGreaterThan(5)
  })
})

function runtimeImportSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const pattern = /^\s*(?:import|export)\s+(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/gm
  for (const match of source.matchAll(pattern)) specifiers.push(match[1])
  // Bare `import 'x'` side-effect imports carry no `from`.
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specifiers.push(match[1])
  return specifiers
}

async function resolveModule(fromDir: string, specifier: string): Promise<string | null> {
  const base = resolve(fromDir, specifier)
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx'), base]) {
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch {
      // try the next candidate
    }
  }
  return null
}
