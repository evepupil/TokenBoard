export type PackageRunner = {
  command: string
  runPackageArgs(packageName: string, binaryName: string, packageArgs: string[]): string[]
}

export function resolvePackageRunner(packageManager = process.env.TOKENBOARD_PACKAGE_MANAGER): PackageRunner {
  if (packageManager === 'bun') {
    return {
      command: process.env.TOKENBOARD_BUNX_BIN || 'bunx',
      runPackageArgs: (packageName, _binaryName, packageArgs) => [packageName, ...packageArgs]
    }
  }

  if (packageManager === 'npm') {
    return {
      command: process.env.TOKENBOARD_NPM_BIN || 'npm',
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

  return {
    command: process.env.TOKENBOARD_NPX_BIN || 'npx',
    runPackageArgs: (packageName, _binaryName, packageArgs) => [packageName, ...packageArgs]
  }
}
