import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { InstallCommand } from './install-command'

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
    expect(html).toContain('node scripts/setup.mjs --pairing-code pair_123')
  })
})
