export const defaultCollectorRepoUrl = 'https://github.com/evepupil/TokenBoard.git'
import {
  createBashCloneRepoCommands,
  createBashUpdateExistingRepoCommands,
  createPowerShellCloneRepoCommands,
  createPowerShellUpdateExistingRepoCommands,
  escapeBashArg,
  escapePowerShellArg,
  indent
} from './install-command-git'

type CommandInput = {
  collectorRepoUrl?: string
  collectorRepoRef?: string
}

type InstallPromptInput = {
  baseUrl: string
  timezone: string
  pairingCode: string
  collectorRepoUrl?: string
  collectorRepoRef?: string
}

type DeviceLinkReconnectCommandInput = CommandInput & {
  baseUrl: string
  timezone: string
}

function createInstallPromptContext(input: InstallPromptInput) {
  const collectorRepoUrl = input.collectorRepoUrl || defaultCollectorRepoUrl
  const collectorRepoRef = normalizeOptionalRef(input.collectorRepoRef)
  return {
    collectorRepoUrl,
    collectorRepoRef,
    bashRepoUrl: escapeBashArg(collectorRepoUrl),
    bashRepoRef: collectorRepoRef ? escapeBashArg(collectorRepoRef) : null,
    bashPairingCode: escapeBashArg(input.pairingCode),
    bashBaseUrl: escapeBashArg(input.baseUrl),
    bashTimezone: escapeBashArg(input.timezone),
    powerShellRepoUrl: escapePowerShellArg(collectorRepoUrl),
    powerShellRepoRef: collectorRepoRef ? escapePowerShellArg(collectorRepoRef) : null,
    powerShellPairingCode: escapePowerShellArg(input.pairingCode),
    powerShellBaseUrl: escapePowerShellArg(input.baseUrl),
    powerShellTimezone: escapePowerShellArg(input.timezone),
    setupRepoArg: collectorRepoUrl === defaultCollectorRepoUrl ? null : collectorRepoUrl,
    setupRepoRefArg: collectorRepoRef
  }
}

export function createInstallPrompt(input: InstallPromptInput) {
  const context = createInstallPromptContext(input)
  return [
    ...createInstallPromptIntro(),
    '',
    ...createInstallPromptBashBlock(context),
    '',
    ...createInstallPromptPowerShellBlock(context),
    '',
    '完成后只汇报：config 是否写入、每日计划是否安装、已安装的触发时间、首次同步是否成功。'
  ].join('\n')
}

function createInstallPromptIntro() {
  return [
    '请在这台机器上安装或升级 TokenBoard collector。',
    '本提示词同时适用于首次安装和旧版 collector 升级；必须在需要同步用量的目标机器上执行。',
    '',
    '重要约束：',
    '- 只使用终端命令完成安装和 setup。',
    '- 不要使用浏览器、Playwright、网页抓取、fetch 或 curl 去访问 GitHub 页面。',
    '- 不要打印 upload token、配对响应、配置文件内容或任何本地隐私数据。',
    '- 如果已经安装旧版 TokenBoard collector，更新现有 checkout 后重新运行 setup；setup 会为当前 server 写入独立 profile，刷新 upload token/deviceId/installationId 和每日定时任务，不会覆盖其它 server 的已保存凭证。',
    '- 不要为了升级手动删除 ~/.tokenboard/config.json，也不要卸载旧计划任务；除非用户明确要求重装或卸载。',
    '- setup 可能写入 ~/.tokenboard/device-link.json 作为敏感恢复状态；不要打印、复制或上传这个文件。',
    '- 只有用户明确要求用本机 device-link 恢复旧设备时，才允许在没有 --pairing-code 的恢复命令中使用 --use-device-link；失败必须停止，不要改成新设备安装。',
    '- 如果已经安装了 TokenBoard skill，可以直接运行其中的 setup 脚本；否则用 git clone/update 仓库后运行脚本。',
    '- 如果提示词里带有 --repo-ref 或 --branch，请保留它们，不要改回默认分支。',
    '- 首次安装默认执行全量同步，用于补齐历史 Claude Code / Codex / Antigravity 用量；不要擅自改成最近 7 天窗口。',
    '- 历史会话很多时首次全量可能耗时较长；保持命令运行，不要把长时间解析误判为失败。',
    '- 使用 TOKENBOARD_CODEX_BATCH_SIZE=200 控制 Codex 历史会话分批处理，只有用户明确要求降低资源峰值时才调小。',
    '- 只有用户明确要求跳过首次同步时，才允许添加 --skip-initial-sync。',
    '- 默认安装 Codex 和 Claude Code notifier hooks；Antigravity CLI status line capture 是显式 opt-in，只有用户要求近实时采集 agy 时才单独运行 install-hook.mjs --source antigravity-cli。',
    '- Antigravity 三类产品的历史用量仍由定时同步读取本地历史；不依赖 status line capture。',
    '- 只有用户明确要求不安装 hooks 时，才允许添加 --skip-hook；后续可单独运行 install-hook.mjs --source all 补装 Codex / Claude Code hooks。',
    '- setup 命令已经带有网页检测或表单确认的 --timezone；不要改成其它时区，除非用户明确要求。',
    '- 执行 setup 前必须先向用户确认每日任务触发时间：默认是 09:00,12:00,18:00,23:00；如果用户要自定义，只接受 24 小时制 HH:MM 逗号分隔列表。',
    '- 根据用户确认的时间把 setup 命令中的 --schedule-times 参数替换为实际值，不要让用户手工创建定时任务。'
  ]
}

