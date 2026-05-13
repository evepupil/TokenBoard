export function buildInitialSyncArgs({ flags = {}, packageManager } = {}) {
  const args = [
    '--mode',
    'sync',
    '--source',
    'all',
    '--since',
    flags.since || 'all'
  ]
  if (typeof packageManager === 'string' && packageManager.trim()) {
    args.push('--package-manager', packageManager)
  }
  return args
}

export function buildInstallCollectorArgs({ flags = {}, packageManager, installCollectorScript = './install-collector.mjs' } = {}) {
  const args = [installCollectorScript]
  if (flags['repo-url']) {
    args.push('--repo-url', flags['repo-url'])
  }
  if (typeof packageManager === 'string' && packageManager.trim()) {
    args.push('--package-manager', packageManager)
  }
  return args
}
