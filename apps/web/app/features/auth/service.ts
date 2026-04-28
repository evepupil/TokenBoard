export function maskTokenPrefix(token: string) {
  return `${token.slice(0, 8)}...`
}

