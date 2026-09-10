import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { collectCodexUsage } from './codex'
import { collectCodexHookProfiles, readCodexHookAcknowledgement } from './codex-hook-profiles'
import { clearPendingUploadCursors } from './session-cursor'
import { cursorFileName } from './session-cursor-store'

describe('Codex multi-profile hook collection', () => {
  test('reconciles a comma-containing Codex home through a frozen scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-comma-hook-'))
    const codexHome = join(root, 'profile,primary')
    const stateDir = join(root, 'state')
    const sessionFile = join(codexHome, 'sessions', '2026', '05', '22', 'session.jsonl')
    const homes: string[] = []

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionFile, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)])

      const snapshots = await collectCodexUsage({
        codexHomes: [codexHome],
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args, options) {
          homes.push(String(options?.env?.CODEX_HOME))
          return args.includes('session') ? sessionResult(15) : dailyResult(15)
        }
      })

      expect(homes).toHaveLength(2)
      expect(new Set(homes).size).toBe(1)
      expect(homes[0]).not.toContain('profile,primary')
      expect(snapshots).toEqual([expect.objectContaining({ totalTokens: 15, sessionCount: 1 })])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reconciles a changed session from a later CODEX_HOME profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const sessionFile = join(secondHome, 'sessions', '2026', '05', '22', 'session.jsonl')
    const homes: string[] = []

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionFile, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)])

      const snapshots = await collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args, options) {
          homes.push(String(options?.env?.CODEX_HOME))
          return args.includes('session') ? sessionResult(15) : dailyResult(15)
        }
      })

      expect(snapshots).toEqual([
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-22',
          model: 'gpt-5',
          totalTokens: 15,
          sessionCount: 1
        })
      ])
      expect(homes).toHaveLength(2)
      expect(new Set(homes).size).toBe(1)
      expect(homes[0]).not.toContain(resolve(firstHome))
      expect(homes[0]).not.toContain(resolve(secondHome))
      expect(homes[0].split(',')).toHaveLength(2)
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps same relative session paths in independent hashed profile cursors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativeSessionPath = join('2026', '05', '22', 'session.jsonl')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await Promise.all([
        writeJsonl(join(firstHome, 'sessions', relativeSessionPath), [tokenCountEvent('2026-05-22T01:00:00.000Z', 10)]),
        writeJsonl(join(secondHome, 'sessions', relativeSessionPath), [tokenCountEvent('2026-05-22T02:00:00.000Z', 20)])
      ])

      await collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? sessionResult(30) : dailyResult(30)
        }
      })

      const firstScope = resolve(firstHome)
      const secondScope = resolve(secondHome)
      const firstCursorPath = join(stateDir, cursorFileName('codex', firstScope))
      const secondCursorPath = join(stateDir, cursorFileName('codex', secondScope))
      const [firstCursor, secondCursor] = await Promise.all([
        readFile(firstCursorPath, 'utf8'),
        readFile(secondCursorPath, 'utf8')
      ])
      expect(JSON.parse(firstCursor).files['2026/05/22/session.jsonl'].pendingUpload).toBe(true)
      expect(JSON.parse(secondCursor).files['2026/05/22/session.jsonl'].pendingUpload).toBe(true)

      await Promise.all([
        clearPendingUploadCursors({ stateDir, source: 'codex', cursorScope: firstScope }),
        clearPendingUploadCursors({ stateDir, source: 'codex', cursorScope: secondScope })
      ])

      const [acknowledgedFirst, acknowledgedSecond] = await Promise.all([
        readFile(firstCursorPath, 'utf8'),
        readFile(secondCursorPath, 'utf8')
      ])
      expect(JSON.parse(acknowledgedFirst).files['2026/05/22/session.jsonl'].pendingUpload).toBeFalsy()
      expect(JSON.parse(acknowledgedSecond).files['2026/05/22/session.jsonl'].pendingUpload).toBeFalsy()
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps each profile cursor stable when CODEX_HOME order changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativeSessionPath = join('2026', '05', '22', 'session.jsonl')
    const cursorSessionPath = '2026/05/22/session.jsonl'
    const secondScope = resolve(secondHome)
    const secondCursorPath = join(stateDir, cursorFileName('codex', secondScope))

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(join(secondHome, 'sessions', relativeSessionPath), [
        tokenCountEvent('2026-05-22T01:00:00.000Z', 15)
      ])

      await collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? sessionResult(15) : dailyResult(15)
        }
      })
      await clearPendingUploadCursors({ stateDir, source: 'codex', cursorScope: secondScope })

      await expect(
        collectCodexUsage({
          codexHome: `${secondHome},${firstHome}`,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:01:00.000Z',
          async runner() {
            throw new Error('unchanged sessions must keep their profile cursor after CODEX_HOME is reordered')
          }
        })
      ).resolves.toEqual([])

      expect(JSON.parse(await readFile(secondCursorPath, 'utf8')).files[cursorSessionPath].pendingUpload).toBeFalsy()
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('deduplicates identical deleted pending sessions across independent profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativeSessionPath = join('2026', '05', '22', 'session.jsonl')
    const firstSession = join(firstHome, 'sessions', relativeSessionPath)
    const secondSession = join(secondHome, 'sessions', relativeSessionPath)

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await Promise.all([
        writeJsonl(firstSession, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)]),
        writeJsonl(secondSession, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)])
      ])

      await expect(
        collectCodexUsage({
          codexHome: `${firstHome},${secondHome}`,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:00:00.000Z',
          async runner() {
            return { data: [] }
          }
        })
      ).rejects.toThrow(/Codex hook reconciliation returned no snapshots/)

      await Promise.all([rm(firstSession), rm(secondSession)])
      const snapshots = await collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:01:00.000Z',
        async runner() {
          throw new Error('deleted pending snapshots must not run ccusage reconciliation')
        }
      })

      expect(snapshots).toEqual([
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-22',
          model: 'gpt-5',
          totalTokens: 15,
          sessionCount: 1
        })
      ])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('derives unresolved context pricing from the deduplicated pending entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-pending-dedup-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativePath = '2026/05/22/deleted.jsonl'
    const fingerprint = {
      size: 15,
      mtimeMs: Date.parse('2026-05-22T01:00:00.000Z'),
      sha256: 'a'.repeat(64)
    }

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeProfileCursor({
        cursorPath: join(stateDir, cursorFileName('codex', resolve(firstHome))),
        relativePath,
        totalTokens: 15,
        ...fingerprint,
        model: 'gpt-5.6-sol',
        costUsd: 0.01,
        contextPricingPending: true,
        pendingUpload: true
      })
      await writeProfileCursor({
        cursorPath: join(stateDir, cursorFileName('codex', resolve(secondHome))),
        relativePath,
        totalTokens: 15,
        ...fingerprint,
        model: 'gpt-5.6-sol',
        costUsd: 0.01,
        pendingUpload: true
      })

      const result = await collectCodexHookProfiles({
        codexHomes: [firstHome, secondHome],
        stateDir,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:01:00.000Z'
      })
      expect(result.cachedSnapshots).toEqual([expect.objectContaining({ model: 'gpt-5.6-sol', totalTokens: 15 })])
      expect(result.unresolvedContextPricingSnapshots).toEqual(result.cachedSnapshots)
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps an unrecoverable context-priced snapshot pending without wedging the hook', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-context-pending-'))
    const codexHome = join(root, 'profile')
    const stateDir = join(root, 'state')
    const relativePath = join('2026', '05', '22', 'deleted.jsonl')
    const cursorPath = join(stateDir, cursorFileName('codex', resolve(codexHome)))

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      const stderr: string[] = []
      await writeProfileCursor({
        cursorPath,
        relativePath,
        totalTokens: 300_000,
        size: 1,
        mtimeMs: Date.parse('2026-05-22T01:00:00.000Z'),
        sha256: 'a'.repeat(64),
        pendingUpload: true,
        model: 'gpt-5.6-sol',
        costUsd: 0
      })

      await expect(
        collectCodexUsage({
          codexHomes: [codexHome],
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:00:00.000Z',
          stderr: (line) => stderr.push(line),
          async runner() {
            throw new Error('unrecoverable pending pricing must not invoke reconciliation')
          }
        })
      ).resolves.toEqual([])
      expect(stderr).toHaveLength(1)
      expect(stderr[0]).toMatch(
        /^Codex context pricing is unavailable for pending snapshots without source session files; keeping them pending: 2026-05-22\//
      )
      const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
      expect(cursor.files[relativePath].pendingUpload).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reconciles identical pending content through a remaining profile session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativeSessionPath = join('2026', '05', '22', 'session.jsonl')
    const firstSession = join(firstHome, 'sessions', relativeSessionPath)
    const secondSession = join(secondHome, 'sessions', relativeSessionPath)

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await Promise.all([
        writeJsonl(firstSession, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)]),
        writeJsonl(secondSession, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)])
      ])

      await expect(
        collectCodexUsage({
          codexHome: `${firstHome},${secondHome}`,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:00:00.000Z',
          async runner() {
            return { data: [] }
          }
        })
      ).rejects.toThrow(/Codex hook reconciliation returned no snapshots/)

      await rm(firstSession)
      const snapshots = await collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:01:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? sessionResult(15) : dailyResult(15)
        }
      })

      expect(snapshots).toEqual([
        expect.objectContaining({
          source: 'codex',
          usageDate: '2026-05-22',
          model: 'gpt-5',
          totalTokens: 15,
          sessionCount: 1
        })
      ])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('recovers an old single-profile pending cursor after switching to multiple profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativeSessionPath = '2026/05/22/legacy.jsonl'
    const legacyCursorPath = join(stateDir, 'codex-cursor.json')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeLegacyPendingCursor({
        cursorPath: legacyCursorPath,
        relativePath: relativeSessionPath,
        totalTokens: 15,
        size: 1,
        sha256: 'a'.repeat(64)
      })

      const recovered = await collectCodexUsage({
        codexHome: `${firstHome},${secondHome}`,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:01:00.000Z',
        async runner() {
          throw new Error('the deleted legacy pending snapshot must be recovered without ccusage')
        }
      })
      expect(recovered).toEqual([expect.objectContaining({ totalTokens: 15, sessionCount: 1 })])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('restores one legacy pending snapshot when matching content was copied into multiple profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativeSessionPath = '2026/05/22/legacy-copy.jsonl'
    const firstSession = join(firstHome, 'sessions', relativeSessionPath)
    const secondSession = join(secondHome, 'sessions', relativeSessionPath)
    const legacyCursorPath = join(stateDir, 'codex-cursor.json')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await Promise.all([
        writeJsonl(firstSession, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)]),
        writeJsonl(secondSession, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)])
      ])
      const fingerprint = await fileFingerprint(firstSession)
      await writeLegacyPendingCursor({
        cursorPath: legacyCursorPath,
        relativePath: relativeSessionPath,
        totalTokens: 15,
        ...fingerprint
      })

      await expect(
        collectCodexUsage({
          codexHome: `${firstHome},${secondHome}`,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:00:00.000Z',
          async runner() {
            return { data: [] }
          }
        })
      ).rejects.toThrow(/Codex hook reconciliation returned no snapshots/)

      await Promise.all([rm(firstSession), rm(secondSession)])
      await expect(
        collectCodexUsage({
          codexHome: `${firstHome},${secondHome}`,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:01:00.000Z',
          async runner() {
            throw new Error('deleted legacy pending copies must be restored without ccusage reconciliation')
          }
        })
      ).resolves.toEqual([expect.objectContaining({ totalTokens: 15, sessionCount: 1 })])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps an old single-profile pending cursor when a different single profile reuses its relative path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativeSessionPath = '2026/05/22/session.jsonl'
    const legacyCursorPath = join(stateDir, 'codex-cursor.json')
    const secondCursorPath = join(stateDir, cursorFileName('codex', resolve(secondHome)))

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeLegacyPendingCursor({
        cursorPath: legacyCursorPath,
        relativePath: relativeSessionPath,
        totalTokens: 15,
        size: 1,
        sha256: 'a'.repeat(64)
      })
      await writeJsonl(join(secondHome, 'sessions', relativeSessionPath), [
        tokenCountEvent('2026-05-22T01:00:00.000Z', 25)
      ])

      await expect(
        collectCodexUsage({
          codexHome: secondHome,
          stateDir,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:01:00.000Z',
          async runner(_command, args) {
            return args.includes('session') ? sessionResult(25) : dailyResult(25)
          }
        })
      ).resolves.toEqual([expect.objectContaining({ totalTokens: 40, sessionCount: 2 })])

      const legacy = JSON.parse(await readFile(legacyCursorPath, 'utf8'))
      const second = JSON.parse(await readFile(secondCursorPath, 'utf8'))
      expect(legacy.files[relativeSessionPath]).toEqual(
        expect.objectContaining({
          pendingUpload: true,
          snapshots: [expect.objectContaining({ totalTokens: 15 })]
        })
      )
      expect(second.files[relativeSessionPath]).toEqual(
        expect.objectContaining({
          pendingUpload: true,
          snapshots: [expect.objectContaining({ totalTokens: 25 })]
        })
      )
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')(
    'rejects a legacy cursor session symbolic link during profile migration',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
      const firstHome = join(root, 'first')
      const secondHome = join(root, 'second')
      const stateDir = join(root, 'state')
      const relativeSessionPath = '2026/05/22/linked.jsonl'
      const outsideSession = join(root, 'outside.jsonl')
      const linkedSession = join(secondHome, 'sessions', relativeSessionPath)
      const legacyCursorPath = join(stateDir, 'codex-cursor.json')
      const profileCursorPath = join(stateDir, cursorFileName('codex', resolve(secondHome)))

      vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
      vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
      vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

      try {
        await writeJsonl(outsideSession, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)])
        await mkdir(dirname(linkedSession), { recursive: true })
        await symlink(outsideSession, linkedSession)
        const fingerprint = await fileFingerprint(outsideSession)
        await writeLegacyPendingCursor({
          cursorPath: legacyCursorPath,
          relativePath: relativeSessionPath,
          totalTokens: 15,
          ...fingerprint
        })

        await expect(
          collectCodexUsage({
            codexHome: `${firstHome},${secondHome}`,
            timezone: 'Asia/Shanghai',
            collectedAt: '2026-05-22T10:01:00.000Z',
            async runner() {
              throw new Error('legacy migration must fail before Codex reconciliation')
            }
          })
        ).rejects.toThrow(/legacy Codex session file: symbolic links are not supported/i)

        const legacyCursor = JSON.parse(await readFile(legacyCursorPath, 'utf8'))
        expect(legacyCursor.files[relativeSessionPath].pendingUpload).toBe(true)
        await expect(readFile(profileCursorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        vi.unstubAllEnvs()
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  test.skipIf(process.platform === 'win32')(
    'rejects an unauthorized legacy session root symlink during profile migration',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
      const firstHome = join(root, 'first')
      const secondHome = join(root, 'second')
      const outsideRoot = join(root, 'outside-sessions')
      const stateDir = join(root, 'state')
      const relativeSessionPath = '2026/05/22/linked-root.jsonl'
      const outsideSession = join(outsideRoot, relativeSessionPath)
      const linkedRoot = join(secondHome, 'archived_sessions')
      const legacyCursorPath = join(stateDir, 'codex-cursor.json')
      const profileCursorPath = join(stateDir, cursorFileName('codex', resolve(secondHome)))

      vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
      vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
      vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

      try {
        await writeJsonl(outsideSession, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)])
        await mkdir(dirname(linkedRoot), { recursive: true })
        await symlink(outsideRoot, linkedRoot, 'dir')
        const fingerprint = await fileFingerprint(outsideSession)
        await writeLegacyPendingCursor({
          cursorPath: legacyCursorPath,
          relativePath: relativeSessionPath,
          totalTokens: 15,
          ...fingerprint
        })

        await expect(
          collectCodexUsage({
            codexHome: `${firstHome},${secondHome}`,
            timezone: 'Asia/Shanghai',
            collectedAt: '2026-05-22T10:01:00.000Z',
            async runner() {
              throw new Error('legacy migration must fail before Codex reconciliation')
            }
          })
        ).rejects.toThrow(/session directory .*symbolic links are not supported/i)

        const legacyCursor = JSON.parse(await readFile(legacyCursorPath, 'utf8'))
        expect(legacyCursor.files[relativeSessionPath].pendingUpload).toBe(true)
        await expect(readFile(profileCursorPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        vi.unstubAllEnvs()
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  test('recovers a scoped pending cursor after switching back to one profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const profileCursorPath = join(stateDir, cursorFileName('codex', resolve(codexHome)))

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', join(root, 'wrong-state'))
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeProfileCursor({
        cursorPath: profileCursorPath,
        relativePath: '2026/05/22/missing.jsonl',
        totalTokens: 15,
        size: 1,
        mtimeMs: Date.parse('2026-05-22T01:00:00.000Z'),
        sha256: 'a'.repeat(64),
        pendingUpload: true
      })

      await expect(
        collectCodexUsage({
          codexHome,
          stateDir,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:01:00.000Z',
          async runner() {
            throw new Error(
              'a scoped pending snapshot must be recovered without ccusage after returning to one profile'
            )
          }
        })
      ).resolves.toEqual([expect.objectContaining({ totalTokens: 15, sessionCount: 1 })])
      await expect(readFile(join(stateDir, 'codex-cursor.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(
        JSON.parse(await readFile(profileCursorPath, 'utf8')).files['2026/05/22/missing.jsonl'].pendingUpload
      ).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('migrates a legacy pending cursor when its session is archived', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-legacy-archived-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const relativePath = '2026/05/22/legacy.jsonl'
    const archivedPath = join(codexHome, 'archived_sessions', relativePath)
    const legacyCursorPath = join(stateDir, 'codex-cursor.json')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(archivedPath, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)])
      const fingerprint = await fileFingerprint(archivedPath)
      await writeLegacyPendingCursor({
        cursorPath: legacyCursorPath,
        relativePath,
        totalTokens: 15,
        ...fingerprint
      })

      await expect(
        collectCodexUsage({
          codexHome,
          stateDir,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:00:00.000Z',
          async runner(_command, args) {
            return args.includes('session') ? sessionResult(15) : dailyResult(15)
          }
        })
      ).resolves.toEqual([expect.objectContaining({ totalTokens: 15, sessionCount: 1 })])
      expect(JSON.parse(await readFile(legacyCursorPath, 'utf8')).files).toEqual({})
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not let an old archived copy override a newer active session path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-legacy-active-'))
    const codexHome = join(root, 'codex')
    const otherHome = join(root, 'other')
    const stateDir = join(root, 'state')
    const relativePath = '2026/05/22/reused.jsonl'
    const activePath = join(codexHome, 'sessions', relativePath)
    const archivedPath = join(codexHome, 'archived_sessions', relativePath)
    const legacyCursorPath = join(stateDir, 'codex-cursor.json')

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(activePath, [tokenCountEvent('2026-05-22T01:00:00.000Z', 7)])
      await writeJsonl(archivedPath, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)])
      const archivedFingerprint = await fileFingerprint(archivedPath)
      await writeLegacyPendingCursor({
        cursorPath: legacyCursorPath,
        relativePath,
        totalTokens: 15,
        ...archivedFingerprint
      })

      const result = await collectCodexHookProfiles({
        codexHomes: [codexHome, otherHome],
        stateDir,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z'
      })
      expect(result.cachedSnapshots).toEqual([expect.objectContaining({ totalTokens: 15 })])
      expect(JSON.parse(await readFile(legacyCursorPath, 'utf8')).files[relativePath].pendingUpload).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retains a pending context-priced snapshot when its source file is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-pending-pricing-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const profileCursorPath = join(stateDir, cursorFileName('codex', resolve(codexHome)))

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', join(root, 'wrong-state'))
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      const stderr: string[] = []
      await writeProfileCursor({
        cursorPath: profileCursorPath,
        relativePath: '2026/05/22/missing.jsonl',
        totalTokens: 15,
        size: 1,
        mtimeMs: Date.parse('2026-05-22T01:00:00.000Z'),
        sha256: 'a'.repeat(64),
        pendingUpload: true,
        model: 'gpt-5.6-sol',
        costUsd: 0.01,
        contextPricingPending: true
      })

      await expect(
        collectCodexUsage({
          codexHome,
          stateDir,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:01:00.000Z',
          stderr: (line) => stderr.push(line),
          async runner() {
            throw new Error('a missing context-priced source must not invoke ccusage reconciliation')
          }
        })
      ).resolves.toEqual([])
      expect(stderr).toHaveLength(1)
      expect(stderr[0]).toMatch(
        /^Codex context pricing is unavailable for pending snapshots without source session files; keeping them pending: 2026-05-22\//
      )
      expect(
        JSON.parse(await readFile(profileCursorPath, 'utf8')).files['2026/05/22/missing.jsonl'].pendingUpload
      ).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('retains a missing file when only some of its pending snapshots can upload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-mixed-pending-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const relativePath = '2026/05/22/missing.jsonl'
    const profileCursorPath = join(stateDir, cursorFileName('codex', resolve(codexHome)))

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeProfileCursor({
        cursorPath: profileCursorPath,
        relativePath,
        totalTokens: 15,
        size: 1,
        mtimeMs: Date.parse('2026-05-22T01:00:00.000Z'),
        sha256: 'a'.repeat(64),
        pendingUpload: true,
        additionalSnapshots: [
          {
            ...snapshot(25, 'gpt-5.6-sol', 0.02),
            codexContextPricingPending: true
          }
        ]
      })

      const snapshots = await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:01:00.000Z',
        async runner() {
          throw new Error('missing pending snapshots must not invoke ccusage reconciliation')
        }
      })
      expect(snapshots).toEqual([expect.objectContaining({ model: 'gpt-5', totalTokens: 15 })])

      const acknowledgement = readCodexHookAcknowledgement(snapshots)
      expect(acknowledgement).toEqual([{ cursorScope: resolve(codexHome), files: [] }])
      await clearPendingUploadCursors({
        stateDir,
        source: 'codex',
        cursorScope: resolve(codexHome),
        acknowledgedSnapshotFiles: acknowledgement?.[0]?.files ?? []
      })

      const cursor = JSON.parse(await readFile(profileCursorPath, 'utf8'))
      expect(cursor.files[relativePath].pendingUpload).toBe(true)
      expect(cursor.files[relativePath].snapshots).toHaveLength(2)
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('recovers pending context pricing after a session moves to archived_sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-archived-hook-'))
    const codexHome = join(root, 'codex')
    const stateDir = join(root, 'state')
    const relativeSessionPath = join('2026', '05', '22', 'session.jsonl')
    const activePath = join(codexHome, 'sessions', relativeSessionPath)
    const archivedPath = join(codexHome, 'archived_sessions', relativeSessionPath)

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(activePath, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15, 'gpt-5.6-sol')])
      const first = await collectCodexUsage({
        codexHome,
        stateDir,
        timezone: 'Asia/Shanghai',
        collectedAt: '2026-05-22T10:00:00.000Z',
        async runner(_command, args) {
          return args.includes('session') ? sessionResult(15, 'gpt-5.6-sol') : dailyResult(15, 'gpt-5.6-sol')
        }
      })
      expect(first).toEqual([expect.objectContaining({ model: 'gpt-5.6-sol', totalTokens: 15 })])

      await mkdir(dirname(archivedPath), { recursive: true })
      await rename(activePath, archivedPath)
      await expect(
        collectCodexUsage({
          codexHome,
          stateDir,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:01:00.000Z',
          async runner(_command, args) {
            return args.includes('session') ? sessionResult(15, 'gpt-5.6-sol') : dailyResult(15, 'gpt-5.6-sol')
          }
        })
      ).resolves.toEqual([expect.objectContaining({ model: 'gpt-5.6-sol', totalTokens: 15 })])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not revive a legacy pending snapshot already acknowledged by a profile cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativeSessionPath = '2026/05/22/acknowledged.jsonl'
    const sessionFile = join(secondHome, 'sessions', relativeSessionPath)
    const legacyCursorPath = join(stateDir, 'codex-cursor.json')
    const profileCursorPath = join(stateDir, cursorFileName('codex', resolve(secondHome)))

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeJsonl(sessionFile, [tokenCountEvent('2026-05-22T01:00:00.000Z', 15)])
      const fingerprint = await fileFingerprint(sessionFile)
      await writeLegacyPendingCursor({
        cursorPath: legacyCursorPath,
        relativePath: relativeSessionPath,
        totalTokens: 15,
        size: fingerprint.size,
        sha256: fingerprint.sha256
      })
      await writeProfileCursor({
        cursorPath: profileCursorPath,
        relativePath: relativeSessionPath,
        totalTokens: 15,
        ...fingerprint
      })

      await expect(
        collectCodexUsage({
          codexHome: `${firstHome},${secondHome}`,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:01:00.000Z',
          async runner() {
            throw new Error('an acknowledged profile cursor must not rerun Codex reconciliation')
          }
        })
      ).resolves.toEqual([])

      expect(JSON.parse(await readFile(legacyCursorPath, 'utf8')).files).toEqual({})
      expect(JSON.parse(await readFile(profileCursorPath, 'utf8')).files[relativeSessionPath].pendingUpload).toBeFalsy()
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('drops an identical legacy pending entry already acknowledged by a profile cursor without reading its source file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tokenboard-codex-multi-hook-'))
    const firstHome = join(root, 'first')
    const secondHome = join(root, 'second')
    const stateDir = join(root, 'state')
    const relativeSessionPath = '2026/05/22/acknowledged-missing.jsonl'
    const legacyCursorPath = join(stateDir, 'codex-cursor.json')
    const profileCursorPath = join(stateDir, cursorFileName('codex', resolve(secondHome)))
    const fingerprint = {
      size: 123,
      mtimeMs: Date.parse('2026-05-22T01:00:00.000Z'),
      sha256: 'a'.repeat(64)
    }

    vi.stubEnv('TOKENBOARD_HOOK_MODE', '1')
    vi.stubEnv('TOKENBOARD_STATE_DIR', stateDir)
    vi.stubEnv('TOKENBOARD_FORCE_PACKAGE_RUNNER', '1')

    try {
      await writeLegacyPendingCursor({
        cursorPath: legacyCursorPath,
        relativePath: relativeSessionPath,
        totalTokens: 15,
        ...fingerprint
      })
      await writeProfileCursor({
        cursorPath: profileCursorPath,
        relativePath: relativeSessionPath,
        totalTokens: 15,
        ...fingerprint
      })

      await expect(
        collectCodexUsage({
          codexHome: `${firstHome},${secondHome}`,
          timezone: 'Asia/Shanghai',
          collectedAt: '2026-05-22T10:01:00.000Z',
          async runner() {
            throw new Error('an acknowledged identical profile cursor must not reread the missing legacy source')
          }
        })
      ).resolves.toEqual([])

      expect(JSON.parse(await readFile(legacyCursorPath, 'utf8')).files).toEqual({})
      expect(JSON.parse(await readFile(profileCursorPath, 'utf8')).files[relativeSessionPath].pendingUpload).toBeFalsy()
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeJsonl(file: string, rows: unknown[]) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

function tokenCountEvent(timestamp: string, totalTokens: number, model = 'gpt-5') {
  return {
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        model,
        last_token_usage: {
          input_tokens: totalTokens,
          output_tokens: 0,
          total_tokens: totalTokens
        }
      }
    }
  }
}

