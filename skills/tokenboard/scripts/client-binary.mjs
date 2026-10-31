// Binary client support (spec §8): a clean machine installs the release
// tarball once, and every later upgrade is the Go binary's own
// `self-update`.
//
// The download path here is the bootstrap only — it exists because the very
// first install has no binary to run `self-update` with. Everything after that
// belongs to `internal/release` + `internal/selfupdate`, which carry the same
// three rules this file implements and must stay in step with:
//   - the latest tag is found by following `/releases/latest`, never by
//     calling the rate-limited REST API;
//   - a release without a checksums manifest is refused, not installed;
//   - the previous binary is kept until the new one has answered `version`.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { scrubbedChildEnv } from './child-env.mjs'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { errorMessage } from './error-message.mjs'
import { redactUrlCredentials } from './redact-credentials.mjs'

export const defaultReleaseRepo = 'MisonL/TokenBoard'
export const defaultReleaseBaseUrl = 'https://github.com'

// Bounds mirror internal/release: a few megabytes of binary, capped so a
// redirect to something else cannot fill the disk.
const maxDownloadBytes = 128 * 1024 * 1024
const maxRedirects = 5
const childOutputMaxBuffer = 64 * 1024 * 1024
// A binary that cannot answer `version` must not hang the caller: the staged-file probe runs
// inside the sync lock, so an unbounded wait there holds sync.lock until the process dies.
// Go's selfupdate uses the same 10s bound; this is the git-side counterpart.
const versionProbeTimeoutMs = 10_000

export function binaryFileName(platform = process.platform) {
  return platform === 'win32' ? 'tokenboard.exe' : 'tokenboard'
}

// clientBinaryPath is where the skill installs the binary: the config
// directory's own bin/, which is `~/.tokenboard/bin` for a default install.
export function clientBinaryPath({ configDir, platform = process.platform }) {
  return join(configDir, 'bin', binaryFileName(platform))
}

// releasePlatform maps Node's platform/arch spellings onto the GOOS/GOARCH
// names the release assets use. Anything else has no published build.
export function releasePlatform(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'windows' : platform
  if (os !== 'darwin' && os !== 'linux' && os !== 'windows') {
    throw new Error(`TokenBoard has no release for ${platform}/${arch}`)
  }
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`TokenBoard has no release for ${platform}/${arch}`)
  }
  return `${os}_${arch === 'x64' ? 'amd64' : arch}`
}

export function archiveName(suffix) {
  return `tokenboard_${suffix}.tar.gz`
}

export function checksumsName() {
  return 'checksums.txt'
}

export function versionOf(tag) {
  const trimmed = String(tag ?? '').trim()
  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed
}

