import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

// Tailwind emits its `hover:` utilities inside `@media (hover: hover)`, so a touch device never
// applies them. Hand-written rules in `style.css` get no such wrapper for free: on a touchscreen
// a tap leaves `:hover` matching until the user taps somewhere else, so the lift, ring, sheen and
// brightness changes stick to whatever was last touched. Every `:hover` rule here therefore has
// to sit inside a `(hover: hover)` block of its own.
function styleSource() {
  return readFileSync(new URL('../style.css', import.meta.url), 'utf8')
}

type HoverRule = { selector: string; guarded: boolean }

// Minimal block walker: enough for a stylesheet without strings, `url()` or escaped braces.
// A rule counts as guarded when a `(hover: hover)` block encloses it, or when it sits in a
// reduced-motion block — those rules only switch motion off, so applying them on a tap is
// the intended behaviour rather than a stuck hover effect.
function collectHoverRules(css: string): HoverRule[] {
  const found: HoverRule[] = []
  const openBlocks: { guarded: boolean; reducedMotion: boolean }[] = []
  let prelude = ''
  for (const char of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (char === '{') {
      const head = prelude.trim()
      prelude = ''
      const enclosing = openBlocks[openBlocks.length - 1] ?? { guarded: false, reducedMotion: false }
      if (head.startsWith('@')) {
        openBlocks.push({
          guarded: enclosing.guarded || /^@media[^{]*\(hover:\s*hover\)/.test(head),
          reducedMotion: enclosing.reducedMotion || /^@media[^{]*\(prefers-reduced-motion:\s*reduce\)/.test(head)
        })
      } else {
        if (head.includes(':hover')) {
          found.push({ selector: head, guarded: enclosing.guarded || enclosing.reducedMotion })
        }
        // A declaration block cannot contain another block, but pushing keeps the depth honest.
        openBlocks.push(enclosing)
      }
      continue
    }
    if (char === '}') {
      openBlocks.pop()
      prelude = ''
      continue
    }
    if (char === ';' && openBlocks.length === 0) {
      // At-rule statements such as `@import` and `@source` end here; they carry no hover rule.
      prelude = ''
      continue
    }
    prelude += char
  }
  return found
}

describe('hover rules', () => {
  test('every :hover rule is gated on a device that can hover', () => {
    const rules = collectHoverRules(styleSource())

    // Sanity: the effects this test exists for are still in the file.
    expect(rules.length).toBeGreaterThan(0)
    expect(rules.some((rule) => rule.selector.includes('.app-metric-card:hover'))).toBe(true)

    const unguarded = rules.filter((rule) => !rule.guarded).map((rule) => rule.selector)
    expect(unguarded).toEqual([])
  })
})
