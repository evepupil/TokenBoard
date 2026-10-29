import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import {
  archiveName,
  binaryFileName,
  clientBinaryPath,
  installClientBinary,
  latestTag,
  readChecksums,
  recoverOrphanedBinary,
  releasePlatform,
  resolveRelease,
  runSelfUpdate,
  tagFromURL,
  verifyChecksum,
  verifyExecutable,
  versionOf
} from './client-binary.mjs'

// A stub standing in for the release binary: it answers `version` the way the
// real one does, because a test cannot ship a compiled binary.
function stubBinary(version) {
  return `#!/bin/sh\nif [ "$1" = version ]; then echo "tokenboard (go) ${version}"; exit 0; fi\nexit 0\n`
}

// buildTarball assembles a release tarball holding one executable. The real
// extraction shells out to `tar`, so the fixture is built the same way.
function buildTarball(dir, name, body, extraFiles = {}) {
  const staging = join(dir, 'staging')
  mkdirSync(staging, { recursive: true })
  const file = join(staging, name)
  writeFileSync(file, body, { mode: 0o755 })
  chmodSync(file, 0o755)
  const members = [name]
  for (const [extraName, extraBody] of Object.entries(extraFiles)) {
    writeFileSync(join(staging, extraName), extraBody, { mode: 0o755 })
    members.push(extraName)
  }
  const archivePath = join(dir, `${name}.tar.gz`)
  const result = spawnSync('tar', ['-czf', archivePath, '-C', staging, ...members], { encoding: 'utf8' })
  assert.equal(result.status, 0, `tar failed: ${result.stderr}`)
  return readFileSync(archivePath)
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

// serveRelease starts a server speaking the three endpoints an install uses.
function serveRelease({
  tag = 'v1.2.3',
  platform = 'darwin_amd64',
  tarball,
  omitChecksums = false,
  badChecksum = false,
  repo = 'MisonL/TokenBoard'
}) {
  const archive = archiveName(platform)
  const manifest = badChecksum ? `${'0'.repeat(64)}  ${archive}\n` : `${sha256(tarball)}  ${archive}\n`
  const server = createServer((request, response) => {
    const url = request.url
    if (url === `/${repo}/releases/latest`) {
      response.writeHead(302, { location: `/${repo}/releases/tag/${tag}` })
      response.end()
      return
    }
    if (url === `/${repo}/releases/tag/${tag}`) {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html>release</html>')
      return
    }
    if (url === `/${repo}/releases/download/${tag}/${archive}`) {
      response.writeHead(200, { 'content-length': String(tarball.length) })
      response.end(tarball)
      return
    }
    if (url === `/${repo}/releases/download/${tag}/checksums.txt`) {
      if (omitChecksums) {
        response.writeHead(404)
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(manifest)
      return
    }
    response.writeHead(404)
    response.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

function withServer(t, options) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-client-'))
  const tarball = buildTarball(dir, 'tokenboard', stubBinary(options.version ?? '1.2.3'), options.extraFiles ?? {})
  return serveRelease({ ...options, tarball }).then(({ server, baseUrl }) => {
    t.after(() => server.close())
    return { baseUrl, dir, tarball }
  })
}

test('resolveRelease follows the releases-latest redirect instead of the REST API', async (t) => {
  const { baseUrl } = await withServer(t, { platform: 'darwin_amd64' })
  const release = await resolveRelease({ baseUrl, platform: 'darwin', arch: 'x64' })
  assert.equal(release.tag, 'v1.2.3')
  assert.equal(release.version, '1.2.3')
  assert.equal(release.archive.name, 'tokenboard_darwin_amd64.tar.gz')
  assert.match(release.archive.url, /\/releases\/download\/v1\.2\.3\//)
  assert.equal(release.checksums.name, 'checksums.txt')
})

test('verifyExecutable requires the version as a whole token', () => {
  // The staged binary is the only check before the swap. A substring match
  // accepts "1.2.30" for "1.2.3" and installs a truncated download as the
  // client; Go's verifyExecutable has always matched a whole token.
  const spawn = () => ({ status: 0, stdout: 'tokenboard (go) 1.2.30\n', stderr: '' })
  assert.throws(() => verifyExecutable('/staged/tokenboard', '1.2.3', { spawn }), /does not run/)

  const exact = () => ({ status: 0, stdout: 'tokenboard (go) 1.2.3\n', stderr: '' })
  verifyExecutable('/staged/tokenboard', '1.2.3', { spawn: exact })
})

test('version probes are bounded so a wedged binary cannot hold the sync lock', async (t) => {
  // recoverOrphanedBinary runs inside runWithSyncLock: a staged binary that never
  // answers `version` would hold sync.lock until the process is killed. Go's
  // selfupdate bounds the same probe at 10s; the git path had no bound at all.
  const dir = await mkdtemp(join(tmpdir(), 'tokenboard-probe-timeout-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const binaryPath = join(dir, 'tokenboard')
  // A staged copy must exist for recoverOrphanedBinary to probe it at all.
  writeFileSync(`${binaryPath}.new`, 'staged', { mode: 0o755 })

  const seen = []
  const spawn = (path, args, options) => {
    seen.push({ path, args, timeout: options?.timeout })
    return { status: 0, stdout: 'tokenboard (go) 1.2.3\n', stderr: '' }
  }

  verifyExecutable('/staged/tokenboard', '1.2.3', { spawn })
  recoverOrphanedBinary({
    binaryPath,
    readDir: () => [],
    rename: () => {},
    remove: () => {},
    spawn
  })

  assert.equal(seen.length, 2, 'both probes must run')
  for (const call of seen) {
    assert.equal(call.timeout, 10_000, `${call.path} probe must carry the 10s bound`)
  }
})

test('resolveRelease refuses a redirect loop rather than walking it', async (t) => {
  const server = createServer((request, response) => {
    response.writeHead(302, { location: '/MisonL/TokenBoard/releases/latest' })
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  await assert.rejects(() => resolveRelease({ baseUrl, platform: 'darwin', arch: 'x64' }), /redirected more than/)
})

test('resolveRelease reports a repository with no release as a 404', async (t) => {
  const server = createServer((request, response) => {
    response.writeHead(404)
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  await assert.rejects(() => resolveRelease({ baseUrl, platform: 'darwin', arch: 'x64' }), /HTTP 404/)
})

test('a pinned tag skips the latest-release lookup entirely', async () => {
  const release = await resolveRelease({
    tag: 'v9.9.9',
    baseUrl: 'https://example.invalid',
    platform: 'linux',
    arch: 'arm64',
    fetcher: () => {
      throw new Error('no request expected')
    }
  })
  assert.equal(release.tag, 'v9.9.9')
  assert.equal(release.archive.name, 'tokenboard_linux_arm64.tar.gz')
})

test('latestTag decodes a percent-escaped tag', () => {
  assert.equal(tagFromURL('https://github.com/o/r/releases/tag/v1.0.0%2Bmeta'), 'v1.0.0+meta')
  assert.equal(tagFromURL('https://github.com/o/r/releases/tag/v1.0.0?x=1'), 'v1.0.0')
  assert.equal(tagFromURL('https://github.com/o/r/releases/latest'), '')
})

test('releasePlatform covers the six published builds and refuses the rest', () => {
  assert.equal(releasePlatform('darwin', 'x64'), 'darwin_amd64')
  assert.equal(releasePlatform('darwin', 'arm64'), 'darwin_arm64')
  assert.equal(releasePlatform('linux', 'x64'), 'linux_amd64')
  assert.equal(releasePlatform('linux', 'arm64'), 'linux_arm64')
  assert.equal(releasePlatform('win32', 'x64'), 'windows_amd64')
  assert.throws(() => releasePlatform('freebsd', 'x64'), /no release/)
  assert.throws(() => releasePlatform('linux', 'ia32'), /no release/)
})

test('versionOf strips only a leading v', () => {
  assert.equal(versionOf('v1.2.3'), '1.2.3')
  assert.equal(versionOf('1.2.3'), '1.2.3')
  assert.equal(versionOf(''), '')
})

test('readChecksums rejects a manifest it cannot read in full', () => {
  assert.throws(() => readChecksums('abc123 tokenboard.tar.gz\n'), /invalid checksums.txt digest/)
  assert.throws(() => readChecksums(`${'a'.repeat(64)}\n`), /invalid checksums.txt line/)
  assert.throws(() => readChecksums('\n  \n'), /no entries/)
})

test('verifyChecksum refuses a missing entry and a mismatch', () => {
  const data = Buffer.from('tarball')
  const manifest = readChecksums(`${sha256(data)}  tokenboard_darwin_amd64.tar.gz\n`)
  assert.doesNotThrow(() => verifyChecksum(data, 'tokenboard_darwin_amd64.tar.gz', manifest))
  assert.throws(
    () => verifyChecksum(Buffer.from('tampered'), 'tokenboard_darwin_amd64.tar.gz', manifest),
    /checksum mismatch/
  )
  assert.throws(() => verifyChecksum(data, 'absent.tar.gz', manifest), /no entry/)
})

test('installClientBinary installs a verified binary and leaves no staged file', async (t) => {
  const { baseUrl } = await withServer(t, { platform: 'darwin_amd64', version: '1.2.3' })
  const configDir = mkdtempSync(join(tmpdir(), 'tokenboard-config-'))
  const result = await installClientBinary({
    baseUrl,
    configDir,
    platform: 'darwin',
    arch: 'x64',
    log: () => {}
  })
  assert.equal(result.version, '1.2.3')
  assert.equal(result.path, clientBinaryPath({ configDir, platform: 'darwin' }))
  assert.match(readFileSync(result.path, 'utf8'), /tokenboard \(go\) 1\.2\.3/)
  assert.equal(existsSync(`${result.path}.new`), false)
  assert.equal(existsSync(join(configDir, 'client-install')), false)
})

test('installClientBinary refuses a checksum mismatch and installs nothing', async (t) => {
  const { baseUrl } = await withServer(t, { platform: 'darwin_amd64', badChecksum: true })
  const configDir = mkdtempSync(join(tmpdir(), 'tokenboard-config-'))
  await assert.rejects(
    () => installClientBinary({ baseUrl, configDir, platform: 'darwin', arch: 'x64', log: () => {} }),
    /checksum mismatch/
  )
  assert.equal(existsSync(clientBinaryPath({ configDir, platform: 'darwin' })), false)
})

test('installClientBinary refuses a release without a checksums manifest', async (t) => {
  const { baseUrl } = await withServer(t, { platform: 'darwin_amd64', omitChecksums: true })
  const configDir = mkdtempSync(join(tmpdir(), 'tokenboard-config-'))
  await assert.rejects(
    () => installClientBinary({ baseUrl, configDir, platform: 'darwin', arch: 'x64', log: () => {} }),
    /HTTP 404/
  )
  assert.equal(existsSync(clientBinaryPath({ configDir, platform: 'darwin' })), false)
})

test('installClientBinary refuses a binary that does not answer version', async (t) => {
  const { baseUrl } = await withServer(t, { platform: 'darwin_amd64', version: '9.9.9' })
  const configDir = mkdtempSync(join(tmpdir(), 'tokenboard-config-'))
  await assert.rejects(
    () => installClientBinary({ baseUrl, configDir, platform: 'darwin', arch: 'x64', log: () => {} }),
    /does not run/
  )
  assert.equal(existsSync(clientBinaryPath({ configDir, platform: 'darwin' })), false)
})

test('runSelfUpdate refuses to run when no client is installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-missing-client-'))
  assert.throws(() => runSelfUpdate({ binaryPath: join(dir, 'missing-tokenboard') }), /is not installed/)
})

test('runSelfUpdate restores a binary left behind by an interrupted swap', () => {
  // `self-update` renames the running binary aside before staging the new one;
  // a process killed in between leaves the backup and no target. Without this
  // recovery every later sync reports "client is not installed".
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-orphan-'))
  const binaryPath = join(dir, binaryFileName('darwin'))
  writeFileSync(`${binaryPath}.backup-20260101T000000Z`, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

  runSelfUpdate({ binaryPath, spawn: () => ({ status: 0, stdout: 'tokenboard (go) 1.2.3\n' }), log: () => {} })

  assert.equal(existsSync(binaryPath), true)
  assert.equal(existsSync(`${binaryPath}.backup-20260101T000000Z`), false)
})

test('recovery follows the configured file name, not the platform default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-renamed-'))
  const binaryPath = join(dir, 'custom-client')
  writeFileSync(`${binaryPath}.backup-20260101T000000Z`, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

  recoverOrphanedBinary({ binaryPath })

  assert.equal(existsSync(binaryPath), true)
})

test('a healthy binary is never replaced by a backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-healthy-'))
  const binaryPath = join(dir, binaryFileName('darwin'))
  writeFileSync(binaryPath, 'current', { mode: 0o755 })
  writeFileSync(`${binaryPath}.backup-20260101T000000Z`, 'older', { mode: 0o755 })

  runSelfUpdate({ binaryPath, spawn: () => ({ status: 0, stdout: 'ok\n' }), log: () => {} })

  assert.equal(readFileSync(binaryPath, 'utf8'), 'current')
})

test('runSelfUpdate forwards --scheduled and reports a non-zero exit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-client-'))
  const binaryPath = join(dir, binaryFileName('darwin'))
  writeFileSync(binaryPath, '#!/bin/sh\necho "$@"\nexit 3\n', { mode: 0o755 })
  chmodSync(binaryPath, 0o755)
  const lines = []
  assert.throws(() => runSelfUpdate({ binaryPath, scheduled: true, log: (line) => lines.push(line) }), /exit code 3/)
  assert.deepEqual(lines, ['self-update --scheduled'])
})

test('downloadBytes enforces the size bound while streaming, not only after the read', async () => {
  const { downloadBytes } = await import('./client-binary.mjs')
  // A chunked body with no Content-Length: the post-read check alone would
  // have buffered the whole thing before refusing.
  const chunkSize = 1024 * 1024
  const oversized = {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: (async function* generate() {
      for (let index = 0; index < 200; index += 1) {
        yield Buffer.alloc(chunkSize, index % 256)
      }
    })()
  }
  await assert.rejects(
    () =>
      downloadBytes({
        url: 'https://example.invalid/x',
        name: 'tokenboard_darwin_amd64.tar.gz',
        fetcher: () => oversized
      }),
    /exceeds/
  )
})

// A swap killed between the two renames can leave the *staged* binary behind
// as well as the backup. The staged one is newer, but a kill during its write
// leaves a truncated file, so it is restored only after it answers `version`;
// otherwise the known-good backup wins.
test('recovery prefers a staged binary that still answers version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-staged-'))
  const binaryPath = join(dir, binaryFileName('darwin'))
  const staged = stubBinary('2.0.0')
  writeFileSync(`${binaryPath}.new`, staged, { mode: 0o755 })
  writeFileSync(`${binaryPath}.backup-20260101T000000Z`, 'old', { mode: 0o755 })

  recoverOrphanedBinary({ binaryPath })

  assert.equal(readFileSync(binaryPath, 'utf8'), staged)
  assert.equal(existsSync(`${binaryPath}.new`), false, 'the staged copy must be moved, not copied')
  assert.equal(existsSync(`${binaryPath}.backup-20260101T000000Z`), true, 'the backup is left alone')
})