// tagFromURL pulls the tag out of a `/releases/tag/<tag>` page URL.
export function tagFromURL(pageUrl) {
  const marker = '/releases/tag/'
  const index = String(pageUrl).indexOf(marker)
  if (index < 0) return ''
  const raw = String(pageUrl)
    .slice(index + marker.length)
    .split(/[?#]/)[0]
  const decoded = decodeURIComponent(raw)
  return decoded
}

// resolveRelease returns the tag and the two download URLs an install needs.
// An explicit tag skips the lookup, so a pinned release installs even when the
// latest-release page is unreachable.
export async function resolveRelease({
  repo = defaultReleaseRepo,
  tag,
  baseUrl = defaultReleaseBaseUrl,
  platform = process.platform,
  arch = process.arch,
  fetcher = fetch
} = {}) {
  const suffix = releasePlatform(platform, arch)
  const root = String(baseUrl).replace(/\/+$/, '')
  let resolvedTag = typeof tag === 'string' ? tag.trim() : ''
  if (!resolvedTag) {
    resolvedTag = await latestTag({ repo, baseUrl: root, fetcher })
  }
  if (!resolvedTag) {
    throw new Error('TokenBoard release tag is empty')
  }
  const downloadBase = `${root}/${repo}/releases/download/${encodeURIComponent(resolvedTag)}`
  return {
    tag: resolvedTag,
    version: versionOf(resolvedTag),
    archive: { name: archiveName(suffix), url: `${downloadBase}/${archiveName(suffix)}` },
    checksums: { name: checksumsName(), url: `${downloadBase}/${checksumsName()}` }
  }
}

// latestTag follows the releases-latest redirect to the tag page. Redirects
// are followed by hand so a loop is reported instead of walked, and so the
// request never depends on the anonymous REST quota.
export async function latestTag({ repo, baseUrl, fetcher = fetch }) {
  let current = `${baseUrl}/${repo}/releases/latest`
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetcher(current, { redirect: 'manual' })
    if (response.status === 404) {
      throw new Error(`TokenBoard release lookup returned HTTP 404 for ${repo}`)
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) {
        throw new Error(`TokenBoard release lookup returned HTTP ${response.status} without a Location`)
      }
      current = new URL(location, current).toString()
      continue
    }
    if (response.status !== 200) {
      throw new Error(`TokenBoard release lookup returned HTTP ${response.status}`)
    }
    const tag = tagFromURL(current)
    if (!tag) {
      throw new Error('TokenBoard release lookup did not land on a tag page')
    }
    return tag
  }
  throw new Error(`TokenBoard release lookup redirected more than ${maxRedirects} times`)
}

// releaseRedirectHosts are the hosts a GitHub release download may land on:
// the origin itself and the asset CDN GitHub redirects to. Same rule the Go
// client's internal/release applies, so both installers trust the same hops.
const releaseRedirectHosts = ['objects.githubusercontent.com', 'release-assets.githubusercontent.com']

// sameRedirectHost keeps the port: hostname alone would treat two servers on
// the same address (a proxy, a test server, a local mirror) as one host.
function sameRedirectHost(origin, target) {
  if (origin.host.toLowerCase() === target.host.toLowerCase()) return true
  return releaseRedirectHosts.includes(target.hostname.toLowerCase())
}

