import { Copy } from 'lucide'
import { LucideIcon } from '../../../components/ui/icon'
import {
  createDeviceLinkReconnectCommands,
  createInstallHookCommands,
  createInstallPrompt,
  createUninstallCommands
} from './install-command-commands'
export {
  createDeviceLinkReconnectCommands,
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
  collectorRepoRef?: string
  pairingCode?: string
  expiresAt?: string
  mode?: 'new' | 'reconnect'
  targetDeviceId?: string
}

export function InstallCommand(props: InstallCommandProps) {
  const prompt = props.pairingCode
    ? createInstallPrompt({
        baseUrl: props.baseUrl,
        timezone: props.timezone,
        pairingCode: props.pairingCode,
        collectorRepoUrl: props.collectorRepoUrl,
        collectorRepoRef: props.collectorRepoRef
      })
    : ''
  const installHookCommands = createInstallHookCommands({
    collectorRepoUrl: props.collectorRepoUrl,
    collectorRepoRef: props.collectorRepoRef
  })
  const deviceLinkReconnectCommands = createDeviceLinkReconnectCommands({
    baseUrl: props.baseUrl,
    timezone: props.timezone,
    collectorRepoUrl: props.collectorRepoUrl,
    collectorRepoRef: props.collectorRepoRef
  })
  const uninstallCommands = createUninstallCommands({
    collectorRepoUrl: props.collectorRepoUrl,
    collectorRepoRef: props.collectorRepoRef
  })

  return (
    <section class="app-folio-container flex flex-col gap-10 pb-14">
      <InstallCommandHeader mode={props.mode ?? 'new'} />
      <InstallTimezoneForm timezone={props.timezone} targetDeviceId={props.targetDeviceId} />
      <InstallPromptSection prompt={prompt} expiresAt={props.expiresAt} visible={Boolean(props.pairingCode)} />
      <div class="app-folio-chapter-rule grid gap-8 pt-8 lg:grid-cols-2">
        <HookCommandSection commands={installHookCommands} />
        <DeviceLinkReconnectCommandSection commands={deviceLinkReconnectCommands} />
      </div>
      <UninstallCommandSection commands={uninstallCommands} />
    </section>
  )
}

function InstallCommandHeader(props: { mode: 'new' | 'reconnect' }) {
  return (
    <header class="border-b border-[var(--app-border-strong)] pb-6">
      <p class="app-folio-kicker">04 — 本地采集器安装 · TOKENBOARD COLLECTOR</p>
      <h1 class="app-folio-h2 mt-2">
        {props.mode === 'reconnect' ? '重新连接旧设备' : '连接这台机器'}
      </h1>
      <p class="mt-3 max-w-2xl text-sm leading-6 text-[var(--app-muted)]">
        {props.mode === 'reconnect'
          ? '生成一个短期有效的重连提示词，把新的本地安装挂回旧设备记录。'
          : '生成一个短期有效的配对提示词，把它粘贴给 Codex 或 Claude Code，让本地 agent 用终端命令安装采集器并配置每日同步。'}
      </p>
    </header>
  )
}

function InstallTimezoneForm(props: { timezone: string; targetDeviceId?: string }) {
  return (
    <form
      method="post"
      class="border border-[var(--app-border)] bg-[var(--app-panel)] p-6"
      data-submit-feedback="true"
    >
      <label class="flex flex-col gap-2 font-mono text-xs font-semibold uppercase tracking-wide text-[var(--app-muted)]">
        时区
        <input
          class="min-h-11 border border-[var(--app-border)] bg-[var(--app-input)] px-3.5 py-2.5 font-sans text-sm text-[var(--app-text)] outline-none transition focus:border-[var(--app-accent-bar)] focus:ring-1 focus:ring-[var(--app-accent-bar)]"
          name="timezone"
          value={props.timezone}
          autocomplete="off"
          data-timezone-input="true"
          data-timezone-default={props.timezone}
          data-timezone-autofill="always"
        />
      </label>
      {props.targetDeviceId ? <input type="hidden" name="targetDeviceId" value={props.targetDeviceId} /> : null}
      <button
        class="mt-4 inline-flex min-h-11 w-full items-center justify-center border border-[var(--app-border-strong)] bg-[var(--app-text)] px-5 py-2.5 text-sm font-bold text-[var(--app-bg)] transition hover:border-[var(--app-accent-bar)] hover:bg-[var(--app-accent-bar)] hover:text-[var(--app-accent-bar-ink)] sm:w-auto"
        type="submit"
        data-submitting-label="正在生成..."
      >
        生成安装提示词 →
      </button>
    </form>
  )
}