function createInstallPromptBashBlock(context: ReturnType<typeof createInstallPromptContext>) {
  const setupRepoArg = context.setupRepoArg ? ` --repo-url ${context.bashRepoUrl}` : ''
  const setupRepoRefArg = context.setupRepoRefArg ? ` --repo-ref ${context.bashRepoRef}` : ''
  return [
    'macOS / Linux / Git Bash：',
    '```bash',
    'set -euo pipefail',
    'repo="$HOME/.tokenboard/TokenBoard"',
    'if [ -d "$repo/.git" ]; then',
    ...indent(createBashUpdateExistingRepoCommands(context.collectorRepoUrl, context.collectorRepoRef)),
    'else',
    '  if [ -e "$repo" ]; then rm -rf "$repo"; fi',
    '  mkdir -p "$HOME/.tokenboard"',
    ...indent(createBashCloneRepoCommands(context.collectorRepoUrl, context.collectorRepoRef)),
    'fi',
    `TOKENBOARD_CODEX_BATCH_SIZE=200 node "$repo/skills/tokenboard/scripts/setup.mjs" --pairing-code ${context.bashPairingCode} --base-url ${context.bashBaseUrl} --timezone ${context.bashTimezone} --schedule-times "09:00,12:00,18:00,23:00"${setupRepoArg}${setupRepoRefArg}`,
    '```'
  ].filter(Boolean)
}

function createInstallPromptPowerShellBlock(context: ReturnType<typeof createInstallPromptContext>) {
  const setupRepoArg = context.setupRepoArg ? ` --repo-url ${context.powerShellRepoUrl}` : ''
  const setupRepoRefArg = context.setupRepoRefArg ? ` --repo-ref ${context.powerShellRepoRef}` : ''
  return [
    'Windows PowerShell：',
    '```powershell',
    '$ErrorActionPreference = "Stop"',
    'function Invoke-Git { git @args; if ($LASTEXITCODE -ne 0) { throw "git failed with exit code $LASTEXITCODE" } }',
    '$repo = Join-Path $HOME ".tokenboard\\TokenBoard"',
    'if (Test-Path (Join-Path $repo ".git")) {',
    ...indent(createPowerShellUpdateExistingRepoCommands(context.collectorRepoUrl, context.collectorRepoRef)),
    '} else {',
    '  if (Test-Path $repo) { Remove-Item -Recurse -Force $repo }',
    '  New-Item -ItemType Directory -Force (Split-Path $repo) | Out-Null',
    ...indent(createPowerShellCloneRepoCommands(context.collectorRepoUrl, context.collectorRepoRef)),
    '}',
    '$env:TOKENBOARD_CODEX_BATCH_SIZE = "200"',
    `node (Join-Path $repo "skills\\tokenboard\\scripts\\setup.mjs") --pairing-code ${context.powerShellPairingCode} --base-url ${context.powerShellBaseUrl} --timezone ${context.powerShellTimezone} --schedule-times "09:00,12:00,18:00,23:00"${setupRepoArg}${setupRepoRefArg}`,
    '```'
  ].filter(Boolean)
}

export function createInstallHookCommands(input: CommandInput = {}) {
  const bootstrap = createBootstrapCommands(input)
  return {
    bash: [
      ...bootstrap.bash,
      '# all installs Codex and Claude Code hooks; install Antigravity CLI capture separately with --source antigravity-cli.',
      'node "$repo/skills/tokenboard/scripts/install-hook.mjs" --source all'
    ].join('\n'),
    powerShell: [
      ...bootstrap.powerShell,
      '# all installs Codex and Claude Code hooks; install Antigravity CLI capture separately with --source antigravity-cli.',
      'node (Join-Path $repo "skills\\tokenboard\\scripts\\install-hook.mjs") --source all'
    ].join('\n')
  }
}