// downloadBytes fetches an asset into memory, bounded the same way
// internal/release bounds its downloads.
//
// The bound is enforced while reading, not after: a host that answers with a
// chunked body and no Content-Length would otherwise be buffered in full
// before the size check could refuse it.
//
// Redirects are followed by hand and pinned to the release host. A caller that
// let fetch follow them would accept a chain to an arbitrary host — the tarball
// and its checksums cannot vouch for each other when both arrive from a host
// the release page never named.
export async function downloadBytes({ url, name, fetcher = fetch }) {
  const origin = new URL(url)
  let current = origin
  let response
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    response = await fetcher(current.toString(), { redirect: 'manual' })
    if (response.status < 300 || response.status >= 400) break
    const location = response.headers?.get?.('location')
    if (!location) {
      throw new Error(`download ${name} returned HTTP ${response.status} without a Location`)
    }
    const next = new URL(location, current)
    if (!sameRedirectHost(origin, next)) {
      throw new Error(`download ${name} redirected to ${next.host}, which is not the release host`)
    }
    current = next
    if (hop === maxRedirects) {
      throw new Error(`download ${name} redirected more than ${maxRedirects} times`)
    }
  }
  if (!response.ok) {
    throw new Error(`download ${name} returned HTTP ${response.status}`)
  }
  const declared = Number(response.headers?.get?.('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > maxDownloadBytes) {
    throw new Error(`download ${name} exceeds ${maxDownloadBytes} bytes`)
  }
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    // A fetcher without a streaming body (a test double, or an older runtime)
    // still gets the post-read check.
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length > maxDownloadBytes) {
      throw new Error(`download ${name} exceeds ${maxDownloadBytes} bytes`)
    }
    return data
  }
  const chunks = []
  let total = 0
  for await (const chunk of response.body) {
    total += chunk.length
    if (total > maxDownloadBytes) {
      throw new Error(`download ${name} exceeds ${maxDownloadBytes} bytes`)
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

// readChecksums parses a GoReleaser checksums.txt. A line that cannot be read
// is an error, not a skipped entry: a manifest that cannot be read in full
// cannot vouch for the asset it covers.
export function readChecksums(content) {
  const entries = new Map()
  for (const rawLine of String(content).split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim()) continue
    const separator = line.indexOf(' ')
    if (separator < 0) throw new Error(`invalid checksums.txt line: ${JSON.stringify(line)}`)
    const digest = line.slice(0, separator).trim()
    const name = line.slice(separator + 1).trim()
    if (!name || !digest) throw new Error(`invalid checksums.txt line: ${JSON.stringify(line)}`)
    if (!/^[0-9a-fA-F]{64}$/.test(digest)) {
      throw new Error(`invalid checksums.txt digest: ${JSON.stringify(digest)}`)
    }
    entries.set(name, digest.toLowerCase())
  }
  if (entries.size === 0) {
    throw new Error('checksums.txt has no entries')
  }
  return entries
}

// verifyChecksum refuses an asset the manifest does not cover: installing an
// unlisted file defeats the point of the manifest.
export function verifyChecksum(data, name, checksums) {
  const expected = checksums.get(name)
  if (!expected) {
    throw new Error(`checksums.txt has no entry for ${name}`)
  }
  const digest = createHash('sha256').update(data).digest('hex')
  if (digest !== expected) {
    throw new Error(`checksum mismatch for ${name}`)
  }
}

function runExternal(command, args, { spawn, platform = process.platform, log = () => {}, quiet = false, cwd }) {
  const result = spawn(command, args, {
    shell: platform === 'win32' && /\.(cmd|bat)$/i.test(command),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: childOutputMaxBuffer,
    ...(cwd ? { cwd } : {})
  })
  const stdout = String(result.stdout ?? '')
  const stderr = String(result.stderr ?? '')
  // A caller that expects the command to fail (an optional archive member that
  // may be absent) must not have its stderr reported as a diagnostic.
  if (!quiet) {
    if (stdout) log(redactUrlCredentials(stdout))
    if (stderr) log(redactUrlCredentials(stderr))
  }
  if (result.error?.code === 'ENOBUFS') {
    throw new Error(`${command} produced more than 64 MiB of output and was stopped`)
  }
  if (result.error) throw new Error(`${command} failed to start: ${errorMessage(result.error)}`)
  if (result.signal) throw new Error(`${command} was terminated by ${result.signal}`)
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? 1}`)
  return result
}

// runTarExtract unpacks one member with the platform's tar.
//
// The archive is always named relatively, from the archive's own directory.
// An absolute Windows path such as `C:\...` reads as a remote host to GNU tar
// (the tar Git for Windows puts first on PATH), which then tries to open an
// rsh connection to a host named "C" and fails with "Cannot connect to C:
// resolve failed" — every binary install on such a machine failed this way.
// `--force-local` would fix GNU tar but Windows' own bsdtar rejects the flag,
// and bsdtar accepts a forward-slash destination while GNU tar rejects a
// backslash one, so the one shape both parsers agree on is: bare file name,
// cwd at the archive's directory, forward-slash destination. That shape is
// also exactly what the POSIX tars accept, so there is no platform branch
// here and CI exercises the same code path on every OS.
function runTarExtract({ archivePath, extractDir, name, platform = process.platform, spawn, log, quiet = false }) {
  return runExternal('tar', ['-xzf', basename(archivePath), '-C', toTarPath(extractDir), name], {
    spawn,
    platform,
    log,
    quiet,
    cwd: dirname(archivePath)
  })
}

function toTarPath(value) {
  return value.replaceAll('\\', '/')
}

// extractBinary unpacks the release tarball and returns the executable's
// bytes. Extraction shells out to the platform's tar (present on macOS, Linux
// and Windows 10+), the way the archive fallback already shells out to unzip.
export function extractBinary({ archivePath, extractDir, name, platform = process.platform, spawn = spawnSync, log }) {
  mkdirSync(extractDir, { recursive: true })
  runTarExtract({ archivePath, extractDir, name, platform, spawn, log })
  return readExtractedFile(extractDir, name, `TokenBoard release tarball does not contain ${name}`)
}

// extractOptionalEntry unpacks an entry that a release may not carry (an older
// tag has no bundled ccusage) and returns null when it is absent. A present
// entry is still validated: an empty or non-file entry is a malformed archive,
// not a release without the file.
//
// tar exits non-zero both for an absent member and for a corrupt archive, and
// cannot distinguish the two here — but `verifyChecksum` has already pinned the
// whole tarball to the release's checksums.txt before extraction, so a corrupt
// archive never reaches this helper. The catch therefore only ever sees the
// legitimate absent-member case.
export function extractOptionalEntry({
  archivePath,
  extractDir,
  name,
  platform = process.platform,
  spawn = spawnSync,
  log
}) {
  mkdirSync(extractDir, { recursive: true })
  // tar exits non-zero when the member is absent; that is the case this
  // helper exists for, so the exit status is not treated as fatal here.
  try {
    runTarExtract({ archivePath, extractDir, name, platform, spawn, log, quiet: true })
  } catch {
    return null
  }
  const extracted = join(extractDir, name)
  if (!existsSync(extracted)) {
    return null
  }
  return readExtractedFile(extractDir, name, `TokenBoard release tarball does not contain ${name}`)
}

function readExtractedFile(extractDir, name, missingMessage) {
  const extracted = join(extractDir, name)
  if (!existsSync(extracted)) {
    throw new Error(missingMessage)
  }
  if (!statSync(extracted).isFile()) {
    throw new Error(`TokenBoard release tarball entry ${name} is not a file`)
  }
  const data = readFileSync(extracted)
  if (data.length === 0) {
    throw new Error(`TokenBoard release tarball entry ${name} is empty`)
  }
  return data
}

// verifyExecutable runs the staged binary's version check. A binary that
// cannot answer is not installed: swapping it in would break the next
// scheduled sync with no way to notice.
export function verifyExecutable(path, version, { spawn = spawnSync } = {}) {
  const result = spawn(path, ['version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: childOutputMaxBuffer,
    timeout: versionProbeTimeoutMs
  })
  if (result.error) throw new Error(`the downloaded TokenBoard binary does not run: ${errorMessage(result.error)}`)
  if (result.status !== 0) {
    throw new Error(`the downloaded TokenBoard binary does not run: exit code ${result.status ?? 1}`)
  }
  const printed = String(result.stdout ?? '').trim()
  if (!printed) throw new Error('the downloaded TokenBoard binary does not run: it printed no version')
  // A substring test would accept "1.2.30" for "1.2.3", and this check is the
  // only thing between a truncated download and a broken install. Go's
  // `verifyExecutable` matches a whole token; the bootstrap has to agree.
  if (!namesVersion(printed, version)) {
    throw new Error(`the downloaded TokenBoard binary does not run: it printed ${JSON.stringify(printed)}`)
  }
}

// namesVersion reports whether the output names the version as a standalone
// token, delimited by anything that is not part of a version number.
export function namesVersion(output, version) {
  const isContinuation = (char) => (char >= '0' && char <= '9') || char === '.'
  let start = 0
  for (;;) {
    const index = output.indexOf(version, start)
    if (index < 0) return false
    const before = index > 0 ? output[index - 1] : ' '
    const end = index + version.length
    const after = end < output.length ? output[end] : ' '
    if (!isContinuation(before) && !isContinuation(after)) return true
    start = index + 1
  }
}

// installClientBinary bootstraps a binary install on a machine that has none.
// It is the only place the skill downloads a release; every later upgrade is
// the binary's own `self-update`.
export async function installClientBinary({
  repo = defaultReleaseRepo,
  tag,
  baseUrl = defaultReleaseBaseUrl,
  configDir,
  platform = process.platform,
  arch = process.arch,
  fetcher = fetch,
  spawn = spawnSync,
  workDir,
  log = () => {}
}) {
  const target = clientBinaryPath({ configDir, platform })
  const work = workDir || join(configDir, 'client-install')
  const release = await resolveRelease({ repo, tag, baseUrl, platform, arch, fetcher })
  const archivePath = join(work, release.archive.name)
  const extractDir = join(work, 'extract')

  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  try {
    const archiveData = await downloadBytes({ url: release.archive.url, name: release.archive.name, fetcher })
    const checksumData = await downloadBytes({
      url: release.checksums.url,
      name: release.checksums.name,
      fetcher
    })
    verifyChecksum(archiveData, release.archive.name, readChecksums(checksumData.toString('utf8')))
    writeFileSync(archivePath, archiveData, { mode: 0o600 })

    const binary = extractBinary({
      archivePath,
      extractDir,
      name: binaryFileName(platform),
      platform,
      spawn,
      log
    })
    // Spec §4.1: the tarball carries the platform's ccusage beside the client.
    // It is unpacked before the client is swapped in so a malformed entry
    // fails the install while the machine is still untouched — the Go
    // self-update extracts it before its own swap for the same reason.
    const ccusageName = platform === 'win32' ? 'ccusage.exe' : 'ccusage'
    const ccusage = extractOptionalEntry({
      archivePath,
      extractDir,
      name: ccusageName,
      platform,
      spawn,
      log
    })
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    const staged = `${target}.new`
    rmSync(staged, { force: true })
    writeFileSync(staged, binary, { mode: 0o755 })
    // The umask may have stripped the execute bit; without it the verification
    // below would fail for a reason unrelated to the download.
    chmodSync(staged, 0o755)
    try {
      verifyExecutable(staged, release.version, { spawn })
      renameSync(staged, target)
    } catch (error) {
      rmSync(staged, { force: true })
      throw error
    }
    // A fresh install places the bundled copy where the bundled layer looks,
    // so the first run works offline; an older release without it simply
    // installs no bundled copy and the probe/download layers take over. The
    // client is already live at this point, so a write failure here warns
    // instead of failing an install that succeeded — the Go self-update
    // treats it the same way.
    if (ccusage !== null) {
      const ccusagePath = join(configDir, 'bin', ccusageName)
      try {
        writeFileSync(ccusagePath, ccusage, { mode: 0o755 })
        chmodSync(ccusagePath, 0o755)
        log(`TokenBoard bundled ccusage installed at ${ccusagePath}`)
      } catch (error) {
        log(
          `TokenBoard client ${release.version} installed, but the bundled ccusage could not be written: ${errorMessage(error)}`
        )
      }
    } else {
      // The release carries no ccusage. A copy from an earlier install stays
      // on disk, and the client will happily run it — so say which version
      // that is instead of reporting a clean install.
      const ccusagePath = join(configDir, 'bin', ccusageName)
      const staleVersion = readVersion(ccusagePath, spawn)
      if (staleVersion !== null) {
        log(
          `TokenBoard client ${release.version} installed; release ${release.tag} carries no ccusage, so the existing ${ccusagePath} (${staleVersion}) is left in place`
        )
      }
    }
    log(`TokenBoard client ${release.version} installed at ${target}`)
    return { version: release.version, path: target, tag: release.tag }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// recoverOrphanedBinary restores a binary whose swap was interrupted.
//
// `self-update` renames the running binary aside, then renames the staged one
// into its place. A process killed between those two leaves `tokenboard.backup-*`
// with no target in place, and the machine then reports "client is not
// installed" on every sync with no way back. The backup is the previous
// working binary, so the recovery is a rename back into place — and it only
// runs when the target is genuinely missing, so it cannot undo a good install.
export function recoverOrphanedBinary({
  binaryPath,
  readDir = readdirSync,
  rename = renameSync,
  remove = rmSync,
  spawn = spawnSync,
  log = () => {}
}) {
  if (existsSync(binaryPath)) {
    return null
  }
  const directory = dirname(binaryPath)
  // Go's backupPath is `current + ".backup-" + stamp`, so the prefix follows the
  // path actually configured rather than the platform's default file name.
  const prefix = `${basename(binaryPath)}.backup-`

  // The staged copy is the newer binary, but a kill during its write leaves a
  // truncated file. It is restored only if it still answers `version`; the
  // known-good backup is the fallback, and a dead staged file is removed so it
  // cannot shadow a later install.
  const staged = `${binaryPath}.new`
  if (existsSync(staged) && runsVersion(staged, spawn)) {
    rename(staged, binaryPath)
    log(`TokenBoard client was missing; restored ${binaryPath} from the staged download`)
    return staged
  }
  remove(staged, { force: true })

  let names
  try {
    names = readDir(directory)
  } catch {
    return null
  }
  const backups = names.filter((name) => name.startsWith(prefix)).sort()
  const latest = backups.at(-1)
  if (!latest) {
    return null
  }
  rename(join(directory, latest), binaryPath)
  log(`TokenBoard client was missing; restored ${binaryPath} from ${latest}`)
  return join(directory, latest)
}

// runsVersion reports whether an executable answers `version` at all. The
// output is not compared to a release: the point is only to reject a file that
// a truncated write left unrunnable.
function runsVersion(path, spawn) {
  try {
    const result = spawn(path, ['version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: childOutputMaxBuffer,
      timeout: versionProbeTimeoutMs,
      // The staged binary is a downloaded release artifact; it is probed before it is trusted,
      // so it must not see the upload token either.
      env: scrubbedChildEnv()
    })
    return !result.error && result.status === 0
  } catch {
    return false
  }
}

// readVersion returns the version token an executable prints, or null when it
// cannot be run. ccusage and tokenboard spell their version lines differently
// ("ccusage 20.0.33" and "tokenboard (go) 1.2.3"), so the last
// whitespace-separated field is the version in both.
//
// The two binaries take different flags — tokenboard answers `version`,
// ccusage answers `--version` — so the argument list is a parameter.
export function readVersion(path, spawn = spawnSync, args = ['--version']) {
  let result
  try {
    // The probed binary is third-party (ccusage) on the status path, so it must not inherit
    // the upload token the way every other child of this skill is prevented from doing.
    result = spawn(path, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 5000,
      env: scrubbedChildEnv()
    })
  } catch {
    return null
  }
  if (result.error || result.status !== 0) return null
  const fields = String(result.stdout ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return fields.length > 0 ? fields.at(-1) : null
}

// runSelfUpdate hands the upgrade to the installed binary, which owns the
// checksum verification and the rename-swap from here on. The scheduled path
// passes --scheduled so an offline machine stays quiet instead of failing the
// run.
export function runSelfUpdate({
  binaryPath,
  scheduled = false,
  spawn = spawnSync,
  env = process.env,
  log = () => {},
  readDir = readdirSync,
  rename = renameSync
}) {
  if (!existsSync(binaryPath)) {
    // A missing target may be the remains of an interrupted swap rather than a
    // client that was never installed; restore before deciding.
    recoverOrphanedBinary({ binaryPath, readDir, rename, log })
  }
  if (!existsSync(binaryPath)) {
    throw new Error(`TokenBoard client is not installed: ${binaryPath}`)
  }
  const args = ['self-update']
  if (scheduled) args.push('--scheduled')
  const result = spawn(binaryPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: childOutputMaxBuffer,
    env
  })
  const stdout = String(result.stdout ?? '')
  const stderr = String(result.stderr ?? '')
  if (stdout.trim()) log(redactUrlCredentials(stdout.trim()))
  if (stderr.trim()) log(redactUrlCredentials(stderr.trim()))
  if (result.error) throw new Error(`TokenBoard self-update failed to start: ${errorMessage(result.error)}`)
  if (result.status !== 0) {
    throw new Error(`TokenBoard self-update failed with exit code ${result.status ?? 1}`)
  }
  return { status: 0 }
}
