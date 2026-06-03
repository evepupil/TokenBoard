import { describe, expect, test } from 'vitest'
import { parseWebhookSubscriptionForm, scheduleWeekdaysFromForm } from './schema'

describe('notification form schema', () => {
  test('preserves multiple schedule times from bracket form fields and ignores blank slots', () => {
    const form = parseWebhookSubscriptionForm({
      name: '日报',
      provider: 'wecom',
      webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef',
      timezone: 'Asia/Shanghai',
      'scheduleTimesLocal[]': ['09:30', '', '18:00', ''],
      'scheduleWeekdays[]': ['1', '3', '5'],
      scheduleWeekdaysTouched: '1',
      enabled: 'on'
    })

    expect(form.scheduleTimeLocal).toBe('09:30')
    expect(form.scheduleTimesLocal).toEqual(['09:30', '18:00'])
    expect(form.scheduleWeekdays).toEqual([1, 3, 5])
  })

  test('rejects more schedule times than the settings UI supports', () => {
    expect(() =>
      parseWebhookSubscriptionForm({
        name: '日报',
        provider: 'wecom',
        webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef',
        timezone: 'Asia/Shanghai',
        'scheduleTimesLocal[]': ['00:00', '06:00', '12:00', '18:00', '23:00'],
        'scheduleWeekdays[]': ['1'],
        scheduleWeekdaysTouched: '1',
        enabled: 'on'
      })
    ).toThrow('Invalid schedule time')
  })

  test('preserves multiple schedule weekdays from bracket form fields', () => {
    expect(scheduleWeekdaysFromForm({
      'scheduleWeekdays[]': ['1', '3', '5'],
      scheduleWeekdaysTouched: '1'
    })).toEqual([1, 3, 5])
  })
})
