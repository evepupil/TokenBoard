export function normalizePublicSlug(slug: string, extension: 'json' | 'svg') {
  return slug.endsWith(`.${extension}`) ? slug.slice(0, -1 * (`.${extension}`.length)) : slug
}

export function getPublicRouteSlug(
  params: Record<string, string | undefined>,
  extension: 'json' | 'svg'
) {
  return normalizePublicSlug(
    params.slug ?? params[`slug.${extension}`] ?? '',
    extension
  )
}
