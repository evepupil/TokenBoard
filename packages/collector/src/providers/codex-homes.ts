import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

type ResolveCodexHomesInput = {
  explicitHomes?: readonly string[]
  jsonValue?: string
  legacyValue?: string
}

export function resolveCodexHomes(input: ResolveCodexHomesInput = {}) {
  if (input.explicitHomes !== undefined) {
    return normalizeCodexHomes(input.explicitHomes)
  }
  if (input.jsonValue?.trim()) {
    return normalizeCodexHomes(parseCodexHomesJson(input.jsonValue))
  }

  const configured = input.legacyValue?.trim()
  if (!configured) return [defaultCodexHome()]
  if (configured.includes(',') && existsSync(resolve(configured))) {
    throw new Error(
      'CODEX_HOME is ambiguous because the configured path contains a comma; ' +
        'use TOKENBOARD_CODEX_HOMES_JSON or the codexHomes array instead'
    )
  }
  return normalizeCodexHomes(configured.split(','))
}

function parseCodexHomesJson(value: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error('Invalid TOKENBOARD_CODEX_HOMES_JSON: expected a JSON array of paths', {
      cause: error
    })
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((item) => typeof item === 'string' && item.trim().length > 0)
  ) {
    throw new Error('Invalid TOKENBOARD_CODEX_HOMES_JSON: expected a non-empty JSON array of paths')
  }
  return parsed
}

function normalizeCodexHomes(values: readonly string[]) {
  const homes = values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(value))
  return [...new Set(homes.length > 0 ? homes : [defaultCodexHome()])]
}

function defaultCodexHome() {
  return resolve(join(homedir(), '.codex'))
}
