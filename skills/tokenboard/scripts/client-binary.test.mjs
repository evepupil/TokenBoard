import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import {
  archiveName,
  binaryFileName,
  clientBinaryPath,
  extractBinary,
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

// A test cannot ship a compiled binary, so the stub above is a POSIX shell
// script. Windows refuses to execute one — spawn fails with EFTYPE before any
// version check runs — so there the version probes are answered here while
// `tar` still runs for real. Extraction is the step that actually differs
// between platforms (GNU tar vs bsdtar, path shapes), so it stays genuine on
// every OS. On POSIX this returns undefined and every caller keeps spawnSync.
//
// A path that does not exist still fails, so a probe of a missing file keeps
// answering null instead of inventing a version.
function fixtureSpawn({ tokenboard = '1.2.3', ccusage = '20.0.20' } = {}) {
  if (process.platform !== 'win32') return undefined
  return (command, args, options) => {
    if (command === 'tar') return spawnSync(command, args, options)
    const path = String(command)
    if (!existsSync(path)) {
      const error = new Error(`spawnSync ${command} ENOENT`)
      error.code = 'ENOENT'
      return { error, status: null, stdout: '', stderr: '' }
    }
    if (basename(path).startsWith('ccusage')) {
      return { status: 0, stdout: `ccusage ${ccusage}\n`, stderr: '' }
    }
    // A script fixture cannot run on Windows, so the version the probe reads
    // comes from the file itself: read the stub's `echo "tokenboard (go) X"`
    // line. One fixed value for every path would make any recovery test that
    // compares two candidates see them as equal.
    const printed = readFileSync(path, 'utf8').match(/tokenboard \(go\) ([0-9][0-9.]*)/)
    const version = printed ? printed[1] : tokenboard
    return { status: 0, stdout: `tokenboard (go) ${version}\n`, stderr: '' }
  }
}

// buildTarball assembles a release tarball holding one executable. The real
// extraction shells out to `tar`, so the fixture is built the same way — and
// with the same shape extractBinary uses (relative archive name, cwd at the
// archive's directory): an absolute `C:\...` archive argument reads as a
// remote host to GNU tar, which is what Git for Windows puts first on PATH.
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
  const result = spawnSync('tar', ['-czf', `${name}.tar.gz`, '-C', 'staging', ...members], {
    encoding: 'utf8',
    cwd: dir
  })
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
  repo = 'evepupil/TokenBoard'
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
    response.writeHead(302, { location: '/evepupil/TokenBoard/releases/latest' })
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

test('extractBinary never hands tar an absolute path', () => {
  // An absolute `C:\...` argument reads as a remote host to GNU tar (first on
  // PATH with Git for Windows): every Windows binary install failed with
  // "Cannot connect to C: resolve failed". The archive must be named
  // relatively from its own directory; the destination must be forward-slash.
  const calls = []
  const extractDir = join(tmpdir(), 'tokenboard-extract-shape', 'out')
  const archivePath = join(tmpdir(), 'tokenboard-extract-shape', 'tokenboard_windows_amd64.tar.gz')
  try {
    extractBinary({
      archivePath,
      extractDir,
      name: binaryFileName('win32'),
      platform: 'win32',
      spawn: (command, args, options) => {
        calls.push({ command, args, options })
        writeFileSync(join(extractDir, binaryFileName('win32')), 'stub')
        return { status: 0, stdout: '', stderr: '' }
      }
    })
  } finally {
    rmSync(join(tmpdir(), 'tokenboard-extract-shape'), { recursive: true, force: true })
  }
  assert.equal(calls.length, 1)
  const { command, args, options } = calls[0]
  assert.equal(command, 'tar')
  assert.equal(args[0], '-xzf')
  assert.equal(args[1], 'tokenboard_windows_amd64.tar.gz', 'the archive must be a bare file name')
  assert.equal(options.cwd, join(tmpdir(), 'tokenboard-extract-shape'), 'tar must run from the archive directory')
  const destination = args[args.indexOf('-C') + 1]
  assert.doesNotMatch(destination, /\\/, 'the -C destination must not contain backslashes')
  assert.doesNotMatch(args[1], /^[A-Za-z]:|^\//, 'no tar argument may be an absolute path')
})

test('installClientBinary installs a verified binary and leaves no staged file', async (t) => {
  const { baseUrl } = await withServer(t, { platform: 'darwin_amd64', version: '1.2.3' })
  const configDir = mkdtempSync(join(tmpdir(), 'tokenboard-config-'))
  const result = await installClientBinary({
    baseUrl,
    configDir,
    platform: 'darwin',
    arch: 'x64',
    spawn: fixtureSpawn(),
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
    () =>
      installClientBinary({
        baseUrl,
        configDir,
        platform: 'darwin',
        arch: 'x64',
        // The stub answers 9.9.9 while the release tag says 1.2.3, so the
        // mismatch — not an unrunnable fixture — is what must reject.
        spawn: fixtureSpawn({ tokenboard: '9.9.9' }),
        log: () => {}
      }),
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
  // POSIX runs the stub and reads what it echoed; Windows cannot execute it,
  // so the recorder answers instead — the argv and exit code are the subject.
  const calls = []
  const recorder =
    fixtureSpawn() === undefined
      ? undefined
      : (command, args) => {
          calls.push({ command, args })
          return { status: 3, stdout: `${args.join(' ')}\n`, stderr: '' }
        }
  assert.throws(
    () => runSelfUpdate({ binaryPath, scheduled: true, spawn: recorder, log: (line) => lines.push(line) }),
    /exit code 3/
  )
  assert.deepEqual(lines, ['self-update --scheduled'])
  if (recorder !== undefined) {
    assert.deepEqual(calls, [{ command: binaryPath, args: ['self-update', '--scheduled'] }])
  }
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

// The asset download is the hop that carries the tarball and its checksums.
// Letting fetch follow redirects to any host would let a redirect chain serve
// both from somewhere the release page never named; the Go client pins the
// same way (release.sameRedirectHost).
test('downloadBytes refuses a redirect that leaves the release host', async () => {
  const { downloadBytes } = await import('./client-binary.mjs')
  const seen = []
  const fetcher = (url, options) => {
    seen.push({ url, redirect: options?.redirect })
    return {
      ok: false,
      status: 302,
      headers: { get: () => 'https://evil.example/tokenboard.tar.gz' },
      body: null
    }
  }

  await assert.rejects(
    () =>
      downloadBytes({
        url: 'https://github.com/MisonL/TokenBoard/releases/download/v1/tokenboard.tar.gz',
        name: 'tokenboard.tar.gz',
        fetcher
      }),
    /not the release host/
  )
  // The redirect is inspected by hand, never followed implicitly.
  assert.equal(seen[0].redirect, 'manual')
  assert.equal(seen.length, 1)
})

test('downloadBytes follows a redirect to the GitHub asset CDN', async () => {
  const { downloadBytes } = await import('./client-binary.mjs')
  const body = (async function* generate() {
    yield Buffer.from('tarball')
  })()
  const responses = [
    {
      ok: false,
      status: 302,
      headers: { get: () => 'https://objects.githubusercontent.com/assets/x' },
      body: null
    },
    { ok: true, status: 200, headers: { get: () => null }, body }
  ]
  let calls = 0
  const data = await downloadBytes({
    url: 'https://github.com/MisonL/TokenBoard/releases/download/v1/tokenboard.tar.gz',
    name: 'tokenboard.tar.gz',
    fetcher: () => responses[calls++]
  })
  assert.equal(data.toString(), 'tarball')
  assert.equal(calls, 2)
})

// Retry classification is a cross-language contract: Go's
// release.isRetryableStatus retries 429 and every 5xx except 501 and 505, and
// treats the rest as the release not existing. One side retrying what the
// other gives up on would show up as installs that work on one client and not
// the other against the same server.
for (const [status, attempts] of [
  [429, 3],
  [500, 3],
  [503, 3],
  [501, 1],
  [505, 1],
  [404, 1],
  [403, 1]
]) {
  test(`downloadBytes retries based on HTTP ${status} exactly like the Go client`, async () => {
    const { downloadBytes } = await import('./client-binary.mjs')
    let calls = 0
    const fetcher = () => {
      calls += 1
      return Promise.resolve({ ok: false, status, headers: { get: () => null }, body: null })
    }

    await assert.rejects(
      () =>
        downloadBytes({
          url: 'https://github.com/MisonL/TokenBoard/releases/download/v1/tokenboard.tar.gz',
          name: 'tokenboard.tar.gz',
          fetcher,
          retryDelayMs: 1
        }),
      new RegExp(`returned HTTP ${status}`)
    )
    assert.equal(calls, attempts)
  })
}

// A 304 is a cache answer, not a redirection, even when it carries a Location.
// Go's net/http only follows 301/302/303/307/308; following this one here would
// let the two clients disagree about what the same server answer means.
test('downloadBytes does not treat a non-redirect 3xx as a redirect', async () => {
  const { downloadBytes } = await import('./client-binary.mjs')
  const seen = []
  const fetcher = (url) => {
    seen.push(url)
    return {
      ok: false,
      status: 304,
      headers: { get: () => 'https://github.com/MisonL/TokenBoard/releases/tag/v1' },
      body: null
    }
  }

  await assert.rejects(
    () =>
      downloadBytes({
        url: 'https://github.com/MisonL/TokenBoard/releases/download/v1/tokenboard.tar.gz',
        name: 'tokenboard.tar.gz',
        fetcher,
        maxAttempts: 1
      }),
    /returned HTTP 304/
  )
  assert.equal(seen.length, 1)
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

  recoverOrphanedBinary({ binaryPath, spawn: fixtureSpawn({ tokenboard: '2.0.0' }) })

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

// Backups written by the current release carry a sequence suffix
// (`<stamp>-000001`) so two swaps in the same second cannot collide. The newer
// stamp is still the one restored: the suffix only breaks ties inside a second.
test('recovery picks the newest backup across both name shapes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-shapes-'))
  const binaryPath = join(dir, binaryFileName('darwin'))
  writeFileSync(`${binaryPath}.backup-20251231T235959Z`, 'legacy old', { mode: 0o755 })
  writeFileSync(`${binaryPath}.backup-20260101T000000Z-000001`, 'newer first', { mode: 0o755 })
  writeFileSync(`${binaryPath}.backup-20260101T000000Z-000002`, 'newer second', { mode: 0o755 })

  recoverOrphanedBinary({ binaryPath })

  assert.equal(readFileSync(binaryPath, 'utf8'), 'newer second')
})

// An earlier binary written by a release that knew no sequence still sorts
// before this release's name for the same second.
test('the sequence suffix sorts after a plain backup of the same second', () => {
  const sorted = ['tokenboard.backup-20260101T000000Z', 'tokenboard.backup-20260101T000000Z-000001'].sort()
  assert.equal(sorted.at(-1), 'tokenboard.backup-20260101T000000Z-000001')
})

// A release archive that happens to carry a ccusage member no longer has it
// installed: the client collects in process since S5 and would never read it.
test('installClientBinary ignores a ccusage member in the archive', async (t) => {
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
    spawn: fixtureSpawn(),
    log: () => {}
  })
  assert.equal(result.version, '1.2.3')
  assert.equal(existsSync(join(configDir, 'bin', 'ccusage')), false, 'the archive member must not be installed')
  assert.equal(existsSync(join(configDir, 'bin', 'tokenboard')), true)
})

// A ccusage copy an earlier release installed is left in place untouched and
// the install says so once, with the same wording the Go self-update uses.
test('installClientBinary reports the ccusage an earlier release left behind', async (t) => {
  const { baseUrl } = await withServer(t, { platform: 'darwin_amd64', version: '1.2.3' })
  const configDir = mkdtempSync(join(tmpdir(), 'tokenboard-config-'))
  mkdirSync(join(configDir, 'bin'), { recursive: true })
  const stalePath = join(configDir, 'bin', 'ccusage')
  writeFileSync(stalePath, '#!/bin/sh\necho "ccusage 20.0.20"\n', { mode: 0o755 })
  const lines = []
  await installClientBinary({
    baseUrl,
    configDir,
    platform: 'darwin',
    arch: 'x64',
    spawn: fixtureSpawn(),
    log: (line) => lines.push(line)
  })
  const stale = lines.find((line) => line.includes('no longer bundles or uses ccusage'))
  assert.ok(stale, `a left-behind ccusage must be reported, got ${JSON.stringify(lines)}`)
  assert.ok(stale.includes(stalePath), `the report must name ${stalePath}, got ${stale}`)
  // Left in place means untouched, and never executed by the install.
  assert.match(readFileSync(stalePath, 'utf8'), /ccusage 20\.0\.20/)
})

// The bootstrap installer stages the same `<binary>.new` Go's `self-update`
// does, so it takes the same lock file in the state directory. A self-update
// holding it means an install would race the swap: the install yields with a
// clear error instead of deleting the other run's staged file.
test('installClientBinary yields while a self-update holds its lock', async (t) => {
  const { baseUrl } = await withServer(t, { platform: 'darwin_amd64', version: '1.2.3' })
  const configDir = mkdtempSync(join(tmpdir(), 'tokenboard-config-locked-'))
  t.after(() => rmSync(configDir, { recursive: true, force: true }))
  // A lock owned by this process looks live; it is released in the cleanup.
  const { acquireLock, releaseLock } = await import('./coordinator-lock.mjs')
  const { stateLockRuntime } = await import('./state-lock-runtime.mjs')
  const runtime = stateLockRuntime({ lockTimeoutMs: 50 })
  const owner = acquireLock(join(configDir, 'self-update.lock'), runtime)
  t.after(() => releaseLock(join(configDir, 'self-update.lock'), runtime, owner))

  await assert.rejects(
    () =>
      installClientBinary({
        baseUrl,
        configDir,
        platform: 'darwin',
        arch: 'x64',
        spawn: fixtureSpawn(),
        log: () => {}
      }),
    /self-update/
  )
  assert.equal(
    existsSync(join(configDir, 'bin', 'tokenboard')),
    false,
    'nothing may be installed while the lock is held'
  )
})

// A stalled transfer must fail, not hang the install forever. The installer
// now holds self-update.lock while it downloads, so an unbounded fetch would
// also block every scheduled self-update behind it.
test('downloadBytes aborts a transfer that stalls past its budget', async () => {
  const { downloadBytes } = await import('./client-binary.mjs')
  let activeSignal
  // A body that never produces a chunk unless the signal fires: an unbounded
  // read would hang the test forever, which is precisely the bug.
  const body = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return new Promise((resolve, reject) => {
            activeSignal.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              {
                once: true
              }
            )
          })
        }
      }
    }
  }
  const fetcher = (url, options) => {
    activeSignal = options?.signal
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, body })
  }
  await assert.rejects(
    () =>
      downloadBytes({
        url: 'https://github.com/MisonL/TokenBoard/releases/download/v1/tokenboard.tar.gz',
        name: 'tokenboard.tar.gz',
        fetcher,
        timeoutMs: 50,
        maxAttempts: 1
      }),
    /timed out|abort/i
  )
  assert.ok(activeSignal, 'the request must carry an abort signal')
})

