import { jsxRenderer } from 'hono/jsx-renderer'
import { Link, Script } from 'honox/server'

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
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="icon" href="/favicon.ico" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <Link href="/app/style.css" rel="stylesheet" />
        <Script src="/app/client.ts" async />
      </head>
      <body>{children}</body>
    </html>
  )
})
