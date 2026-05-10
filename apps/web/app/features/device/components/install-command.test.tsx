import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { createInstallPrompt, InstallCommand } from './install-command'

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
    expect(html).toContain('aria-label="复制安装提示词"')
    expect(html).toContain('skills/tokenboard/scripts/setup.mjs')
  })

  test('generates a direct shell-oriented prompt that discourages browser detours', () => {
    const prompt = createInstallPrompt({
      baseUrl: 'https://tokenboard.example',
      timezone: 'Asia/Shanghai',
      pairingCode: 'pair_123'
    })

    expect(prompt).toContain('不要使用浏览器、Playwright、网页抓取、fetch 或 curl')
    expect(prompt).toContain("git clone 'https://github.com/evepupil/TokenBoard.git'")
    expect(prompt).toContain('git -C "$repo" pull --ff-only')
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
