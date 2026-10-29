// ccusage runs as a child process, and on a machine with no bundled binary it is
// fetched and executed through the package runner (`npx`, `pnpm dlx`, `bunx`). A
// downloaded package must not be handed the upload token: that token authorizes
// writes as this device, so a compromised or merely careless third-party build
// could read it from its own environment and upload as the user.
//
// The collector never passes the token to a child for any other reason — ccusage
// prices usage from its own catalogue and has no use for it — so the fix is to
// strip credentials from the child environment rather than to add a new channel.
//
// `TOKENBOARD_PAIRING_CODE` is included for the same reason: it is a short-lived
// credential that redeems a device, and nothing ccusage does needs it.
export const credentialEnvKeys = ['TOKENBOARD_UPLOAD_TOKEN', 'TOKENBOARD_PAIRING_CODE'] as const

/**
 * Returns a copy of `env` with credential-bearing variables removed.
 *
 * Callers must pass the result to a child process, never use it for their own
 * lookups: a provider that resolved its own configuration from this copy would
 * silently lose whatever the stripped keys carried.
 */
export function childProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env }
  for (const key of credentialEnvKeys) delete result[key]
  return result
}