function InstallPromptSection(props: { prompt: string; expiresAt?: string; visible: boolean }) {
  if (!props.visible) return null

  return (
    <section class="border border-[var(--app-border-strong)] bg-[var(--app-panel-strong)] p-6">
      <div class="flex flex-col gap-1">
        <p class="app-folio-kicker">PAIRING PROMPT · ONE-TIME</p>
        <h2 class="mt-1 text-lg font-extrabold">粘贴到 Codex 或 Claude Code</h2>
        <p class="font-mono text-xs text-[var(--app-muted)]">过期时间：{props.expiresAt}</p>
      </div>
      <div class="app-surface-subtle mt-4 overflow-hidden border border-[var(--app-border)] bg-[var(--app-bg-soft)] text-sm leading-6 text-[var(--app-text)]">
        <CopyBlockHeader title="安装提示词" targetId="install-prompt-text" label="复制安装提示词" />
        <pre id="install-prompt-text" class="overflow-x-auto p-4 font-mono text-xs leading-6">
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

function DeviceLinkReconnectCommandSection(props: { commands: { bash: string; powerShell: string } }) {
  return (
    <CommandSection
      title="使用 device-link 恢复旧设备"
      description="仅在这台机器仍保留 ~/.tokenboard/device-link.json，且需要挂回旧设备记录时使用。"
      commands={props.commands}
      idPrefix="device-link-reconnect"
      actionLabel="device-link 恢复命令"
    />
  )
}

function UninstallCommandSection(props: { commands: { bash: string; powerShell: string } }) {
  return (
    <CommandSection title="一键卸载 collector" commands={props.commands} idPrefix="uninstall" actionLabel="卸载命令" />
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
    <section class="border border-[var(--app-border)] bg-[var(--app-panel)] p-5">
      <div class="flex flex-col gap-1">
        <h2 class="text-base font-extrabold">{props.title}</h2>
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

export function CopyableCommandBlock(props: { title: string; command: string; targetId: string; copyLabel: string }) {
  return (
    <div class="min-w-0">
      <div class="app-surface-subtle overflow-hidden border border-[var(--app-border)] bg-[var(--app-panel-strong)] text-sm leading-6 text-[var(--app-text)]">
        <CopyBlockHeader title={props.title} targetId={props.targetId} label={props.copyLabel} />
        <pre id={props.targetId} class="overflow-x-auto p-4 font-mono text-xs leading-6">
          {props.command}
        </pre>
      </div>
    </div>
  )
}

function CopyBlockHeader(props: { title: string; targetId: string; label: string }) {
  return (
    <div class="flex min-h-11 items-center justify-between gap-3 border-b border-[var(--app-border)] bg-[var(--app-panel)] pl-4">
      <p class="min-w-0 font-mono text-xs text-[var(--app-muted)]">{props.title}</p>
      <CopyIconButton targetId={props.targetId} label={props.label} />
    </div>
  )
}

function CopyIconButton(props: { targetId: string; label: string }) {
  return (
    <button
      type="button"
      class="inline-flex min-h-11 w-11 shrink-0 items-center justify-center border-l border-[var(--app-border)] text-[var(--app-muted)] transition hover:bg-[var(--app-text)] hover:text-[var(--app-bg)] focus:outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--app-accent-bar)]"
      data-copy-target={props.targetId}
      aria-label={props.label}
      title={props.label}
    >
      <LucideIcon icon={Copy} size={16} />
    </button>
  )
}