function dailyResult(totalTokens: number, model = 'gpt-5') {
  return {
    data: [
      {
        date: '2026-05-22',
        model,
        inputTokens: totalTokens,
        outputTokens: 0,
        totalTokens,
        costUSD: 0.01
      }
    ]
  }
}

function sessionResult(totalTokens: number, model = 'gpt-5') {
  return {
    data: [
      {
        sessionId: 'session',
        directory: '2026/05/22',
        sessionFile: 'session',
        lastActivity: '2026-05-22T01:00:00.000Z',
        models: {
          [model]: {
            inputTokens: totalTokens,
            outputTokens: 0,
            totalTokens
          }
        }
      }
    ]
  }
}

async function writeLegacyPendingCursor(input: {
  cursorPath: string
  relativePath: string
  totalTokens: number
  size: number
  sha256: string
}) {
  await mkdir(dirname(input.cursorPath), { recursive: true })
  await writeFile(
    input.cursorPath,
    `${JSON.stringify(
      {
        version: 1,
        source: 'codex',
        files: {
          [input.relativePath]: {
            size: input.size,
            mtimeMs: Date.parse('2026-05-22T01:00:00.000Z'),
            sha256: input.sha256,
            snapshots: [
              {
                source: 'codex',
                usageDate: '2026-05-22',
                timezone: 'Asia/Shanghai',
                model: 'gpt-5',
                inputTokens: input.totalTokens,
                outputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                totalTokens: input.totalTokens,
                costUsd: 0.01,
                sessionCount: 1
              }
            ],
            missingCost: false,
            pendingUpload: true,
            updatedAt: '2026-05-22T10:00:00.000Z'
          }
        }
      },
      null,
      2
    )}\n`
  )
}

