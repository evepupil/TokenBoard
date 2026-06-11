export function canShowPublicProfile(isPublic: boolean) {
  return isPublic
}

export function getCanonicalPublicOrigin(input: {
  configuredOrigin?: string | null
  requestOrigin: string
}) {
  return (input.configuredOrigin || input.requestOrigin).replace(/\/$/, '')
}
