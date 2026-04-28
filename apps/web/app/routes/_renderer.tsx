import { jsxRenderer } from 'hono/jsx-renderer'
import { Link, Script } from 'honox/server'

const themeScript = `
try {
  const storedTheme = localStorage.getItem('tokenboard-theme')
  const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches
  const theme = storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : (prefersLight ? 'light' : 'dark')
  document.documentElement.classList.toggle('theme-light', theme === 'light')
  document.documentElement.dataset.theme = theme
} catch (_) {}
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
