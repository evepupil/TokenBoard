export const defaultCollectorRepoUrl = 'https://github.com/evepupil/TokenBoard.git'

type CommandInput = {
  collectorRepoUrl?: string
}

type InstallPromptInput = {
  baseUrl: string
  timezone: string
  pairingCode: string
  collectorRepoUrl?: string
}

function createInstallPromptContext(input: InstallPromptInput) {
  const collectorRepoUrl = input.collectorRepoUrl || defaultCollectorRepoUrl
  return {
    bashRepoUrl: escapeBashArg(collectorRepoUrl),
    bashPairingCode: escapeBashArg(input.pairingCode),
    bashBaseUrl: escapeBashArg(input.baseUrl),
    bashTimezone: escapeBashArg(input.timezone),
    powerShellRepoUrl: escapePowerShellArg(collectorRepoUrl),
    powerShellPairingCode: escapePowerShellArg(input.pairingCode),
    powerShellBaseUrl: escapePowerShellArg(input.baseUrl),
    powerShellTimezone: escapePowerShellArg(input.timezone),
    setupRepoArg: collectorRepoUrl === defaultCollectorRepoUrl ? null : collectorRepoUrl
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
    '- 如果已经安装旧版 TokenBoard collector，更新现有 checkout 后重新运行 setup；setup 会重新配对设备、刷新 upload token/deviceId、刷新每日定时任务。',
    '- 不要为了升级手动删除 ~/.tokenboard/config.json，也不要卸载旧计划任务；除非用户明确要求重装或卸载。',
    '- 如果已经安装了 TokenBoard skill，可以直接运行其中的 setup 脚本；否则用 git clone/update 仓库后运行脚本。',
    '- 首次安装默认执行全量同步，用于补齐历史 Claude Code / Codex 用量；不要擅自改成最近 7 天窗口。',
    '- 历史会话很多时首次全量可能耗时较长；保持命令运行，不要把长时间解析误判为失败。',
    '- 使用 TOKENBOARD_CODEX_BATCH_SIZE=200 控制 Codex 历史会话分批处理，只有用户明确要求降低资源峰值时才调小。',
    '- 只有用户明确要求跳过首次同步时，才允许添加 --skip-initial-sync。',
    '- 默认安装 Codex 和 Claude Code notifier hooks，用于本机会话结束后的近实时增量同步。',
    '- 只有用户明确要求不安装 hooks 时，才允许添加 --skip-hook；后续可单独运行 install-hook.mjs --source all 补装。',
    '- setup 命令已经带有网页检测或表单确认的 --timezone；不要改成其它时区，除非用户明确要求。',
    '- 执行 setup 前必须先向用户确认每日任务触发时间：默认是 09:00,12:00,18:00,23:00；如果用户要自定义，只接受 24 小时制 HH:MM 逗号分隔列表。',
    '- 根据用户确认的时间把 setup 命令中的 --schedule-times 参数替换为实际值，不要让用户手工创建定时任务。'
  ]
}

function createInstallPromptBashBlock(context: ReturnType<typeof createInstallPromptContext>) {
  const setupRepoArg = context.setupRepoArg ? ` --repo-url ${context.bashRepoUrl}` : ''
  return [
    'macOS / Linux / Git Bash：',
    '```bash',
    'repo="$HOME/.tokenboard/TokenBoard"',
    'if [ -d "$repo/.git" ]; then',
    '  git -C "$repo" pull --ff-only',
    'else',
    '  if [ -e "$repo" ]; then rm -rf "$repo"; fi',
    '  mkdir -p "$HOME/.tokenboard"',
    `  git clone ${context.bashRepoUrl} "$repo"`,
    'fi',
    `TOKENBOARD_CODEX_BATCH_SIZE=200 node "$repo/skills/tokenboard/scripts/setup.mjs" --pairing-code ${context.bashPairingCode} --base-url ${context.bashBaseUrl} --timezone ${context.bashTimezone} --schedule-times "09:00,12:00,18:00,23:00"${setupRepoArg}`,
    '```'
  ]
}

function createInstallPromptPowerShellBlock(context: ReturnType<typeof createInstallPromptContext>) {
  const setupRepoArg = context.setupRepoArg ? ` --repo-url ${context.powerShellRepoUrl}` : ''
  return [
    'Windows PowerShell：',
    '```powershell',
    '$repo = Join-Path $HOME ".tokenboard\\TokenBoard"',
    'if (Test-Path (Join-Path $repo ".git")) {',
    '  git -C $repo pull --ff-only',
    '} else {',
    '  if (Test-Path $repo) { Remove-Item -Recurse -Force $repo }',
    '  New-Item -ItemType Directory -Force (Split-Path $repo) | Out-Null',
    `  git clone ${context.powerShellRepoUrl} $repo`,
    '}',
    '$env:TOKENBOARD_CODEX_BATCH_SIZE = "200"',
    `node (Join-Path $repo "skills\\tokenboard\\scripts\\setup.mjs") --pairing-code ${context.powerShellPairingCode} --base-url ${context.powerShellBaseUrl} --timezone ${context.powerShellTimezone} --schedule-times "09:00,12:00,18:00,23:00"${setupRepoArg}`,
    '```'
  ]
}

export function createInstallHookCommands(input: CommandInput = {}) {
  const bootstrap = createBootstrapCommands(input)
  return {
    bash: [
      ...bootstrap.bash,
      '# To install only one source, replace all with codex or claude-code.',
      'node "$repo/skills/tokenboard/scripts/install-hook.mjs" --source all'
    ].join('\n'),
    powerShell: [
      ...bootstrap.powerShell,
      '# To install only one source, replace all with codex or claude-code.',
      'node (Join-Path $repo "skills\\tokenboard\\scripts\\install-hook.mjs") --source all'
    ].join('\n')
  }
}

export function createUninstallCommands(input: CommandInput = {}) {
  const bootstrap = createBootstrapCommands(input)
  return {
    bash: [
      ...bootstrap.bash,
      'node "$repo/skills/tokenboard/scripts/uninstall.mjs" --all'
    ].join('\n'),
    powerShell: [
      ...bootstrap.powerShell,
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

function createBootstrapCommands(input: CommandInput) {
  const collectorRepoUrl = input.collectorRepoUrl || defaultCollectorRepoUrl
  return {
    bash: [
      'repo="$HOME/.tokenboard/TokenBoard"',
      'if [ -d "$repo/.git" ]; then',
      '  git -C "$repo" pull --ff-only',
      'else',
      '  if [ -e "$repo" ]; then rm -rf "$repo"; fi',
      '  mkdir -p "$HOME/.tokenboard"',
      `  git clone ${escapeBashArg(collectorRepoUrl)} "$repo"`,
      'fi'
    ],
    powerShell: [
      '$repo = Join-Path $HOME ".tokenboard\\TokenBoard"',
      'if (Test-Path (Join-Path $repo ".git")) {',
      '  git -C $repo pull --ff-only',
      '} else {',
      '  if (Test-Path $repo) { Remove-Item -Recurse -Force $repo }',
      '  New-Item -ItemType Directory -Force (Split-Path $repo) | Out-Null',
      `  git clone ${escapePowerShellArg(collectorRepoUrl)} $repo`,
      '}'
    ]
  }
}

function escapeBashArg(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function escapePowerShellArg(value: string) {
  return `"${value
    .replaceAll('`', '``')
    .replaceAll('"', '`"')
    .replaceAll('$', '`$')}"`
}
