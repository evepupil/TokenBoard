import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import {
  createDeviceLinkReconnectCommands,
  createInstallHookCommands,
  createInstallPrompt,
  createUninstallCommand,
  createUninstallCommands,
  InstallCommand
} from './install-command'

describe('InstallCommand', () => {
  test('renders a copy action for the generated install prompt', async () => {
    const html = await renderToString(
      <InstallCommand
        baseUrl="https://tokenboard.example"
        timezone="Asia/Shanghai"
        pairingCode="pair_123"
        expiresAt="2026-04-29T18:00:00.000Z"
      />
    )

    expect(html).toContain('data-copy-target="install-prompt-text"')
    expect(html).toContain('data-copy-target="install-hook-bash-command-text"')
    expect(html).toContain('data-copy-target="install-hook-powershell-command-text"')
    expect(html).toContain('data-copy-target="device-link-reconnect-bash-command-text"')
    expect(html).toContain('data-copy-target="device-link-reconnect-powershell-command-text"')
    expect(html).toContain('data-copy-target="uninstall-bash-command-text"')
    expect(html).toContain('data-copy-target="uninstall-powershell-command-text"')
    expect(html).toContain('data-timezone-input="true"')
    expect(html).toContain('data-timezone-default="Asia/Shanghai"')
    expect(html).toContain('data-timezone-autofill="always"')
    expect(html).toContain('data-submit-feedback="true"')
    expect(html).toContain('data-submitting-label="正在生成..."')
    expect(html).toContain('autocomplete="off"')
    expect(html).toContain('aria-label="复制安装提示词"')
    expect(html).toContain('aria-label="复制 macOS / Linux / Git Bash hook 安装命令"')
    expect(html).toContain('aria-label="复制 Windows PowerShell hook 安装命令"')
    expect(html).toContain('aria-label="复制 macOS / Linux / Git Bash device-link 恢复命令"')
    expect(html).toContain('aria-label="复制 Windows PowerShell device-link 恢复命令"')
    expect(html).toContain('aria-label="复制 macOS / Linux / Git Bash 卸载命令"')
    expect(html).toContain('aria-label="复制 Windows PowerShell 卸载命令"')
    expect(html).toContain('flex min-h-12 items-center justify-between')
    expect(html).toContain('app-surface-subtle mt-4 overflow-hidden')
    expect(html).toContain('app-surface-subtle overflow-hidden rounded-xl')
    expect(html).toContain('border-b border-[var(--app-border)]')
    expect(html).not.toContain('absolute right-3 top-3')
    expect(html).not.toContain('pr-16 pt-14')
    expect(html).toContain('macOS / Linux / Git Bash')
    expect(html).toContain('Windows PowerShell')
    expect(html).toContain('skills/tokenboard/scripts/setup.mjs')
    expect(html).toContain('skills/tokenboard/scripts/install-hook.mjs')
    expect(html).toContain('skills/tokenboard/scripts/uninstall.mjs')
    expect(html).toContain('使用 device-link 恢复旧设备')
    expect(html).toContain('仅在这台机器仍保留 ~/.tokenboard/device-link.json')
  })

  test('generates a direct shell-oriented prompt that discourages browser detours', () => {
    const prompt = createInstallPrompt({
      baseUrl: 'https://tokenboard.example',
      timezone: 'Asia/Shanghai',
      pairingCode: 'pair_123'
    })

    expect(prompt).toContain('不要使用浏览器、Playwright、网页抓取、fetch 或 curl')
    expect(prompt).toContain('首次安装默认执行全量同步')
    expect(prompt).toContain('补齐历史 Claude Code / Codex / Antigravity 用量')
    expect(prompt).toContain('不要擅自改成最近 7 天窗口')
    expect(prompt).toContain('TOKENBOARD_CODEX_BATCH_SIZE=200')
    expect(prompt).toContain('$env:TOKENBOARD_CODEX_BATCH_SIZE = "200"')
    expect(prompt).toContain('只有用户明确要求跳过首次同步')
    expect(prompt).toContain('默认安装 Codex 和 Claude Code notifier hooks')
    expect(prompt).toContain('Antigravity CLI status line capture 是显式 opt-in')
    expect(prompt).toContain('install-hook.mjs --source antigravity-cli')
    expect(prompt).toContain('Antigravity 三类产品的历史用量仍由定时同步读取本地历史')
    expect(prompt).toContain('只有用户明确要求不安装 hooks 时，才允许添加 --skip-hook')
    expect(prompt).toContain('install-hook.mjs --source all 补装 Codex / Claude Code hooks')
    expect(prompt).toContain('网页检测或表单确认的 --timezone')
    expect(prompt).toContain("git clone 'https://github.com/evepupil/TokenBoard.git'")
    expect(prompt).toContain('git -C "$repo" pull --ff-only')
    expect(prompt).toContain('rm -rf "$repo"')
    expect(prompt).toContain('skills/tokenboard/scripts/setup.mjs')
    expect(prompt).toContain("--pairing-code 'pair_123'")
    expect(prompt).toContain("--base-url 'https://tokenboard.example'")
    expect(prompt).toContain("--timezone 'Asia/Shanghai'")
    expect(prompt).toContain('必须先向用户确认每日任务触发时间')
    expect(prompt).toContain('--schedule-times "09:00,12:00,18:00,23:00"')
    expect(prompt).toContain('已安装的触发时间')
    expect(prompt).not.toContain('从这个 GitHub repo 路径安装')
    expect(prompt).not.toContain('node scripts/setup.mjs')
  })

  test('makes the old-client upgrade path explicit for agents', () => {
    const prompt = createInstallPrompt({
      baseUrl: 'https://tokenboard.example',
      timezone: 'Asia/Shanghai',
      pairingCode: 'pair_123'
    })

    expect(prompt).toContain('本提示词同时适用于首次安装和旧版 collector 升级')
    expect(prompt).toContain('必须在需要同步用量的目标机器上执行')
    expect(prompt).toContain('如果已经安装旧版 TokenBoard collector，更新现有 checkout 后重新运行 setup')
    expect(prompt).toContain('不要为了升级手动删除 ~/.tokenboard/config.json')
    expect(prompt).toContain('~/.tokenboard/device-link.json 作为敏感恢复状态')
    expect(prompt).toContain('不要打印、复制或上传这个文件')
    expect(prompt).toContain('只有用户明确要求用本机 device-link 恢复旧设备')
    expect(prompt).toContain('失败必须停止，不要改成新设备安装')
    expect(prompt).toContain('当前 server 写入独立 profile')
    expect(prompt).toContain('刷新 upload token/deviceId/installationId 和每日定时任务')
    expect(prompt).toContain('不会覆盖其它 server 的已保存凭证')
  })

  test('renders reconnect copy for old device pairing', async () => {
    const html = await renderToString(
      <InstallCommand
        baseUrl="https://tokenboard.example"
        timezone="Asia/Shanghai"
        pairingCode="pair_123"
        expiresAt="2026-04-29T18:00:00.000Z"
        mode="reconnect"
        targetDeviceId="dev_old"
      />
    )

    expect(html).toContain('重新连接旧设备')
    expect(html).toContain('新的本地安装挂回旧设备记录')
    expect(html).toContain('name="targetDeviceId"')
    expect(html).toContain('value="dev_old"')
    expect(html).toContain('data-copy-target="install-prompt-text"')
  })

  test('allows deployments to override the collector repo url', () => {
    const prompt = createInstallPrompt({
      baseUrl: 'https://tokenboard.example',
      timezone: 'Asia/Shanghai',
      pairingCode: 'pair_123',
      collectorRepoUrl: 'https://github.com/example/TokenBoard.git'
    })

    expect(prompt).toContain("git clone 'https://github.com/example/TokenBoard.git'")
    expect(prompt).toContain("--repo-url 'https://github.com/example/TokenBoard.git'")
    expect(prompt).toContain('--repo-url "https://github.com/example/TokenBoard.git"')
    expect(prompt).not.toContain("git clone 'https://github.com/evepupil/TokenBoard.git'")
  })

  test('allows deployments to pin a collector ref for feature branch installs', () => {
    const prompt = createInstallPrompt({
      baseUrl: 'https://tokenboard.example',
      timezone: 'Asia/Shanghai',
      pairingCode: 'pair_123',
      collectorRepoUrl: 'https://github.com/example/TokenBoard.git',
      collectorRepoRef: 'research/agy-token-support-plan'
    })

    expect(prompt).toContain('如果提示词里带有 --repo-ref 或 --branch')
    expect(prompt).toContain('git clone --depth 1 --no-checkout \'https://github.com/example/TokenBoard.git\' "$repo"')
    expect(prompt).toContain(
      'git -C "$repo" fetch --depth 1 origin \'+refs/heads/research/agy-token-support-plan:refs/remotes/origin/research/agy-token-support-plan\''
    )
    expect(prompt).toContain(
      "git -C \"$repo\" checkout -B 'research/agy-token-support-plan' 'refs/remotes/origin/research/agy-token-support-plan'"
    )
    expect(prompt).toContain('git -C "$repo" fetch --depth 1 origin \'research/agy-token-support-plan\'')
    expect(prompt).toContain('git -C "$repo" checkout FETCH_HEAD')
    expect(prompt).toContain("--repo-ref 'research/agy-token-support-plan'")
    expect(prompt).toContain('--repo-ref "research/agy-token-support-plan"')
  })

  test('tries all-hex collector refs as branches before raw refs', () => {
    const prompt = createInstallPrompt({
      baseUrl: 'https://tokenboard.example',
      timezone: 'Asia/Shanghai',
      pairingCode: 'pair_123',
      collectorRepoUrl: 'https://github.com/example/TokenBoard.git',
      collectorRepoRef: 'deadbeef'
    })

    expect(prompt).toContain(
      'git -C "$repo" fetch --depth 1 origin \'+refs/heads/deadbeef:refs/remotes/origin/deadbeef\''
    )
    expect(prompt).toContain("git -C \"$repo\" checkout -B 'deadbeef' 'refs/remotes/origin/deadbeef'")
    expect(prompt).toContain('git -C "$repo" fetch --depth 1 origin \'deadbeef\'')
    expect(prompt).toContain('git -C "$repo" checkout FETCH_HEAD')
    expect(prompt).toContain('git -C $repo fetch --depth 1 origin "+refs/heads/deadbeef:refs/remotes/origin/deadbeef"')
    expect(prompt).toContain('Invoke-Git -C $repo fetch --depth 1 origin "deadbeef"')
  })

  test('generates platform-specific one-command uninstall instructions', () => {
    const commands = createUninstallCommands()

    expect(commands.bash).toContain("git clone 'https://github.com/evepupil/TokenBoard.git'")
    expect(commands.bash).toContain('git -C "$repo" pull --ff-only')
    expect(commands.bash).toContain('rm -rf "$repo"')
    expect(commands.bash).toContain('device-link recovery state')
    expect(commands.bash).toContain('skills/tokenboard/scripts/uninstall.mjs" --all')
    expect(commands.bash).not.toContain('```')
    expect(commands.bash).not.toContain('Windows PowerShell')
    expect(commands.powerShell).toContain('Invoke-Git clone "https://github.com/evepupil/TokenBoard.git" $repo')
    expect(commands.powerShell).toContain('device-link recovery state')
    expect(commands.powerShell).toContain('skills\\tokenboard\\scripts\\uninstall.mjs") --all')
    expect(commands.powerShell).not.toContain('```')
    expect(commands.powerShell).not.toContain('macOS / Linux / Git Bash')
  })

  test('generates platform-specific one-command hook install instructions', () => {
    const commands = createInstallHookCommands()

    expect(commands.bash).toContain("git clone 'https://github.com/evepupil/TokenBoard.git'")
    expect(commands.bash).toContain('git -C "$repo" pull --ff-only')
    expect(commands.bash).toContain('skills/tokenboard/scripts/install-hook.mjs" --source all')
    expect(commands.bash).toContain(
      '# all installs Codex and Claude Code hooks; install Antigravity CLI capture separately with --source antigravity-cli.'
    )
    expect(commands.bash).not.toContain('```')
    expect(commands.powerShell).toContain('Invoke-Git clone "https://github.com/evepupil/TokenBoard.git" $repo')
    expect(commands.powerShell).toContain('skills\\tokenboard\\scripts\\install-hook.mjs") --source all')
    expect(commands.powerShell).toContain(
      '# all installs Codex and Claude Code hooks; install Antigravity CLI capture separately with --source antigravity-cli.'
    )
    expect(commands.powerShell).not.toContain('```')
  })

  test('generates explicit device-link reconnect commands without pairing code', () => {
    const commands = createDeviceLinkReconnectCommands({
      baseUrl: 'https://tokenboard.example',
      timezone: 'Asia/Shanghai'
    })

    expect(commands.bash).toContain("git clone 'https://github.com/evepupil/TokenBoard.git'")
    expect(commands.bash).toContain('git -C "$repo" pull --ff-only')
    expect(commands.bash).toContain('Explicit recovery path')
    expect(commands.bash).toContain('TOKENBOARD_CODEX_BATCH_SIZE=200')
    expect(commands.bash).toContain('skills/tokenboard/scripts/setup.mjs" --use-device-link')
    expect(commands.bash).toContain("--base-url 'https://tokenboard.example'")
    expect(commands.bash).toContain("--timezone 'Asia/Shanghai'")
    expect(commands.bash).toContain('--schedule-times "09:00,12:00,18:00,23:00"')
    expect(commands.bash).not.toContain('--pairing-code')
    expect(commands.bash).not.toContain('installClaim')
    expect(commands.bash).not.toContain('```')
    expect(commands.powerShell).toContain('Invoke-Git clone "https://github.com/evepupil/TokenBoard.git" $repo')
    expect(commands.powerShell).toContain('$env:TOKENBOARD_CODEX_BATCH_SIZE = "200"')
    expect(commands.powerShell).toContain('skills\\tokenboard\\scripts\\setup.mjs") --use-device-link')
    expect(commands.powerShell).toContain('--base-url "https://tokenboard.example"')
    expect(commands.powerShell).toContain('--timezone "Asia/Shanghai"')
    expect(commands.powerShell).not.toContain('--pairing-code')
    expect(commands.powerShell).not.toContain('installClaim')
    expect(commands.powerShell).not.toContain('```')
  })

  test('uses overridden repo settings for device-link reconnect commands', () => {
    const commands = createDeviceLinkReconnectCommands({
      baseUrl: 'https://tokenboard.example',
      timezone: 'Asia/Shanghai',
      collectorRepoUrl: 'https://github.com/example/TokenBoard.git',
      collectorRepoRef: 'docs/device-identity-reconnect-plan'
    })

    expect(commands.bash).toContain(
      'git clone --depth 1 --no-checkout \'https://github.com/example/TokenBoard.git\' "$repo"'
    )
    expect(commands.bash).toContain("--repo-url 'https://github.com/example/TokenBoard.git'")
    expect(commands.bash).toContain("--repo-ref 'docs/device-identity-reconnect-plan'")
    expect(commands.powerShell).toContain(
      'Invoke-Git clone --depth 1 --no-checkout "https://github.com/example/TokenBoard.git" $repo'
    )
    expect(commands.powerShell).toContain('--repo-url "https://github.com/example/TokenBoard.git"')
    expect(commands.powerShell).toContain('--repo-ref "docs/device-identity-reconnect-plan"')
  })

  test('generates branch-pinned hook install instructions when configured', () => {
    const commands = createInstallHookCommands({
      collectorRepoUrl: 'https://github.com/example/TokenBoard.git',
      collectorRepoRef: 'research/agy-token-support-plan'
    })

    expect(commands.bash).toContain(
      'git clone --depth 1 --no-checkout \'https://github.com/example/TokenBoard.git\' "$repo"'
    )
    expect(commands.bash).toContain(
      'git -C "$repo" fetch --depth 1 origin \'+refs/heads/research/agy-token-support-plan:refs/remotes/origin/research/agy-token-support-plan\''
    )
    expect(commands.bash).toContain(
      "git -C \"$repo\" checkout -B 'research/agy-token-support-plan' 'refs/remotes/origin/research/agy-token-support-plan'"
    )
    expect(commands.powerShell).toContain(
      'Invoke-Git clone --depth 1 --no-checkout "https://github.com/example/TokenBoard.git" $repo'
    )
    expect(commands.powerShell).toContain(
      'git -C $repo fetch --depth 1 origin "+refs/heads/research/agy-token-support-plan:refs/remotes/origin/research/agy-token-support-plan"'
    )
    expect(commands.powerShell).toContain(
      'Invoke-Git -C $repo checkout -B "research/agy-token-support-plan" "refs/remotes/origin/research/agy-token-support-plan"'
    )
  })

  test('supports full branch, tag, and commit refs in generated bootstrap commands', () => {
    const branchPrompt = createInstallPrompt({
      baseUrl: 'https://tokenboard.example',
      timezone: 'Asia/Shanghai',
      pairingCode: 'pair_123',
      collectorRepoRef: 'refs/heads/master'
    })
    const tagCommands = createInstallHookCommands({ collectorRepoRef: 'refs/tags/v1.2.3' })
    const commitCommands = createDeviceLinkReconnectCommands({
      baseUrl: 'https://tokenboard.example',
      timezone: 'Asia/Shanghai',
      collectorRepoRef: '0123456789abcdef0123456789abcdef01234567'
    })

    expect(branchPrompt).toContain(
      'git -C "$repo" fetch --depth 1 origin \'+refs/heads/master:refs/remotes/origin/master\''
    )
    expect(branchPrompt).toContain("git -C \"$repo\" checkout -B 'master' 'refs/remotes/origin/master'")
    expect(tagCommands.bash).toContain('git -C "$repo" fetch --depth 1 origin \'refs/tags/v1.2.3\'')
    expect(tagCommands.bash).toContain('git -C "$repo" checkout FETCH_HEAD')
    expect(tagCommands.powerShell).toContain('Invoke-Git -C $repo fetch --depth 1 origin "refs/tags/v1.2.3"')
    expect(commitCommands.bash).toContain(
      'git -C "$repo" fetch --depth 1 origin \'0123456789abcdef0123456789abcdef01234567\''
    )
    expect(commitCommands.powerShell).toContain('Invoke-Git -C $repo checkout FETCH_HEAD')
  })

  test('generated default-branch bootstrap fails fast and switches back to origin head', () => {
    const commands = createInstallHookCommands()

    expect(commands.bash).toContain('set -euo pipefail')
    expect(commands.bash).toContain('ls-remote --symref origin HEAD')
    expect(commands.bash).toContain("config --replace-all remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'")
    expect(commands.bash).toContain(
      'git -C "$repo" fetch origin "+refs/heads/$default_branch:refs/remotes/origin/$default_branch"'
    )
    expect(commands.bash).not.toContain(
      'git -C "$repo" fetch --depth 1 origin "+refs/heads/$default_branch:refs/remotes/origin/$default_branch"'
    )
    expect(commands.bash).toContain(
      'git -C "$repo" checkout -B "$default_branch" "refs/remotes/origin/$default_branch"'
    )
    expect(commands.powerShell).toContain('$ErrorActionPreference = "Stop"')
    expect(commands.powerShell).toContain('function Invoke-Git')
    expect(commands.powerShell).toContain('$defaultBranchLine = git -C $repo ls-remote --symref origin HEAD')
    expect(commands.powerShell).toContain(
      '$defaultBranch = $defaultBranchLine -replace "^ref: refs/heads/([^\\s]+)\\sHEAD$", \'$1\''
    )
    expect(commands.powerShell).not.toContain(
      '$defaultBranch = $defaultBranchLine -replace "^ref: refs/heads/([^\\s]+)\\sHEAD$", "$1"'
    )
    expect(commands.powerShell).toContain(
      'Invoke-Git -C $repo fetch origin "+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}"'
    )
    expect(commands.powerShell).not.toContain(
      'Invoke-Git -C $repo fetch --depth 1 origin "+refs/heads/$defaultBranch:refs/remotes/origin/$defaultBranch"'
    )
    expect(commands.powerShell).not.toContain('$defaultBranch:refs')
    expect(commands.powerShell).toContain(
      'Invoke-Git -C $repo checkout -B $defaultBranch "refs/remotes/origin/$defaultBranch"'
    )
  })

  test('uses overridden repo url for hook install command bootstrap', () => {
    const commands = createInstallHookCommands({
      collectorRepoUrl: 'https://github.com/example/TokenBoard.git'
    })

    expect(commands.bash).toContain("git clone 'https://github.com/example/TokenBoard.git'")
    expect(commands.powerShell).toContain('Invoke-Git clone "https://github.com/example/TokenBoard.git" $repo')
    expect(commands.bash).not.toContain("git clone 'https://github.com/evepupil/TokenBoard.git'")
  })

  test('keeps the combined uninstall prompt available for agent handoff', () => {
    const command = createUninstallCommand()

    expect(command).toContain('macOS / Linux / Git Bash：')
    expect(command).toContain('```bash')
    expect(command).toContain('Windows PowerShell：')
    expect(command).toContain('```powershell')
  })

  test('uses overridden repo url for uninstall command bootstrap', () => {
    const commands = createUninstallCommands({
      collectorRepoUrl: 'https://github.com/example/TokenBoard.git'
    })

    expect(commands.bash).toContain("git clone 'https://github.com/example/TokenBoard.git'")
    expect(commands.powerShell).toContain('Invoke-Git clone "https://github.com/example/TokenBoard.git" $repo')
    expect(commands.bash).not.toContain("git clone 'https://github.com/evepupil/TokenBoard.git'")
    expect(commands.powerShell).not.toContain('Invoke-Git clone "https://github.com/evepupil/TokenBoard.git" $repo')
  })

  test('escapes install prompt command arguments for shells', () => {
    const prompt = createInstallPrompt({
      baseUrl: 'https://tokenboard.example/a b',
      timezone: 'Asia/Shanghai";Write-Host $env:USER',
      pairingCode: "pair_'123",
      collectorRepoUrl: 'https://github.com/example/TokenBoard.git'
    })

    expect(prompt).toContain("--pairing-code 'pair_'\\''123'")
    expect(prompt).toContain("--base-url 'https://tokenboard.example/a b'")
    expect(prompt).toContain("--timezone 'Asia/Shanghai\";Write-Host $env:USER'")
    expect(prompt).toContain('--pairing-code "pair_\'123"')
    expect(prompt).toContain('--timezone "Asia/Shanghai`";Write-Host `$env:USER"')
  })
})
