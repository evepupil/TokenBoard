#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { platform } from 'node:os'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(new URL('./sync.mjs', import.meta.url))

if (platform() === 'win32') {
  const taskCommand = `"${process.execPath}" "${scriptPath}" --mode sync --source all`
  const result = spawnSync(
    'schtasks.exe',
    [
      '/Create',
      '/F',
      '/SC',
      'DAILY',
      '/TN',
      'TokenBoardDailySync',
      '/TR',
      taskCommand,
      '/ST',
      '09:00'
    ],
    { stdio: 'inherit' }
  )
  process.exit(result.status ?? 1)
}

console.log('Automatic schedule was not installed on this OS yet.')
console.log(`Run daily: "${process.execPath}" "${scriptPath}" --mode sync --source all`)
