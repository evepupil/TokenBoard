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
    <section class="mx-auto flex max-w-4xl flex-col gap-5">
      <header class="relative overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[radial-gradient(circle_at_90%_10%,rgba(190,242,100,.2),transparent_28%),var(--app-panel)] p-6 shadow-xl shadow-black/10">
        <div class="absolute -right-16 -top-16 h-40 w-40 rounded-full border border-lime-300/20" />
        <p class="text-sm font-black uppercase tracking-[0.28em] text-lime-300">TokenBoard Collector</p>
        <h1 class="mt-4 text-4xl font-black tracking-tight">连接这台机器</h1>
        <p class="mt-3 max-w-2xl text-sm leading-6 text-[var(--app-muted)]">
          生成一个短期有效的配对提示词，把它粘贴给 Codex 或 Claude Code，让本地 agent 安装 TokenBoard skill 并配置每日同步。
        </p>
      </header>

      <form method="post" class="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-xl shadow-black/10 backdrop-blur">
        <label class="flex flex-col gap-2 text-sm font-bold text-[var(--app-muted)]">
          时区
          <input
            class="rounded-xl border border-[var(--app-border)] bg-[var(--app-input)] px-4 py-3 text-[var(--app-text)] outline-none transition focus:border-lime-300 focus:ring-2 focus:ring-lime-300/20"
            name="timezone"
            value={props.timezone}
          />
        </label>
        <button
          class="mt-4 rounded-xl bg-lime-300 px-4 py-2.5 text-sm font-black text-stone-950 transition hover:bg-lime-200"
          type="submit"
        >
          生成安装提示词
        </button>
      </form>

      {props.pairingCode ? (
        <section class="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-xl shadow-black/10 backdrop-blur">
          <div class="flex flex-col gap-1">
            <h2 class="text-base font-black">粘贴到 Codex 或 Claude Code</h2>
            <p class="text-sm text-[var(--app-muted)]">过期时间：{props.expiresAt}</p>
          </div>
          <pre class="mt-4 overflow-x-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-4 text-sm leading-6 text-[var(--app-text)]">
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