// A transient failure (dropped connection) is retried; the install is a
// one-off, and a single blip should not send the operator back to square one.
test('downloadBytes retries a transient failure', async () => {
  const { downloadBytes } = await import('./client-binary.mjs')
  let calls = 0
  const fetcher = () => {
    calls += 1
    if (calls === 1) return Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
    const body = (async function* generate() {
      yield Buffer.from('complete')
    })()
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, body })
  }
  const data = await downloadBytes({
    url: 'https://github.com/MisonL/TokenBoard/releases/download/v1/tokenboard.tar.gz',
    name: 'tokenboard.tar.gz',
    fetcher,
    retryDelayMs: 1
  })
  assert.equal(data.toString(), 'complete')
  assert.equal(calls, 2)
})

// A 404 is the release not existing; retrying it only delays the failure.
test('downloadBytes does not retry a permanent failure', async () => {
  const { downloadBytes } = await import('./client-binary.mjs')
  let calls = 0
  const fetcher = () => {
    calls += 1
    return Promise.resolve({ ok: false, status: 404, headers: { get: () => null }, body: null })
  }
  await assert.rejects(
    () =>
      downloadBytes({
        url: 'https://github.com/MisonL/TokenBoard/releases/download/v1/tokenboard.tar.gz',
        name: 'tokenboard.tar.gz',
        fetcher,
        retryDelayMs: 1
      }),
    /HTTP 404/
  )
  assert.equal(calls, 1)
})

