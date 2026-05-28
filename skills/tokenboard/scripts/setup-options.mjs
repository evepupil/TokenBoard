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

export function shouldWarmHookCursorsBeforeInstall(flags = {}) {
  if (flags['skip-hook']) return false
  if (flags['skip-initial-sync']) return true
  return flags.since !== undefined && flags.since !== 'all'
}

export function buildWarmHookCursorArgs({ packageManager } = {}) {
  const args = ['--mode', 'warm-hooks', '--source', 'all', '--skip-upgrade']
  if (typeof packageManager === 'string' && packageManager.trim()) {
    args.push('--package-manager', packageManager)
  }
  return args
}

export function readSetupBaseUrl({ flags = {}, env = process.env } = {}) {
  const value = flags['base-url'] || env.TOKENBOARD_BASE_URL
  return value ? String(value).replace(/\/$/, '') : null
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
