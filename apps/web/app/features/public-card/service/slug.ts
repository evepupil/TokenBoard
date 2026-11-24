// Fixed routes under /api/public take precedence over user slugs; every one of them must
// also be reserved here, or a profile that picked the same slug becomes unreachable (the
// route wins) while the settings form happily accepts it.
const reservedPublicSlugs = new Set(['model-pricing', 'version'])

export function isReservedPublicSlug(slug: string) {
  return reservedPublicSlugs.has(slug.toLowerCase())
}