test('recovery ignores a staged binary that does not run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-broken-'))
  const binaryPath = join(dir, binaryFileName('darwin'))
  writeFileSync(`${binaryPath}.new`, 'truncated', { mode: 0o755 })
  writeFileSync(`${binaryPath}.backup-20260101T000000Z`, 'previous', { mode: 0o755 })

  recoverOrphanedBinary({ binaryPath })

  assert.equal(readFileSync(binaryPath, 'utf8'), 'previous')
})

// Spec §4.1: the release tarball carries the platform's ccusage beside the
// client. A fresh install must place it where the bundled layer looks, or the
// first run falls back to a download the offline hook path cannot perform.
test('installClientBinary installs the bundled ccusage beside the client', async (t) => {
  const { baseUrl } = await withServer(t, {
    platform: 'darwin_amd64',
    version: '1.2.3',
    extraFiles: { ccusage: '#!/bin/sh\necho "ccusage 20.0.33"\n' }
  })
  const configDir = mkdtempSync(join(tmpdir(), 'tokenboard-config-'))
  const result = await installClientBinary({
    baseUrl,
    configDir,
    platform: 'darwin',
    arch: 'x64',
    log: () => {}
  })
  const bundled = join(configDir, 'bin', 'ccusage')
  assert.equal(existsSync(bundled), true, 'the bundled ccusage must be installed')
  assert.match(readFileSync(bundled, 'utf8'), /ccusage 20\.0\.33/)
  assert.equal(existsSync(join(configDir, 'client-install')), false)
})

