import type { UsageSnapshot } from '@tokenboard/usage-core'
import type { CollectorConfig } from './config'

export async function uploadSnapshots(config: CollectorConfig, snapshots: UsageSnapshot[]) {
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.uploadToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ snapshots })
  })

  if (!response.ok) {
    throw new Error(`Upload failed with status ${response.status}`)
  }

  return response.json()
}

