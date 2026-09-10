import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AntigravityGuiSource } from './antigravity-gui'
export { errorMessage } from '../error-message'

export function isUnavailableDbError(error: unknown) {
  if (!(error instanceof Error)) return false
  return (
    error.message.startsWith('Antigravity SQLite reader unavailable:') ||
    error.message.startsWith('Antigravity conversations directory not found:')
  )
}

export function isUnavailableLanguageServerError(error: unknown) {
  if (!(error instanceof Error)) return false
  return (
    error.message.includes('Antigravity language server exited before it was ready') ||
    error.message.includes('Timed out starting Antigravity language server') ||
    error.message.startsWith('Antigravity metadata request failed for ') ||
    error.message.startsWith('Antigravity metadata request transport failed for ') ||
    error.message.startsWith('Antigravity metadata request timed out for ') ||
    error.message.match(/^spawn .*(Antigravity.*language_server|tokenboard-antigravity-language-server) ENOENT/) !==
      null
  )
}

export function readStateDir() {
  return process.env.TOKENBOARD_STATE_DIR || process.env.TOKENBOARD_CONFIG_DIR || join(homedir(), '.tokenboard')
}

export function defaultConversationDir(source: AntigravityGuiSource) {
  return join(homedir(), '.gemini', source, 'conversations')
}
