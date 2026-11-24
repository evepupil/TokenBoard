import { jsxRenderer } from 'hono/jsx-renderer'
import { Link } from 'honox/server'
import { initialColorScheme, mobileNightModeOptOutMeta, themeChromeColors } from '../lib/theme'
import { themeScript } from '../lib/theme-script'
import { clientVersion, serverVersion } from '../lib/version'

type Manifest = Record<string, { file?: string }>
type ManifestModule = { default?: Manifest }

export default jsxRenderer(({ children }) => {
  const clientScriptSrc = getClientScriptSrc()

  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="color-scheme" content={initialColorScheme} />
        <meta name={mobileNightModeOptOutMeta.name} content={mobileNightModeOptOutMeta.content} />
        <meta name="theme-color" content={themeChromeColors.dark} />
        <link rel="icon" type="image/svg+xml" href="/logo.svg" />
        <link rel="alternate icon" href="/favicon.ico" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <Link href="/app/style.css" rel="stylesheet" />
        <script type="module" src={clientScriptSrc} async />
      </head>
      <body>
        <a class="app-skip-link" href="#app-content">
          跳到主要内容
        </a>
        {children}
        {/* Editorial 4-column Colophon Footer matching Folio publication structure */}
        <footer
          class="border-t border-[var(--app-border-strong)] bg-[var(--app-bg)] px-4 py-10 text-[var(--app-text)] sm:px-8"
          data-app-version="true"
        >
          <div class="app-folio-container">
            <div class="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p class="text-sm font-extrabold tracking-tight text-[var(--app-text)]">TokenBoard</p>
                <p class="mt-2 text-xs leading-6 text-[var(--app-muted)]">
                  面向多用户的 AI Token 算力用量统计与研究型遥测归档平台。
                </p>
              </div>
              <div>
                <p class="font-mono text-xs font-bold uppercase tracking-wider text-[var(--app-text)]">
                  本地采集隐私原则
                </p>
                <p class="mt-2 text-xs leading-6 text-[var(--app-muted)]">
                  本机采集器仅投影 Token、模型、日期与会话汇总快照；不读取、不留存、不上传任何对话正文或代码路径。
                </p>
              </div>
              <div>
                <p class="font-mono text-xs font-bold uppercase tracking-wider text-[var(--app-text)]">21 源统一计量</p>
                <p class="mt-2 text-xs leading-6 text-[var(--app-muted)]">
                  原生覆盖 Claude Code、Codex、Antigravity、OpenCode、Pi、Grok Build、DeepSeek Harness 等 21
                  个工具来源。
                </p>
              </div>
              <div>
                <p class="font-mono text-xs font-bold uppercase tracking-wider text-[var(--app-text)]">版本与开源</p>
                <p class="mt-2 font-mono text-xs leading-6 text-[var(--app-muted)]">
                  TokenBoard · 服务端 v{serverVersion} · 客户端 v{clientVersion}
                </p>
                <p class="mt-1 font-mono text-[11px] text-[var(--app-subtle)]">
                  <a class="underline underline-offset-4 hover:text-[var(--app-text)]" href="/leaderboards">
                    公开排行榜
                  </a>
                  {' · '}
                  <a
                    class="underline underline-offset-4 hover:text-[var(--app-text)]"
                    href="https://github.com/evepupil/TokenBoard"
                    target="_blank"
                    rel="noreferrer"
                  >
                    GitHub 仓库
                  </a>
                </p>
              </div>
            </div>
          </div>
        </footer>
      </body>
    </html>
  )
})

function getClientScriptSrc() {
  if (!import.meta.env.PROD) return '/app/client.ts'

  const manifestFiles = import.meta.glob<ManifestModule>('/dist/.vite/manifest.json', { eager: true })
  for (const manifestFile of Object.values(manifestFiles)) {
    const manifest = manifestFile.default
    const clientEntry = manifest?.['app/client.ts']
    if (clientEntry?.file) return `/${clientEntry.file}`
  }

  return '/app/client.ts'
}
