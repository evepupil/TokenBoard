export type PackageRunner = {
  command: string
  runPackageArgs(packageName: string, binaryName: string, packageArgs: string[]): string[]
}

export function resolvePackageRunner(
  packageManager = process.env.TOKENBOARD_PACKAGE_MANAGER,
  platform = process.platform
): PackageRunner {
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

function packageCommand(command: string, platform: string) {
  return platform === 'win32' ? `${command}.cmd` : command
}