// A timeout is not retried. The installer holds self-update.lock while it
// downloads, so retrying a stalled transfer multiplies the time it blocks
// every scheduled self-update: three 120s budgets beat a fast, honest failure.
test('downloadBytes does not retry a timeout', async () => {
  const { downloadBytes } = await import('./client-binary.mjs')
  let calls = 0
  let activeSignal
  const body = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return new Promise((resolve, reject) => {
            activeSignal.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              {
                once: true
              }
            )
          })
        }
      }
    }
  }
  const fetcher = (url, options) => {
    calls += 1
    activeSignal = options?.signal
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, body })
  }
  await assert.rejects(
    () =>
      downloadBytes({
        url: 'https://github.com/MisonL/TokenBoard/releases/download/v1/tokenboard.tar.gz',
        name: 'tokenboard.tar.gz',
        fetcher,
        timeoutMs: 30,
        retryDelayMs: 1
      }),
    /timed out/i
  )
  assert.equal(calls, 1, 'a timeout must fail on the first attempt')
})

// A `.new` left by a failed *older* download runs fine, so "answers version"
// alone would restore it over a newer backup and roll the client back. The
// staged copy is taken only when it is at least as new as the backup.
test('recovery prefers a newer backup over a runnable but older staged binary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-stale-staged-'))
  const binaryPath = join(dir, binaryFileName('darwin'))
  writeFileSync(`${binaryPath}.new`, stubBinary('0.1.9'), { mode: 0o755 })
  writeFileSync(`${binaryPath}.backup-20260101T000000Z-000001`, stubBinary('0.2.0'), { mode: 0o755 })
  const lines = []

  recoverOrphanedBinary({
    binaryPath,
    spawn: fixtureSpawn({ tokenboard: '0.2.0' }),
    log: (line) => lines.push(line)
  })

  assert.match(readFileSync(binaryPath, 'utf8'), /0\.2\.0/, 'the newer backup must be restored')
  assert.equal(existsSync(`${binaryPath}.new`), false, 'the stale staged copy must be dropped')
})

