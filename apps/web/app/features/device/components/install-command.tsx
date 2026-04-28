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
        <h1 class="text-3xl font-semibold">连接这台机器</h1>
        <p class="max-w-2xl text-sm text-zinc-400">
          生成一个短期有效的配对提示词，把它粘贴给 Codex 或 Claude Code，让本地 agent 安装 TokenBoard skill 并配置每日同步。
        </p>
      </header>

      <form method="post" class="rounded-xl border border-zinc-800 bg-zinc-900/70 p-5">
        <label class="flex flex-col gap-2 text-sm text-zinc-300">
          时区
          <input
            class="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-50"
            name="timezone"
            value={props.timezone}
          />
        </label>
        <button
          class="mt-4 rounded-md bg-cyan-400 px-4 py-2 text-sm font-semibold text-zinc-950"
          type="submit"
        >
          生成安装提示词
        </button>
      </form>

      {props.pairingCode ? (
        <section class="rounded-xl border border-zinc-800 bg-zinc-900/70 p-5">
          <div class="flex flex-col gap-1">
            <h2 class="text-base font-semibold">粘贴到 Codex 或 Claude Code</h2>
            <p class="text-sm text-zinc-400">过期时间：{props.expiresAt}</p>
          </div>
          <pre class="mt-4 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950 p-4 text-sm leading-6 text-zinc-100">
            {prompt}
          </pre>
        </section>
      ) : null}
    </section>
  )
}

export function createInstallPrompt(baseUrl: string, timezone: string, pairingCode: string) {
  return [
    '请在这台机器上安装并运行 TokenBoard。',
    '',
    '1. 从这个 GitHub repo 路径安装 TokenBoard skill：',
    '   https://github.com/evepupil/TokenBoard/tree/master/skills/tokenboard',
    '2. 使用安装好的 TokenBoard skill 执行 setup：',
    '',
    `node scripts/setup.mjs --pairing-code ${pairingCode} --base-url ${baseUrl} --timezone ${timezone}`,
    '',
    '不要打印 upload token。安装每日同步计划，并立即执行第一次同步。'
  ].join('\n')
}
