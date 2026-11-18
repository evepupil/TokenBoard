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

// Opens the message for "the default install path holds no language server",
// raised from a plain existence check instead of a spawn failure. The CLI's
// availability predicate matches it even under TOKENBOARD_FAIL_ON_SOURCE_ERROR:
// a missing app is not something a retry can fix, while spawn ENOENT also
// matches a path the client mangled — the regression strict mode is there to
// report — so that shape stays inside the switch.
export const languageServerNotInstalledPrefix = 'Antigravity language server is not installed at '

export function isLanguageServerNotInstalled(message: string) {
  return message.includes(languageServerNotInstalledPrefix)
}

export function isUnavailableLanguageServerError(error: unknown) {
  if (!(error instanceof Error)) return false
  return (
    error.message.includes('Antigravity language server exited before it was ready') ||
    error.message.includes('Timed out starting Antigravity language server') ||
    error.message.startsWith('Antigravity metadata request failed for ') ||
    error.message.startsWith('Antigravity metadata request transport failed for ') ||
    error.message.startsWith('Antigravity metadata request timed out for ') ||
    isLanguageServerNotInstalled(error.message) ||
    error.message.match(/^spawn .*(Antigravity.*language_server|tokenboard-antigravity-language-server) ENOENT/) !==
      null
  )
}

export function readStateDir() {
  return (
    process.env.TOKENBOARD_STATE_DIR?.trim() ||
    process.env.TOKENBOARD_CONFIG_DIR?.trim() ||
    join(homedir(), '.tokenboard')
  )
}

export function defaultConversationDir(source: AntigravityGuiSource) {
  return join(homedir(), '.gemini', source, 'conversations')
}