export function createDeviceLinkReconnectCommands(input: DeviceLinkReconnectCommandInput) {
  const bootstrap = createBootstrapCommands(input)
  const context = createDeviceLinkReconnectCommandContext(input)
  return {
    bash: [
      ...bootstrap.bash,
      '# Explicit recovery path: uses local ~/.tokenboard/device-link.json and does not need a pairing code.',
      `TOKENBOARD_CODEX_BATCH_SIZE=200 node "$repo/skills/tokenboard/scripts/setup.mjs" --use-device-link --base-url ${context.bashBaseUrl} --timezone ${context.bashTimezone} --schedule-times "09:00,12:00,18:00,23:00"${context.bashSetupRepoArg}${context.bashSetupRepoRefArg}`
    ].join('\n'),
    powerShell: [
      ...bootstrap.powerShell,
      '# Explicit recovery path: uses local ~/.tokenboard/device-link.json and does not need a pairing code.',
      '$env:TOKENBOARD_CODEX_BATCH_SIZE = "200"',
      `node (Join-Path $repo "skills\\tokenboard\\scripts\\setup.mjs") --use-device-link --base-url ${context.powerShellBaseUrl} --timezone ${context.powerShellTimezone} --schedule-times "09:00,12:00,18:00,23:00"${context.powerShellSetupRepoArg}${context.powerShellSetupRepoRefArg}`
    ].join('\n')
  }
}

export function createUninstallCommands(input: CommandInput = {}) {
  const bootstrap = createBootstrapCommands(input)
  return {
    bash: [
      ...bootstrap.bash,
      '# --all removes local config, collector checkout, hooks, schedule, and device-link recovery state.',
      'node "$repo/skills/tokenboard/scripts/uninstall.mjs" --all'
    ].join('\n'),
    powerShell: [
      ...bootstrap.powerShell,
      '# --all removes local config, collector checkout, hooks, schedule, and device-link recovery state.',
      'node (Join-Path $repo "skills\\tokenboard\\scripts\\uninstall.mjs") --all'
    ].join('\n')
  }
}

export function createUninstallCommand(input: CommandInput = {}) {
  const commands = createUninstallCommands(input)
  return [
    'macOS / Linux / Git Bash：',
    '```bash',
    commands.bash,
    '```',
    '',
    'Windows PowerShell：',
    '```powershell',
    commands.powerShell,
    '```'
  ].join('\n')
}

function createDeviceLinkReconnectCommandContext(input: DeviceLinkReconnectCommandInput) {
  const collectorRepoUrl = input.collectorRepoUrl || defaultCollectorRepoUrl
  const collectorRepoRef = normalizeOptionalRef(input.collectorRepoRef)
  return {
    bashBaseUrl: escapeBashArg(input.baseUrl),
    bashTimezone: escapeBashArg(input.timezone),
    bashSetupRepoArg:
      collectorRepoUrl === defaultCollectorRepoUrl ? '' : ` --repo-url ${escapeBashArg(collectorRepoUrl)}`,
    bashSetupRepoRefArg: collectorRepoRef ? ` --repo-ref ${escapeBashArg(collectorRepoRef)}` : '',
    powerShellBaseUrl: escapePowerShellArg(input.baseUrl),
    powerShellTimezone: escapePowerShellArg(input.timezone),
    powerShellSetupRepoArg:
      collectorRepoUrl === defaultCollectorRepoUrl ? '' : ` --repo-url ${escapePowerShellArg(collectorRepoUrl)}`,
    powerShellSetupRepoRefArg: collectorRepoRef ? ` --repo-ref ${escapePowerShellArg(collectorRepoRef)}` : ''
  }
}

function createBootstrapCommands(input: CommandInput) {
  const collectorRepoUrl = input.collectorRepoUrl || defaultCollectorRepoUrl
  const collectorRepoRef = normalizeOptionalRef(input.collectorRepoRef)
  return {
    bash: [
      'set -euo pipefail',
      'repo="$HOME/.tokenboard/TokenBoard"',
      'if [ -d "$repo/.git" ]; then',
      ...indent(createBashUpdateExistingRepoCommands(collectorRepoUrl, collectorRepoRef)),
      'else',
      '  if [ -e "$repo" ]; then rm -rf "$repo"; fi',
      '  mkdir -p "$HOME/.tokenboard"',
      ...indent(createBashCloneRepoCommands(collectorRepoUrl, collectorRepoRef)),
      'fi'
    ].filter(Boolean),
    powerShell: [
      '$ErrorActionPreference = "Stop"',
      'function Invoke-Git { git @args; if ($LASTEXITCODE -ne 0) { throw "git failed with exit code $LASTEXITCODE" } }',
      '$repo = Join-Path $HOME ".tokenboard\\TokenBoard"',
      'if (Test-Path (Join-Path $repo ".git")) {',
      ...indent(createPowerShellUpdateExistingRepoCommands(collectorRepoUrl, collectorRepoRef)),
      '} else {',
      '  if (Test-Path $repo) { Remove-Item -Recurse -Force $repo }',
      '  New-Item -ItemType Directory -Force (Split-Path $repo) | Out-Null',
      ...indent(createPowerShellCloneRepoCommands(collectorRepoUrl, collectorRepoRef)),
      '}'
    ].filter(Boolean)
  }
}

function normalizeOptionalRef(value?: string) {
  const ref = value?.trim()
  return ref || null
}
