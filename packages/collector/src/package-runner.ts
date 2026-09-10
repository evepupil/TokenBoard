import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type PackageRunner = {
  command: string
  runPackageArgs(packageName: string, binaryName: string, packageArgs: string[]): string[]
}

export const ccusagePackageSpecifier = 'ccusage@20.0.20'

export function resolvePackageRunner(
  packageManager = process.env.TOKENBOARD_PACKAGE_MANAGER,
  platform = process.platform,
  fileExists: (path: string) => boolean = existsSync
): PackageRunner {
  const forcePackageRunner = Boolean(process.env.TOKENBOARD_FORCE_PACKAGE_RUNNER)
  const forcedCcusage = process.env.TOKENBOARD_CCUSAGE_BIN
  if (!forcePackageRunner && forcedCcusage) {
    if (!fileExists(forcedCcusage)) {
      throw new Error(`TOKENBOARD_CCUSAGE_BIN does not exist: ${forcedCcusage}`)
    }
    return createLocalCcusageRunner(forcedCcusage, fileExists)
  }

  const localCcusage = resolveLocalCcusageBin(platform)
  if (!forcePackageRunner && fileExists(localCcusage)) {
    return createLocalCcusageRunner(localCcusage, fileExists)
  }

  if (packageManager === 'bun') {
    return {
      command: process.env.TOKENBOARD_BUNX_BIN || 'bunx',
      runPackageArgs: (packageName, _binaryName, packageArgs) => [
        packageName,
        ...appendCcusageConfig(packageName, packageArgs, fileExists)
      ]
    }
  }

  if (packageManager === 'npm') {
    return {
      command: process.env.TOKENBOARD_NPM_BIN || packageCommand('npm', platform),
      runPackageArgs: (packageName, binaryName, packageArgs) => [
        'exec',
        '--yes',
        '--package',
        packageName,
        '--',
        binaryName,
        ...appendCcusageConfig(packageName, packageArgs, fileExists)
      ]
    }
  }

  if (packageManager === 'pnpm') {
    return {
      command: process.env.TOKENBOARD_PNPM_BIN || packageCommand('pnpm', platform),
      runPackageArgs: (packageName, _binaryName, packageArgs) => [
        'dlx',
        packageName,
        ...appendCcusageConfig(packageName, packageArgs, fileExists)
      ]
    }
  }

  return {
    command: process.env.TOKENBOARD_NPX_BIN || packageCommand('npx', platform),
    runPackageArgs: (packageName, _binaryName, packageArgs) => [
      packageName,
      ...appendCcusageConfig(packageName, packageArgs, fileExists)
    ]
  }
}

function createLocalCcusageRunner(command: string, fileExists: (path: string) => boolean): PackageRunner {
  return {
    command,
    runPackageArgs: (packageName, _binaryName, packageArgs) => appendCcusageConfig(packageName, packageArgs, fileExists)
  }
}

function appendCcusageConfig(packageName: string, packageArgs: string[], fileExists: (path: string) => boolean) {
  if (packageName !== ccusagePackageSpecifier) return packageArgs
  const configPath = process.env.TOKENBOARD_CCUSAGE_CONFIG?.trim()
  if (!configPath) return packageArgs
  if (!fileExists(configPath)) {
    throw new Error(`TOKENBOARD_CCUSAGE_CONFIG does not exist: ${configPath}`)
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
