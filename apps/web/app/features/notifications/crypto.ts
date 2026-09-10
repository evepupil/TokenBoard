import { decodeEncryptionKey } from './config'

const encryptedValuePrefix = 'v1'

export async function encryptSecret(value: string, secret: string) {
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const key = await importSecretKey(secret)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value))

  return `${encryptedValuePrefix}:${base64UrlEncode(iv)}:${base64UrlEncode(new Uint8Array(ciphertext))}`
}

export async function decryptSecret(value: string, secret: string) {
  const [version, rawIv, rawCiphertext] = value.split(':')
  if (version !== encryptedValuePrefix || !rawIv || !rawCiphertext) {
    throw new Error('Invalid encrypted value')
  }

  const key = await importSecretKey(secret)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlDecode(rawIv) },
    key,
    base64UrlDecode(rawCiphertext)
  )

  return new TextDecoder().decode(plaintext)
}

async function importSecretKey(secret: string) {
  return crypto.subtle.importKey('raw', decodeEncryptionKey(secret), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64UrlDecode(value: string) {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
