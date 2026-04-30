import { Copy } from 'lucide'
import { LucideIcon } from '../../../components/ui/icon'

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
          生成一个短期有效的配对提示词，把它粘贴给 Codex 或 Claude Code，让本地 agent 用终端命令安装采集器并配置每日同步。
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
          <div class="relative mt-4">
            <button
              type="button"
              class="absolute right-3 top-3 inline-flex h-9 w-9 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-muted)] shadow-sm transition hover:border-lime-300/50 hover:text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-lime-300/30"
              data-copy-target="install-prompt-text"
              aria-label="复制安装提示词"
              title="复制安装提示词"
            >
              <LucideIcon icon={Copy} size={17} />
            </button>
            <pre id="install-prompt-text" class="overflow-x-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] p-4 pr-16 text-sm leading-6 text-[var(--app-text)]">
              {prompt}
            </pre>
          </div>
        </section>
      ) : null}
    </section>
  )
}

export function createInstallPrompt(baseUrl: string, timezone: string, pairingCode: string) {
  return [
    '请在这台机器上安装并运行 TokenBoard collector。',
    '',
    '重要约束：',
    '- 只使用终端命令完成安装和 setup。',
    '- 不要使用浏览器、Playwright、网页抓取、fetch 或 curl 去访问 GitHub 页面。',
    '- 不要打印 upload token、配对响应、配置文件内容或任何本地隐私数据。',
    '- 如果已经安装了 TokenBoard skill，可以直接运行其中的 setup 脚本；否则用 git clone/update 仓库后运行脚本。',
    '',
    'macOS / Linux / Git Bash：',
    '```bash',
    'repo="$HOME/.tokenboard/TokenBoard"',
    'if [ -d "$repo/.git" ]; then',
    '  git -C "$repo" pull --ff-only',
    'else',
    '  mkdir -p "$HOME/.tokenboard"',
    '  git clone https://github.com/evepupil/TokenBoard.git "$repo"',
    'fi',
    `node "$repo/skills/tokenboard/scripts/setup.mjs" --pairing-code ${pairingCode} --base-url ${baseUrl} --timezone ${timezone}`,
    '```',
    '',
    'Windows PowerShell：',
    '```powershell',
    '$repo = Join-Path $HOME ".tokenboard\\TokenBoard"',
    'if (Test-Path (Join-Path $repo ".git")) {',
    '  git -C $repo pull --ff-only',
    '} else {',
    '  New-Item -ItemType Directory -Force (Split-Path $repo) | Out-Null',
    '  git clone https://github.com/evepupil/TokenBoard.git $repo',
    '}',
    `node (Join-Path $repo "skills\\tokenboard\\scripts\\setup.mjs") --pairing-code ${pairingCode} --base-url ${baseUrl} --timezone ${timezone}`,
    '```',
    '',
    '完成后只汇报：config 是否写入、每日计划是否安装、首次同步是否成功。'
  ].join('\n')
}
