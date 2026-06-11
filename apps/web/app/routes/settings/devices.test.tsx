import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { DevicesPage } from './devices'

describe('DevicesPage layout', () => {
  test('renders adaptive device cards on mobile and the table on desktop', async () => {
    const html = await renderToString(
      <DevicesPage
        email="user@example.com"
        saved={false}
        revoked={false}
        devices={[
          {
            id: 'device_1',
            name: 'MacBook Pro With A Long Local Collector Name',
            platform: 'darwin',
            lastSyncedAt: '2026-05-29T01:27:47.279Z',
            createdAt: '2026-04-29T10:03:36.232Z',
            activeTokenCount: 1
          }
        ]}
      />
    )

    expect(html).toContain('data-devices-mobile-list="true"')
    expect(html).toContain('data-devices-desktop-table="true"')
    expect(html).toContain('app-surface-raised rounded-xl')
    expect(html).toContain('md:hidden')
    expect(html).toContain('hidden overflow-x-auto md:block')
    expect(html).toContain('MacBook Pro With A Long Local Collector Name')
    expect(html).toContain('w-full sm:w-auto')
    expect(html).toContain('name="name"')
    expect(html).toContain('autocomplete="off"')
  })
})
