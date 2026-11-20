import { afterEach, describe, expect, test, vi } from 'vitest'
import { refreshPublicCardPreview } from './client-preview'

// The live preview is a POST whose answer replaces the image. A rejected body or a dropped
// connection used to leave the image at its last good render with nothing on screen saying
// so; the status line is the fix, and these tests pin both halves: failure is reported, and
// success clears the line rather than leaving a stale complaint.

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('public card preview refresh', () => {
  test('reports a rejected preview instead of leaving a stale image silently', async () => {
    const dom = installPreviewDom()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: { message: 'Invalid request body' } }, { status: 400 }))
    )

    await refreshPublicCardPreview()

    expect(dom.image.src).toBe('data:image/svg+xml;charset=utf-8,original')
    expect(dom.status.hidden).toBe(false)
    expect(dom.status.textContent).toBe('预览未更新：Invalid request body')
  })

  test('falls back to the status code when the error body is not JSON', async () => {
    const dom = installPreviewDom()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>oops</html>', { status: 500 }))
    )

    await refreshPublicCardPreview()

    expect(dom.status.hidden).toBe(false)
    expect(dom.status.textContent).toBe('预览未更新（HTTP 500）。')
  })

  test('reports a dropped connection as an unavailable preview', async () => {
    const dom = installPreviewDom()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
    )

    await refreshPublicCardPreview()

    expect(dom.status.hidden).toBe(false)
    expect(dom.status.textContent).toBe('预览暂时不可用，请稍后重试。')
  })

  test('reveals the status line before writing into it so the live region announces', async () => {
    // A role="status" line inside a display:none subtree is not announced, and
    // writing first then revealing is exactly that sequence. The element double
    // records the order of the two operations.
    const dom = installPreviewDom()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: { message: 'Invalid request body' } }, { status: 400 }))
    )

    await refreshPublicCardPreview()

    expect(dom.writes).toEqual(['hidden=false', 'text=预览未更新：Invalid request body'])
  })

  test('renders the new SVG and clears an earlier failure', async () => {
    const dom = installPreviewDom()
    dom.status.hidden = false
    dom.status.textContent = '预览未更新（HTTP 500）。'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<svg>fresh</svg>', { status: 200 }))
    )

    await refreshPublicCardPreview()

    expect(dom.image.src).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg>fresh</svg>')}`)
    expect(dom.status.hidden).toBe(true)
    expect(dom.status.textContent).toBe('')
  })

  test('a stale failed response does not repaint over a newer success', async () => {
    // Two refreshes overlap: an older slow failure resolves after a newer fast
    // success. Without the generation guard the late failure writes its
    // "预览未更新" beside the already-fresh image. Resolve the newer one first, then
    // deliver the older failure — it must be ignored.
    const dom = installPreviewDom()
    const pending: Array<(response: Response) => void> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)))
    )

    const first = refreshPublicCardPreview()
    const second = refreshPublicCardPreview()

    pending[1](new Response('<svg>fresh</svg>', { status: 200 }))
    await second
    expect(dom.image.src).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg>fresh</svg>')}`)

    pending[0](Response.json({ error: { message: 'stale failure' } }, { status: 400 }))
    await first

    expect(dom.image.src).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg>fresh</svg>')}`)
    expect(dom.status.hidden).toBe(true)
    expect(dom.status.textContent).toBe('')
  })
})

function installPreviewDom() {
  const image: { src: string; dataset: Record<string, string> } = {
    src: 'data:image/svg+xml;charset=utf-8,original',
    dataset: { publicCardPublicUrl: 'https://tokenboard.example/api/public/eve.svg' }
  }
  // The status double records every mutation in order, so a test can pin that
  // the line is revealed before its text is written (a live region inside a
  // hidden subtree is not announced) and that a success empties before hiding.
  const writes: string[] = []
  const state: { hidden: boolean; textContent: string } = { hidden: true, textContent: '' }
  const status = {
    get hidden() {
      return state.hidden
    },
    set hidden(value: boolean) {
      writes.push(`hidden=${value}`)
      state.hidden = value
    },
    get textContent() {
      return state.textContent
    },
    set textContent(value: string) {
      writes.push(`text=${value}`)
      state.textContent = value
    }
  }
  const editor = {
    querySelector: (selector: string) =>
      selector === '[data-public-card-preview]'
        ? image
        : selector === '[data-public-card-preview-status]'
          ? status
          : null,
    closest: (selector: string) => (selector === 'form' ? { querySelectorAll: () => [] } : null)
  }
  vi.stubGlobal('document', {
    querySelector: (selector: string) => (selector === '[data-public-card-config]' ? editor : null)
  })
  // The payload reader wraps the form in FormData; a real <form> is not available outside
  // a browser, so this double answers the two lookups it performs.
  vi.stubGlobal(
    'FormData',
    class {
      get() {
        return null
      }
    }
  )
  return { image, status, writes }
}