async function writeProfileCursor(input: {
  cursorPath: string
  relativePath: string
  totalTokens: number
  size: number
  mtimeMs: number
  sha256: string
  pendingUpload?: boolean
  model?: string
  costUsd?: number
  contextPricingPending?: boolean
  additionalSnapshots?: Array<ReturnType<typeof snapshot> & { codexContextPricingPending?: true }>
}) {
  await mkdir(dirname(input.cursorPath), { recursive: true })
  await writeFile(
    input.cursorPath,
    `${JSON.stringify(
      {
        version: 1,
        source: 'codex',
        files: {
          [input.relativePath]: {
            size: input.size,
            mtimeMs: input.mtimeMs,
            sha256: input.sha256,
            endsWithNewline: true,
            snapshots: [
              {
                ...snapshot(input.totalTokens, input.model, input.costUsd),
                ...(input.contextPricingPending ? { codexContextPricingPending: true } : {})
              },
              ...(input.additionalSnapshots ?? [])
            ],
            missingCost: false,
            ...(input.pendingUpload ? { pendingUpload: true } : {}),
            updatedAt: '2026-05-22T10:00:00.000Z'
          }
        }
      },
      null,
      2
    )}\n`
  )
}

function snapshot(totalTokens: number, model = 'gpt-5', costUsd = 0.01) {
  return {
    source: 'codex',
    usageDate: '2026-05-22',
    timezone: 'Asia/Shanghai',
    model,
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens,
    costUsd,
    sessionCount: 1
  }
}

async function fileFingerprint(file: string) {
  const [contents, details] = await Promise.all([readFile(file), stat(file)])
  return {
    size: details.size,
    mtimeMs: details.mtimeMs,
    sha256: createHash('sha256').update(contents).digest('hex')
  }
}
