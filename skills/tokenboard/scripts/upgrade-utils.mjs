import { resolve } from 'node:path'

export function runStep(step, runtime) {
  if (step.command === 'remove') {
    runtime.remove(step.args[0], step.options)
    return
  }

  if (step.command === 'copy') {
    runtime.copy(step.args[0], step.args[1], step.options)
    return
  }

  const result = runtime.spawn(step.command, step.args, {
    stdio: 'inherit',
    shell: runtime.platform === 'win32' && step.command.endsWith('.cmd'),
    ...step.options
  })
  if (result.status !== 0) {
    throw new Error(`${step.command} failed with exit code ${result.status ?? 1}`)
  }
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export function escapePowerShellSingleQuoted(value) {
  return String(value).replaceAll("'", "''")
}

export function samePath(leftPath, rightPath) {
  return resolve(leftPath) === resolve(rightPath)
}

export function corepackCommand(platform) {
  return platform === 'win32' ? 'corepack.cmd' : 'corepack'
}

export function joinForPlatform(base, first, second) {
  const separator = String(base).includes('\\') ? '\\' : '/'
  return [String(base).replace(/[\\/]$/, ''), first, second]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join(separator)
}
