export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function randomToken(prefix: string) {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  const value = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
  return `${prefix}_${value}`
}

export function randomId(prefix: string) {
  return randomToken(prefix)
}

