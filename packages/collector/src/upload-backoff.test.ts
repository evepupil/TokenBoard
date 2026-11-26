import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  isUploadPaused,
  loadUploadBackoff,
  recordUploadFailure,
  recordUploadSuccess,
  redactUrls,
  summarize,
  uploadFailurePauseThreshold
} from './upload-backoff'

describe('upload backoff', () => {
  test('records consecutive non-transient failures and pauses after the threshold', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'upload-backoff-'))
    try {
      const now = new Date('2026-10-14T00:00:00.000Z')
      for (let index = 1; index < uploadFailurePauseThreshold; index += 1) {
        const state = await recordUploadFailure(stateDir, 'codex', new Error('status 400 from server'), now)
        expect(state.consecutiveFailures).toBe(index)
        expect(state.pausedUntil).toBeUndefined()
      }
      const final = await recordUploadFailure(stateDir, 'codex', new Error('status 401 unauthorized'), now)
      expect(final.consecutiveFailures).toBe(uploadFailurePauseThreshold)
      expect(final.pausedUntil).toBe('2026-10-15T00:00:00.000Z')
      expect((await isUploadPaused(stateDir, 'codex', now))?.pausedUntil).toBe('2026-10-15T00:00:00.000Z')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('a successful upload clears the counter and the file', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'upload-backoff-clear-'))
    try {
      await recordUploadFailure(stateDir, 'codex', new Error('status 400'))
      await recordUploadSuccess(stateDir, 'codex')
      expect(await loadUploadBackoff(stateDir)).toBeNull()
      expect(await isUploadPaused(stateDir, 'codex')).toBeNull()
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('an expired pause no longer blocks', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'upload-backoff-expired-'))
    try {
      await recordUploadFailure(stateDir, 'codex', new Error('status 400'), new Date('2026-10-01T00:00:00.000Z'))
      // Force the threshold directly through the v2 state file shape.
      const stateFile = join(stateDir, 'upload-backoff.json')
      const state = JSON.parse(await readFile(stateFile, 'utf8'))
      state.sources.codex.consecutiveFailures = 5
      state.sources.codex.pausedUntil = '2026-10-03T00:00:00.000Z'
      await writeFile(stateFile, JSON.stringify(state))
      expect(await isUploadPaused(stateDir, 'codex', new Date('2026-10-14T00:00:00.000Z'))).toBeNull()
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('a corrupt state file reads as absent', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'upload-backoff-corrupt-'))
    try {
      await writeFile(join(stateDir, 'upload-backoff.json'), '{"consecutiveFailures": ')
      expect(await loadUploadBackoff(stateDir)).toBeNull()
      expect(await isUploadPaused(stateDir, 'codex')).toBeNull()
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('one source pausing leaves the others uploadable', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'upload-backoff-source-'))
    try {
      const now = new Date('2026-10-14T00:00:00.000Z')
      for (let index = 0; index < uploadFailurePauseThreshold; index += 1) {
        await recordUploadFailure(stateDir, 'codex', new Error('status 400'), now)
      }
      expect(await isUploadPaused(stateDir, 'codex', now)).not.toBeNull()
      expect(await isUploadPaused(stateDir, 'claude-code', now)).toBeNull()
      // A success clears only its own entry.
      await recordUploadSuccess(stateDir, 'claude-code')
      expect(await isUploadPaused(stateDir, 'codex', now)).not.toBeNull()
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  // The v1 file has no source attribution: its pause covers every source, and
  // its count is never inherited by whichever source writes first.
  test('a legacy v1 pause covers every source without attributing its count', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'upload-backoff-legacy-'))
    try {
      const now = new Date('2026-10-14T00:00:00.000Z')
      await writeFile(
        join(stateDir, 'upload-backoff.json'),
        JSON.stringify({
          consecutiveFailures: 4,
          lastErrorSummary: 'Upload failed with status 400',
          pausedUntil: '2026-10-14T01:00:00.000Z'
        })
      )
      expect(await isUploadPaused(stateDir, 'codex', now)).not.toBeNull()
      expect(await isUploadPaused(stateDir, 'claude-code', now)).not.toBeNull()
      const state = await recordUploadFailure(stateDir, 'codex', new Error('status 400'), now)
      expect(state.consecutiveFailures).toBe(1)
      const file = JSON.parse(await readFile(join(stateDir, 'upload-backoff.json'), 'utf8'))
      expect(file.consecutiveFailures).toBe(4)
      expect(file.pausedUntil).toBe('2026-10-14T01:00:00.000Z')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('expired legacy fields are cleaned on the next success', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'upload-backoff-legacy-expired-'))
    try {
      await writeFile(
        join(stateDir, 'upload-backoff.json'),
        JSON.stringify({
          consecutiveFailures: 5,
          lastErrorSummary: 'Upload failed with status 400',
          pausedUntil: '2026-10-13T00:00:00.000Z'
        })
      )
      await recordUploadSuccess(stateDir, 'codex')
      expect(await loadUploadBackoff(stateDir)).toBeNull()
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  // Shape pinned against the Go fixture in
  // clients/go/internal/upload/backoff_sources_test.go.
  test('reads the cross-language v2 shape', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'upload-backoff-crosslang-'))
    try {
      await writeFile(
        join(stateDir, 'upload-backoff.json'),
        JSON.stringify({
          version: 2,
          sources: {
            'claude-code': {
              consecutiveFailures: 2,
              lastErrorSummary: 'status 400',
              pausedUntil: '2026-05-09T13:00:00.000Z'
            }
          }
        })
      )
      const now = new Date('2026-05-09T12:00:00.000Z')
      expect(await isUploadPaused(stateDir, 'claude-code', now)).toEqual({
        pausedUntil: '2026-05-09T13:00:00.000Z'
      })
      expect(await isUploadPaused(stateDir, 'codex', now)).toBeNull()
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  // The backoff file outlives the request. A transport error embeds the full
  // request URL, and the endpoint can carry a query string or userinfo, so the
  // persisted summary keeps only the origin — the same reduction the Go client
  // applies (upload.RedactURLs).
  test('summarize reduces URLs to their origin before persisting', async () => {
    expect(redactUrls('Post "https://tokenboard.example/api/v1/ingest?token=secret": EOF')).toBe(
      'Post "https://tokenboard.example": EOF'
    )
    expect(redactUrls('dial tcp: https://user:pass@host.example:8443/x failed.')).toBe(
      'dial tcp: https://host.example:8443 failed.'
    )
    expect(redactUrls('no url here')).toBe('no url here')
    expect(redactUrls('fetch http://[::1 failed')).toBe('fetch https://<redacted> failed')

    const stateDir = await mkdtemp(join(tmpdir(), 'upload-backoff-redact-'))
    try {
      const state = await recordUploadFailure(
        stateDir,
        'codex',
        new Error('request to https://tokenboard.example/ingest?token=secret failed'),
        new Date('2026-10-14T00:00:00.000Z')
      )
      expect(state.lastErrorSummary).toBe('request to https://tokenboard.example failed')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})
