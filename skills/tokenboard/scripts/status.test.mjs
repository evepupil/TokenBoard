import assert from 'node:assert/strict'
import test from 'node:test'
import { buildStatus } from './status.mjs'

test('status includes configured schedule times', () => {
  assert.deepEqual(
    buildStatus({
      configPath: '/home/user/.tokenboard/config.json',
      config: {
        endpoint: 'https://tokenboard.example/api/v1/ingest',
        deviceId: 'dev_123',
        timezone: 'Asia/Shanghai',
        source: 'all',
        packageManager: 'bun',
        collectorDir: '/home/user/.tokenboard/TokenBoard',
        scheduleTimes: ['06:00', '09:00']
      }
    }),
    {
      configured: true,
      configPath: '/home/user/.tokenboard/config.json',
      endpoint: 'https://tokenboard.example/api/v1/ingest',
      deviceId: 'dev_123',
      timezone: 'Asia/Shanghai',
      source: 'all',
      packageManager: 'bun',
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      scheduleTimes: ['06:00', '09:00']
    }
  )
})
