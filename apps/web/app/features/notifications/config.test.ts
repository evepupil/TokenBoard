import { describe, expect, test } from 'vitest'
import {
  webhookCronBatchSize,
  hasValidEncryptionKey,
  parseProviderWebhookUrl,
  requireEncryptionKey,
  shouldPruneWebhookDeliveryLogs,
  webhookLogRetentionDays
} from './config'

const validBase64Key = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='
const validBase64UrlKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY'

describe('notification config', () => {
  test('accepts 32-byte base64 webhook encryption keys', () => {
    expect(requireEncryptionKey({ WEBHOOK_ENCRYPTION_KEY: validBase64Key })).toBe(validBase64Key)
    expect(requireEncryptionKey({ WEBHOOK_ENCRYPTION_KEY: validBase64UrlKey })).toBe(validBase64UrlKey)
    expect(hasValidEncryptionKey({ WEBHOOK_ENCRYPTION_KEY: validBase64Key })).toBe(true)
  })

  test('rejects missing or weak webhook encryption keys', () => {
    expect(() => requireEncryptionKey({})).toThrow('WEBHOOK_ENCRYPTION_KEY is not configured')
    expect(() => requireEncryptionKey({ WEBHOOK_ENCRYPTION_KEY: 'test-key' })).toThrow('32-byte base64')
    expect(() => requireEncryptionKey({ WEBHOOK_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow('32-byte base64')
    expect(hasValidEncryptionKey({ WEBHOOK_ENCRYPTION_KEY: 'test-key' })).toBe(false)
  })

  test('accepts official webhook URLs with provider bot tokens', () => {
    expect(parseProviderWebhookUrl('wecom', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef').toString()).toBe(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef'
    )
    expect(parseProviderWebhookUrl('dingtalk', 'https://oapi.dingtalk.com/robot/send?access_token=abcdef').toString()).toBe(
      'https://oapi.dingtalk.com/robot/send?access_token=abcdef'
    )
    expect(parseProviderWebhookUrl('feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdef').toString()).toBe(
      'https://open.feishu.cn/open-apis/bot/v2/hook/abcdef'
    )
    expect(parseProviderWebhookUrl('feishu', 'https://open.larksuite.com/open-apis/bot/v2/hook/abcdef').toString()).toBe(
      'https://open.larksuite.com/open-apis/bot/v2/hook/abcdef'
    )
  })

  test('rejects official webhook URLs without provider bot tokens', () => {
    expect(() => parseProviderWebhookUrl('wecom', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send')).toThrow(
      'Webhook URL host or path is not supported'
    )
    expect(() => parseProviderWebhookUrl('wecom', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=')).toThrow(
      'Webhook URL host or path is not supported'
    )
    expect(() => parseProviderWebhookUrl('dingtalk', 'https://oapi.dingtalk.com/robot/send')).toThrow(
      'Webhook URL host or path is not supported'
    )
    expect(() => parseProviderWebhookUrl('dingtalk', 'https://oapi.dingtalk.com/robot/send?access_token=')).toThrow(
      'Webhook URL host or path is not supported'
    )
    expect(() => parseProviderWebhookUrl('feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/')).toThrow(
      'Webhook URL host or path is not supported'
    )
    expect(() => parseProviderWebhookUrl('feishu', 'https://open.larksuite.com/open-apis/bot/v2/hook/')).toThrow(
      'Webhook URL host or path is not supported'
    )
  })

  test('rejects Feishu webhook URLs with extra token path segments', () => {
    expect(() => parseProviderWebhookUrl('feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdef/extra')).toThrow(
      'Webhook URL host or path is not supported'
    )
    expect(() => parseProviderWebhookUrl('feishu', 'https://open.larksuite.com/open-apis/bot/v2/hook/abcdef/extra')).toThrow(
      'Webhook URL host or path is not supported'
    )
  })

  test('reads webhook delivery log retention config', () => {
    expect(webhookLogRetentionDays({})).toBe(90)
    expect(webhookLogRetentionDays({ TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS: '7' })).toBe(7)
    expect(webhookLogRetentionDays({ TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS: '365' })).toBe(365)
  })

  test.each(['', '0', '366', 'abc', '7.5'])('rejects invalid webhook log retention value %s', (value) => {
    expect(() => webhookLogRetentionDays({
      TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS: value
    })).toThrow('TOKENBOARD_WEBHOOK_LOG_RETENTION_DAYS must be an integer from 1 to 365')
  })

  test('reads a conservative webhook cron batch size', () => {
    expect(webhookCronBatchSize({})).toBe(5)
    expect(webhookCronBatchSize({ TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE: '1' })).toBe(1)
    expect(webhookCronBatchSize({ TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE: '5' })).toBe(5)
  })

  test.each(['', '0', '6', 'abc', '7.5'])('rejects invalid webhook cron batch size %s', (value) => {
    expect(() => webhookCronBatchSize({
      TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE: value
    })).toThrow('TOKENBOARD_WEBHOOK_CRON_BATCH_SIZE must be an integer from 1 to 5')
  })

  test('prunes webhook delivery logs during the UTC midnight hour by default', () => {
    expect(shouldPruneWebhookDeliveryLogs(
      new Date('2026-04-29T00:00:00.000Z')
    )).toBe(true)
    expect(shouldPruneWebhookDeliveryLogs(
      new Date('2026-04-29T00:15:00.000Z')
    )).toBe(true)
    expect(shouldPruneWebhookDeliveryLogs(
      new Date('2026-04-29T01:00:00.000Z')
    )).toBe(false)
  })
})
