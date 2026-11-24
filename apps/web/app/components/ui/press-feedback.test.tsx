import { readFileSync } from 'node:fs'
import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { Button, LinkButton } from './button'

// `style.css` already gives every `<button>` and every `a[data-link-button]` a press state
// (`button:active { transform: ... scale(0.96) }`). Tailwind's `active:scale-[0.96]` sets the
// independent `scale` property instead of touching `transform`, so putting both on the same
// element multiplies them: 0.96 × 0.96 = 0.92, below the 0.95 floor where a press starts to
// look exaggerated. These tests pin that premise and the classes that depend on it.
function styleSource() {
  return readFileSync(new URL('../../style.css', import.meta.url), 'utf8')
}

describe('press feedback', () => {
  test('style.css owns the button press scale', () => {
    const css = styleSource()
    const rule = css.match(/button:active,\s*a\[data-link-button='true'\]:active\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    expect(rule?.[1]).toContain('scale(0.96)')
  })

  // A mouse press is always also a hover, and `button:hover:not(:disabled):not([aria-disabled])`
  // is specificity (0,3,1) against `button:active`'s (0,1,1). Without `:not(:active)` on the
  // hover rule the lift wins the cascade for the whole press and the press state never shows.
  test('the hover lift yields to the press while the pointer is down', () => {
    const css = styleSource()
    const hover = css.match(/button:hover[^{]*\{[^}]*\}/)
    expect(hover).not.toBeNull()
    expect(hover?.[0]).toContain(':not(:active)')
  })

  // The copy button carries its own, bigger press scale (0.9), declared after the first
  // reduced-motion block — so a `button:active { transform: none }` there does not reach it.
  // A reduced-motion user would still get an instant 10% snap under the pointer.
  test('reduced motion disables the copy button press too', () => {
    const css = styleSource()
    const base = css.search(/button\[data-copy-target\]:active\s*\{[^}]*scale\(0\.9\)/)
    expect(base).toBeGreaterThanOrEqual(0)
    const resets = [...css.matchAll(/button\[data-copy-target\]:active\s*\{([^}]*)\}/g)].filter(
      (m) => m.index !== undefined && m.index > base && /transform:\s*none/.test(m[1])
    )
    expect(resets.length).toBeGreaterThan(0)
  })

  test('buttons do not stack a second press scale on top', async () => {
    const html = await renderToString(<Button>保存</Button>)
    const link = await renderToString(<LinkButton href="/dashboard">返回</LinkButton>)

    expect(html).not.toContain('active:scale')
    expect(link).not.toContain('active:scale')
  })
})