// The staged copy an interrupted update was installing is newer than the
// backup beside it, and it still wins.
test('recovery still prefers a staged binary newer than the backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-newer-staged-'))
  const binaryPath = join(dir, binaryFileName('darwin'))
  writeFileSync(`${binaryPath}.new`, stubBinary('0.3.0'), { mode: 0o755 })
  writeFileSync(`${binaryPath}.backup-20260101T000000Z-000001`, stubBinary('0.2.0'), { mode: 0o755 })

  recoverOrphanedBinary({ binaryPath, spawn: fixtureSpawn({ tokenboard: '0.3.0' }) })

  assert.match(readFileSync(binaryPath, 'utf8'), /0\.3\.0/, 'the staged copy must be restored')
  assert.equal(existsSync(`${binaryPath}.backup-20260101T000000Z-000001`), true, 'the backup is left alone')
})

// The installer holds self-update.lock while it resolves the tag, so a
// lookup that never answers must fail on its own budget rather than block
// every scheduled self-update behind it.
test('latestTag fails on its own budget when the lookup hangs', async () => {
  const { latestTag } = await import('./client-binary.mjs')
  const fetcher = (url, options) =>
    new Promise((resolve, reject) => {
      options?.signal?.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        {
          once: true
        }
      )
      void resolve
    })
  await assert.rejects(
    () => latestTag({ repo: 'owner/repo', baseUrl: 'https://github.com', fetcher, lookupTimeoutMs: 30 }),
    /lookup timed out/
  )
})

