import { jsxRenderer } from 'hono/jsx-renderer'
import { Link } from 'honox/server'

type Manifest = Record<string, { file?: string }>
type ManifestModule = { default?: Manifest }

const themeScript = `
(function () {
  var themeKey = 'tokenboard-theme'

  function getTheme() {
    try {
      var storedTheme = localStorage.getItem(themeKey)
      if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme
    } catch (_) {}
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }

  function applyTheme(theme) {
    document.documentElement.classList.toggle('theme-light', theme === 'light')
    document.documentElement.dataset.theme = theme
    document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
      button.setAttribute('aria-label', theme === 'light' ? '切换到深色主题' : '切换到浅色主题')
      button.setAttribute('title', theme === 'light' ? '切换到深色主题' : '切换到浅色主题')
    })
  }

  applyTheme(getTheme())

  document.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('[data-theme-toggle]') : null
    if (!target) return

    var nextTheme = document.documentElement.classList.contains('theme-light') ? 'dark' : 'light'
    try {
      localStorage.setItem(themeKey, nextTheme)
    } catch (_) {}
    applyTheme(nextTheme)
  })
})()
`

export default jsxRenderer(({ children }) => {
  const clientScriptSrc = getClientScriptSrc()

  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="icon" type="image/svg+xml" href="/logo.svg" />
        <link rel="alternate icon" href="/favicon.ico" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <Link href="/app/style.css" rel="stylesheet" />
        <script type="module" src={clientScriptSrc} async />
      </head>
      <body>{children}</body>
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
