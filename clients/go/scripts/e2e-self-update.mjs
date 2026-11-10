// End-to-end check for the binary client's upgrade path (spec §9 M6):
// serve a release the way GitHub does, run `tokenboard self-update` against
// it, and assert the client swapped itself, kept a backup, treats a second
// run as a no-op, and leaves a ccusage copy from an earlier release alone.
//
// Run after `goreleaser release --snapshot`:
//
//	node clients/go/scripts/e2e-self-update.mjs
//
// The release asset is rebuilt with the tag's version stamped in, because
// self-update verifies that the downloaded binary answers with the version
// it is updating to — a snapshot archive reports 0.0.0-SNAPSHOT-<sha> and is
// correctly refused.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const goDir = join(repoRoot, 'clients', 'go')
const tag = 'v9.9.9'
const version = '9.9.9'
const goos = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform]
if (goos === undefined) {
  console.error(`unsupported platform: ${process.platform}`)
  process.exit(2)
}
const goarch = process.arch === 'arm64' ? 'arm64' : 'amd64'
const archiveName = `tokenboard_${goos}_${goarch}.tar.gz`
const clientName = goos === 'windows' ? 'tokenboard.exe' : 'tokenboard'
const ccusageName = goos === 'windows' ? 'ccusage.exe' : 'ccusage'

const root = mkdtempSync(join(tmpdir(), 'tokenboard-e2e-'))
const cleanup = () => rmSync(root, { recursive: true, force: true })

try {
  // A release asset is a binary stamped with the version it publishes.
  const staged = join(root, 'stage')
  mkdirSync(staged, { recursive: true })
  execFileSync(
    'go',
    [
      'build',
      '-o',
      join(staged, clientName),
      '-ldflags',
      `-X github.com/MisonL/TokenBoard/clients/go/internal/cli.Version=${version}`,
      './cmd/tokenboard'
    ],
    {
      cwd: goDir,
      stdio: 'inherit'
    }
  )
  copyFileSync(join(repoRoot, 'README.md'), join(staged, 'README.md'))

  const releaseDir = join(root, 'MisonL', 'TokenBoard', 'releases', 'download', tag)
  mkdirSync(releaseDir, { recursive: true })
  execFileSync('tar', ['-czf', join(releaseDir, archiveName), '-C', staged, '.'])
  const digest = createHash('sha256')
    .update(readFileSync(join(releaseDir, archiveName)))
    .digest('hex')
  writeFileSync(join(releaseDir, 'checksums.txt'), `${digest}  ${archiveName}\n`)

  const hits = []
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    hits.push(path)
    // GitHub answers /releases/latest with a redirect to the tag page; the
    // client follows it instead of calling the rate-limited api.github.com.
    if (path === '/MisonL/TokenBoard/releases/latest') {
      response.writeHead(302, { location: `/MisonL/TokenBoard/releases/tag/${tag}` })
      response.end()
      return
    }
    if (path.startsWith('/MisonL/TokenBoard/releases/tag/')) {
      response.writeHead(200)
      response.end('<html>tag</html>')
      return
    }
    const file = join(root, decodeURIComponent(path))
    if (!existsSync(file)) {
      response.writeHead(404)
      response.end('missing')
      return
    }
    response.writeHead(200)
    response.end(readFileSync(file))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const binDir = join(root, 'bin')
  const configDir = join(root, 'config')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(join(configDir, 'bin'), { recursive: true })
  // A pre-S5 install left a ccusage copy beside the client. The update must
  // not touch it, and must say so once rather than reporting a bundled install.
  const legacyCcusage = join(configDir, 'bin', ccusageName)
  writeFileSync(legacyCcusage, '#!/bin/sh\necho "ccusage 20.0.33 (left by an earlier release)"\n')
  chmodSync(legacyCcusage, 0o755)
  const client = join(binDir, clientName)
  // Install the "previous release": the snapshot binary from dist/, whose
  // version differs from the one being served.
  copyFileSync(join(repoRoot, 'dist', archiveName), join(root, 'seed.tar.gz'))
  execFileSync('tar', ['-xzf', join(root, 'seed.tar.gz'), '-C', binDir, clientName])
  chmodSync(client, 0o755)
  const before = execFileSync(client, ['version'], { encoding: 'utf8' }).trim()
  console.log(`installed client reports: ${before}`)

  // The child is spawned asynchronously: spawnSync would block the event loop
  // that has to answer its HTTP requests.
  const runSelfUpdate = () =>
    new Promise((resolve) => {
      const child = spawn(client, ['self-update'], {
        env: {
          ...process.env,
          TOKENBOARD_RELEASE_BASE_URL: `http://127.0.0.1:${port}`,
          TOKENBOARD_RELEASE_REPO: 'MisonL/TokenBoard',
          TOKENBOARD_CONFIG_DIR: configDir
        }
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => (stdout += chunk))
      child.stderr.on('data', (chunk) => (stderr += chunk))
      child.on('close', (status) => resolve({ status, stdout, stderr }))
    })

  const fail = (message) => {
    console.error(`e2e-self-update: ${message}`)
    cleanup()
    process.exit(1)
  }

  const first = await runSelfUpdate()
  if (first.status !== 0) fail(`self-update exited ${first.status}: ${first.stderr.trim()}`)
  const after = execFileSync(client, ['version'], { encoding: 'utf8' }).trim()
  if (!after.endsWith(` ${version}`)) fail(`version after update = ${after}, want the published ${version}`)
  const backups = readdirSync(binDir).filter((entry) => entry.includes('.backup-'))
  if (backups.length !== 1) fail(`expected exactly one backup, found ${backups.length}`)

  const leftovers = readFileSync(legacyCcusage, 'utf8')
  if (!leftovers.includes('left by an earlier release')) {
    fail('self-update replaced the ccusage copy an earlier release installed')
  }
  if (!first.stderr.includes('no longer bundles or uses ccusage')) {
    fail(`self-update did not report the ccusage copy it left in place: ${first.stderr.trim()}`)
  }

  // Already at the published version: the second run must not re-download.
  const downloadsBefore = hits.filter((path) => path.includes('/releases/download/')).length
  const second = await runSelfUpdate()
  if (second.status !== 0) fail(`second self-update exited ${second.status}: ${second.stderr.trim()}`)
  const downloadsAfter = hits.filter((path) => path.includes('/releases/download/')).length
  if (downloadsAfter !== downloadsBefore) fail('the second run downloaded an archive it did not need')

  console.log(`self-update: ${before} -> ${after}, backup kept, legacy ccusage left in place, second run a no-op`)
  server.close()
  cleanup()
} catch (error) {
  cleanup()
  throw error
}
