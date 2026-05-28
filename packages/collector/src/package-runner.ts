import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type PackageRunner = {
  command: string
  runPackageArgs(packageName: string, binaryName: string, packageArgs: string[]): string[]
}

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
    return createLocalCcusageRunner(forcedCcusage)
  }

  const localCcusage = resolveLocalCcusageBin(platform)
  if (!forcePackageRunner && fileExists(localCcusage)) {
    return createLocalCcusageRunner(localCcusage)
  }

  if (packageManager === 'bun') {
    return {
      command: process.env.TOKENBOARD_BUNX_BIN || 'bunx',
      runPackageArgs: (packageName, _binaryName, packageArgs) => [packageName, ...packageArgs]
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
        ...packageArgs
      ]
    }
  }

  if (packageManager === 'pnpm') {
    return {
      command: process.env.TOKENBOARD_PNPM_BIN || packageCommand('pnpm', platform),
      runPackageArgs: (packageName, _binaryName, packageArgs) => ['dlx', packageName, ...packageArgs]
    }
  }

  return {
    command: process.env.TOKENBOARD_NPX_BIN || packageCommand('npx', platform),
    runPackageArgs: (packageName, _binaryName, packageArgs) => [packageName, ...packageArgs]
  }
}

function createLocalCcusageRunner(command: string): PackageRunner {
  return {
    command,
    runPackageArgs: (_packageName, _binaryName, packageArgs) => packageArgs
  }
}

function packageCommand(command: string, platform: string) {
  return platform === 'win32' ? `${command}.cmd` : command
}

function resolveLocalCcusageBin(platform: string) {
  const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
  return join(packageDir, 'node_modules', '.bin', packageCommand('ccusage', platform))
}
