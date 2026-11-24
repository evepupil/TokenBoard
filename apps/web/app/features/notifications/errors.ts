import { ApiError } from '../../lib/errors'

export const notificationFormErrorMessages = {
  'invalid-daily-report-id': 'Invalid daily report id',
  'invalid-request': 'Invalid request',
  'invalid-schedule-time': 'Invalid schedule time',
  'invalid-schedule-weekday': 'Invalid schedule weekday',
  'invalid-timezone': 'Invalid timezone',
  'invalid-webhook-name': 'Invalid webhook name',
  'too-many-webhooks': 'Too many webhook subscriptions',
  'webhook-url-must-use-https': 'Webhook URL must use HTTPS',
  'webhook-url-not-supported': 'Webhook URL host or path is not supported for this provider'
} as const

export type NotificationFormErrorCode = keyof typeof notificationFormErrorMessages

export class NotificationFormError extends ApiError {
  constructor(readonly formErrorCode: NotificationFormErrorCode) {
    super('BAD_REQUEST', notificationFormErrorMessages[formErrorCode], 400)
  }
}

export function notificationFormErrorMessage(code: string | undefined) {
  if (!code) return undefined
  // A `?error=` query is user-controlled. Bracket lookup would walk the prototype chain, so
  // `?error=constructor` would resolve to `Object`'s own function instead of a message; ownership
  // is required to reach one, matching `settingsFormErrorMessage` and `deviceFormErrorMessage`.
  if (!Object.prototype.hasOwnProperty.call(notificationFormErrorMessages, code)) return undefined
  return notificationFormErrorMessages[code as NotificationFormErrorCode]
}
