export type InstallCommandProps = {
  baseUrl: string
  timezone: string
  pairingCode?: string
  expiresAt?: string
}

export function InstallCommand(props: InstallCommandProps) {
  const prompt = props.pairingCode
    ? createInstallPrompt(props.baseUrl, props.timezone, props.pairingCode)
    : ''

  return (
    <section class="mx-auto flex max-w-3xl flex-col gap-6">
      <header class="flex flex-col gap-2 border-b border-zinc-800 pb-6">
        <p class="text-sm font-medium uppercase tracking-wide text-cyan-300">TokenBoard</p>
        <h1 class="text-3xl font-semibold">Connect this machine</h1>
        <p class="max-w-2xl text-sm text-zinc-400">
          Generate a short-lived pairing prompt, paste it into Codex or Claude Code, and let the
          local agent install the TokenBoard skill plus daily sync.
        </p>
      </header>

      <form method="post" class="rounded-lg border border-zinc-800 bg-zinc-900/70 p-5">
        <label class="flex flex-col gap-2 text-sm text-zinc-300">
          Timezone
          <input
            class="rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-50"
            name="timezone"
            value={props.timezone}
          />
        </label>
        <button
          class="mt-4 rounded bg-cyan-400 px-4 py-2 text-sm font-semibold text-zinc-950"
          type="submit"
        >
          Generate install prompt
        </button>
      </form>

      {props.pairingCode ? (
        <section class="rounded-lg border border-zinc-800 bg-zinc-900/70 p-5">
          <div class="flex flex-col gap-1">
            <h2 class="text-base font-semibold">Paste into Codex or Claude Code</h2>
            <p class="text-sm text-zinc-400">Expires at {props.expiresAt}</p>
          </div>
          <pre class="mt-4 overflow-x-auto rounded border border-zinc-800 bg-zinc-950 p-4 text-sm leading-6 text-zinc-100">
            {prompt}
          </pre>
        </section>
      ) : null}
    </section>
  )
}

export function createInstallPrompt(baseUrl: string, timezone: string, pairingCode: string) {
  return [
    'Install and run TokenBoard on this machine.',
    '',
    '1. Install the TokenBoard skill from this GitHub repo path:',
    '   https://github.com/evepupil/TokenBoard/tree/master/skills/tokenboard',
    '2. Use the installed TokenBoard skill to run setup:',
    '',
    `node scripts/setup.mjs --pairing-code ${pairingCode} --base-url ${baseUrl} --timezone ${timezone}`,
    '',
    'Do not print the upload token. Install the daily sync schedule and run the initial sync.'
  ].join('\n')
}
