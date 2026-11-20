import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { CustomSelect } from './custom-select'

const options = [
  { value: '', label: '全部' },
  { value: 'claude-code', label: 'Claude Code' }
]

describe('CustomSelect', () => {
  // The label is a sibling <span>, not a <label for>, so the button needs its own name.
  // An aria-label would replace the content in that name and the current selection would
  // vanish from it; the hidden prefix keeps both: "来源: 全部".
  test('keeps the label and the selected value in the accessible name', async () => {
    const html = await renderToString(<CustomSelect label="来源" name="source" value="claude-code" options={options} />)

    expect(html).not.toContain('aria-label="来源"')
    expect(html).toContain('<span class="sr-only">来源: </span>')
    expect(html).toContain('<span data-custom-select-label="true">Claude Code</span>')
  })

  test('renders no hidden prefix when there is no label', async () => {
    const html = await renderToString(<CustomSelect name="source" value="" options={options} />)

    expect(html).not.toContain('sr-only')
    expect(html).toContain('<span data-custom-select-label="true">全部</span>')
  })
})
