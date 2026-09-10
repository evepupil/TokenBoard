import { describe, expect, test } from 'vitest'
import { decryptSecret, encryptSecret } from './crypto'

const testEncryptionKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='
const otherEncryptionKey = 'YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZmFiY2RlZjAxMjM='

describe('notification secret encryption', () => {
  test('encrypts without storing plaintext and decrypts with the same key', async () => {
    const encrypted = await encryptSecret(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret',
      testEncryptionKey
    )

    expect(encrypted).toMatch(/^v1:/)
    expect(encrypted).not.toContain('secret')
    await expect(decryptSecret(encrypted, testEncryptionKey)).resolves.toBe(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret'
    )
  })

  test('rejects a different decryption key', async () => {
    const encrypted = await encryptSecret('value', testEncryptionKey)

    await expect(decryptSecret(encrypted, otherEncryptionKey)).rejects.toThrow()
  })
})