// A lookup that answers normally is unaffected by the budget.
test('latestTag follows the redirect when the lookup answers', async () => {
  const { latestTag } = await import('./client-binary.mjs')
  const responses = [
    { status: 302, headers: new Map([['location', 'https://github.com/owner/repo/releases/tag/v1.2.3']]) },
    { status: 200, headers: new Map() }
  ]
  let calls = 0
  const tag = await latestTag({
    repo: 'owner/repo',
    baseUrl: 'https://github.com',
    fetcher: () => Promise.resolve(responses[calls++]),
    lookupTimeoutMs: 1000
  })
  assert.equal(tag, 'v1.2.3')
})

// runSelfUpdate is a second recovery entry, reached from the upgrade path of a
// process whose hook run does not hold sync.lock. It must not recover while a
// Go swap holds self-update.lock, or it could move that swap's backup away.
test('runSelfUpdate does not recover while a self-update holds the lock', async () => {
  const { runSelfUpdate } = await import('./client-binary.mjs')
  const { acquireLock, releaseLock } = await import('./coordinator-lock.mjs')
  const { selfUpdateLockFileName, stateLockRuntime } = await import('./state-lock-runtime.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-runselfupdate-lock-'))
  const binaryPath = join(dir, 'tokenboard')
  writeFileSync(`${binaryPath}.backup-20260101T000000Z-000001`, 'previous', { mode: 0o755 })
  const runtime = stateLockRuntime({ lockTimeoutMs: 0 })
  const owner = acquireLock(join(dir, selfUpdateLockFileName), runtime)
  const lines = []

  assert.throws(
    () =>
      runSelfUpdate({
        binaryPath,
        env: { TOKENBOARD_STATE_DIR: dir },
        log: (l) => lines.push(l),
        spawn: () => ({ status: 0 })
      }),
    /not installed/
  )
  releaseLock(join(dir, selfUpdateLockFileName), runtime, owner)

  assert.equal(existsSync(binaryPath), false, 'recovery must not have run while the lock was held')
  assert.match(lines.join('\n'), /self-update holds/)
})

