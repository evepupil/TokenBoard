import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export async function writeJsonl(file: string, rows: unknown[]) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, {
    flag: 'w'
  })
}

export async function createEmptyCodexHome() {
  const codexHome = await mkdtemp(join(tmpdir(), 'tokenboard-codex-home-'))
  await mkdir(join(codexHome, 'sessions'), { recursive: true })
  return codexHome
}

export async function fileContainsTokenCount(file: string) {
  return readFile(file, 'utf8')
    .then((content) => content.includes('token_count'))
    .catch(() => false)
}

export async function fileExists(file: string) {
  return stat(file)
    .then(() => true)
    .catch(() => false)
}

export function tokenCountEvent(timestamp: string, totalTokens: number) {
  return {
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5',
        last_token_usage: {
          input_tokens: totalTokens,
          output_tokens: 0,
          total_tokens: totalTokens
        }
      }
    }
  }
}

export function platformCommand(command: string) {
  return process.platform === 'win32' ? `${command}.cmd` : command
}