// A malformed bundled ccusage must fail the install before the client is
// swapped in. Failing afterwards would leave a client whose install reported
// an error but which is already live — the next sync would run against a
// half-installed tree with no bundled ccusage.
test('installClientBinary refuses a malformed ccusage without installing the client', async (t) => {
  const { baseUrl } = await withServer(t, {
    platform: 'darwin_amd64',
    version: '1.2.3',
    extraFiles: { ccusage: '' }
  })
  const configDir = mkdtempSync(join(tmpdir(), 'tokenboard-config-'))
  await assert.rejects(
    installClientBinary({ baseUrl, configDir, platform: 'darwin', arch: 'x64', log: () => {} }),
    /ccusage is empty|does not contain ccusage/
  )
  assert.equal(existsSync(join(configDir, 'bin', 'tokenboard')), false, 'the client must not be installed')
})

// An older release without ccusage still installs the client; the three-layer
// acquisition covers the machine afterwards.
test('installClientBinary accepts a release without ccusage', async (t) => {
  const { baseUrl } = await withServer(t, { platform: 'darwin_amd64', version: '1.2.3' })
  const configDir = mkdtempSync(join(tmpdir(), 'tokenboard-config-'))
  const result = await installClientBinary({
    baseUrl,
    configDir,
    platform: 'darwin',
    arch: 'x64',
    log: () => {}
  })
  assert.equal(result.version, '1.2.3')
  assert.equal(existsSync(join(configDir, 'bin', 'ccusage')), false)
})

// An older release without a bundled ccusage leaves the previous one in
// place. That copy is now a version the new client was never tested against,
// so the install must say so rather than report a clean install.
test('installClientBinary warns when it leaves a stale bundled ccusage behind', async (t) => {
  const { baseUrl } = await withServer(t, { platform: 'darwin_amd64', version: '1.2.3' })
  const configDir = mkdtempSync(join(tmpdir(), 'tokenboard-config-'))
  mkdirSync(join(configDir, 'bin'), { recursive: true })
  writeFileSync(join(configDir, 'bin', 'ccusage'), '#!/bin/sh\necho "ccusage 20.0.20"\n', { mode: 0o755 })
  const lines = []
  await installClientBinary({
    baseUrl,
    configDir,
    platform: 'darwin',
    arch: 'x64',
    log: (line) => lines.push(line)
  })
  const stale = lines.find((line) => line.includes('carries no ccusage'))
  assert.ok(stale, `a stale bundled ccusage must be reported, got ${JSON.stringify(lines)}`)
  assert.match(stale, /20\.0\.20/)
})
