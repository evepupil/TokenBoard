import { ApiError } from '../../lib/errors'

export const notificationFormErrorMessages = {
  'invalid-daily-report-id': 'Invalid daily report id',
  'invalid-request': 'Invalid request',
  'invalid-schedule-time': 'Invalid schedule time',
  'invalid-schedule-weekday': 'Invalid schedule weekday',
  'invalid-timezone': 'Invalid timezone',
  'invalid-webhook-name': 'Invalid webhook name',
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
  return notificationFormErrorMessages[code as NotificationFormErrorCode]
}
