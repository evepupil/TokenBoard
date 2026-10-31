import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type PackageRunner = {
  command: string
  runPackageArgs(packageName: string, binaryName: string, packageArgs: string[]): string[]
}

export const ccusagePackageSpecifier = 'ccusage@20.0.33'

export function resolvePackageRunner(
  packageManager: string | undefined = undefined,
  platform = process.platform,
  fileExists: (path: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
  hookMode = false
): PackageRunner {
  packageManager ??= env.TOKENBOARD_PACKAGE_MANAGER
  const forcePackageRunner = Boolean(env.TOKENBOARD_FORCE_PACKAGE_RUNNER)
  const forcedCcusage = env.TOKENBOARD_CCUSAGE_BIN
  if (!forcePackageRunner && forcedCcusage) {
    if (!fileExists(forcedCcusage)) {
      throw new Error(`TOKENBOARD_CCUSAGE_BIN does not exist: ${forcedCcusage}`)
    }
    return createLocalCcusageRunner(forcedCcusage, fileExists, env)
  }

  const localCcusage = resolveLocalCcusageBin(platform)
  if (!forcePackageRunner && fileExists(localCcusage)) {
    return createLocalCcusageRunner(localCcusage, fileExists, env)
  }

  // A hook runs inside the editor's own lifecycle and must not reach the network, so a missing
  // local ccusage is an error there rather than a prompt to fetch one. The Go client refuses the
  // download in hook mode for the same reason (`ccusage/acquire.go`); without this the TS side
  // would quietly run `npx ccusage@…` mid-session. `TOKENBOARD_FORCE_PACKAGE_RUNNER` is an
  // explicit operator override and still wins.
  if (hookMode && !forcePackageRunner) {
    throw new Error(
      'ccusage is not installed and hook mode does not download it; install the bundled client or put ccusage on PATH'
    )
  }

  if (packageManager === 'bun') {
    return {
      command: env.TOKENBOARD_BUNX_BIN || 'bunx',
      runPackageArgs: (packageName, _binaryName, packageArgs) => [
        packageName,
        ...appendCcusageConfig(packageName, packageArgs, fileExists, env)
      ]
    }
  }

  if (packageManager === 'npm') {
    return {
      command: env.TOKENBOARD_NPM_BIN || packageCommand('npm', platform),
      runPackageArgs: (packageName, binaryName, packageArgs) => [
        'exec',
        '--yes',
        '--package',
        packageName,
        '--',
        binaryName,
        ...appendCcusageConfig(packageName, packageArgs, fileExists, env)
      ]
    }
  }

  if (packageManager === 'pnpm') {
    return {
      command: env.TOKENBOARD_PNPM_BIN || packageCommand('pnpm', platform),
      runPackageArgs: (packageName, _binaryName, packageArgs) => [
        'dlx',
        packageName,
        ...appendCcusageConfig(packageName, packageArgs, fileExists, env)
      ]
    }
  }

  return {
    command: env.TOKENBOARD_NPX_BIN || packageCommand('npx', platform),
    runPackageArgs: (packageName, _binaryName, packageArgs) => [
      packageName,
      ...appendCcusageConfig(packageName, packageArgs, fileExists, env)
    ]
  }
}

function createLocalCcusageRunner(
  command: string,
  fileExists: (path: string) => boolean,
  env: NodeJS.ProcessEnv
): PackageRunner {
  return {
    command,
    runPackageArgs: (packageName, _binaryName, packageArgs) =>
      appendCcusageConfig(packageName, packageArgs, fileExists, env)
  }
}

function appendCcusageConfig(
  packageName: string,
  packageArgs: string[],
  fileExists: (path: string) => boolean,
  env: NodeJS.ProcessEnv
) {
  if (packageName !== ccusagePackageSpecifier) return packageArgs
  const dynamicConfigPath = env.TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG?.trim()
  const explicitConfigPath = env.TOKENBOARD_CCUSAGE_CONFIG?.trim()
  const configPath = dynamicConfigPath || explicitConfigPath
  if (!configPath) return packageArgs
  if (!fileExists(configPath)) {
    const variableName = dynamicConfigPath ? 'TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG' : 'TOKENBOARD_CCUSAGE_CONFIG'
    throw new Error(`${variableName} does not exist: ${configPath}`)
  }
  return [...packageArgs, '--config', configPath]
}

function packageCommand(command: string, platform: string) {
  return platform === 'win32' ? `${command}.cmd` : command
}

function resolveLocalCcusageBin(platform: string) {
  const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
  return join(packageDir, 'node_modules', '.bin', packageCommand('ccusage', platform))
}
