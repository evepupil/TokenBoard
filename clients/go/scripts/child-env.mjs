// The credential variables the collector must never hand to a child process
// (AGENTS.md "跨端协议不变量"). The same four keys are stripped by
// packages/collector/src/child-env.ts, clients/go/internal/ccusage/credentials.go
// and skills/tokenboard/scripts/child-env.mjs; the generators here exec
// third-party binaries (ccusage, and through CCUSAGE_BIN anything a maintainer
// points at), so they need the same scrub.
export const SCRUBBED_ENV_KEYS = [
  'TOKENBOARD_UPLOAD_TOKEN',
  'TOKENBOARD_PAIRING_CODE',
  'TOKENBOARD_RELEASE_BASE_URL',
  'TOKENBOARD_REPO_URL'
]

/** A copy of `env` with the credential keys removed. */
export function scrubbedEnv(env = process.env) {
  const copy = { ...env }
  for (const key of SCRUBBED_ENV_KEYS) {
    delete copy[key]
  }
  return copy
}