// With the lock free, runSelfUpdate still recovers a missing binary.
test('runSelfUpdate recovers a missing binary when no update holds the lock', async () => {
  const { runSelfUpdate } = await import('./client-binary.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-runselfupdate-free-'))
  const binaryPath = join(dir, 'tokenboard')
  writeFileSync(`${binaryPath}.backup-20260101T000000Z-000001`, stubBinary('0.2.0'), { mode: 0o755 })

  runSelfUpdate({
    binaryPath,
    env: { TOKENBOARD_STATE_DIR: dir },
    log: () => {},
    spawn: () => ({ status: 0, stdout: '', stderr: '' })
  })

  assert.equal(existsSync(binaryPath), true, 'the backup must have been restored')
})

// A staged copy whose version cannot be read is not proof it is current. The
// known backup wins: restoring an unidentifiable file could roll the client
// back with no way to tell.
test('recovery keeps the backup when the staged version cannot be read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-unreadable-staged-'))
  const binaryPath = join(dir, binaryFileName('darwin'))
  writeFileSync(`${binaryPath}.new`, stubBinary('9.9.9'), { mode: 0o755 })
  writeFileSync(`${binaryPath}.backup-20260101T000000Z-000001`, stubBinary('0.2.0'), { mode: 0o755 })
  // The staged probe answers success but prints no parseable version.
  const spawn = (command) => {
    const text = readFileSync(String(command), 'utf8')
    if (String(command).endsWith('.new')) return { status: 0, stdout: 'no version here\n', stderr: '' }
    return { status: 0, stdout: text.includes('0.2.0') ? 'tokenboard (go) 0.2.0\n' : 'no version here\n', stderr: '' }
  }

  recoverOrphanedBinary({ binaryPath, spawn, log: () => {} })

  assert.match(readFileSync(binaryPath, 'utf8'), /0\.2\.0/, 'the known backup must be restored')
})

