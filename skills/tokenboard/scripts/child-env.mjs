// The skill exports credentials into its own environment and then runs code it
// downloaded: `pnpm install` executes dependency lifecycle scripts, and `git`
// runs credential helpers and hooks. Neither needs this device's upload token
// or a pairing code, so neither is handed one. This mirrors
// `packages/collector/src/child-env.ts`, which guards the same boundary for
// the collector's `npx ccusage` child; the skill cannot import that package
// (it runs from a git checkout before any build), so the list is a hand-kept
// mirror and `child-env.test.mjs` parses the TypeScript declaration to catch
// drift.
export const credentialEnvKeys = [
  'TOKENBOARD_UPLOAD_TOKEN',
  'TOKENBOARD_PAIRING_CODE',
  'TOKENBOARD_RELEASE_BASE_URL',
  'TOKENBOARD_REPO_URL'
]

/**
 * Returns a copy of `env` with credential-bearing variables removed. Callers
 * must pass the result to a child process, never use it for their own lookups.
 */
export function scrubbedChildEnv(env = process.env) {
  const result = { ...env }
  for (const key of credentialEnvKeys) delete result[key]
  return result
}
