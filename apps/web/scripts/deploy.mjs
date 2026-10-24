import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const configPath = resolveDeployConfigPath()

runNode(['scripts/check-production-config.mjs'], {
  ...process.env,
  TOKENBOARD_WRANGLER_CONFIG: configPath
})

runPnpm(['run', 'build'])
runPnpm(['exec', 'wrangler', 'deploy', '--dry-run', '--config', configPath])
if (!process.env.CLOUDFLARE_API_TOKEN?.trim() && !process.env.CF_API_TOKEN?.trim()) {
  runPnpm(['exec', 'wrangler', 'whoami'])
}
runNode(['scripts/check-production-route.mjs'], {
  ...process.env,
  TOKENBOARD_WRANGLER_CONFIG: configPath
})
runPnpm(['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath])
assertNoPendingMigrations(configPath)

// Post-migration schema gates. Each file raises on a violation and exits non-zero, so a
// failure here stops the deploy before the Worker is published. The foreign-key check is
// last because it validates data, not shape: a missing table would make it fail with a
// less specific error than the schema checks above.
//
// `--yes` is required, not cosmetic: `wrangler d1 execute --file --remote` only prompts when
// the process is interactive (`isInteractive4 && !yes && !json2`), and declining returns null,
// which the command treats as a no-op and exits 0. Without `--yes` an operator who answers
// "n" once would leave every gate unrun while deploy.mjs reads a zero status and publishes
// the Worker — a silent green. `d1 migrations apply` above has no such flag, and its confirm
// only falls back to "yes" on the non-interactive path: an operator who answers "n" in a real
// terminal exits 0 with nothing applied. The gates cannot catch that for a pure-data migration
// (0035/0037/0038 change no table, column, index, or FK shape), so the pending list below is
// what closes the hole: any migration still pending after the apply step stops the deploy.
for (const file of [
  'db/verify-critical-schema.sql',
  'db/verify-rate-limit-index.sql',
  'db/verify-retention-index.sql',
  'db/verify-foreign-keys.sql'
]) {
  runPnpm(['exec', 'wrangler', 'd1', 'execute', 'DB', '--remote', '--file', file, '--yes', '--config', configPath])
}

runPnpm(['exec', 'wrangler', 'deploy', '--config', configPath])

// `migrations apply` is advisory on a declined prompt (exit 0, nothing applied — see the note
// above), so the deploy re-lists the pending migrations and refuses to publish while any
// remain. `list` exits 0 both when the queue is empty and when it prints entries, so the
// output decides: the schema gates prove shape, this proves presence.
function assertNoPendingMigrations(configPath) {
  const { command, args } = pnpmInvocation([
    'exec',
    'wrangler',
    'd1',
    'migrations',
    'list',
    'DB',
    '--remote',
    '--config',
    configPath
  ])
  const result = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  if (result.status !== 0) {
    console.error(`TokenBoard deploy could not verify the applied migrations: ${result.stderr}`)
    process.exit(result.status ?? 1)
  }
  const output = `${result.stdout}\n${result.stderr}`
  if (/No migrations to apply/i.test(output)) return
  // Fail-closed on an unrecognised listing as well: silence from a changed wrangler output
  // format must not read as "nothing pending". The only accepted clean state is the explicit
  // "No migrations to apply" line.
  const pending = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[│|]?\s*\d{4}_\S+\.sql/.test(line) || /Migrations to be applied/i.test(line))
  console.error('TokenBoard deploy stopped: migrations are still pending after the apply step.')
  console.error('A declined "About to apply N migration(s)" prompt exits 0 without applying anything.')
  if (pending.length > 0) console.error(pending.join('\n'))
  else console.error(output.trim())
  process.exit(1)
}

function resolveDeployConfigPath() {
  const envPath = process.env.TOKENBOARD_WRANGLER_CONFIG?.trim()
  if (envPath) return envPath

  const privateConfigPath = 'wrangler.production.jsonc'
  if (existsSync(privateConfigPath)) return privateConfigPath

  const generatedConfigPath = 'wrangler.production.ci.jsonc'
  runNode(['scripts/write-production-config.mjs', 'wrangler.production.example.jsonc', generatedConfigPath])
  return generatedConfigPath
}

function runNode(args, extraEnv) {
  run(process.execPath, args, extraEnv)
}

function pnpmInvocation(args) {
  const packageManagerCli = process.env.TOKENBOARD_PNPM_CLI?.trim() || process.env.npm_execpath?.trim()
  if (packageManagerCli) return { command: process.execPath, args: [packageManagerCli, ...args] }
  return { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args }
}

function runPnpm(args, extraEnv) {
  const { command, args: resolvedArgs } = pnpmInvocation(args)
  run(command, resolvedArgs, extraEnv)
}

function run(command, args, extraEnv) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    cwd: process.cwd()
  })
  if (result.status !== 0) {
    if (result.error) console.error(`Failed to start ${command}: ${result.error.message}`)
    process.exit(result.status ?? 1)
  }
}
