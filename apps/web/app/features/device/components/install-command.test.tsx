import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { createInstallPrompt, createUninstallCommand, createUninstallCommands, InstallCommand } from './install-command'

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
    expect(html).toContain('data-copy-target="uninstall-bash-command-text"')
    expect(html).toContain('data-copy-target="uninstall-powershell-command-text"')
    expect(html).toContain('aria-label="复制安装提示词"')
    expect(html).toContain('aria-label="复制 macOS / Linux / Git Bash 卸载命令"')
    expect(html).toContain('aria-label="复制 Windows PowerShell 卸载命令"')
    expect(html).toContain('macOS / Linux / Git Bash')
    expect(html).toContain('Windows PowerShell')
    expect(html).toContain('skills/tokenboard/scripts/setup.mjs')
    expect(html).toContain('skills/tokenboard/scripts/uninstall.mjs')
  })

  test('generates a direct shell-oriented prompt that discourages browser detours', () => {
    const prompt = createInstallPrompt({
      baseUrl: 'https://tokenboard.example',
      timezone: 'Asia/Shanghai',
      pairingCode: 'pair_123'
    })

    expect(prompt).toContain('不要使用浏览器、Playwright、网页抓取、fetch 或 curl')
    expect(prompt).toContain('首次安装默认执行全量同步')
    expect(prompt).toContain('不要擅自改成最近 7 天窗口')
    expect(prompt).toContain('TOKENBOARD_CODEX_BATCH_SIZE=200')
    expect(prompt).toContain('$env:TOKENBOARD_CODEX_BATCH_SIZE = "200"')
    expect(prompt).toContain('只有用户明确要求跳过首次同步')
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
    expect(prompt).toContain('重新配对设备、刷新 upload token/deviceId、刷新每日定时任务')
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

  test('generates platform-specific one-command uninstall instructions', () => {
    const commands = createUninstallCommands()

    expect(commands.bash).toContain("git clone 'https://github.com/evepupil/TokenBoard.git'")
    expect(commands.bash).toContain('git -C "$repo" pull --ff-only')
    expect(commands.bash).toContain('rm -rf "$repo"')
    expect(commands.bash).toContain('skills/tokenboard/scripts/uninstall.mjs" --all')
    expect(commands.bash).not.toContain('```')
    expect(commands.bash).not.toContain('Windows PowerShell')
    expect(commands.powerShell).toContain('git clone "https://github.com/evepupil/TokenBoard.git" $repo')
    expect(commands.powerShell).toContain('skills\\tokenboard\\scripts\\uninstall.mjs") --all')
    expect(commands.powerShell).not.toContain('```')
    expect(commands.powerShell).not.toContain('macOS / Linux / Git Bash')
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
    expect(commands.powerShell).toContain('git clone "https://github.com/example/TokenBoard.git" $repo')
    expect(commands.bash).not.toContain("git clone 'https://github.com/evepupil/TokenBoard.git'")
    expect(commands.powerShell).not.toContain('git clone "https://github.com/evepupil/TokenBoard.git" $repo')
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
    expect(prompt).toContain('--timezone \'Asia/Shanghai";Write-Host $env:USER\'')
    expect(prompt).toContain('--pairing-code "pair_\'123"')
    expect(prompt).toContain('--timezone "Asia/Shanghai`";Write-Host `$env:USER"')
  })
})
