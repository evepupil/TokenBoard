import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type CommandRunner = (command: string, args: string[]) => Promise<unknown>

export const runJsonCommand: CommandRunner = async (command, args) => {
  const { stdout } = await execFileAsync(command, args, {
    shell: false,
    maxBuffer: 128 * 1024 * 1024
  })

  return JSON.parse(stdout)
}
