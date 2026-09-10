import type { Bindings } from '../../lib/db'
import { ApiError } from '../../lib/errors'

export type DeviceSensitiveAction =
  'device.reconnect' | 'device.revoke' | 'installation.revoke' | 'token.rotate' | 'token.revoke'

export function requireDeviceStepUp(env: Pick<Bindings, 'TOKENBOARD_STEP_UP_REQUIRED'>, action: DeviceSensitiveAction) {
  if (!stepUpRequired(env)) return
  throw new ApiError('FORBIDDEN', `Step-up verification is required for ${action}`, 403)
}

function stepUpRequired(env: Pick<Bindings, 'TOKENBOARD_STEP_UP_REQUIRED'>) {
  const value = env.TOKENBOARD_STEP_UP_REQUIRED?.trim().toLowerCase()
  return value === '1' || value === 'true'
}