// A recovery that cannot rename (a read-only directory) must not throw past
// runSelfUpdate: the caller needs "not installed", the actionable fact, and the
// next run retries. The failure is reported, not swallowed.
test('runSelfUpdate reports a failed recovery instead of throwing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-recovery-eacces-'))
  const binaryPath = join(dir, 'tokenboard')
  writeFileSync(`${binaryPath}.backup-20260101T000000Z-000001`, 'prev', { mode: 0o755 })
  const lines = []

  assert.throws(
    () =>
      runSelfUpdate({
        binaryPath,
        env: { TOKENBOARD_STATE_DIR: dir },
        log: (l) => lines.push(l),
        // A rename that fails the way a read-only directory does.
        rename: () => {
          const error = new Error('EACCES: permission denied')
          error.code = 'EACCES'
          throw error
        },
        spawn: () => ({ status: 0, stdout: '', stderr: '' })
      }),
    /not installed/,
    'the run must report the missing binary, not the recovery error'
  )
  assert.equal(
    lines.some((l) => /recovery failed/.test(l)),
    true,
    'the recovery failure must be logged'
  )
})

// The installer extracts with the platform's tar, so the refusals Go's
// extractBinary makes by hand have to be made here too: an archive that does
// not carry the executable, or whose entry is not a non-empty file, must not
// produce a staged binary.
test('the installer refuses an archive without the executable', async () => {
  const { extractBinary } = await import('./client-binary.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-nobin-'))
  const archive = join(dir, 'release.tar.gz')
  writeFileSync(archive, buildTarball(dir, 'README.md', 'docs'))
  assert.throws(
    () => extractBinary({ archivePath: archive, extractDir: join(dir, 'x'), name: 'tokenboard', log: () => {} }),
    /does not contain tokenboard/
  )
})

test('the installer refuses an empty executable entry', async () => {
  const { extractBinary } = await import('./client-binary.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-emptybin-'))
  const archive = join(dir, 'release.tar.gz')
  writeFileSync(archive, buildTarball(dir, 'tokenboard', ''))
  assert.throws(
    () => extractBinary({ archivePath: archive, extractDir: join(dir, 'x'), name: 'tokenboard', log: () => {} }),
    /is empty/
  )
})

test('latestTag does not treat a non-redirect 3xx as a redirect', async () => {
  const { latestTag } = await import('./client-binary.mjs')
  const seen = []
  const fetcher = (url) => {
    seen.push(url)
    return Promise.resolve({
      status: 304,
      headers: new Map([['location', 'https://github.com/o/r/releases/tag/v1']])
    })
  }

  await assert.rejects(() => latestTag({ repo: 'o/r', baseUrl: 'https://github.com', fetcher }), /returned HTTP 304/)
  assert.equal(seen.length, 1)
})

