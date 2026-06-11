import { Copy } from 'lucide'
import { LucideIcon } from '../../../components/ui/icon'
import {
  createInstallHookCommands,
  createInstallPrompt,
  createUninstallCommands
} from './install-command-commands'
export {
  createInstallHookCommands,
  createInstallPrompt,
  createUninstallCommand,
  createUninstallCommands,
  defaultCollectorRepoUrl
} from './install-command-commands'

export type InstallCommandProps = {
  baseUrl: string
  timezone: string
  collectorRepoUrl?: string
  pairingCode?: string
  expiresAt?: string
}

export function InstallCommand(props: InstallCommandProps) {
  const prompt = props.pairingCode
    ? createInstallPrompt({
        baseUrl: props.baseUrl,
        timezone: props.timezone,
        pairingCode: props.pairingCode,
        collectorRepoUrl: props.collectorRepoUrl
      })
    : ''
  const installHookCommands = createInstallHookCommands({
    collectorRepoUrl: props.collectorRepoUrl
  })
  const uninstallCommands = createUninstallCommands({
    collectorRepoUrl: props.collectorRepoUrl
  })

  return (
    <section class="mx-auto flex max-w-4xl flex-col gap-5">
      <InstallCommandHeader />
      <InstallTimezoneForm timezone={props.timezone} />
      <InstallPromptSection prompt={prompt} expiresAt={props.expiresAt} visible={Boolean(props.pairingCode)} />
      <HookCommandSection commands={installHookCommands} />
      <UninstallCommandSection commands={uninstallCommands} />
    </section>
  )
}

function InstallCommandHeader() {
  return (
    <header class="app-surface-raised relative overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[radial-gradient(circle_at_90%_10%,rgba(190,242,100,.2),transparent_28%),var(--app-panel)] p-5 sm:p-6">
      <div class="absolute -right-16 -top-16 h-40 w-40 rounded-full border border-lime-300/20" />
      <p class="app-accent-text text-sm font-black uppercase tracking-[0.28em]">TokenBoard Collector</p>
      <h1 class="mt-4 text-3xl font-black tracking-tight sm:text-4xl">连接这台机器</h1>
      <p class="mt-3 max-w-2xl text-sm leading-6 text-[var(--app-muted)]">
        生成一个短期有效的配对提示词，把它粘贴给 Codex 或 Claude Code，让本地 agent 用终端命令安装采集器并配置每日同步。
      </p>
    </header>
  )
}

function InstallTimezoneForm(props: { timezone: string }) {
  return (
    <form method="post" class="app-surface-raised rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 backdrop-blur">
      <label class="flex flex-col gap-2 text-sm font-bold text-[var(--app-muted)]">
        时区
        <input
          class="min-h-11 rounded-xl border border-[var(--app-border)] bg-[var(--app-input)] px-4 py-3 text-[var(--app-text)] outline-none transition focus:border-lime-300 focus:ring-2 focus:ring-lime-300/20"
          name="timezone"
          value={props.timezone}
          autocomplete="off"
          data-timezone-input="true"
          data-timezone-default={props.timezone}
          data-timezone-autofill="always"
        />
      </label>
      <button
        class="mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-lime-300 px-4 py-2.5 text-sm font-black text-stone-950 transition hover:bg-lime-200 sm:w-auto"
        type="submit"
      >
        生成安装提示词
      </button>
    </form>
  )
}

function InstallPromptSection(props: { prompt: string; expiresAt?: string; visible: boolean }) {
  if (!props.visible) return null

  return (
    <section class="app-surface-raised rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 backdrop-blur">
      <div class="flex flex-col gap-1">
        <h2 class="text-base font-black">粘贴到 Codex 或 Claude Code</h2>
        <p class="text-sm text-[var(--app-muted)]">过期时间：{props.expiresAt}</p>
      </div>
      <div class="app-surface-subtle mt-4 overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] text-sm leading-6 text-[var(--app-text)]">
        <CopyBlockHeader title="安装提示词" targetId="install-prompt-text" label="复制安装提示词" />
        <pre id="install-prompt-text" class="overflow-x-auto p-4">
          {props.prompt}
        </pre>
      </div>
    </section>
  )
}

function HookCommandSection(props: { commands: { bash: string; powerShell: string } }) {
  return (
    <CommandSection
      title="单独安装 notifier hooks"
      description="适用于首次 setup 跳过 hooks，或后续只补装 Codex / Claude Code 近实时同步触发。"
      commands={props.commands}
      idPrefix="install-hook"
      actionLabel="hook 安装命令"
    />
  )
}

function UninstallCommandSection(props: { commands: { bash: string; powerShell: string } }) {
  return (
    <CommandSection
      title="一键卸载 collector"
      commands={props.commands}
      idPrefix="uninstall"
      actionLabel="卸载命令"
    />
  )
}

function CommandSection(props: {
  title: string
  description?: string
  commands: { bash: string; powerShell: string }
  idPrefix: string
  actionLabel: string
}) {
  return (
    <section class="app-surface-raised rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 backdrop-blur">
      <div class="flex flex-col gap-1">
        <h2 class="text-base font-black">{props.title}</h2>
        {props.description ? <p class="text-sm text-[var(--app-muted)]">{props.description}</p> : null}
      </div>
      <div class="mt-4 flex flex-col gap-4">
        <CopyableCommandBlock
          title="macOS / Linux / Git Bash"
          command={props.commands.bash}
          targetId={`${props.idPrefix}-bash-command-text`}
          copyLabel={`复制 macOS / Linux / Git Bash ${props.actionLabel}`}
        />
        <CopyableCommandBlock
          title="Windows PowerShell"
          command={props.commands.powerShell}
          targetId={`${props.idPrefix}-powershell-command-text`}
          copyLabel={`复制 Windows PowerShell ${props.actionLabel}`}
        />
      </div>
    </section>
  )
}

function CopyableCommandBlock(props: {
  title: string
  command: string
  targetId: string
  copyLabel: string
}) {
  return (
    <div class="min-w-0">
      <div class="app-surface-subtle overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg-soft)] text-sm leading-6 text-[var(--app-text)]">
        <CopyBlockHeader title={props.title} targetId={props.targetId} label={props.copyLabel} />
        <pre id={props.targetId} class="overflow-x-auto p-4">{props.command}</pre>
      </div>
    </div>
  )
}

function CopyBlockHeader(props: { title: string; targetId: string; label: string }) {
  return (
    <div class="flex min-h-12 items-center justify-between gap-3 border-b border-[var(--app-border)] bg-[var(--app-panel)] pl-4">
      <p class="min-w-0 font-mono text-[var(--app-muted)]">{props.title}</p>
      <CopyIconButton targetId={props.targetId} label={props.label} />
    </div>
  )
}

function CopyIconButton(props: { targetId: string; label: string }) {
  return (
    <button
      type="button"
      class="inline-flex min-h-12 w-12 shrink-0 items-center justify-center border-l border-[var(--app-border)] text-[var(--app-muted)] transition hover:bg-[var(--app-hover)] hover:text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-lime-300/30"
      data-copy-target={props.targetId}
      aria-label={props.label}
      title={props.label}
    >
      <LucideIcon icon={Copy} size={17} />
    </button>
  )
}