// A 3xx without a Location, and a redirect that lands on a page that is not a
// release tag, must both be refused: following either leaves the installer with
// no tag to download from. Go's latestTag draws the same lines.
test('latestTag refuses a redirect without a Location', async () => {
  const { latestTag } = await import('./client-binary.mjs')
  const fetcher = () => Promise.resolve({ status: 302, headers: new Map() })
  await assert.rejects(() => latestTag({ repo: 'o/r', baseUrl: 'https://github.com', fetcher }), /without a Location/)
})

test('latestTag refuses a page that is not a release tag', async () => {
  const { latestTag } = await import('./client-binary.mjs')
  const fetcher = () => Promise.resolve({ status: 200, headers: new Map() })
  await assert.rejects(
    () => latestTag({ repo: 'o/r', baseUrl: 'https://github.com', fetcher }),
    /did not land on a tag page/
  )
})

// On Windows a scanner holds a freshly written file long enough for rename to
// answer EPERM. Recovery must retry that, the same way the state writes do
// through rename-atomic.ts, or an update that was about to succeed fails.
test('recovery retries a transiently busy rename', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-busy-rename-'))
  const binaryPath = join(dir, binaryFileName('darwin'))
  writeFileSync(`${binaryPath}.backup-20260101T000000Z-000001`, '#!/bin/sh\necho "tokenboard (go) 0.2.0"\n', {
    mode: 0o755
  })
  let attempts = 0
  const rename = (from, to) => {
    attempts += 1
    if (attempts === 1) {
      const error = new Error('EBUSY: resource busy or locked')
      error.code = 'EBUSY'
      throw error
    }
    renameSync(from, to)
  }

  recoverOrphanedBinary({ binaryPath, spawn: () => ({ status: 0, stdout: 'tokenboard (go) 0.2.0\n' }), rename })

  assert.equal(attempts, 2, 'the busy rename is retried once')
  assert.equal(existsSync(binaryPath), true, 'the binary is back in place')
})

// A permanent rename error (a read-only directory) is not retried: retrying
// cannot clear it, and each attempt costs the caller a delay.
test('recovery does not retry a permanent rename failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-eacces-rename-'))
  const binaryPath = join(dir, binaryFileName('darwin'))
  writeFileSync(`${binaryPath}.backup-20260101T000000Z-000001`, '#!/bin/sh\necho "tokenboard (go) 0.2.0"\n', {
    mode: 0o755
  })
  let attempts = 0
  const rename = () => {
    attempts += 1
    const error = new Error('EACCES: permission denied')
    error.code = 'EACCES'
    throw error
  }

  assert.throws(
    () =>
      recoverOrphanedBinary({ binaryPath, spawn: () => ({ status: 0, stdout: 'tokenboard (go) 0.2.0\n' }), rename }),
    /EACCES/
  )
  assert.equal(attempts, 1, 'a permanent failure is not retried')
})

// A directory that cannot be listed is not a directory with no backups. If
// recovery answered "none" here, a runnable but older `.new` would win over a
// newer backup it could not see — the rollback this comparison exists to stop.
test('recovery does not treat an unlistable directory as having no backups', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-unlistable-'))
  const binaryPath = join(dir, binaryFileName('darwin'))
  writeFileSync(`${binaryPath}.new`, stubBinary('0.1.9'), { mode: 0o755 })
  const error = new Error('EACCES: permission denied')
  error.code = 'EACCES'

  assert.throws(
    () =>
      recoverOrphanedBinary({
        binaryPath,
        spawn: () => ({ status: 0, stdout: 'tokenboard (go) 0.1.9\n' }),
        readDir: () => {
          throw error
        }
      }),
    /EACCES/
  )
  assert.equal(existsSync(binaryPath), false, 'nothing may be restored from an unknown directory')
})
